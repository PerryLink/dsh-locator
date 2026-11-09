/**
 * Lifecycle of the locator engine child process and its line-delimited JSON
 * protocol.
 * @module dsh-locator/runtime
 */
import type { Config } from './config.ts';
/** One search hit. */
export interface SearchHit {
    path: string;
    name: string;
    size: number;
    mtime: number;
    ext: string;
    dir: boolean;
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
    scanning: boolean;
    usn: boolean;
    uptimeSec: number;
    stateDir: string;
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
}
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
    /** Read one page of the index for an export. */
    dump(after: number, limit: number): Promise<DumpPage>;
    /** Read live status from the engine, refreshing the cached event copy. */
    engineStatus(): Promise<EngineStatus | undefined>;
    /** Ask the engine to rebuild the whole index in the background. */
    rebuild(roots?: string[], excludes?: string[]): Promise<{
        started: boolean;
    }>;
    /** Stop the engine and wait for its process to exit. */
    stop(): Promise<void>;
}
//# sourceMappingURL=runtime.d.ts.map