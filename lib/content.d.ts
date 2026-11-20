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
import { type CodeSymbol } from './symbols.ts';
import type { LocatorRuntime } from './runtime.ts';
export type { CodeSymbol, SymbolKind } from './symbols.ts';
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
    /** Citable evidence ref for this hit (session URI or ref://file). */
    ref?: string;
    /**
     * Extracted document format (`pdf`, `docx`, `xlsx`, `pptx`, `epub`) for file
     * hits whose body came from a document. Plain text files keep it absent so
     * existing consumers see no new field.
     */
    format?: string;
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
/** Distinct evidence-ref identities stored in the content index, grouped by kind. */
export interface RefKindCount {
    total: number;
    byKind: Record<string, number>;
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
    /** Distinct stored evidence refs grouped by kind; absent before the database opens. */
    refs?: RefKindCount;
}
/** Body-budget coverage of the file index, for `ContentIndex.diagnostics`. */
export interface ContentCoverage {
    /** File documents currently stored. */
    indexedFiles: number;
    /** Indexable file entries seen by the last full sweep; null before one ran. */
    candidateFiles: number | null;
    /** indexedFiles / candidateFiles, 0..1; null while candidateFiles is unknown. */
    ratio: number | null;
    /** Stored body bytes. */
    bodyBytes: number;
    /** Configured body budget; 0 means unlimited. */
    budgetBytes: number;
    /** Configured document-count budget; 0 means unlimited. */
    fileBudget: number;
    /** The last build dropped documents because of a budget or cap. */
    truncated: boolean;
    /** Documents evicted to make room since this instance opened the database. */
    evictedDocs: number;
    sessions: number;
    messages: number;
}
/**
 * Cheap, read-only observability payload for `locator_status` and the HTTP
 * status route. Kept out of {@link ContentState} so the tool output schemas
 * that predate it (and validate `status()` strictly) keep passing.
 */
export interface ContentDiagnostics {
    coverage: ContentCoverage;
    dbBytes: number;
    walBytes: number;
    /** Live database bytes: (page_count - freelist_count) * page_size (P0-5). */
    dbLiveBytes: number;
    /** Reclaimable free-list bytes: freelist_count * page_size. */
    freelistBytes: number;
    /** Configured content.db budget; 0 means unlimited. Compared against live bytes. */
    dbBudgetBytes: number;
    dbOverBudget: boolean;
    /** Approximate number of FTS5 segments left in the trigram index. */
    ftsSegments: number;
    /** Epoch ms of the last successful FTS optimize, 0 when never run. */
    ftsOptimizedAt: number;
    /** FTS optimize failures recorded since this database was created. */
    optimizeWarnings: number;
    lastRefreshMs: number;
    /** Wall-clock ms of the last incremental (live) refresh; 0 before one ran. */
    liveRefreshMsLast: number;
    lastRefreshMode: 'full' | 'incremental' | 'fast' | 'deferred' | '';
    engineGeneration: number | null;
    symbolsPerFile: number;
    /** Document extraction runs in a worker thread (false: in-process fallback). */
    extractWorker: boolean;
    /** Persisted non-fatal warning counters (0.20.2 P1-8); absent when empty. */
    warningCounts?: Record<string, number>;
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
     * Extract bodies from PDF/Office/EPUB documents too (default true). Off keeps
     * only the plain-text path, for embedders that want the old behavior.
     */
    extractDocuments?: boolean;
    /** Largest document handed to the extractor; 0 means unlimited (default 20 MiB). */
    extractMaxBytes?: number;
    /**
     * Attach the extracted document format to file hits (default false). Only
     * enable this once every tool that forwards content hits declares a `format`
     * field: the host rejects undeclared tool-output properties. `docFormat()`
     * and `formatsFor()` expose the same data without touching hits.
     */
    attachHitFormats?: boolean;
    /** Index code symbols for the outline/symbol/repo-map data layer (default true). */
    indexSymbols?: boolean;
    /** Largest code file considered for symbol extraction (default 512 KiB). */
    symbolMaxBytes?: number;
    /**
     * Optional notIndexed hook: return false to skip a path before any bytes are
     * read (the plugin wires this to the Scope layer). Applies to documents,
     * text bodies and symbol extraction, and is re-checked on backfills.
     */
    isIndexable?: (path: string) => boolean;
    /**
     * Optional OCR fallback for a PDF with no extractable text layer (a scan).
     * Returns the recognized text, or undefined to leave the document out. The
     * plugin wires this to `runOcrCommand` when the operator configures one.
     */
    ocr?: (path: string, format: string) => Promise<string | undefined>;
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
    /** Number of parallel content-query workers (default 2; at most 4). */
    searchWorkers?: number;
    /**
     * Evict the oldest documents when the body budget is full instead of
     * freezing the index (default false for direct embedders; the plugin turns
     * it on from `contentEvict`).
     */
    evict?: boolean;
    /** Hard budget for content.db in bytes; 0 means unlimited. */
    maxDbBytes?: number;
    /** Symbols stored per code file (default 500). */
    symbolsPerFile?: number;
    /** Let the query layer skip bm25 rank ordering for wide result sets. */
    rankAdaptive?: boolean;
    /** Content search result cache entries; 0 disables caching. */
    queryCacheSize?: number;
    /** Content search result cache TTL in ms. */
    queryCacheTtlMs?: number;
    /** Largest session log read for indexing; larger logs index their head only. */
    sessionMaxBytes?: number;
    /** Throttle builds when the machine is loaded or on battery. */
    adaptiveRefresh?: boolean;
    /** Deadline for one extraction in the extractor worker. */
    extractTimeoutMs?: number;
    /** Override the periodic full file-index sweep interval (tests). */
    fullSweepIntervalMs?: number;
    /**
     * Parallel file read/decode/symbol-extraction workers during a full build
     * (default 4, clamped to 1..8). Body writes always stay on the main thread:
     * the pool only prefetches rows, which keeps SQLite single-writer safe.
     */
    parallelPrefetch?: number;
    /**
     * Read the first 4 KiB of extensionless files and index them when they look
     * like text (default false for embedders; the plugin turns it on). Binary
     * samples and generated .map/.tsbuildinfo/.out files are always skipped.
     */
    textSniff?: boolean;
    /**
     * Allow the query layer to answer 2-code-point queries with a bounded LIKE
     * fallback; forwarded to content-search.ts (default false = reject as before).
     */
    shortQueryFallback?: boolean;
    /**
     * Run the post-build FTS optimize as an idle task after the build reports
     * done instead of extending the build (default false = inline, chunked).
     */
    optimizeInIdle?: boolean;
}
/** One symbol search hit from the additive `symbols` table. */
export interface SymbolMatch {
    path: string;
    /** 1-based declaration line. */
    line: number;
    kind: string;
    name: string;
    language: string;
    /** Enclosing type/namespace, when the extractor found one. */
    scope?: string;
}
/** One file of a {@link ContentIndex.repoMap} result. */
export interface RepoMapFile {
    path: string;
    symbols: CodeSymbol[];
}
export declare class ContentIndex {
    private readonly rt;
    private readonly options;
    private db;
    private readonly state;
    private generation;
    private totalBytes;
    private sliceDeadline;
    /** Next event-loop yield deadline for the refresh path (30-50 ms slices). */
    private refreshSliceDeadline;
    /** Search workers; each owns its own read-only database connection. */
    private readonly workerPool;
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
    /** A database predating the additive `symbols` table needs a one-time fill. */
    private needsSymbolBackfill;
    /** Queued write operations since the last batch commit. */
    private inBatch;
    private batchOps;
    /** A full build created the symbols table without its indexes; create them at the end. */
    private symbolIndexesPending;
    /** Fresh full build: symbols indexes are created after the insert pass, so per-file deletes must wait. */
    private symbolsBulk;
    private readonly symbolsBulkPurge;
    /** Persisted counters kept in content_meta so caps checks stay O(1). */
    private fileDocs;
    private oversizedDocs;
    private countersLoaded;
    /** Indexable file entries seen by the last full sweep (coverage denominator). */
    private candidateFiles;
    /** Documents evicted from the body budget since this instance opened. */
    private evictedDocs;
    private dbBytes;
    private walBytes;
    /** Live database bytes and free-list bytes, cached by measureDatabase(). */
    private dbLiveBytes;
    private freelistBytes;
    /** Approximate FTS5 segment count, cached after each build/optimize. */
    private ftsSegments;
    private ftsOptimizedAt;
    /** Persisted FTS optimize failure count (0.20.2 P1-8). */
    private optimizeWarnings;
    private lastRefreshMs;
    /** Wall-clock ms of the last incremental refresh (P0-3 observability). */
    private liveRefreshMsLast;
    private lastRefreshMode;
    /** Persisted non-fatal warning counters, keyed by warning code (P1-8). */
    private readonly warningCounts;
    /** Extensionless paths a sniff rejected at this mtime; avoids re-reading them. */
    private readonly sniffRejects;
    /** Start of the current incremental refresh, for its wall-clock budget. */
    private refreshStartedAt;
    /** The current incremental refresh hit its budget and deferred the rest. */
    private refreshBudgetHit;
    /** An idle FTS optimize is scheduled/running (never two at once). */
    private idleOptimizeRunning;
    /** The FTS index still needs its idle merge; retried after the next pass. */
    private idleOptimizeNeeded;
    /** File-index generation observed while walking the last dump. */
    private engineGeneration;
    /** Wall clock at the start of the current build. */
    private buildStartedAt;
    /** Cached adaptive-throttle verdict (sysfs reads are not free). */
    private machineSample;
    /** Single reusable extractor worker plus its pending requests. */
    private extractWorker;
    private extractSeq;
    private readonly extractPending;
    /** Decoded document bodies keyed by file sha256, bounded by characters. */
    private readonly extractCache;
    private extractCacheChars;
    /** Lazily created query-result cache (see content-cache.ts). */
    private searchCache;
    constructor(rt: LocatorRuntime, options: ContentOptions);
    status(): ContentState;
    /**
     * Cheap observability payload for status routes and tools: budget coverage,
     * database size and generation state. Synchronous and O(1) apart from two
     * stats, and safe to call while a build is running.
     */
    diagnostics(): ContentDiagnostics;
    /** Current on-disk content.db size (an open handle keeps counting its file). */
    private dbSizeBytes;
    /**
     * Live page bytes of the open database (P0-5): page_count - freelist_count
     * times page size. Freed pages from FTS merges stay in the file until a
     * VACUUM/incremental-vacuum, so the file size is not the storage cost.
     */
    private pageUsage;
    /** Refresh the cached database, WAL, live-page and segment measurements. */
    private measureDatabase;
    /**
     * Approximate FTS5 segment count: each segment b-tree page is one row in the
     * docs_data shadow table whose rowid encodes the segment id in its high
     * bits (page number in the low 32). Counting distinct high words is version
     * stable across the SQLite builds Node ships and needs no structure-record
     * parsing. The exact count is a full scan of a table that can be over 2 GB,
     * so it is only measured for a small corpus; a large one reports the known
     * result of a converged merge (1) or 0 = "not measured yet". Diagnostics
     * only, never a correctness input.
     */
    private measureFtsSegments;
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
     * Load the O(1) caps counters persisted in content_meta. A database written
     * before they existed (or whose configured maxFileBytes changed) is recounted
     * once with a bounded scan; steady-state refreshes never scan the FTS table.
     */
    private loadPersistedCounters;
    /** Persist the counters that make the caps check O(1) on the next boot. */
    private savePersistedCounters;
    /**
     * Delete quarantined database archives that are old (or exceed the retention
     * count) so a crash-corruption loop cannot fill the disk. Only files this
     * plugin created with its own quarantine naming are removed.
     */
    private cleanupCorruptArchives;
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
    /**
     * Record one non-fatal build warning (deduplicated in the live state, but
     * every occurrence is counted and persisted so diagnostics survive a restart
     * even though the log itself is in memory only; 0.20.2 P1-8).
     */
    private addWarning;
    /** Terminate every search worker and fail the requests waiting on them. */
    private stopWorker;
    /** Effective search worker count: default 2, clamped to 1..4. */
    private searchWorkerCount;
    /**
     * Pick the least busy worker, creating workers up to the configured pool size.
     * @returns null when workers are disabled or cannot be spawned at all; that is
     *          the only case in which an in-process query is allowed.
     */
    private acquireWorker;
    /**
     * Create one worker connection. Real workers get a shared cancellation
     * buffer: a message alone cannot interrupt a synchronous SQLite call, but the
     * worker polls the buffer between scan steps (impl-content-query protocol).
     */
    private createWorkerSlot;
    /** Remove one dead/timed-out worker and fail everything waiting on it. */
    private dropWorkerSlot;
    /**
     * Resolve one worker reply. A malformed reply is reported as a protocol
     * error; the query is never retried on the host thread.
     */
    private onWorkerReply;
    /** Ask one worker to abandon a request cooperatively. */
    private cancelWorkerRequest;
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
    /**
     * Whether the stored rows already respect the configured file/body caps.
     * Steady-state checks read the persisted counters (O(1)); only a database
     * written before the counters existed pays one scan.
     */
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
    /**
     * Whether the machine looks loaded enough that a background content build
     * should slow down: load per CPU, I/O or CPU pressure, or running on battery.
     * Sampled at most once every five seconds; any read failure means "not busy".
     */
    private machineBusy;
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
    /**
     * FTS5 incremental merge ("FTS optimize", 0.20.2 P0-2). 0.20.1 used the
     * invalid syntax INSERT INTO docs(docs) VALUES('merge=4,32'), swallowed the
     * error and therefore never wrote fts_optimized_at. The supported form is
     * INSERT INTO docs(docs, rank) VALUES('merge', N), where |N| bounds the pages
     * merged per statement. The first call must pass a negative N so the merge
     * sees one level; later calls pass a positive N so FTS5 runs that merge to
     * completion. A total_changes() delta below 2 means the call did no work
     * (documented FTS5 convergence test).
     * @param generation - build generation to abort an idle merge after a rebuild.
     * @param idle - the merge runs outside a build and must yield to it.
     * @returns whether the index converged; failures leave a warning, never throw.
     */
    private optimizeFts;
    /** Yield between bounded merge rounds (idle task, host stays responsive). */
    private yieldForMerge;
    /** Schedule the post-build FTS merge as an idle task (P0-2 optimizeInIdle). */
    private scheduleIdleOptimize;
    private runIdleOptimize;
    /** Wall-clock budget check for one incremental refresh (P0-3). */
    private refreshBudgetExceeded;
    /**
     * Yield every ~40 ms (or every 64 documents) while refreshing, instead of
     * every ~8 ms as during a build: a live refresh is allowed to take a little
     * longer per slice as long as the host is never blocked for a whole batch.
     */
    private refreshBreathe;
    /** Effective prefetch parallelism: default 4, clamped to 1..8 (P1-9). */
    private parallelPrefetchCount;
    /**
     * Release build-only buffers and, when the process was started with
     * --expose-gc, hint the collector. Node has no FreeOSMemory(); the Go engine
     * implements that for its own heap, this is the host-side equivalent.
     */
    private releaseBuildMemory;
    /** Stop the extractor worker and fail its pending requests. */
    private stopExtractWorker;
    /** Drop cached query results after the database changed. */
    private invalidateSearchCache;
    private finish;
    /**
     * Rebuild the session id → session log path map from the persisted sources.
     * Runs after `open()` and after every build/refresh, so session-scoped
     * searches work against an existing database before the first refresh ends.
     */
    private refreshSessionPaths;
    /**
     * Insert one document body. A fresh full build already planned the retention
     * set, so the per-row storedBytes/deleteDoc existence lookups and the
     * eviction path are skipped entirely (0.20.2 P0-1).
     */
    private addDoc;
    /**
     * Evict the oldest documents until a new body fits the budget, leaving a
     * small headroom so the next document does not immediately evict again.
     * Victims are removed in shards with a scheduler yield so one saturated
     * refresh cannot monopolise the event loop (0.20.2 P0-3); their symbol rows
     * are deleted in one batched DELETE per hundred paths (P0-4).
     * Returns false when eviction is disabled or even an empty table cannot fit
     * the incoming body; the caller then reports truncation.
     */
    private evictForBudget;
    /** Delete one stored document row and adjust every derived counter. */
    private removeDocRow;
    /** Body bytes stored for one document key (0 when it is not indexed). */
    private storedBytes;
    private deleteDoc;
    private deletePath;
    /**
     * Dump one page of the engine index, forwarding the generation/modification
     * filters an engine that supports them understands. Runtime versions without
     * the optional third parameter are called with two arguments only.
     */
    private dumpPage;
    /** Remember the lowest engine generation observed across dump pages. */
    private observeGeneration;
    /** Whether a dump page proves the engine supports generation/modification filters. */
    private generationSupported;
    /** Stored mtime for one file document key, undefined when not indexed. */
    private storedMtime;
    /**
     * Index every file document from scratch (a full content rebuild).
     *
     * Two phases over the same dump (0.20.2 P0-1): the first collection pass
     * stores metadata only, then the retention set is planned newest-first
     * within the body budget and only those files are read. The old single pass
     * read every candidate and evicted ~38 k of them afterwards, which cost the
     * read/decoded time plus (before the mtime index) the victim queries. A final
     * fill pass spends any budget the conservative size estimate left unused.
     */
    private indexFiles;
    /**
     * Drop extensionless candidates whose first 4 KiB are not text. The full
     * build reads those bytes anyway once the file is selected; doing it up front
     * keeps the coverage denominator and the byte plan accurate without reading
     * any other candidate early (0.20.2 P1-7).
     */
    private sniffExtensionlessCandidates;
    /** Plan the newest-first retention set for a fresh file build (P0-1). */
    private planFullBuild;
    /**
     * Upper bound on the body length one candidate can add. Text bodies are at
     * most min(byte size, maxFileBytes) UTF-16 code units; extracted document
     * text is capped at maxFileBytes and may exceed the compressed file size.
     */
    private estimateCandidateBytes;
    /**
     * Read a batch of candidates through a bounded prefetch pool and insert the
     * decoded rows on the main thread (SQLite stays single-writer). Bodies are
     * decoded in parallel, but every DB write happens here in candidate order.
     */
    private readAndStoreCandidates;
    /**
     * Refresh the file index. A stored engine generation lets an unchanged
     * refresh end without dumping the whole index (P0-7); otherwise a periodic
     * full sweep catches deletions and renames, which a generation diff cannot.
     */
    private refreshFiles;
    /**
     * Index only the entries the engine reports as modified (P0-7). Deletions and
     * renames are intentionally not handled here: the periodic full sweep owns
     * them.
     */
    private incrementalFileRefresh;
    /**
     * Compare the whole engine index against docs_meta: re-read changed files and
     * remove documents whose files disappeared. Records the generation and sweep
     * timestamps the fast path later relies on.
     *
     * 0.20.2: changed files are prefetched in parallel and written in order, the
     * pass honours the incremental wall-clock budget (a partial walk never deletes
     * rows or advances the generation markers), and deletions remove their symbol
     * rows with one batched path IN delete instead of one scan per file.
     */
    private fullFileSweep;
    /** Would storing a file of this size overflow the configured body budget? */
    private wouldExceed;
    private readFileDoc;
    /** Extract one document body; its format is recorded additively in docs_meta. */
    private readDocumentDoc;
    /**
     * Extract one document body, in the extractor worker when it exists and
     * in-process otherwise (direct embedders and test runs).
     */
    private extractDocumentBody;
    /** In-process extraction, used when no compiled worker is available. */
    private extractInProcess;
    /**
     * Lazily create the extractor worker. It is capped at 512 MB old-gen heap,
     * matching the resource envelope the extraction path is designed for.
     * @returns the worker, or null when it cannot be created.
     */
    private ensureExtractWorker;
    /** Resolve one extractor reply; malformed replies count as failed extraction. */
    private onExtractMessage;
    /** Run one extraction on the worker with a hard deadline. */
    private extractInWorker;
    /** Return the cached extraction for one hash and refresh its LRU position. */
    private touchExtractCache;
    /** Store one extraction answer under its content hash, bounded LRU. */
    private storeExtractCache;
    /**
     * Whether one dump entry belongs in this build. Document extraction has its
     * own byte cap: a normal PDF or deck is larger than the text-file limit.
     * Extensionless files pass when their name is a known text name (LICENSE,
     * Dockerfile, dotfiles) or, with the textSniff option, when the first bytes
     * still have to prove it (readFileDoc does the sniff; 0.20.2 P1-7).
     */
    private entryIsIndexable;
    private indexSessions;
    private refreshSessions;
    /** Load every indexed session log's source row (path, mtime, tail state). */
    private readSessionSources;
    /**
     * Refresh one session log: append only the new Zstandard frames when the log
     * grew and the tail starts with a frame magic (P1 streaming/tail refresh),
     * otherwise re-read the whole log (or its head when it exceeds the cap).
     * @returns true when rows were written and the caller should count progress.
     */
    private refreshSessionFile;
    /**
     * Decode and index only the appended tail of one session log. Returns null
     * when the tail does not start with a Zstandard frame (rewritten file) or the
     * first decoded line is not a fresh JSONL document (partial line), in which
     * case the caller re-reads the whole log.
     */
    private readSessionDelta;
    /** Persist one session log's source row, including its incremental tail state. */
    private writeSessionSource;
    /**
     * Index decoded session lines in order. In append mode existing rows stay and
     * only new messages/refs are written.
     * @returns success plus the tail state the caller persists in sources.
     */
    private indexSessionLines;
    /**
     * Open one region of a session log and decode its complete Zstandard frames
     * lazily, one frame at a time, so a 45 MB plaintext log never has to exist as
     * a single string (P1 streaming decode).
     * @returns the line generator plus the compressed offset after the last
     *          complete frame, or null when the region is unreadable/corrupt.
     */
    private openSessionDecode;
    /**
     * Session logs to consider, newest first. Archived logs are indexed too:
     * they are excluded from queries (see {@link searchDetailed}) unless the
     * caller or the configuration asks for them, so toggling archived search
     * needs no rebuild.
     */
    private sessionCandidates;
    /** Create the additive `refs`/`refs_meta` tables; true when they were missing. */
    private ensureRefsTables;
    /** Replace one session log's ref occurrences after re-reading it. */
    private replaceSessionRefs;
    /** Add the additive `sources.cwd` column without bumping the schema version. */
    private ensureSourcesCwdColumn;
    /** Add the additive docs_meta.format column without bumping the schema version. */
    private ensureDocsMetaFormatColumn;
    /** Create the additive symbols table; true when it was missing. */
    private ensureSymbolsTables;
    /**
     * Create the symbols indexes after a full insert pass (or when an existing
     * database is missing them, e.g. a build interrupted before this step).
     */
    private ensureSymbolIndexes;
    /**
     * Add the additive session-log columns used by streaming/tail refreshes
     * (sources.byte_len, last_line, title, capped) without bumping the schema
     * version. Rows from an older database keep NULL and are re-read in full.
     */
    private ensureSessionColumns;
    /** Open a build transaction; nested calls are ignored. */
    private beginBatch;
    /** Count one queued write; commit and start a new transaction at the limit. */
    private batchTick;
    /** Commit the open batch (no-op when none is open). */
    private commitBatch;
    /** Roll back an aborted build so no partial transaction survives it. */
    private rollbackBatch;
    /** Effective symbols stored per file; 0/absent means the 500 default. */
    private symbolsPerFile;
    /** Full-sweep interval for the generation fast path. */
    private fullSweepIntervalMs;
    /** Effective session-log read cap; 0 means unlimited. */
    private sessionMaxBytes;
    /** Effective extraction worker deadline. */
    private extractTimeoutMs;
    /** Document extraction is on unless an embedder explicitly opted out. */
    private extractDocumentsEnabled;
    /** Effective document byte cap; 0/absent means the 20 MiB default. */
    private documentMaxBytes;
    /** Symbol indexing is on unless an embedder explicitly opted out. */
    private indexSymbolsEnabled;
    /** Effective symbol source-file byte cap; 0/absent means the 512 KiB default. */
    private symbolMaxBytes;
    /** Symbols for one code file, or undefined when it is not symbol-indexed. */
    private collectFileSymbols;
    /** Whether the compiled extractor worker exists next to this module. */
    private extractWorkerAvailable;
    /** Extract and store symbols for one file while its text is in hand. */
    private writeFileSymbols;
    /** Replace every stored symbol of one file (additive table; failures ignored). */
    private writeSymbols;
    /** Remove every stored symbol of one deleted file. */
    private deleteSymbols;
    /**
     * Remove the symbol rows of many deleted files with a bounded path IN list
     * (0.20.2 P0-4). One DELETE per ~131 files instead of one full-scan DELETE
     * per file: the old per-file loop dominated the eviction path of a
     * saturated build.
     */
    private deleteSymbolsBulk;
    /** Drop every stored symbol after symbol indexing is turned off. */
    private clearSymbols;
    /**
     * Apply the symbol-index toggle and run the one-time fill when this database
     * predates the additive table (or symbols were off when it was last built).
     * Called on every incremental path, including the branches that end early,
     * so a finish() can never record symbols=1 without the fill having run.
     */
    private syncSymbols;
    /**
     * One-time fill of the symbol table from the bodies already stored in the
     * database: a database that predates the additive table (or one whose symbol
     * rules changed) never has to walk the disk again. Bodies are paged so a
     * 1 GB corpus is never loaded at once.
     */
    private backfillSymbols;
    /**
     * Every stored spelling one indexed path may have: exactly as given, its
     * canonical real path, and the configured root's raw spelling. The engine
     * indexes files in the spelling of the configured root, which is not always
     * the real path (macOS `/var` → `/private/var`, a Windows short name, an
     * operator-configured symlink), while tools authorize and report canonical
     * paths. Symbols and docs_meta lookups accept any spelling, so a caller can
     * pass either one and databases written before this resolution stay readable.
     */
    private pathSpellings;
    /** A `column IN (…)` fragment and its values covering every spelling of one path. */
    private pathMatch;
    /**
     * Indexed document format for one file (pdf, docx, ...); undefined for plain
     * text, unknown paths and databases built before extraction existed.
     */
    docFormat(path: string): string | undefined;
    /**
     * Every symbol stored for one path, in line order.
     * @param path - absolute file path as stored by the file index, or any other
     *   spelling of it (canonical real path / configured-root path).
     * @returns symbols for the file; empty when it was not symbol-indexed.
     */
    outline(path: string): CodeSymbol[];
    /**
     * Find symbols by name. Exact matches rank before prefix matches, then
     * substring matches.
     * @param name - symbol name or fragment.
     * @param limit - maximum rows (default 50, at most 200).
     * @returns path/line/kind/name rows across indexed files.
     */
    findSymbols(name: string, limit?: number): SymbolMatch[];
    /**
     * Compact repository map for agent context: files ranked by symbol count,
     * cut to a token budget that is estimated as characters / 4. A file is
     * included whole; a file that does not fit is skipped so smaller lower-ranked
     * files can still make it.
     * @param roots - directory prefixes to include; empty means every indexed file.
     * @param tokenBudget - approximate token budget; non-positive returns nothing.
     * @returns included files with their symbols, most structural first.
     */
    repoMap(roots: readonly string[], tokenBudget: number): RepoMapFile[];
    /**
     * Every stored spelling one requested root may have: exactly as given and its
     * canonical real path (a symlinked temp dir or Windows short name differs).
     */
    private rootSpellings;
    /**
     * Symbol count per file path, restricted to the requested roots, ranked in
     * SQL and cut to the repo-map candidate limit. Runs as one index-only
     * aggregate per root spelling instead of loading every symbol row.
     */
    private symbolPathCounts;
    /**
     * Stored mtimes for a batch of file paths (0.20.2 P1-1). Combined search used
     * one SQL statement per hit to label content freshness; this answers the
     * whole page with chunked read-only path IN lookups. Path spelling follows
     * indexedMtime/pathMatch, so a canonical caller path matches a row stored
     * with the configured-root spelling.
     * @param paths - candidate file paths.
     * @returns caller path -> stored mtime (ms); absent paths mean "not indexed".
     */
    mtimesForPaths(paths: readonly string[]): Map<string, number>;
    /**
     * Stored document formats for the given file paths (only extracted
     * documents have one). Unlike hit enrichment this is safe to call before a
     * tool schema declares the field.
     * @param paths - candidate file paths.
     * @returns path to format map; plain text and unknown paths are absent.
     */
    formatsFor(paths: readonly string[]): Map<string, string>;
    /** Attach formats only when the caller opted in (tool schemas must declare it). */
    private enrichHitFormats;
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
    /**
     * The mtime the index stored for one document (file or session message).
     * File paths are matched under every spelling of the path, so a caller that
     * authorized a canonical path still finds a row stored with the
     * configured-root spelling.
     */
    indexedMtime(kind: 'file' | 'session', path: string, messageId?: string): number | undefined;
    /** The stored (≤8KB) body for one indexed session message. */
    sessionBody(sessionId: string, messageId: string): string | undefined;
    /** One stored evidence-ref occurrence. */
    refsForMessage(sessionId: string, messageId: string): StoredRefRow[];
    /** All authorized-agnostic occurrences of one ref key (bounded). */
    refsFor(refKey: string, limit?: number): StoredRefRow[];
    /** Occurrence counts for the status tool. */
    refCount(): {
        refs: number;
        occurrences: number;
    };
    /**
     * Distinct evidence refs grouped by kind, for `locator_status`. One GROUP BY
     * keeps the status call cheap; a database without the additive tables reports
     * zeros instead of failing.
     * @returns total distinct refs plus one count per ref kind.
     */
    refsByKind(): RefKindCount;
    /**
     * Persist the lazy "missing" marker for one ref across all its occurrences.
     * Only the first miss writes; later resolves read the stored meta instead of
     * re-statting the spill file / attachment store.
     * @param refKey - complete ref string of the missing target.
     * @returns true when this call wrote a new marker, false when it was cached.
     */
    markRefMissing(refKey: string): boolean;
    /**
     * Merge one JSON patch into every occurrence's refs.meta (bounded, additive).
     * Used by URL-ref freshness (ETag / Last-Modified / body sha256) so a later
     * resolve can issue a conditional request. A patch field overwrites a stale
     * field of the same name; the lazy missing marker is always preserved. A
     * patch that cannot fit the bounded column is skipped for that occurrence
     * instead of being truncated into invalid JSON.
     * @param refKey - complete ref string whose occurrences are updated.
     * @param patch - JSON-safe fields to store (nested objects are allowed).
     * @returns true when at least one occurrence was updated.
     */
    setRefMeta(refKey: string, patch: Record<string, unknown>): boolean;
    /**
     * Stored session-event refs for one page of indexed message ids, used by
     * `locator_find` to attach the event seq/ref to session hits.
     * @param sessionId - owning session.
     * @param messageIds - message ids from the current hit page.
     * @returns message id → { seq, ref }; ids without a stored event are absent.
     */
    sessionEventRefs(sessionId: string, messageIds: readonly string[]): Map<string, {
        seq: number;
        ref: string;
    }>;
    /**
     * Read one event by sequence from the local session log, for refs resolution.
     * The header is the first physical line, so event `seq` is line `seq + 1`.
     * @param sessionId - session id.
     * @param seq - event sequence.
     * @param maxChars - cap on the returned JSON line.
     * @returns the raw event line, or undefined when the session/log is unavailable.
     */
    sessionEventBody(sessionId: string, seq: number, maxChars?: number): Promise<string | undefined>;
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
    search(query: string, limit: number, options: ContentSearchOptions, searchOptions?: {
        signal?: AbortSignal;
    }): Promise<ContentSearchResult>;
    private searchDetailed;
    /** Run one query in the worker pool, or in-process when workers are absent. */
    private runSearch;
    /**
     * Run one query on a pooled worker. A timeout terminates that worker; an
     * abort rejects with a DOMException AbortError after asking the worker to
     * stop cooperatively.
     */
    private searchOnWorker;
    /** Lazily create the query cache (content-cache.ts). */
    private ensureSearchCache;
    /** Map a request's sessionId onto the indexed session log path. */
    private resolveSession;
    /**
     * In-process query path. When `degraded` is set (worker creation failed) the
     * options are tightened so this rare path cannot spend an unbounded amount of
     * host-thread time counting matches.
     */
    private searchSync;
}
/**
 * Decide whether background content work should throttle. Pure so the policy
 * can be tested without touching /proc or /sys.
 * @param input - sampled loadavg, CPU count, PSI files and battery status.
 * @returns the verdict plus the reason codes that triggered it.
 */
export declare function adaptivePressure(input: {
    loadavg?: string | undefined;
    cpuCount: number;
    ioPressure?: string | undefined;
    cpuPressure?: string | undefined;
    batteryStatus?: string | undefined;
}): {
    busy: boolean;
    reasons: string[];
};
/** One evidence ref occurrence extracted from a session log event. */
export interface EvidenceRefRow {
    refKey: string;
    kind: 'url' | 'session-event' | 'spill' | 'attachment';
    target: string;
    sha256: string | null;
    sessionId: string;
    messageId: string;
    seq: number | null;
    origin: 'web_search' | 'web_fetch' | 'spill' | 'attachment' | 'session';
    title: string | null;
    bytes: number | null;
    meta: string | null;
}
/** One persisted evidence-ref occurrence as stored in `refs`. */
export interface StoredRefRow {
    refKey: string;
    kind: 'url' | 'session-event' | 'spill' | 'attachment';
    target: string;
    sha256: string | null;
    sessionId: string;
    messageId: string;
    seq: number | null;
    origin: string;
    title: string | null;
    bytes: number | null;
    meta: string | null;
    logMtime: number | null;
    indexedAt: number;
}
/**
 * Extract the non-session-event evidence refs carried by one session log event:
 * `web_search`/`web_fetch` URLs (from `data.meta`), spill locators (from the
 * tool-result text notice) and attachment digests (from user message blocks).
 * Session-event refs are added by the caller for events that became documents.
 * @param event - parsed session event line.
 * @param sessionId - owning session.
 * @param messageId - message/call id the occurrence belongs to.
 * @param seq - event sequence (the line ordinal minus the header line).
 * @returns ref rows ready for `refs` (deduplication happens at insert time).
 */
export declare function extractEvidenceRefs(event: {
    type?: string;
    data?: Record<string, unknown>;
}, sessionId: string, messageId: string, seq: number): EvidenceRefRow[];
//# sourceMappingURL=content.d.ts.map