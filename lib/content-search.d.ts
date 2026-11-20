/**
 * Content FTS5 query engine: normal substring search, Notepad++-style extended
 * escaping, case-sensitive GLOB matching and whole-word post-filtering, with
 * exact or bounded counts.
 *
 * Shared by the host thread, the search worker and the combined panel search.
 * The page path is deliberately two-phase: rank the rowids first, then read the
 * few bodies and build the snippet in JS. Putting `snippet()` in the same
 * `ORDER BY rank` statement made a SQLite sorter evaluate it for every match
 * (measured 2.7 s for "the" on a 1 GB corpus; 60 ms with this split).
 *
 * Every unbounded-looking path has an explicit budget: queries shorter than a
 * trigram are rejected instead of degrading into a full-table LIKE/GLOB scan,
 * and the whole-word post-filter stops after a fixed number of rows, body bytes
 * or milliseconds and reports a bounded count.
 *
 * 0.20.0 adds three policies on top of that:
 * - adaptive rank (P0-6): one bounded count of the raw match set decides whether
 *   ORDER BY rank is affordable; wide sets page in rowid order and a cheap JS
 *   sort orders the fetched page. Whole-word queries never rank.
 * - split filter SQL (P1-3): the page keeps rowid-subquery filters (narrow
 *   docs_meta sets turn into FTS rowid probes) while counts use docs-column
 *   filters and a LIMIT, plus a kind-separated fast path for workspace scope.
 * - a degraded profile (worker-driven) that forces bounded counts and no rank
 *   after a query runs past its deadline.
 * @module dsh-locator/content-search
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ContentHit } from './content.ts';
/** How the query text is interpreted. */
export type ContentMatchMode = 'normal' | 'extended' | 'regex';
/** How much work the caller wants the count to spend. */
export type ContentCountMode = 'exact' | 'bounded' | 'none';
/** A match count, with its confidence. `bounded` means "at least value". */
export interface ContentCount {
    value: number;
    kind: 'exact' | 'bounded' | 'unknown';
    limit?: number;
}
/**
 * Hard budget for the whole-word post-filter, which has to read candidate
 * bodies in JS. Exceeding any cap stops the scan and keeps the hits found so
 * far; the count then becomes bounded. Exposed mainly so embedders and tests
 * can shrink the caps.
 */
export interface ContentScanBudget {
    maxRows?: number;
    maxBytes?: number;
    maxMs?: number;
}
/** Options accepted by {@link searchContent} and the content search worker. */
export interface ContentSearchOptions {
    matchMode?: ContentMatchMode;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    /** Resolved by ContentIndex from the request's sessionId. */
    sessionId?: string;
    /** Session log path; set by ContentIndex after resolving sessionId. */
    sessionPath?: string | null;
    count?: ContentCountMode;
    countLimit?: number;
    /** Skip this many ranked matches before the page (panel load-more). */
    offset?: number;
    /**
     * Keep only file documents whose stored path lives under this directory
     * prefix (the locator_find `scope: workspace` filter). Combined with
     * `sessionPath` the two filters are composed by document kind: session
     * documents come from that session log, file documents from that prefix.
     */
    pathPrefix?: string | null;
    /**
     * What to do when `sessionId` names a session that is not indexed yet:
     * return nothing (default, used by the panel's session scope) or keep
     * searching file documents without the session filter (`files-only`, used by
     * `locator_find` workspace scope so file hits stay searchable before the
     * active session is indexed).
     */
    sessionUnavailable?: 'empty' | 'files-only';
    /**
     * Adaptive bm25 ordering (0.20.0, default on). Before paging, one bounded
     * count of the raw match set decides the plan: up to
     * RANK_ADAPTIVE_THRESHOLD matches keep ORDER BY rank, a wider set skips the
     * full-corpus bm25 sort and pages in rowid order with a cheap JS sort. Rank
     * cost grows with the number of documents that match at all (a word present
     * in every document costs 70 ms of ranking versus 0.3 ms without rank), so
     * the probe is cheap and the saving is large. false restores the 0.19
     * "always rank" behavior for narrow queries.
     */
    rankAdaptive?: boolean;
    /** Drop session documents entirely (the unknown-session fallback). */
    excludeSessions?: boolean;
    /** Include archived sessions in this query (panel checkbox or config). */
    includeArchived?: boolean;
    /** Internal: archived session ids to drop from the query. */
    excludeArchivedSessions?: string[];
    /**
     * Restrict session documents to these ids (caller + same-workspace sessions).
     * An empty array means "file documents only". Absent means no restriction.
     */
    allowedSessionIds?: readonly string[];
    /**
     * Keep file documents from every indexed root while session documents stay
     * scoped to `sessionPath`. Used by `locator_find` workspace scope when the
     * caller cwd is outside every indexed root: there is no workspace file
     * subset, so files fall back to the whole index while sessions stay current.
     */
    fileHitsAllRoots?: boolean;
    /** Override for the whole-word scan caps; production uses the defaults. */
    scanBudget?: ContentScanBudget;
    /**
     * Cooperative cancellation hook, installed by the search worker because a
     * function cannot cross a postMessage boundary. Checked between scan rows
     * and SQL statements; when it returns true the query stops early and reports
     * error 'content-search-cancelled'.
     */
    isCancelled?: () => boolean;
    /**
     * Force the degraded profile: bounded counting and no bm25 sort. The worker
     * switches it on for a while after a query ran past its deadline (around one
     * second), so one pathological query cannot repeat on every keystroke.
     */
    degrade?: boolean;
    /**
     * Abort signal accepted at the ContentIndex layer (see the cancel protocol in
     * content-search-worker.ts). searchContent is synchronous: it only checks
     * aborted before starting and then returns 'content-search-cancelled'; the
     * async layer turns that into an AbortError rejection.
     */
    signal?: AbortSignal;
}
/** Result of one content query. */
export interface ContentSearchResult {
    hits: ContentHit[];
    count: ContentCount;
    warnings: string[];
    error?: string;
}
/**
 * Raw match count above which bm25 ordering stops paying for itself. The probe
 * that reads it is a bounded count (a few hundred microseconds); ranking costs
 * O(matches) and is the dominant cost for common words on a multi-GB corpus.
 */
export declare const RANK_ADAPTIVE_THRESHOLD = 2000;
/** Counting cap applied while the worker is in its degraded profile. */
export declare const DEGRADED_COUNT_LIMIT = 500;
/** Text escaped for an FTS5 quoted phrase (`"` doubled). */
export declare function quoteFts(text: string): string;
/** Escape a literal for SQLite GLOB (`*`, `?`, `[`, `]`). */
export declare function escapeGlob(text: string): string;
/** Escape a literal for SQL LIKE with `ESCAPE '\'`. */
export declare function escapeLike(text: string): string;
/** Decoded extended-mode query text. */
export interface DecodedExtended {
    ok: boolean;
    text: string;
    warnings: string[];
    /** `invalid-escape` when `\\xNN` is malformed. */
    error?: string;
}
/**
 * Decode Notepad++-style extended escapes: `\n`, `\r`, `\t`, `\0`, `\\`,
 * `\xNN`. Unknown escapes are kept literally with a warning.
 */
export declare function decodeExtended(input: string): DecodedExtended;
/**
 * Extended decoding for file names: names cannot contain control characters, so
 * they are dropped from the pattern and reported instead of silently matching
 * nothing.
 */
export declare function decodeExtendedForNames(input: string): DecodedExtended;
/** Result of the query-entry checks shared by searchContent and the panel. */
export interface ContentQueryCheck {
    ok: boolean;
    /** Literal terms for normal mode; one phrase for extended mode. */
    terms: string[];
    phrase: boolean;
    warnings: string[];
    error?: string;
}
/**
 * Validate a content query before it reaches SQL.
 *
 * Content search only supports substrings the FTS5 trigram tokenizer can
 * serve. A 1–2 character term used to fall back to a whole-corpus `LIKE` scan,
 * which is both slow and unbounded; it is now a hard, visible error instead.
 * The same limits apply after extended-mode escapes are decoded, and lengths
 * are measured in Unicode code points so emoji are not mistaken for long text.
 * @param query - raw query text.
 * @param matchMode - `normal` (whitespace-separated terms) or `extended`.
 * @returns normalized terms, or the first entry error.
 */
export declare function checkContentQuery(query: string, matchMode: ContentMatchMode): ContentQueryCheck;
/** Whether `index` starts a whole-word occurrence of `length` bytes. */
export declare function isWholeWord(hay: string, index: number, length: number): boolean;
/** One located match: byte offset and length. */
interface Located {
    index: number;
    length: number;
}
/** First whole-word (or plain) occurrence of any term, or null. */
export declare function locateMatch(body: string, terms: readonly string[], caseSensitive: boolean, wholeWord: boolean): Located | null;
/** 1-based line number of a byte offset. */
export declare function lineOf(body: string, index: number): number;
/**
 * Put a read-only content connection into the search profile (P2).
 *
 * Search workers each get a 16 MiB page cache and a 256 MiB mmap window so
 * repeated queries keep their FTS pages warm without touching the build
 * connection. Failures are ignored: an older SQLite or a filesystem that
 * rejects mmap must never stop search from working.
 */
export declare function configureSearchConnection(db: DatabaseSync): void;
/**
 * Run one content query.
 *
 * Modes: `normal` (whitespace-separated substring terms), `extended`
 * (Notepad++ escapes, one literal phrase), `regex` (not executed server-side in
 * 0.9.0: returns `content-regex-not-supported`).
 *
 * Ordering (0.20.0, P0-6): a wide match set is not sorted by bm25. One bounded
 * count of the raw match set first, then either ORDER BY rank (narrow) or a
 * rowid-order page with a cheap JS sort (wide), because rank cost grows with
 * the number of matching documents and dominates a common-word query. Whole-word
 * queries never rank: their post-filter rewrites the result set anyway.
 *
 * Counting (0.20.0, P1-3): the page uses rowid-subquery filters while the count
 * uses docs-column filters, and wide filtered sets report a bounded count
 * instead of paying an O(match-set) exact COUNT.
 *
 * Cancellation: synchronous by design, so it only observes an already-aborted
 * signal or a cancellation hook between SQL statements and scan rows; the async
 * layer converts a cancelled result into an AbortError rejection.
 */
export declare function searchContent(db: DatabaseSync, query: string, limit: number, options?: ContentSearchOptions): ContentSearchResult;
export {};
//# sourceMappingURL=content-search.d.ts.map