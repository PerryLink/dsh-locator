/**
 * Content search: text files and DSH session messages in SQLite FTS5.
 *
 * File names stay in the Go engine. This store is built from the engine's
 * `dump` RPC plus the session logs: Node reads text bodies, decompresses
 * `session.v4.jsonl.zstd`, and SQLite's trigram tokenizer gives substring and
 * CJK search. A meta table stores each source's mtime so refresh() only
 * re-reads what changed; rebuild() drops and rebuilds everything.
 *
 * Everything here runs inside the DSH host process, so the build must never
 * monopolise its event loop: file reads and zstd decoding are asynchronous and
 * the loops yield to the scheduler every ~8 ms of work. Session logs are read
 * only once they have settled (an actively written session is skipped until it
 * has been quiet for `activeSessionDelayMs`), and archived sessions are left
 * alone unless `includeArchived` is set.
 * @module dsh-locator/content
 */
import type { LocatorRuntime } from './runtime.ts';
export interface ContentHit {
    kind: 'file' | 'session';
    path: string;
    title: string;
    snippet: string;
    sessionId?: string;
    messageId?: string;
    score: number;
}
export interface ContentState {
    building: boolean;
    files: number;
    sessions: number;
    messages: number;
    truncated: boolean;
    error: string;
    updatedAt: number;
}
export interface ContentOptions {
    stateDir: string;
    sessionDirs?: string[] | undefined;
    /** Path segments or substrings never read into the content index. */
    excludes?: string[];
    /** Index archived sessions too; false (the default) leaves them out. */
    includeArchived?: boolean;
    /**
     * Skip session logs modified more recently than this many milliseconds, so
     * the session being written right now is not re-read on every refresh.
     */
    activeSessionDelayMs?: number;
    maxFileBytes: number;
    maxTotalBytes?: number;
    maxFiles: number;
    maxSessions: number;
    /**
     * Run content queries in a worker thread so a slow search never blocks the
     * DSH host event loop. Off by default so direct embedders and tests stay
     * single-threaded.
     */
    searchWorker?: boolean;
}
export declare class ContentIndex {
    private readonly rt;
    private readonly options;
    private db;
    private readonly state;
    private generation;
    private totalBytes;
    private sliceDeadline;
    private worker;
    private lockHeld;
    private readonly lockToken;
    private workerSeq;
    private pendingStart;
    private readonly pending;
    constructor(rt: LocatorRuntime, options: ContentOptions);
    status(): ContentState;
    /**
     * Report a lazy build as in progress before the asynchronous start reaches
     * `boot()`, so the panel/agent sees "building" on the very first query
     * instead of an empty result with no hint.
     */
    markPending(): void;
    /** Drop the pending flag when the lazy start failed before it began. */
    clearPending(): void;
    /** Queue a full rebuild; false when one is already running. */
    rebuild(): boolean;
    /** Queue an incremental refresh; false when one is already running. */
    refreshNow(): boolean;
    close(): void;
    /** Build everything from scratch. */
    start(): void;
    /**
     * Start at plugin boot: reuse an existing database and refresh it
     * incrementally, so a restart does not re-read and re-index gigabytes of
     * text. A missing or incompatible database falls back to a full build.
     */
    boot(): void;
    /** Re-read changed files/sessions; open the DB when this is the first run. */
    refresh(): void;
    /**
     * Serialize content builds across plugin instances and DSH processes that
     * share a state directory: a stale lock (dead pid or older than 30 minutes)
     * is taken over, a live one keeps this instance from writing concurrently.
     * @returns whether this instance owns the build lock.
     */
    private acquireLock;
    private releaseLock;
    private begin;
    private full;
    private incremental;
    private open;
    private reopenWorker;
    private stopWorker;
    private ensureWorker;
    /** Whether `path` is a SQLite database this plugin created (has docs_meta). */
    private ownedDatabase;
    private readFlag;
    private writeFlag;
    /**
     * Body bytes already stored. Reading a persisted counter avoids a full scan
     * of every FTS body (measured ~0.6 s for 1 GB) at the start of each refresh.
     * A database written before the counter existed falls back to one scan.
     */
    private readTotalBytes;
    private writeTotalBytes;
    /** Yield to the host event loop once the current ~8 ms work slice is spent. */
    private breathe;
    /** True when a session log has been quiet long enough to be read safely. */
    private settled;
    private finish;
    private addDoc;
    private deleteDoc;
    private deletePath;
    private indexFiles;
    private refreshFiles;
    /** Would storing a file of this size overflow the configured body budget? */
    private wouldExceed;
    private readFileDoc;
    private indexSessions;
    private refreshSessions;
    private indexSessionFile;
    /** Session logs to consider, newest first, minus archived ones by default. */
    private sessionCandidates;
    sessionRoots(): string[];
    /**
     * Search file bodies and session messages. With `searchWorker` enabled the
     * query itself runs off the host thread; a failed or wedged worker falls back
     * to the in-process query so a result is still produced.
     * @param query - words or a phrase to find.
     * @param limit - maximum hits.
     * @returns matching documents ordered by relevance.
     */
    search(query: string, limit: number): Promise<ContentHit[]>;
    private searchSync;
}
//# sourceMappingURL=content.d.ts.map