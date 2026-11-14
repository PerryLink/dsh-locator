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
import { Worker } from 'node:worker_threads';
import { type ContentSearchOptions, type ContentSearchResult } from './content-search.ts';
import type { LocatorRuntime } from './runtime.ts';
export interface ContentHit {
    kind: 'file' | 'session';
    path: string;
    title: string;
    snippet: string;
    sessionId?: string;
    messageId?: string;
    /** Exact `data-chat-node-key` of the rendered row, when the host has one. */
    nodeKey?: string;
    /** 1-based line of the first match inside the stored body, for file hits. */
    line?: number;
    score: number;
}
/** Which half of the content build a progress record belongs to. */
export type ContentProgressPhase = 'files' | 'sessions';
/**
 * Live progress for the content build. It only exists while `building` is
 * true, so the status endpoint, the Web panel and `locator_status` can show
 * what a long first build is doing instead of a bare boolean.
 */
export interface ContentProgress {
    phase: ContentProgressPhase;
    /** Entries examined: engine entries for files, session logs for sessions. */
    scanned: number;
    /** Entries stored by this phase: indexed files or indexed session logs. */
    indexed: number;
    /** Known total for this phase; absent when it is not known yet. */
    total?: number;
    /** Most recently examined path, for a live "current item" hint. */
    path?: string;
    /** Epoch milliseconds when this phase started. */
    startedAt: number;
}
export interface ContentState {
    building: boolean;
    files: number;
    sessions: number;
    messages: number;
    truncated: boolean;
    error: string;
    /**
     * Non-fatal problems from the last build/refresh: unreadable session logs,
     * a quarantined database, and so on. Empty when everything was read.
     */
    warnings: string[];
    updatedAt: number;
    /** Live build progress; absent when no build is running. */
    progress?: ContentProgress;
    /** Both numeric content caps are explicitly unlimited. */
    fullIndex?: boolean;
    /** Assistant reasoning/thinking blocks are included in session docs. */
    reasoningIndex?: boolean;
    /** Tool-result text is indexed as its own session documents. */
    toolResultsIndex?: boolean;
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
    /** Index assistant reasoning blocks as part of the message body. */
    includeReasoning?: boolean;
    /** Index `tool/result` text as its own session document (opt-in). */
    includeToolResults?: boolean;
    /**
     * Run content queries in a worker thread so a slow search never blocks the
     * DSH host event loop. Off by default so direct embedders and tests stay
     * single-threaded.
     */
    searchWorker?: boolean;
    /**
     * How long one worker query may run before it is reported as
     * `content-search-timeout`. The query is never re-run on the host thread.
     */
    searchWorkerTimeoutMs?: number;
    /**
     * Test seam: build the search worker instead of spawning the compiled one.
     * Production never sets it.
     */
    searchWorkerFactory?: (workerPath: string) => Worker;
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
    private progress;
    private dbIdentity;
    /** Session id → indexed session log path, for session-scoped content search. */
    private readonly sessionPaths;
    /** Archived session ids, excluded from queries unless asked for. */
    private archivedSessions;
    /** Session id → the session header's cwd, for caller/workspace authorization. */
    private readonly sessionCwds;
    /** A legacy database gained `sources.cwd`; rebuild session docs to fill it. */
    private needsSessionBackfill;
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
    /**
     * Decide what an existing `content.db` is before touching it:
     * - `foreign`: no dsh-locator table at all — refuse to modify it.
     * - `corrupt`: zero bytes, unreadable, or not a SQLite database.
     * - `incompatible`: has our tables but a different schema version/shape.
     * - `ok`: safe to reuse.
     */
    private classifyDatabase;
    /**
     * Move a broken/outdated database aside instead of destroying it. The
     * timestamped name keeps the bytes around for inspection; if the rename
     * fails (another process still holds it on Windows) a fresh file is still
     * created so content search recovers.
     */
    private quarantineDatabase;
    /** Record one non-fatal build warning (deduplicated, bounded). */
    private addWarning;
    private reopenWorker;
    private stopWorker;
    /**
     * Whether a usable search worker exists, creating one when needed.
     * @returns false when the worker cannot be created at all; that is the only
     *          case in which an in-process (sync) query is allowed.
     */
    private ensureWorker;
    /**
     * Resolve one worker reply. A malformed reply is reported as a protocol
     * error; the query is never retried on the host thread.
     */
    private onWorkerMessage;
    private identityOf;
    /**
     * Whether the open handle still points at the file on disk. Another DSH
     * process that shares this `stateDir` can recreate `content.db` during its
     * full rebuild; our handle would then keep reading the unlinked inode until
     * the process exits. Windows reports ino 0 for some filesystems, in which
     * case the check is skipped rather than producing false positives.
     */
    private databaseIsCurrent;
    /** Close the stale handle and reopen/rebuild from the file now on disk. */
    private recoverExternal;
    /** Whether the engine is re-scanning, which can move its dump cursor. */
    private engineRescanning;
    /** Remove all session documents, keeping file documents and their bytes. */
    private clearSessions;
    /** Whether the stored rows already respect the configured file/body caps. */
    private capsSatisfied;
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
    /** Start one build phase; `total` becomes the progress denominator when known. */
    private beginPhase;
    /** Forget live progress once a build finishes, fails or is abandoned. */
    private clearProgress;
    /** Count one examined entry and keep its path for the "current item" hint. */
    private scanEntry;
    /** Count one entry that produced a stored row. */
    private countIndexed;
    /** Total engine entries, used as the files-phase progress denominator. */
    private engineEntries;
    private finish;
    /**
     * Rebuild the session id → session log path map from the persisted sources.
     * Runs after `open()` and after every build/refresh, so session-scoped
     * searches work against an existing database before the first refresh ends.
     */
    private refreshSessionPaths;
    private addDoc;
    /** Body bytes stored for one document key (0 when it is not indexed). */
    private storedBytes;
    private deleteDoc;
    private deletePath;
    private indexFiles;
    private refreshFiles;
    /** Would storing a file of this size overflow the configured body budget? */
    private wouldExceed;
    private readFileDoc;
    private indexSessions;
    private refreshSessions;
    /** Read and decompress one session log completely; no side effects on rows. */
    private readSessionText;
    /** Index one already-decoded session log; the caller owns row replacement. */
    private indexSessionText;
    /**
     * Session logs to consider, newest first. Archived logs are indexed too:
     * they are excluded from queries (see {@link searchDetailed}) unless the
     * caller or the configuration asks for them, so toggling archived search
     * needs no rebuild.
     */
    private sessionCandidates;
    /** Add the additive `sources.cwd` column without bumping the schema version. */
    private ensureSourcesCwdColumn;
    /** The session header's cwd for one indexed session, when known. */
    sessionCwd(sessionId: string): string | undefined;
    /**
     * Session ids the caller may read: its own session plus sessions whose
     * header cwd equals the caller cwd (the same rule as DSH's
     * `tool-session-query` workspace authorization).
     * @param callerCwd - caller session cwd (immutable header value).
     * @param callerSessionId - caller session id.
     * @returns allowed session ids; empty when the caller has no identity.
     */
    authorizedSessionIds(callerCwd: string | undefined, callerSessionId: string | undefined): Set<string>;
    /** The mtime the index stored for one document (file or session message). */
    indexedMtime(kind: 'file' | 'session', path: string, messageId?: string): number | undefined;
    /** The stored (≤8KB) body for one indexed session message. */
    sessionBody(sessionId: string, messageId: string): string | undefined;
    /** The mtime recorded for one session log in `sources`. */
    sessionIndexedMtime(sessionId: string): number | undefined;
    sessionRoots(): string[];
    /**
     * Search file bodies and session messages. With `searchWorker` enabled the
     * query itself runs off the host thread.
     *
     * A worker timeout, crash or malformed reply is a hard error result: the
     * same query is never re-run on the host thread, where a heavy query (for
     * example a whole-word scan) would stall the DSH event loop. Only when the
     * worker cannot be created at all does the query run in-process, and that
     * fallback is budgeted (bounded counts).
     *
     * The two-argument form returns the hit array (legacy callers). The
     * three-argument form returns hits plus count, warnings and an error code,
     * and understands the advanced match options.
     * @param query - words or a phrase to find.
     * @param limit - maximum hits.
     * @param options - match mode, case/whole-word flags, session scope, count mode.
     * @returns matching documents ordered by relevance.
     */
    search(query: string, limit: number): Promise<ContentHit[]>;
    search(query: string, limit: number, options: ContentSearchOptions): Promise<ContentSearchResult>;
    private searchDetailed;
    /** Run one query on the worker; timeout/protocol errors are final results. */
    private searchInWorker;
    /** Map a request's sessionId onto the indexed session log path. */
    private resolveSession;
    /**
     * In-process query path. When `degraded` is set (worker creation failed) the
     * options are tightened so this rare path cannot spend an unbounded amount of
     * host-thread time counting matches.
     */
    private searchSync;
}
//# sourceMappingURL=content.d.ts.map