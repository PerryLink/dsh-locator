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
    /**
     * Keep only file/session documents whose stored path lives under this
     * directory prefix (the locator_find `scope: workspace` filter). Session
     * documents are unaffected: they are scoped by `sessionPath`/`sessionId`.
     */
    pathPrefix?: string | null;
    /** Override for the whole-word scan caps; production uses the defaults. */
    scanBudget?: ContentScanBudget;
}
/** Result of one content query. */
export interface ContentSearchResult {
    hits: ContentHit[];
    count: ContentCount;
    warnings: string[];
    error?: string;
}
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
 * Run one content query.
 *
 * Modes: `normal` (whitespace-separated substring terms), `extended`
 * (Notepad++ escapes, one literal phrase), `regex` (not executed server-side in
 * 0.9.0: returns `content-regex-not-supported`).
 */
export declare function searchContent(db: DatabaseSync, query: string, limit: number, options?: ContentSearchOptions): ContentSearchResult;
export {};
//# sourceMappingURL=content-search.d.ts.map