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
 * Every unbounded-looking path has an explicit budget and a short term never
 * degrades a whole query into a full-table LIKE/GLOB scan (0.23, P0-7): when a
 * query mixes long terms with 2-codepoint terms the trigram matcher serves the
 * long ones and the short ones are enforced as a JS post-filter over the
 * candidates; a 1-codepoint term is dropped with a `terms-dropped` warning
 * when a long term exists; only an all-short query is rejected or answered by
 * the bounded short-query fallback. The whole-word/post-filter scan stops after
 * a fixed number of rows, body bytes or milliseconds and reports a bounded
 * count.
 *
 * 0.21.0 adapts the query layer to content schema v4: docs_meta identifies a
 * document by (path_id, kind_id) and keeps the path text once in the normalized
 * `paths` dictionary. Every docs_meta scope filter resolves through that
 * dictionary (META_ROWIDS_*), while the FTS `docs` table and its own
 * path/kind UNINDEXED columns stay unchanged. Filters, counts, paging and the
 * short-query fallback keep their 0.20.2 behavior.
 *
 * 0.20.2 adds two quality fixes on top of that:
 * - wide-page kind grouping (P0-1): the adaptive-rank wide path used to page in
 *   rowid order, and a full build indexes sessions first, so common words
 *   (the/function/error) returned a page that was 100% session documents. A wide
 *   unranked page is now fetched per kind (file first, then at most
 *   WIDE_SESSION_MAX_SHARE of the requested page from sessions) and re-sorted
 *   in-page with a cheap term-frequency/title/depth/line heuristic.
 * - short-query fallback (P0-2): a 2-codepoint query (ai / js / 索引) cannot be
 *   served by the trigram index. When the caller opts in with
 *   shortQueryFallback, a bounded scan returns name matches first and then body
 *   hits within a fixed wall clock, instead of rejecting the query.
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
import { type ContentHit } from './content.ts';
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
    /**
     * Bounded LIKE fallback for queries whose every term is too short for the
     * trigram index (0.20.2, P0-2; narrowed in 0.23). The trigram index cannot
     * serve a 2-character term (ai / js / 索引), so an all-short query is
     * normally rejected with 'content-query-too-short'. When this is true the
     * query is answered by a bounded scan instead: file-name (stored path) hits
     * first, then body hits under a fixed wall-clock budget, with a
     * 'content-query-short-fallback' warning and shortQueryFallback: true on the
     * result. This option never gates a mixed query: with at least one long term
     * the long terms drive FTS/BM25 and 2-codepoint terms are post-filtered in JS
     * (P0-7). An all-short query containing a 1-codepoint term stays rejected,
     * because a single character cannot produce a useful bounded page. Default
     * off for direct embedders; the plugin turns it on from
     * contentShortQueryFallback.
     */
    shortQueryFallback?: boolean;
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
    /**
     * True when a 2-codepoint query was answered by the bounded short-query
     * fallback, so the page is approximate (name hits plus a bounded body scan)
     * rather than trigram-exact. Absent for every normal query.
     */
    shortQueryFallback?: boolean;
}
/**
 * Raw match count above which bm25 ordering stops paying for itself. The probe
 * that reads it is a bounded count (a few hundred microseconds); ranking costs
 * O(matches) and is the dominant cost for common words on a multi-GB corpus.
 */
export declare const RANK_ADAPTIVE_THRESHOLD = 2000;
/** Counting cap applied while the worker is in its degraded profile. */
export declare const DEGRADED_COUNT_LIMIT = 500;
/**
 * Shortest term the bounded short-query fallback accepts (0.20.2, P0-2). One
 * codepoint is never served: in a mixed query it is dropped (warning
 * `terms-dropped`) because a single character matches so much of a corpus
 * that it cannot be a useful AND term, and in an all-short query it stays
 * 'content-query-too-short'.
 */
export declare const SHORT_TERM_MIN = 2;
/**
 * Wall-clock budget for one short-query fallback, in ms. The scan never starts
 * another rowid chunk after the deadline, so the overshoot is bounded by one
 * chunk; this is also the number the UI can use to label the result
 * approximate.
 */
export declare const SHORT_QUERY_FALLBACK_MAX_MS = 2000;
/**
 * Maximum session share of one requested wide page (0.20.2, P0-1). The file
 * page fills the requested page first, so a file-rich common-word query returns
 * file hits only (the research prototype hit 100% files versus 100% sessions
 * before the fix); sessions only fill slots the file page leaves empty and are
 * capped here so they can never dominate a page.
 */
export declare const WIDE_SESSION_MAX_SHARE = 0.3;
/**
 * Page cache for one search connection, KiB (0.20.2, P1). Raised from 16 MiB to
 * 64 MiB after measuring the live 4.1 GB snapshot: hot wide-query p50 fell from
 * 72.9 ms to 57.3 ms (-21%) and hot narrow p50 from 23.2 ms to 19.4 ms (-16%),
 * while fresh-connection cold latency stayed at ~21 ms (narrow) / ~68 ms (wide)
 * and the process RSS did not move (the 256 MiB mmap window dominates). The
 * bound is deliberate and must stay explicit: the host can run two search
 * workers at once, so 2 x 64 MiB is the worst case.
 */
export declare const SEARCH_CACHE_KIB: number;
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
    /**
     * Literal terms for the trigram matcher (normal mode); one phrase for
     * extended mode. Short terms that the matcher cannot serve are kept out of
     * this list: dropped 1-codepoint terms disappear, 2-codepoint terms move to
     * {@link postFilterTerms}.
     */
    terms: string[];
    /**
     * 2-codepoint terms of a mixed long/short query (0.23, P0-7). They cannot be
     * served by the trigram index, but the query still has long terms, so they
     * are enforced as a JS post-filter over the FTS candidates instead of
     * degrading the whole query to a bounded LIKE scan. Empty for all-long,
     * all-short and extended queries.
     */
    postFilterTerms: string[];
    phrase: boolean;
    warnings: string[];
    error?: string;
    /**
     * True when every term is too short for the trigram index but the bounded
     * short-query fallback can answer the query (2 codepoints, `allowShort`).
     * Callers that did not opt into the fallback get an error instead.
     */
    short: boolean;
}
/** Knobs for {@link checkContentQuery}. */
export interface ContentQueryCheckOptions {
    /**
     * Accept 2-codepoint terms for the bounded LIKE fallback (0.20.2, P0-2).
     * Default false keeps the 0.20.0 contract: the panel can show
     * 'content-query-too-short' without touching the store.
     */
    allowShort?: boolean;
}
/**
 * Validate a content query before it reaches SQL (0.23 contract, P0-7).
 *
 * Content search only supports substrings the FTS5 trigram tokenizer can
 * serve. A 1–2 character term used to fall back to a whole-corpus `LIKE` scan,
 * which is both slow and unbounded; it became a hard error in 0.20.0 and a
 * bounded, opt-in fallback in 0.20.2. 0.23 narrows the fallback to all-short
 * queries: a mixed long/short query keeps its long terms on the FTS/BM25 path
 * and enforces the 2-codepoint terms with a bounded JS post-filter, so a single
 * short term can no longer degrade the whole query. 1-codepoint terms are only
 * dropped when a long term exists (warning `terms-dropped`); on their own they
 * stay 'content-query-too-short'. Extended mode is one literal phrase, so its
 * length is measured over the whole decoded phrase including spaces (the
 * trigram tokenizer serves any 3+ code-point phrase). Lengths are measured in
 * Unicode code points so emoji are not mistaken for long text.
 * @param query - raw query text.
 * @param matchMode - `normal` (whitespace-separated terms) or `extended`.
 * @param options - `allowShort` opts into the bounded all-short fallback.
 * @returns normalized terms, or the first entry error.
 */
export declare function checkContentQuery(query: string, matchMode: ContentMatchMode, options?: ContentQueryCheckOptions): ContentQueryCheck;
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
 * Put a read-only content connection into the search profile (P2, raised in
 * 0.20.2 P1).
 *
 * Search workers each get a bounded page cache (SEARCH_CACHE_KIB, currently
 * 64 MiB), a 256 MiB mmap window and an in-memory temp store so repeated
 * queries keep their FTS pages warm without touching the build connection.
 * Failures are ignored: an older SQLite or a filesystem that rejects mmap must
 * never stop search.
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
 * Ordering (0.20.2, P0-1): the wide unranked page is now fetched per document
 * kind — the file page fills the requested page first and sessions only fill
 * leftover slots, capped at WIDE_SESSION_MAX_SHARE — then each group is
 * re-sorted in page by term frequency/title/depth/line. Narrow sets keep the
 * exact bm25 order unchanged.
 *
 * Short queries (0.20.2, P0-2; narrowed in 0.23, P0-7): with
 * options.shortQueryFallback an all-short 2-codepoint query is answered by the
 * bounded name+body fallback (see shortQueryFallbackSearch) instead of being
 * rejected; the result carries shortQueryFallback: true and a
 * 'content-query-short-fallback' warning. An all-short query containing a
 * 1-codepoint term stays rejected. A query that mixes long and short terms
 * never takes the fallback: its long terms drive FTS/BM25 and its 2-codepoint
 * terms are enforced as a JS post-filter over the candidates (scanFiltered),
 * while 1-codepoint terms are dropped with a 'terms-dropped' warning.
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