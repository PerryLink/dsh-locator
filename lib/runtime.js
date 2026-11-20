/**
 * Lifecycle of the locator engine child process and its line-delimited JSON
 * protocol.
 * @module dsh-locator/runtime
 */
import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { totalmem } from 'node:os';
import { createInterface } from 'node:readline';
/** Smallest automatic engine heap limit, in MiB. */
export const AUTO_MEMORY_MIN_MB = 384;
/** Largest automatic engine heap limit, in MiB. */
export const AUTO_MEMORY_MAX_MB = 1024;
/**
 * Derive the automatic Go heap limit that `memoryLimitMB: 0` means: a quarter
 * of physical memory clamped to {@link AUTO_MEMORY_MIN_MB}-{@link AUTO_MEMORY_MAX_MB}
 * MiB. The result is always passed to the engine as `--memory-limit-mb` so an
 * unset configuration never leaves the engine without a GOMEMLIMIT (the 0.19.x
 * behavior that let the engine grow past 1 GB RSS).
 * @param totalBytes - physical memory in bytes (defaults to this machine).
 * @returns the limit in MiB.
 */
export function autoMemoryLimitMB(totalBytes = totalmem()) {
    if (!Number.isFinite(totalBytes) || totalBytes <= 0)
        return AUTO_MEMORY_MIN_MB;
    const quarterMB = Math.trunc(totalBytes / (1024 * 1024) / 4);
    return Math.min(AUTO_MEMORY_MAX_MB, Math.max(AUTO_MEMORY_MIN_MB, quarterMB));
}
/**
 * Build the argv for one `indexd serve` session.
 *
 * Extracted so the fallback-refresh switch (`--no-incremental-refresh`), the
 * 0.20.0 resource flags (`--include-caches`, `--watch-max-dirs`,
 * `--snapshot-compression`) and the always-present `--memory-limit-mb` can be
 * asserted without spawning a process.
 *
 * Optional config fields (the 0.20.0 additions) are omitted from the argv when
 * they are `undefined`, which keeps the engine's own defaults in force and keeps
 * hand-built configs (tests/embedders) valid; a profile load always materializes
 * them through the schema, so production always passes them.
 * @param config - validated plugin configuration.
 * @param roots - resolved index roots.
 * @param stateDir - snapshot directory.
 * @returns the engine argv.
 */
export function engineServeArgs(config, roots, stateDir) {
    const args = ['serve', '--state', stateDir];
    for (const root of roots)
        args.push('--root', root);
    for (const exclude of config.excludes)
        args.push('--exclude', exclude);
    if (!config.watch)
        args.push('--no-watch');
    // Default true: periodic fallback refreshes only watcher-less roots. false
    // restores the 0.18 full-rescan behavior.
    if (config.refreshIncremental === false)
        args.push('--no-incremental-refresh');
    if (config.refreshIntervalMs > 0)
        args.push('--refresh', String(config.refreshIntervalMs) + 'ms');
    // Roots without a native watcher (9p/DrvFs, NFS, SMB) get their own, usually
    // faster cadence. Absent/0 keeps the engine default (min(unwatched, base)).
    const unwatchedRefreshMs = config.unwatchedRefreshIntervalMs;
    if (typeof unwatchedRefreshMs === 'number' && Number.isFinite(unwatchedRefreshMs) && unwatchedRefreshMs > 0) {
        args.push('--unwatched-refresh', String(Math.trunc(unwatchedRefreshMs)) + 'ms');
    }
    if (config.scanWorkers > 0)
        args.push('--workers', String(config.scanWorkers));
    // 0 means "auto": derive the machine-sized limit and always pass it, so an
    // unset memoryLimitMB no longer leaves the engine unbounded.
    const memoryLimitMB = config.memoryLimitMB > 0 ? Math.trunc(config.memoryLimitMB) : autoMemoryLimitMB();
    args.push('--memory-limit-mb', String(memoryLimitMB));
    // Absent means "exclude the toolchain/package caches"; only an explicit true
    // restores the pre-0.20 full-coverage scan.
    if (config.includeCaches === true)
        args.push('--include-caches');
    if (typeof config.watchMaxDirs === 'number' && Number.isFinite(config.watchMaxDirs) && config.watchMaxDirs > 0) {
        args.push('--watch-max-dirs', String(Math.trunc(config.watchMaxDirs)));
    }
    // Compression is opt-in and wave2-only: absent keeps the engine's `none` default.
    if (config.snapshotCompression === 'zstd')
        args.push('--snapshot-compression', 'zstd');
    if (config.windowsUsn)
        args.push('--usn');
    return args;
}
/**
 * Owns the engine process. Tools await {@link LocatorRuntime.waitReady} before
 * issuing requests; a missing binary or a crashed engine surfaces as a tool
 * error carrying the engine's own message.
 */
export class LocatorRuntime {
    config;
    roots;
    stateDir;
    binary;
    cwd;
    status = { running: false };
    child = null;
    pending = new Map();
    nextId = 1;
    started = false;
    disposed = false;
    failure = null;
    ready;
    settleReady;
    settled = false;
    startupTimer;
    /** Epoch ms of the last stats event/RPC reply; drives the status TTL cache. */
    lastStatsAt;
    constructor(config, roots, stateDir, binary, cwd) {
        this.config = config;
        this.roots = roots;
        this.stateDir = stateDir;
        this.binary = binary;
        this.cwd = cwd;
        this.ready = new Promise(resolve => {
            this.settleReady = (failure) => {
                if (this.settled)
                    return;
                this.settled = true;
                if (failure !== undefined)
                    this.failure = failure;
                resolve();
            };
        });
    }
    /** Start the engine once. Safe to call repeatedly. */
    start() {
        if (this.started || this.disposed)
            return;
        this.started = true;
        this.spawn();
    }
    spawn() {
        // npm and git checkouts can lose the executable bit on the bundled engine.
        // Restore it (best effort) before spawning; Windows does not use it.
        if (process.platform !== 'win32') {
            try {
                chmodSync(this.binary, 0o755);
            }
            catch {
                // A read-only install cannot be fixed here; spawn reports the real error.
            }
        }
        const args = engineServeArgs(this.config, this.roots, this.stateDir);
        let child;
        try {
            child = spawn(this.binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        }
        catch (error) {
            this.fail(error);
            return;
        }
        this.child = child;
        this.status.running = true;
        delete this.status.error;
        const out = createInterface({ input: child.stdout });
        out.on('line', line => this.onLine(line));
        const err = createInterface({ input: child.stderr });
        err.on('line', line => {
            if (line.trim() !== '')
                console.error(`[dsh-locator] ${line}`);
        });
        child.once('error', error => this.fail(error));
        child.once('exit', (code, signal) => this.onExit(code, signal));
        this.startupTimer = setTimeout(() => {
            this.fail(`locator engine did not become ready in ${String(this.config.startupTimeoutMs)} ms; ` +
                `a very large root may still be scanning (state: ${this.stateDir})`);
        }, this.config.startupTimeoutMs);
    }
    onLine(line) {
        if (line.trim() === '')
            return;
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            console.error(`[dsh-locator] malformed engine output: ${line.slice(0, 200)}`);
            return;
        }
        if (!isRecord(message))
            return;
        if (typeof message.event === 'string') {
            this.onEvent(message.event, message.params);
            return;
        }
        if (typeof message.id !== 'number')
            return;
        const pending = this.pending.get(message.id);
        if (pending === undefined)
            return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (isRecord(message.error)) {
            const rpc = message.error;
            pending.reject(new Error(rpc.message ?? rpc.code ?? 'engine request failed'));
            return;
        }
        pending.resolve(message.result);
    }
    onEvent(event, params) {
        switch (event) {
            case 'ready':
            case 'stats':
                this.applyStats(params);
                this.clearStartupTimer();
                this.settleReady();
                break;
            case 'scan': {
                if (!isRecord(params))
                    break;
                const phase = typeof params.phase === 'string' ? params.phase : '';
                if (phase === 'done') {
                    delete this.status.scanning;
                }
                else if (phase !== '') {
                    const scanning = { phase };
                    if (typeof params.entries === 'number')
                        scanning.entries = params.entries;
                    if (typeof params.current === 'string' && params.current !== '')
                        scanning.current = params.current;
                    this.status.scanning = scanning;
                }
                break;
            }
            case 'warning':
                if (isRecord(params) && typeof params.message === 'string')
                    this.status.warning = params.message;
                break;
            case 'error':
                if (isRecord(params) && typeof params.message === 'string')
                    this.status.error = params.message;
                break;
            default:
                break;
        }
    }
    applyStats(params) {
        if (!isRecord(params))
            return;
        const roots = Array.isArray(params.roots) ? params.roots.filter((r) => typeof r === 'string') : this.roots;
        this.status.engine = {
            version: typeof params.version === 'string' ? params.version : '0.1.0',
            platform: typeof params.platform === 'string' ? params.platform : '',
            roots,
            entries: numberOr(params.entries, 0),
            files: numberOr(params.files, 0),
            dirs: numberOr(params.dirs, 0),
            nameBytes: numberOr(params.nameBytes, 0),
            deleted: numberOr(params.deleted, 0),
            watching: params.watching === true,
            ...(params.watchDegraded === true ? { watchDegraded: true } : {}),
            ...(typeof params.watchReason === 'string' ? { watchReason: params.watchReason } : {}),
            ...(typeof params.watchRoots === 'number' ? { watchRoots: params.watchRoots } : {}),
            ...(params.refreshFallback === true ? { refreshFallback: true } : {}),
            ...(typeof params.incrementalRefresh === 'boolean' ? { incrementalRefresh: params.incrementalRefresh } : {}),
            ...(Array.isArray(params.watchUnwatchedRoots) ? { watchUnwatchedRoots: stringList(params.watchUnwatchedRoots) } : {}),
            ...(typeof params.refreshMode === 'string' ? { refreshMode: params.refreshMode } : {}),
            ...(typeof params.refreshReason === 'string' ? { refreshReason: params.refreshReason } : {}),
            ...(Array.isArray(params.refreshScannedRoots) ? { refreshScannedRoots: stringList(params.refreshScannedRoots) } : {}),
            ...(Array.isArray(params.refreshSkippedRoots) ? { refreshSkippedRoots: stringList(params.refreshSkippedRoots) } : {}),
            ...(typeof params.refreshEntries === 'number' ? { refreshEntries: params.refreshEntries } : {}),
            ...(typeof params.refreshTookMs === 'number' ? { refreshTookMs: params.refreshTookMs } : {}),
            ...(typeof params.refreshAt === 'number' ? { refreshAt: params.refreshAt } : {}),
            ...(typeof params.unwatchedRefreshMs === 'number' ? { unwatchedRefreshMs: params.unwatchedRefreshMs } : {}),
            ...(typeof params.nextRefreshAt === 'number' ? { nextRefreshAt: params.nextRefreshAt } : {}),
            ...(typeof params.refreshRounds === 'number' ? { refreshRounds: params.refreshRounds } : {}),
            ...(typeof params.refreshSkippedByPressure === 'number' ? { refreshSkippedByPressure: params.refreshSkippedByPressure } : {}),
            ...(typeof params.generation === 'number' ? { generation: params.generation } : {}),
            ...(typeof params.builtAt === 'number' ? { builtAt: params.builtAt } : {}),
            ...(typeof params.rssBytes === 'number' ? { rssBytes: params.rssBytes } : {}),
            ...(typeof params.hwmBytes === 'number' ? { hwmBytes: params.hwmBytes } : {}),
            ...(typeof params.watchDirs === 'number' ? { watchDirs: params.watchDirs } : {}),
            ...(typeof params.watchLimit === 'number' ? { watchLimit: params.watchLimit } : {}),
            ...(params.watchLimited === true ? { watchLimited: true } : {}),
            ...(typeof params.snapshotBytes === 'number' ? { snapshotBytes: params.snapshotBytes } : {}),
            ...(typeof params.saveBytes === 'number' ? { saveBytes: params.saveBytes } : {}),
            ...(typeof params.saveMs === 'number' ? { saveMs: params.saveMs } : {}),
            ...(typeof params.saveCount === 'number' ? { saveCount: params.saveCount } : {}),
            ...(typeof params.queueDepth === 'number' ? { queueDepth: params.queueDepth } : {}),
            ...(params.watchInitializing === true ? { watchInitializing: true } : {}),
            ...(typeof params.queryCount === 'number' ? { queryCount: params.queryCount } : {}),
            ...(typeof params.lastQueryMs === 'number' ? { lastQueryMs: params.lastQueryMs } : {}),
            ...(Array.isArray(params.recentQueryMs) ? { recentQueryMs: numberList(params.recentQueryMs) } : {}),
            ...(typeof params.heapBytes === 'number' ? { heapBytes: params.heapBytes } : {}),
            ...(typeof params.numGC === 'number' ? { numGC: params.numGC } : {}),
            ...(typeof params.refreshBackoffMs === 'number' ? { refreshBackoffMs: params.refreshBackoffMs } : {}),
            scanning: params.scanning === true,
            usn: params.usn === true,
            uptimeSec: numberOr(params.uptimeSec, 0),
            stateDir: typeof params.stateDir === 'string' ? params.stateDir : this.stateDir,
        };
        this.lastStatsAt = Date.now();
    }
    clearStartupTimer() {
        if (this.startupTimer !== undefined) {
            clearTimeout(this.startupTimer);
            this.startupTimer = undefined;
        }
    }
    fail(error) {
        const message = error instanceof Error ? error.message : String(error);
        this.clearStartupTimer();
        this.status.running = false;
        this.status.error = message;
        this.settleReady(message);
        this.rejectPending(new Error(message));
    }
    onExit(code, signal) {
        this.clearStartupTimer();
        this.child = null;
        this.status.running = false;
        const message = this.disposed
            ? 'locator engine stopped'
            : `locator engine exited (code ${String(code)}, signal ${String(signal)})`;
        if (!this.disposed)
            this.status.error = message;
        this.settleReady(message);
        this.rejectPending(new Error(message));
    }
    rejectPending(error) {
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
    /** Wait until the engine is ready, or throw the recorded startup failure. */
    async waitReady() {
        await this.ready;
        if (this.failure !== null)
            throw new Error(this.failure);
    }
    /** Issue one request against the engine. */
    async request(method, params = {}) {
        await this.waitReady();
        const child = this.child;
        if (child === null || !child.stdin.writable)
            throw new Error('locator engine is not running');
        const id = this.nextId++;
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`locator engine request "${method}" timed out after ${String(this.config.requestTimeoutMs)} ms`));
            }, this.config.requestTimeoutMs);
            this.pending.set(id, {
                resolve: value => resolve(value),
                reject,
                timer,
            });
        });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
        return promise;
    }
    /** Run a search. */
    async search(args) {
        const result = await this.request('search', {
            query: args.query,
            limit: args.limit,
            offset: args.offset,
            sort: args.sort,
            desc: args.desc,
            regex: args.regex,
            case: args.caseSensitive,
            wholeWord: args.wholeWord,
            filesOnly: args.filesOnly,
            dirsOnly: args.dirsOnly,
        });
        return {
            ...result,
            hits: Array.isArray(result.hits) ? result.hits : [],
        };
    }
    /**
     * Read one page of the index for an export or the content refresh.
     *
     * `since` is an index generation: when it still matches, the engine answers
     * `unchanged: true` without walking the index (content refresh fast path).
     * `mtimeFrom` narrows the walk to entries modified at/after that epoch ms.
     * Both are omitted when they are not positive finite numbers, so the
     * historical `dump(after, limit)` call keeps its exact behavior.
     * @param after - pagination cursor (entry index).
     * @param limit - page size.
     * @param opts - optional generation/mtime narrowing.
     * @returns one dump page.
     */
    async dump(after, limit, opts = {}) {
        const params = { after, limit };
        if (typeof opts.since === 'number' && Number.isFinite(opts.since) && opts.since > 0)
            params.since = opts.since;
        if (typeof opts.mtimeFrom === 'number' && Number.isFinite(opts.mtimeFrom) && opts.mtimeFrom > 0)
            params.mtimeFrom = opts.mtimeFrom;
        return await this.request('dump', params);
    }
    /** Read live status from the engine, refreshing the cached event copy. */
    async engineStatus() {
        try {
            const raw = await this.request('status');
            this.applyStats(raw);
            return this.status.engine;
        }
        catch {
            return this.status.engine;
        }
    }
    /**
     * Engine status served from the pushed stats cache for `ttlMs` (default 1 s),
     * falling back to one status RPC when the copy is absent or stale.
     *
     * The engine emits a `stats` event on every state change and the runtime
     * keeps the latest copy, so a panel polling `/status` no longer pays an IPC
     * round-trip on every tick (0.20.0 P0-12).
     * @param ttlMs - how long a pushed stats copy stays fresh.
     * @returns the current engine status, if any.
     */
    async engineStatusCached(ttlMs = 1_000) {
        const last = this.lastStatsAt;
        if (this.status.engine !== undefined && last !== undefined && Date.now() - last < ttlMs)
            return this.status.engine;
        return await this.engineStatus();
    }
    /** Ask the engine to rebuild the whole index in the background. */
    async rebuild(roots, excludes) {
        return await this.request('rebuild', {
            ...(roots === undefined ? {} : { roots }),
            ...(excludes === undefined ? {} : { excludes }),
        });
    }
    /** Stop the engine and wait for its process to exit. */
    async stop() {
        this.disposed = true;
        this.clearStartupTimer();
        const child = this.child;
        if (child === null)
            return;
        try {
            child.stdin.write(JSON.stringify({ id: 0, method: 'shutdown', params: {} }) + '\n');
        }
        catch {
            // The pipe is already gone; the kill below still applies.
        }
        await new Promise(resolve => {
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                resolve();
            }, 1500);
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
        this.child = null;
        this.status.running = false;
    }
}
/** Numeric engine status fields copied through to the status outputs. */
const ENGINE_NUMBER_FIELDS = [
    'generation',
    'builtAt',
    'rssBytes',
    'hwmBytes',
    'watchDirs',
    'watchLimit',
    'snapshotBytes',
    'saveBytes',
    'saveMs',
    'saveCount',
    'queueDepth',
    'queryCount',
    'lastQueryMs',
    'heapBytes',
    'numGC',
    'refreshBackoffMs',
    'unwatchedRefreshMs',
    'nextRefreshAt',
    'refreshRounds',
    'refreshSkippedByPressure',
];
/**
 * The additive engine resource/observability fields, ready to spread into a
 * status payload (locator_status, HTTP /status).
 *
 * The 0.20.0 engine reports these as optional numbers; a field the running
 * engine does not know about is simply absent, so old snapshots/binaries keep
 * rendering. Only finite numbers and true booleans are forwarded (a 0 is a
 * meaningful value and is kept).
 * @param engine - engine status, if the engine already answered.
 * @returns a bounded record of present fields.
 */
export function engineResourceFields(engine) {
    if (engine === undefined)
        return {};
    const source = engine;
    const fields = {};
    for (const key of ENGINE_NUMBER_FIELDS) {
        const value = source[key];
        if (typeof value === 'number' && Number.isFinite(value))
            fields[key] = value;
    }
    if (source.watchLimited === true)
        fields.watchLimited = true;
    if (source.watchInitializing === true)
        fields.watchInitializing = true;
    const recent = source.recentQueryMs;
    if (Array.isArray(recent)) {
        fields.recentQueryMs = recent.filter((value) => typeof value === 'number' && Number.isFinite(value));
    }
    return fields;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function numberOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
/** Only the string entries of an engine array field. */
function stringList(value) {
    return value.filter((entry) => typeof entry === 'string');
}
/** Only the finite-number entries of an engine array field. */
function numberList(value) {
    return value.filter((entry) => typeof entry === 'number' && Number.isFinite(entry));
}
//# sourceMappingURL=runtime.js.map