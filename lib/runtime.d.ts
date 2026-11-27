/**
 * Lifecycle of the locator engine child process and its line-delimited JSON
 * protocol.
 * @module dsh-locator/runtime
 */
import type { Config } from './config.ts';
import { type StateDirPermissions } from './paths.ts';
/** One search hit. */
export interface SearchHit {
    path: string;
    name: string;
    size: number;
    mtime: number;
    ext: string;
    dir: boolean;
    /** Citable evidence ref for this name hit (ref://file). */
    ref?: string;
}
/** One search result page. */
export interface SearchResult {
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    indexing?: boolean;
    tookNs: number;
    hits: SearchHit[];
}
/** Search arguments forwarded to the engine. */
export interface SearchArgs {
    query: string;
    limit: number;
    offset: number;
    sort: string;
    desc: boolean;
    regex: boolean;
    caseSensitive: boolean;
    wholeWord: boolean;
    filesOnly: boolean;
    dirsOnly: boolean;
}
/** One row of a paginated index dump. */
export interface DumpEntry {
    path: string;
    name: string;
    size: number;
    mtime: number;
    ext: string;
    dir: boolean;
}
/** One page of an index dump. */
export interface DumpPage {
    entries: DumpEntry[];
    next: number;
    done: boolean;
    /**
     * Set when the caller's `since` generation already matches the engine's
     * current generation: the page is empty and there is nothing to walk.
     */
    unchanged?: boolean;
    /** Index generation this page was read from (content refresh fast path). */
    generation?: number;
}
/** Optional narrowing for one dump walk (content refresh fast path). */
export interface DumpOptions {
    /** Only walk when the index generation differs from this value. */
    since?: number;
    /** Only return entries modified at/after this epoch millisecond. */
    mtimeFrom?: number;
}
/** Engine status as reported by the `status` method and events. */
export interface EngineStatus {
    version: string;
    platform: string;
    roots: string[];
    entries: number;
    files: number;
    dirs: number;
    nameBytes: number;
    deleted: number;
    watching: boolean;
    /** The native watcher covers only part of the configured roots. */
    watchDegraded?: boolean;
    watchReason?: string;
    /** Number of roots actually watched. */
    watchRoots?: number;
    /** Periodic rebuild fallback is active because the watcher is incomplete. */
    refreshFallback?: boolean;
    /** The fallback refreshes only watcher-less roots instead of re-scanning all. */
    incrementalRefresh?: boolean;
    /** Configured roots no native watcher covers (refreshed by the fallback). */
    watchUnwatchedRoots?: string[];
    /** Last fallback refresh mode: incremental or full. */
    refreshMode?: string;
    /** Why the last fallback refresh ran. */
    refreshReason?: string;
    /** Roots scanned by the last fallback refresh. */
    refreshScannedRoots?: string[];
    /** Healthy roots skipped by the last incremental refresh. */
    refreshSkippedRoots?: string[];
    /** Entries re-read by the last fallback refresh. */
    refreshEntries?: number;
    /** Wall-clock cost of the last fallback refresh. */
    refreshTookMs?: number;
    /** Epoch milliseconds of the last fallback refresh. */
    refreshAt?: number;
    /** Configured refresh cadence for roots without a native watcher, in ms (0 = engine default). */
    unwatchedRefreshMs?: number;
    /** Epoch milliseconds of the next scheduled fallback refresh. */
    nextRefreshAt?: number;
    /** Completed fallback-refresh rounds since engine start. */
    refreshRounds?: number;
    /** Fallback refreshes skipped by the pressure gate since engine start. */
    refreshSkippedByPressure?: number;
    scanning: boolean;
    usn: boolean;
    uptimeSec: number;
    stateDir: string;
    /** Index generation (moves on every real mutation); used by the content fast path. */
    generation?: number;
    /** Epoch milliseconds of the snapshot the index was loaded/built from (ms, not ns). */
    builtAt?: number;
    /** The async watcher install is still running; `watching` fills in on a later stats event. */
    watchInitializing?: boolean;
    /** Completed query RPCs since engine start. */
    queryCount?: number;
    /** Wall-clock cost of the last query RPC, in milliseconds. */
    lastQueryMs?: number;
    /** Ring of the last query durations in ms, newest last. */
    recentQueryMs?: number[];
    /** Go heap size in bytes. */
    heapBytes?: number;
    /** Number of completed GC cycles. */
    numGC?: number;
    /** Current refresh retry backoff, in milliseconds. */
    refreshBackoffMs?: number;
    /** Engine process resident set size, in bytes (observability, optional). */
    rssBytes?: number;
    /** Engine process peak resident set size, in bytes (observability, optional). */
    hwmBytes?: number;
    /** Directories currently watched by the native watcher. */
    watchDirs?: number;
    /** Configured watcher directory budget (`watchMaxDirs`). */
    watchLimit?: number;
    /** The watcher hit its directory budget and leaves the rest to incremental refresh. */
    watchLimited?: boolean;
    /** On-disk snapshot size in bytes. */
    snapshotBytes?: number;
    /** Bytes written by the last snapshot save. */
    saveBytes?: number;
    /** Wall-clock cost of the last snapshot save. */
    saveMs?: number;
    /** Snapshot saves since engine start. */
    saveCount?: number;
    /** Pending work queue depth (refresh/scan), when the engine reports it. */
    queueDepth?: number;
    /**
     * Another live engine owns the state directory (0.23 state-dir write lock):
     * this engine serves the snapshot read-only and does not write.
     */
    readOnly?: boolean;
    /** PID of the engine that owns the state-directory write lock. */
    lockPid?: number;
}
/** One prepared engine binary: the path to spawn plus what had to be done. */
export interface PreparedEngineBinary {
    /** The executable to spawn. */
    path: string;
    /** True when the executable was copied out of the package (Windows only). */
    copied: boolean;
    /** Copy directories removed while pruning old package versions. */
    cleaned: string[];
    /** A non-fatal problem; the package binary is then used unchanged. */
    warning?: string;
}
/** Runtime status exposed to the status tool. */
export interface RuntimeStatus {
    running: boolean;
    error?: string;
    warning?: string;
    scanning?: {
        phase: string;
        entries?: number;
        current?: string;
    };
    engine?: EngineStatus;
    /** Result of the startup state-directory permission pass (P0-2 follow-up). */
    permissions?: StateDirPermissions;
}
/** Smallest automatic engine heap limit, in MiB. */
export declare const AUTO_MEMORY_MIN_MB = 384;
/** Largest automatic engine heap limit, in MiB. */
export declare const AUTO_MEMORY_MAX_MB = 1024;
/**
 * Derive the automatic Go heap limit that `memoryLimitMB: 0` means: a quarter
 * of physical memory clamped to {@link AUTO_MEMORY_MIN_MB}-{@link AUTO_MEMORY_MAX_MB}
 * MiB. The result is always passed to the engine as `--memory-limit-mb` so an
 * unset configuration never leaves the engine without a GOMEMLIMIT (the 0.19.x
 * behavior that let the engine grow past 1 GB RSS).
 * @param totalBytes - physical memory in bytes (defaults to this machine).
 * @returns the limit in MiB.
 */
export declare function autoMemoryLimitMB(totalBytes?: number): number;
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
export declare function engineServeArgs(config: Pick<Config, 'excludes' | 'watch' | 'refreshIntervalMs' | 'refreshIncremental' | 'scanWorkers' | 'memoryLimitMB' | 'windowsUsn' | 'includeCaches' | 'watchMaxDirs' | 'snapshotCompression' | 'unwatchedRefreshIntervalMs'>, roots: readonly string[], stateDir: string): string[];
/**
 * Copy the package engine binary below the state directory on Windows.
 *
 * Windows locks a running executable against replacement, so upgrading the
 * plugin in place fails with a sharing violation while the old engine is still
 * running from `bin/win32-<arch>/indexd.exe`. Spawning from
 * `<stateDir>/engine/<packageVersion>/indexd.exe` instead decouples the
 * running engine from the package directory: npm can replace the package, the
 * old engine keeps its private copy, and the next start uses the new version.
 *
 * Copies for other package versions are pruned afterwards (best effort: an old
 * engine may still hold its executable, which Windows refuses to delete and the
 * next boot retries). On every other platform the package binary is executed
 * directly and this function is a no-op.
 * @param binary - the package engine binary.
 * @param stateDir - the resolved state directory.
 * @param version - the package version the copy is keyed by.
 * @param platform - the platform to prepare for (defaults to this one).
 * @returns the executable path and what was copied/cleaned.
 */
export declare function prepareEngineBinary(binary: string, stateDir: string, version: string, platform?: NodeJS.Platform): PreparedEngineBinary;
/**
 * Owns the engine process. Tools await {@link LocatorRuntime.waitReady} before
 * issuing requests; a missing binary or a crashed engine surfaces as a tool
 * error carrying the engine's own message.
 */
export declare class LocatorRuntime {
    readonly config: Config;
    readonly roots: string[];
    readonly stateDir: string;
    readonly binary: string;
    readonly cwd: string;
    readonly status: RuntimeStatus;
    private child;
    private pending;
    private nextId;
    private started;
    private disposed;
    private failure;
    private readonly ready;
    private settleReady;
    private settled;
    private startupTimer;
    /** Epoch ms of the last stats event/RPC reply; drives the status TTL cache. */
    private lastStatsAt;
    constructor(config: Config, roots: string[], stateDir: string, binary: string, cwd: string);
    /** Start the engine once. Safe to call repeatedly. */
    start(): void;
    private spawn;
    private onLine;
    private onEvent;
    private applyStats;
    private clearStartupTimer;
    private fail;
    private onExit;
    private rejectPending;
    /** Wait until the engine is ready, or throw the recorded startup failure. */
    waitReady(): Promise<void>;
    /** Issue one request against the engine. */
    request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
    /** Run a search. */
    search(args: SearchArgs): Promise<SearchResult>;
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
    dump(after: number, limit: number, opts?: DumpOptions): Promise<DumpPage>;
    /** Read live status from the engine, refreshing the cached event copy. */
    engineStatus(): Promise<EngineStatus | undefined>;
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
    engineStatusCached(ttlMs?: number): Promise<EngineStatus | undefined>;
    /** Ask the engine to rebuild the whole index in the background. */
    rebuild(roots?: string[], excludes?: string[]): Promise<{
        started: boolean;
    }>;
    /** Stop the engine and wait for its process to exit. */
    stop(): Promise<void>;
}
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
export declare function engineResourceFields(engine: EngineStatus | undefined): Record<string, number | boolean | number[]>;
//# sourceMappingURL=runtime.d.ts.map