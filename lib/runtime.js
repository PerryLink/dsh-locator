/**
 * Lifecycle of the locator engine child process and its line-delimited JSON
 * protocol.
 * @module dsh-locator/runtime
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
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
        const args = ['serve', '--state', this.stateDir];
        for (const root of this.roots)
            args.push('--root', root);
        for (const exclude of this.config.excludes)
            args.push('--exclude', exclude);
        if (!this.config.watch)
            args.push('--no-watch');
        if (this.config.refreshIntervalMs > 0)
            args.push('--refresh', `${String(this.config.refreshIntervalMs)}ms`);
        if (this.config.scanWorkers > 0)
            args.push('--workers', String(this.config.scanWorkers));
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
            uptimeSec: numberOr(params.uptimeSec, 0),
            stateDir: typeof params.stateDir === 'string' ? params.stateDir : this.stateDir,
        };
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
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function numberOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
//# sourceMappingURL=runtime.js.map