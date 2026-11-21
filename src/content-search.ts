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

import { sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
// Schema v4 (see content.ts) persists document kinds as integer codes and the
// path text in the normalized `paths` dictionary. content.ts statically imports
// this module, so importing its constants back closes a module cycle: the
// bindings below are only read inside query functions (never while either
// module evaluates), which keeps the cycle safe in both entry orders.
import { DOC_KIND_FILE, DOC_KIND_SESSION, type ContentHit } from './content.ts'

/** How the query text is interpreted. */
export type ContentMatchMode = 'normal' | 'extended' | 'regex'

/** How much work the caller wants the count to spend. */
export type ContentCountMode = 'exact' | 'bounded' | 'none'

/** A match count, with its confidence. `bounded` means "at least value". */
export interface ContentCount {
  value: number
  kind: 'exact' | 'bounded' | 'unknown'
  limit?: number
}

/**
 * Hard budget for the whole-word post-filter, which has to read candidate
 * bodies in JS. Exceeding any cap stops the scan and keeps the hits found so
 * far; the count then becomes bounded. Exposed mainly so embedders and tests
 * can shrink the caps.
 */
export interface ContentScanBudget {
  maxRows?: number
  maxBytes?: number
  maxMs?: number
}

/** Options accepted by {@link searchContent} and the content search worker. */
export interface ContentSearchOptions {
  matchMode?: ContentMatchMode
  caseSensitive?: boolean
  wholeWord?: boolean
  /** Resolved by ContentIndex from the request's sessionId. */
  sessionId?: string
  /** Session log path; set by ContentIndex after resolving sessionId. */
  sessionPath?: string | null
  count?: ContentCountMode
  countLimit?: number
  /** Skip this many ranked matches before the page (panel load-more). */
  offset?: number
  /**
   * Keep only file documents whose stored path lives under this directory
   * prefix (the locator_find `scope: workspace` filter). Combined with
   * `sessionPath` the two filters are composed by document kind: session
   * documents come from that session log, file documents from that prefix.
   */
  pathPrefix?: string | null
  /**
   * What to do when `sessionId` names a session that is not indexed yet:
   * return nothing (default, used by the panel's session scope) or keep
   * searching file documents without the session filter (`files-only`, used by
   * `locator_find` workspace scope so file hits stay searchable before the
   * active session is indexed).
   */
  sessionUnavailable?: 'empty' | 'files-only'
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
  rankAdaptive?: boolean
  /**
   * Bounded LIKE fallback for 2-codepoint queries (0.20.2, P0-2). The trigram
   * index cannot serve a 2-character term (ai / js / 索引), so such a query is
   * normally rejected with 'content-query-too-short'. When this is true the
   * query is answered by a bounded scan instead: file-name (stored path) hits
   * first, then body hits under a fixed wall-clock budget, with a
   * 'content-query-short-fallback' warning and shortQueryFallback: true on the
   * result. One-codepoint queries stay rejected. Default off for direct
   * embedders; the plugin turns it on from contentShortQueryFallback.
   */
  shortQueryFallback?: boolean
  /** Drop session documents entirely (the unknown-session fallback). */
  excludeSessions?: boolean
  /** Include archived sessions in this query (panel checkbox or config). */
  includeArchived?: boolean
  /** Internal: archived session ids to drop from the query. */
  excludeArchivedSessions?: string[]
  /**
   * Restrict session documents to these ids (caller + same-workspace sessions).
   * An empty array means "file documents only". Absent means no restriction.
   */
  allowedSessionIds?: readonly string[]
  /**
   * Keep file documents from every indexed root while session documents stay
   * scoped to `sessionPath`. Used by `locator_find` workspace scope when the
   * caller cwd is outside every indexed root: there is no workspace file
   * subset, so files fall back to the whole index while sessions stay current.
   */
  fileHitsAllRoots?: boolean
  /** Override for the whole-word scan caps; production uses the defaults. */
  scanBudget?: ContentScanBudget
  /**
   * Cooperative cancellation hook, installed by the search worker because a
   * function cannot cross a postMessage boundary. Checked between scan rows
   * and SQL statements; when it returns true the query stops early and reports
   * error 'content-search-cancelled'.
   */
  isCancelled?: () => boolean
  /**
   * Force the degraded profile: bounded counting and no bm25 sort. The worker
   * switches it on for a while after a query ran past its deadline (around one
   * second), so one pathological query cannot repeat on every keystroke.
   */
  degrade?: boolean
  /**
   * Abort signal accepted at the ContentIndex layer (see the cancel protocol in
   * content-search-worker.ts). searchContent is synchronous: it only checks
   * aborted before starting and then returns 'content-search-cancelled'; the
   * async layer turns that into an AbortError rejection.
   */
  signal?: AbortSignal
}

/** Result of one content query. */
export interface ContentSearchResult {
  hits: ContentHit[]
  count: ContentCount
  warnings: string[]
  error?: string
  /**
   * True when a 2-codepoint query was answered by the bounded short-query
   * fallback, so the page is approximate (name hits plus a bounded body scan)
   * rather than trigram-exact. Absent for every normal query.
   */
  shortQueryFallback?: boolean
}

/** Shortest text a trigram tokenizer can index. */
const TRIGRAM_MIN = 3
/** Query entry limits: no unbounded parsing, no unbounded SQL. */
const MAX_QUERY_CODEPOINTS = 256
const MAX_QUERY_TERMS = 32
const MAX_LIMIT = 100
const DEFAULT_COUNT_LIMIT = 1000
const MAX_COUNT_LIMIT = 5000
const SNIPPET_BEFORE = 60
const SNIPPET_AFTER = 120
const SNIPPET_MAX = 400

/** Whole-word post-filter defaults (rows, body bytes, wall clock). */
const SCAN_MAX_ROWS = 5_000
const SCAN_MAX_BYTES = 64 * 1024 * 1024
const SCAN_MAX_MS = 800

/**
 * Raw match count above which bm25 ordering stops paying for itself. The probe
 * that reads it is a bounded count (a few hundred microseconds); ranking costs
 * O(matches) and is the dominant cost for common words on a multi-GB corpus.
 */
export const RANK_ADAPTIVE_THRESHOLD = 2_000

/** Counting cap applied while the worker is in its degraded profile. */
export const DEGRADED_COUNT_LIMIT = 500

/**
 * Shortest term the bounded short-query fallback accepts (0.20.2, P0-2). One
 * codepoint is still rejected: a single character matches so much of a corpus
 * that even a bounded scan is not worth answering.
 */
export const SHORT_TERM_MIN = 2

/**
 * Wall-clock budget for one short-query fallback, in ms. The scan never starts
 * another rowid chunk after the deadline, so the overshoot is bounded by one
 * chunk; this is also the number the UI can use to label the result
 * approximate.
 */
export const SHORT_QUERY_FALLBACK_MAX_MS = 2_000

/**
 * Rows scanned per fallback chunk. The body scan is split into explicit rowid
 * ranges so cancellation and the deadline are observed between chunks; a
 * chunk of a pathological corpus (many multi-MB documents) bounds the
 * worst-case overshoot of the wall-clock budget.
 */
const SHORT_QUERY_FALLBACK_CHUNK_ROWS = 512

/**
 * Minimum fallback chunk after adaptive shrinking. A corpus chunk made of
 * multi-MB documents can take long enough that one chunk exceeds the remaining
 * wall clock; the scan halves the chunk size when a chunk runs past
 * SHORT_QUERY_FALLBACK_SLOW_CHUNK_MS.
 */
const SHORT_QUERY_FALLBACK_MIN_CHUNK_ROWS = 64
const SHORT_QUERY_FALLBACK_SLOW_CHUNK_MS = 50

/** How many name hits (path matches) the fallback collects before body hits. */
const SHORT_QUERY_NAME_MIN_LIMIT = 40
const SHORT_QUERY_NAME_MAX_LIMIT = 500

/**
 * Maximum session share of one requested wide page (0.20.2, P0-1). The file
 * page fills the requested page first, so a file-rich common-word query returns
 * file hits only (the research prototype hit 100% files versus 100% sessions
 * before the fix); sessions only fill slots the file page leaves empty and are
 * capped here so they can never dominate a page.
 */
export const WIDE_SESSION_MAX_SHARE = 0.3

/**
 * Term-frequency terminator for the wide-page rerank: counting stops after this
 * many occurrences, so a word present on every line cannot make the heuristic
 * scan a whole document.
 */
const FREQ_SCAN_CAP = 64

/** Bytes of each body sampled for the term-frequency heuristic. */
const FREQ_BODY_MAX = 65_536

/**
 * Candidate-rowid cap for the split workspace count. Above it the rowid probe
 * list is so broad that the combined column count wins; below it the two narrow
 * halves are an order of magnitude cheaper.
 */
const COMPOSITE_ROWID_LIMIT = 5_000

/*
 * Schema v4 (see content.ts) stores document identity as (path_id, kind_id):
 * the path text lives once in the `paths` dictionary, so every
 * filter that used docs_meta.path/kind resolves through it explicitly. The FTS
 * `docs` table is unchanged and keeps its own path/kind columns, so
 * only docs_meta filters need these fragments.
 */

/** docs_meta rowids whose stored path equals one spelled path (v4). */
const META_ROWIDS_BY_PATH = 'SELECT m.rowid FROM docs_meta m JOIN paths p ON p.id = m.path_id WHERE p.path = ?'

/** docs_meta rowids whose stored path starts with one prefix (v4). */
const META_ROWIDS_BY_PREFIX = "SELECT m.rowid FROM docs_meta m JOIN paths p ON p.id = m.path_id WHERE p.path LIKE ? ESCAPE '\\'"

/** docs_meta rowids for one persisted document-kind code (v4). */
function metaRowidsByKind(kindId: number): string {
  return 'SELECT rowid FROM docs_meta WHERE kind_id = ' + String(kindId)
}

/** docs_meta candidate count used as the split-count guard. */
const COMPOSITE_CANDIDATE_SQL = "SELECT count(*) AS n FROM docs_meta m JOIN paths p ON p.id = m.path_id WHERE p.path LIKE ? ESCAPE '\\'"

/**
 * Page cache for one search connection, KiB (0.20.2, P1). Raised from 16 MiB to
 * 64 MiB after measuring the live 4.1 GB snapshot: hot wide-query p50 fell from
 * 72.9 ms to 57.3 ms (-21%) and hot narrow p50 from 23.2 ms to 19.4 ms (-16%),
 * while fresh-connection cold latency stayed at ~21 ms (narrow) / ~68 ms (wide)
 * and the process RSS did not move (the 256 MiB mmap window dominates). The
 * bound is deliberate and must stay explicit: the host can run two search
 * workers at once, so 2 x 64 MiB is the worst case.
 */
export const SEARCH_CACHE_KIB = 64 * 1024

/**
 * Read-only connection pragmas for content search (worker and embedders).
 * temp_store stays MEMORY so a transient sorter never spills to disk; between
 * them these are the whole per-connection memory profile.
 */
const SEARCH_PRAGMAS: readonly string[] = [
  'PRAGMA busy_timeout = 5000',
  'PRAGMA query_only = ON',
  `PRAGMA cache_size = -${SEARCH_CACHE_KIB}`,
  'PRAGMA mmap_size = 268435456',
  'PRAGMA temp_store = MEMORY',
]

/** Bytes that count as "inside a word", matching the name engine. */
const WORD_BYTE = /[A-Za-z0-9_]/
/** Control bytes: file names cannot contain them, so name patterns drop them. */
const CONTROL_CHARS = /[\u0000-\u001f]/
/**
 * Control bytes rejected in a content query. Tab/LF/CR stay allowed: they are
 * ordinary term separators in normal mode and explicit escapes in extended
 * mode. NUL and the other C0 bytes must never reach SQLite.
 */
const QUERY_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/

/** Text escaped for an FTS5 quoted phrase (`"` doubled). */
export function quoteFts(text: string): string {
  return '"' + text.replace(/"/g, '""') + '"'
}

/** Escape a literal for SQLite GLOB (`*`, `?`, `[`, `]`). */
export function escapeGlob(text: string): string {
  return text.replace(/[*?[\]]/g, ch => (ch === ']' ? '[]]' : '[' + ch + ']'))
}

/** Escape a literal for SQL LIKE with `ESCAPE '\'`. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, ch => '\\' + ch)
}

/** Decoded extended-mode query text. */
export interface DecodedExtended {
  ok: boolean
  text: string
  warnings: string[]
  /** `invalid-escape` when `\\xNN` is malformed. */
  error?: string
}

/**
 * Decode Notepad++-style extended escapes: `\n`, `\r`, `\t`, `\0`, `\\`,
 * `\xNN`. Unknown escapes are kept literally with a warning.
 */
export function decodeExtended(input: string): DecodedExtended {
  const warnings = new Set<string>()
  let text = ''
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (ch !== '\\') {
      text += ch
      continue
    }
    const next = input[i + 1]
    if (next === undefined) {
      warnings.add('extended-trailing-backslash')
      text += '\\'
      continue
    }
    switch (next) {
      case 'n':
        text += '\n'
        i++
        continue
      case 'r':
        text += '\r'
        i++
        continue
      case 't':
        text += '\t'
        i++
        continue
      case '0':
        text += '\0'
        warnings.add('extended-control-char')
        i++
        continue
      case '\\':
        text += '\\'
        i++
        continue
      case 'x': {
        const hex = input.slice(i + 2, i + 4)
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
          return { ok: false, text: '', warnings: [...warnings], error: 'invalid-escape' }
        }
        const code = Number.parseInt(hex, 16)
        text += String.fromCharCode(code)
        if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) warnings.add('extended-control-char')
        i += 3
        continue
      }
      default:
        warnings.add('extended-unknown-escape')
        text += '\\' + next
        i++
    }
  }
  return { ok: true, text, warnings: [...warnings] }
}

/**
 * Extended decoding for file names: names cannot contain control characters, so
 * they are dropped from the pattern and reported instead of silently matching
 * nothing.
 */
export function decodeExtendedForNames(input: string): DecodedExtended {
  const decoded = decodeExtended(input)
  if (!decoded.ok) return decoded
  const kept = decoded.text.replace(CONTROL_CHARS, '')
  if (kept !== decoded.text) decoded.warnings.push('name-extended-control-char')
  return { ...decoded, text: kept }
}

/** Length in Unicode code points, so emoji count as one character. */
function codePointCount(text: string): number {
  return Array.from(text).length
}

/** Whether text still contains a byte the content query must reject. */
function hasControlChars(text: string): boolean {
  return QUERY_CONTROL_CHARS.test(text)
}

/** Split a normal-mode query on whitespace, dropping empty terms. */
function splitTerms(text: string): string[] {
  return text.split(/\s+/).map(part => part.replace(/^"|"$/g, '')).filter(part => part !== '')
}

/** Split decoded extended text into words for the entry checks. */
function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(part => part !== '')
}

/** Result of the query-entry checks shared by searchContent and the panel. */
export interface ContentQueryCheck {
  ok: boolean
  /** Literal terms for normal mode; one phrase for extended mode. */
  terms: string[]
  phrase: boolean
  warnings: string[]
  error?: string
  /**
   * True when every term is too short for the trigram index but long enough for
   * the bounded short-query fallback (2 codepoints). Callers that did not opt
   * into the fallback get an error instead, so this is only set with
   * `allowShort`.
   */
  short: boolean
}

/** Knobs for {@link checkContentQuery}. */
export interface ContentQueryCheckOptions {
  /**
   * Accept 2-codepoint terms for the bounded LIKE fallback (0.20.2, P0-2).
   * Default false keeps the 0.20.0 contract: the panel can show
   * 'content-query-too-short' without touching the store.
   */
  allowShort?: boolean
}

/**
 * Decide what to do with terms that the trigram tokenizer cannot index.
 * @returns an entry error, or `short: true` when the caller may fall back.
 */
function shortTermsStatus(terms: readonly string[], allowShort: boolean): { error?: string; short: boolean } {
  if (!terms.some(term => codePointCount(term) < TRIGRAM_MIN)) return { short: false }
  // A one-codepoint term stays rejected even with the fallback: it matches so
  // much of any real corpus that a bounded scan cannot produce a useful page.
  if (terms.some(term => codePointCount(term) < SHORT_TERM_MIN)) return { short: false, error: 'content-query-too-short' }
  if (!allowShort) return { short: false, error: 'content-query-too-short' }
  return { short: true }
}

/**
 * Validate a content query before it reaches SQL.
 *
 * Content search only supports substrings the FTS5 trigram tokenizer can
 * serve. A 1–2 character term used to fall back to a whole-corpus `LIKE` scan,
 * which is both slow and unbounded; it became a hard error in 0.20.0. 0.20.2
 * reintroduces it as an explicit, bounded fallback: callers that pass
 * `allowShort` accept 2-codepoint terms and searchContent answers them with a
 * deadline-bounded scan. The same limits apply after extended-mode escapes are
 * decoded, and lengths are measured in Unicode code points so emoji are not
 * mistaken for long text.
 * @param query - raw query text.
 * @param matchMode - `normal` (whitespace-separated terms) or `extended`.
 * @param options - `allowShort` opts into the bounded fallback.
 * @returns normalized terms, or the first entry error.
 */
export function checkContentQuery(
  query: string,
  matchMode: ContentMatchMode,
  options: ContentQueryCheckOptions = {},
): ContentQueryCheck {
  const warnings: string[] = []
  const allowShort = options.allowShort === true
  const text = query.trim()
  if (text === '') return { ok: true, terms: [], phrase: false, warnings, short: false }
  if (codePointCount(text) > MAX_QUERY_CODEPOINTS) {
    return { ok: false, terms: [], phrase: false, warnings, error: 'content-query-too-long', short: false }
  }
  if (hasControlChars(text)) {
    // A NUL (or other C0 byte) in the query must never be passed to SQLite:
    // some string paths would stop at it and turn the query into "match
    // everything". Reject it explicitly instead.
    return { ok: false, terms: [], phrase: false, warnings, error: 'invalid-control-char', short: false }
  }
  if (matchMode === 'extended') {
    const decoded = decodeExtended(text)
    warnings.push(...decoded.warnings)
    if (!decoded.ok) {
      return { ok: false, terms: [], phrase: false, warnings, error: decoded.error ?? 'invalid-escape', short: false }
    }
    if (hasControlChars(decoded.text)) {
      return { ok: false, terms: [], phrase: false, warnings, error: 'invalid-control-char', short: false }
    }
    const words = splitWords(decoded.text)
    if (words.length === 0) return { ok: true, terms: [], phrase: true, warnings, short: false }
    if (words.length > MAX_QUERY_TERMS) {
      return { ok: false, terms: [], phrase: true, warnings, error: 'content-query-too-many-terms', short: false }
    }
    const status = shortTermsStatus(words, allowShort)
    if (status.error !== undefined) {
      return { ok: false, terms: [], phrase: true, warnings, error: status.error, short: false }
    }
    return { ok: true, terms: [decoded.text], phrase: true, warnings, short: status.short }
  }
  const terms = splitTerms(text)
  if (terms.length > MAX_QUERY_TERMS) {
    return { ok: false, terms: [], phrase: false, warnings, error: 'content-query-too-many-terms', short: false }
  }
  const status = shortTermsStatus(terms, allowShort)
  if (status.error !== undefined) {
    return { ok: false, terms: [], phrase: false, warnings, error: status.error, short: false }
  }
  return { ok: true, terms, phrase: false, warnings, short: status.short }
}

/** Whether `index` starts a whole-word occurrence of `length` bytes. */
export function isWholeWord(hay: string, index: number, length: number): boolean {
  const left = index === 0 || !WORD_BYTE.test(hay[index - 1] ?? '')
  const end = index + length
  const right = end >= hay.length || !WORD_BYTE.test(hay[end] ?? '')
  return left && right
}

/** One located match: byte offset and length. */
interface Located {
  index: number
  length: number
}

/** First whole-word (or plain) occurrence of any term, or null. */
export function locateMatch(
  body: string,
  terms: readonly string[],
  caseSensitive: boolean,
  wholeWord: boolean,
): Located | null {
  const hay = caseSensitive ? body : body.toLowerCase()
  let best: Located | null = null
  for (const term of terms) {
    if (term === '') continue
    const needle = caseSensitive ? term : term.toLowerCase()
    let from = 0
    while (from <= hay.length) {
      const index = hay.indexOf(needle, from)
      if (index < 0) break
      if (!wholeWord || isWholeWord(hay, index, needle.length)) {
        if (best === null || index < best.index) best = { index, length: needle.length }
        break
      }
      from = index + 1
    }
  }
  return best
}

/** Every term must appear as a whole word (normal mode) or the literal must
 *  have non-word edges (extended mode is a single "term"). */
function matchesWholeWord(body: string, terms: readonly string[], caseSensitive: boolean): boolean {
  for (const term of terms) {
    if (term === '') continue
    if (locateMatch(body, [term], caseSensitive, true) === null) return false
  }
  return true
}

/** 1-based line number of a byte offset. */
export function lineOf(body: string, index: number): number {
  let line = 1
  let from = 0
  for (;;) {
    const next = body.indexOf('\n', from)
    if (next < 0 || next >= index) return line
    line++
    from = next + 1
  }
}

/** Bounded, single-line snippet around the first match. */
function makeSnippet(body: string, located: Located | null): string {
  if (located === null) {
    const flat = body.replace(/\s+/g, ' ').trim()
    return flat.length > SNIPPET_MAX ? flat.slice(0, SNIPPET_MAX - 1) + '…' : flat
  }
  const start = Math.max(0, located.index - SNIPPET_BEFORE)
  const end = Math.min(body.length, located.index + located.length + SNIPPET_AFTER)
  const flat = body.slice(start, end).replace(/\s+/g, ' ')
  const text = (start > 0 ? '…' : '') + flat + (end < body.length ? '…' : '')
  return text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX - 1) + '…' : text
}

function emptyCount(mode: ContentCountMode): ContentCount {
  if (mode === 'none') return { value: 0, kind: 'unknown' }
  return { value: 0, kind: 'exact' }
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limit) ? Math.trunc(limit) : MAX_LIMIT))
}

function clampCountLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_COUNT_LIMIT
  return Math.max(1, Math.min(MAX_COUNT_LIMIT, Math.trunc(limit)))
}

/** A positive integer override, or the default when unset/invalid. */
function budgetValue(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback
  return Math.trunc(value)
}

function resolveScanBudget(budget: ContentScanBudget | undefined): { maxRows: number; maxBytes: number; maxMs: number } {
  return {
    maxRows: budgetValue(budget?.maxRows, SCAN_MAX_ROWS),
    maxBytes: budgetValue(budget?.maxBytes, SCAN_MAX_BYTES),
    maxMs: budgetValue(budget?.maxMs, SCAN_MAX_MS),
  }
}

/** Normalize the optional path-prefix filter; keep the platform separator. */
function normalizePathPrefix(prefix: string | null | undefined): string | null {
  if (typeof prefix !== 'string') return null
  const trimmed = prefix.trim()
  if (trimmed === '') return null
  if (trimmed.endsWith('/') || trimmed.endsWith('\\')) return trimmed
  return trimmed + sep
}

/** One filter fragment: SQL and its parameters, in placeholder order. */
interface FilterFragment {
  sql: string
  params: Array<string | number>
}

/** Scope filters resolved from the query options. */
interface PlanFilters {
  sessionPath: string | null
  pathPrefix: string | null
  excludeSessions: boolean
  fileHitsAllRoots: boolean
  archivedExcluded: readonly string[]
  allowedSessions: readonly string[] | null
}

/**
 * Scope filters expressed as rowid subqueries: the page path.
 *
 * A narrow docs_meta set (one session log, one project subtree) becomes a
 * handful of FTS rowid probes, which is far cheaper than ranking the whole
 * corpus and filtering afterwards. Broad sets are exactly where probing every
 * rowid used to blow up, so the count path uses the column form instead (see
 * countFilters).
 */
function pageFilters(filters: PlanFilters): FilterFragment {
  const { sessionPath, pathPrefix, excludeSessions, fileHitsAllRoots, archivedExcluded, allowedSessions } = filters
  const sql: string[] = []
  const params: Array<string | number> = []
  if (sessionPath !== null && pathPrefix !== null) {
    // Workspace scope has two halves: session rows from the caller's session
    // log, file rows under the caller's cwd. They must be composed by kind —
    // ANDing the two path filters matched no row at all (0.11.0–0.11.6 bug),
    // so file bodies were never searchable in workspace scope.
    sql.push(" AND ((kind = 'session' AND rowid IN (" + META_ROWIDS_BY_PATH + ")) OR (kind = 'file' AND rowid IN (" + META_ROWIDS_BY_PREFIX + ')))')
    params.push(sessionPath, escapeLike(pathPrefix) + '%')
  } else if (sessionPath !== null && fileHitsAllRoots) {
    // The caller cwd is outside every indexed root: file documents come from
    // the whole index, session documents still from the caller's session log.
    sql.push(" AND ((kind = 'session' AND rowid IN (" + META_ROWIDS_BY_PATH + ")) OR kind = 'file')")
    params.push(sessionPath)
  } else if (sessionPath !== null) {
    // Pure session scope (panel "this conversation", sessionId-only requests).
    sql.push(' AND rowid IN (' + META_ROWIDS_BY_PATH + ')')
    params.push(sessionPath)
  } else if (pathPrefix !== null) {
    // File scope without a session: session rows stay available as before.
    sql.push(" AND (kind = 'session' OR rowid IN (" + META_ROWIDS_BY_PREFIX + '))')
    params.push(escapeLike(pathPrefix) + '%')
  }
  if (excludeSessions) sql.push(" AND kind = 'file'")
  if (allowedSessions !== null) {
    // Caller authorization for session documents; file documents are scoped by
    // the roots/cwd filters instead. An empty allow-list keeps only files.
    if (allowedSessions.length === 0) sql.push(" AND kind = 'file'")
    else {
      sql.push(` AND (kind = 'file' OR session_id IN (${allowedSessions.map(() => '?').join(', ')}))`)
      params.push(...allowedSessions)
    }
  }
  if (archivedExcluded.length > 0) {
    // Archived session logs are indexed but hidden by default; file documents
    // have no session id and must stay visible.
    sql.push(` AND (kind = 'file' OR session_id IS NULL OR session_id NOT IN (${archivedExcluded.map(() => '?').join(', ')}))`)
    params.push(...archivedExcluded)
  }
  return { sql: sql.join(''), params }
}

/**
 * Scope filters expressed on the docs columns: the count path.
 *
 * Filtering an FTS match with rowid IN (SELECT ...) degrades badly when the
 * subquery yields tens of thousands of rowids (a broad workspace prefix used
 * to cost ~3.2 s versus a few hundred ms reading the UNINDEXED path column per
 * match), and a count has no ORDER BY page to amortize that. The column form is
 * a per-match predicate the FTS scan can fold in, and callers bound the work
 * with LIMIT (see boundedCount).
 *
 * Pure session scope is the one exception: exactly one indexed session log is
 * the narrowest filter there is (a single path equality, a handful of docs), so
 * the rowid-subquery form stays cheapest for both exact and bounded counts.
 *
 * Schema v4 leaves the docs-column form valid: the FTS docs table still
 * carries its own kind/path UNINDEXED columns. Only the docs_meta identity
 * (pure session scope below) is resolved through the normalized dictionary.
 */
function countFilters(filters: PlanFilters): FilterFragment {
  const { sessionPath, pathPrefix, excludeSessions, fileHitsAllRoots, archivedExcluded, allowedSessions } = filters
  const sql: string[] = []
  const params: Array<string | number> = []
  if (sessionPath !== null && pathPrefix !== null) {
    sql.push(" AND ((kind = 'session' AND path = ?) OR (kind = 'file' AND path LIKE ? ESCAPE '\\'))")
    params.push(sessionPath, escapeLike(pathPrefix) + '%')
  } else if (sessionPath !== null && fileHitsAllRoots) {
    sql.push(" AND ((kind = 'session' AND path = ?) OR kind = 'file')")
    params.push(sessionPath)
  } else if (sessionPath !== null) {
    sql.push(' AND rowid IN (' + META_ROWIDS_BY_PATH + ')')
    params.push(sessionPath)
  } else if (pathPrefix !== null) {
    sql.push(" AND (kind = 'session' OR path LIKE ? ESCAPE '\\')")
    params.push(escapeLike(pathPrefix) + '%')
  }
  if (excludeSessions) sql.push(" AND kind = 'file'")
  if (allowedSessions !== null) {
    if (allowedSessions.length === 0) sql.push(" AND kind = 'file'")
    else {
      sql.push(` AND (kind = 'file' OR session_id IN (${allowedSessions.map(() => '?').join(', ')}))`)
      params.push(...allowedSessions)
    }
  }
  if (archivedExcluded.length > 0) {
    sql.push(` AND (kind = 'file' OR session_id IS NULL OR session_id NOT IN (${archivedExcluded.map(() => '?').join(', ')}))`)
    params.push(...archivedExcluded)
  }
  return { sql: sql.join(''), params }
}

/** One query plan: matcher, filter fragments and paging/count policy. */
interface QueryPlan {
  /** The matcher alone: `docs MATCH ?` or `body GLOB ?`. */
  matchWhere: string
  matchParams: Array<string | number>
  /** Matcher + scope filters as rowid subqueries (page path). */
  pageWhere: string
  pageParams: Array<string | number>
  /** Matcher + scope filters on docs columns (count path). */
  countWhere: string
  countParams: Array<string | number>
  /** Literal terms used for whole-word checks and snippet location. */
  terms: string[]
  caseSensitive: boolean
  wholeWord: boolean
  /** Match the whole phrase as one literal (extended mode). */
  phrase: boolean
  /** The bm25 rank column exists for this matcher (GLOB cannot rank). */
  rankCapable: boolean
  /** Counting means scanning every document (GLOB body): always bound it. */
  countBounded: boolean
  /** Scope filters are present, so a wide exact count is not worth paying. */
  filtered: boolean
  /** File documents can survive the scope filters. */
  canHitFiles: boolean
  /** Session documents can survive the scope filters. */
  canHitSessions: boolean
  /**
   * Workspace scope counted as two kind-separated halves, each with a narrow
   * rowid probe set (see CompositeCountPlan). Absent for every other scope.
   */
  composite?: CompositeCountPlan
}

/**
 * Kind-separated count plan for workspace scope (session log + cwd prefix).
 *
 * The combined filter is `(session rows from this log) OR (file rows under this
 * prefix)`; counting it as one OR clause makes SQLite scan every match. Split
 * in two, each half is driven by a narrow docs_meta rowid set instead, which is
 * roughly an order of magnitude cheaper.
 */
interface CompositeCountPlan {
  fileWhere: string
  fileParams: Array<string | number>
  /** null when no session document can pass the filters. */
  sessionWhere: string | null
  sessionParams: Array<string | number>
  /** Escaped LIKE pattern for the docs_meta candidate-size guard. */
  candidatePattern: string
}

/**
 * Build the split count plan for workspace scope, if this plan has one.
 *
 * File documents are filtered by the cwd prefix only; session documents by the
 * session log path plus the caller/archived authorization filters (file
 * documents have no session id, so those filters never apply to them).
 */
function compositeCountPlan(
  filters: PlanFilters,
  matchWhere: string,
  matchParams: Array<string | number>,
): CompositeCountPlan | null {
  const { sessionPath, pathPrefix, excludeSessions, allowedSessions, archivedExcluded } = filters
  if (sessionPath === null || pathPrefix === null) return null
  const pattern = escapeLike(pathPrefix) + '%'
  const fileWhere = matchWhere + " AND kind = 'file' AND rowid IN (" + META_ROWIDS_BY_PREFIX + ')'
  const sessionParams: Array<string | number> = [...matchParams, sessionPath]
  let sessionWhere: string | null = matchWhere + " AND kind = 'session' AND rowid IN (" + META_ROWIDS_BY_PATH + ')'
  if (excludeSessions === true || (allowedSessions !== null && allowedSessions.length === 0)) {
    sessionWhere = null
    sessionParams.length = 0
  } else if (allowedSessions !== null) {
    sessionWhere += ` AND session_id IN (${allowedSessions.map(() => '?').join(', ')})`
    sessionParams.push(...allowedSessions)
  }
  if (sessionWhere !== null && archivedExcluded.length > 0) {
    sessionWhere += ` AND (session_id IS NULL OR session_id NOT IN (${archivedExcluded.map(() => '?').join(', ')}))`
    sessionParams.push(...archivedExcluded)
  }
  return { fileWhere, fileParams: [...matchParams, pattern], sessionWhere, sessionParams, candidatePattern: pattern }
}

function buildPlan(terms: readonly string[], options: {
  caseSensitive: boolean
  wholeWord: boolean
  phrase: boolean
  sessionPath: string | null
  pathPrefix: string | null
  excludeSessions: boolean
  fileHitsAllRoots: boolean
  archivedExcluded: readonly string[]
  allowedSessions: readonly string[] | null
}): QueryPlan | null {
  const { caseSensitive, wholeWord, phrase } = options
  if (terms.length === 0) return null
  const filters: PlanFilters = {
    sessionPath: options.sessionPath,
    pathPrefix: options.pathPrefix,
    excludeSessions: options.excludeSessions,
    fileHitsAllRoots: options.fileHitsAllRoots,
    archivedExcluded: options.archivedExcluded,
    allowedSessions: options.allowedSessions,
  }
  const page = pageFilters(filters)
  const count = countFilters(filters)
  const filtered = page.sql !== ''
  // Which document kinds can survive the scope filters: the wide-page kind
  // grouping (P0-1) only splits into file/session pages when both are possible.
  const filePathOnly = filters.sessionPath !== null && filters.pathPrefix === null && !filters.fileHitsAllRoots
  const canHitFiles = !filePathOnly
  const canHitSessions = filters.excludeSessions !== true
    && !(filters.allowedSessions !== null && filters.allowedSessions.length === 0)
  const plan = (matchWhere: string, matchParams: Array<string | number>, rankCapable: boolean, countBounded: boolean): QueryPlan => {
    const composite = compositeCountPlan(filters, matchWhere, matchParams)
    return {
      matchWhere,
      matchParams,
      pageWhere: matchWhere + page.sql,
      pageParams: [...matchParams, ...page.params],
      countWhere: matchWhere + count.sql,
      countParams: [...matchParams, ...count.params],
      terms: [...terms],
      caseSensitive,
      wholeWord,
      phrase,
      rankCapable,
      countBounded,
      filtered,
      canHitFiles,
      canHitSessions,
      ...(composite === null ? {} : { composite }),
    }
  }
  if (phrase) {
    const literal = terms[0]!
    if (caseSensitive) return plan('body GLOB ?', ['*' + escapeGlob(literal) + '*'], false, true)
    return plan('docs MATCH ?', [quoteFts(literal)], true, false)
  }
  if (caseSensitive) {
    return plan(terms.map(() => 'body GLOB ?').join(' AND '), terms.map(term => '*' + escapeGlob(term) + '*'), false, true)
  }
  return plan('docs MATCH ?', [terms.map(quoteFts).join(' AND ')], true, false)
}

/** One document row fetched for a hit. */
interface DocRow {
  kind?: string
  path?: string
  title?: string
  session_id?: string | null
  message_id?: string | null
  body?: string
  node_key?: string | null
  score?: number
}

const DOC_SQL = `SELECT d.kind AS kind, d.path AS path, d.title AS title,
  d.session_id AS session_id, d.message_id AS message_id, d.body AS body,
  m.node_key AS node_key
  FROM docs d LEFT JOIN docs_meta m ON m.rowid = d.rowid
  WHERE d.rowid = ?`

/** The plan fields a hit builder needs (also usable by the short-query fallback). */
type HitPlan = Pick<QueryPlan, 'terms' | 'caseSensitive' | 'wholeWord'>

/** Hits built for one page, with the rerank samples aligned by index. */
interface BuiltHits {
  hits: ContentHit[]
  /** Term frequency per hit for the wide-page rerank (0 when not requested). */
  frequency: number[]
}

/**
 * Count query-term occurrences in a bounded sample of one body. Used only as a
 * cheap tie-breaker for the unranked wide page: a document that repeats the
 * term is usually more relevant than one that mentions it once. Counting stops
 * at FREQ_SCAN_CAP and reads at most FREQ_BODY_MAX bytes, so the heuristic
 * never turns into a second full-corpus scan.
 */
function countTermFrequency(body: string, needles: readonly string[], caseSensitive: boolean): number {
  if (needles.length === 0) return 0
  const sample = body.length > FREQ_BODY_MAX ? body.slice(0, FREQ_BODY_MAX) : body
  const hay = caseSensitive ? sample : sample.toLowerCase()
  let total = 0
  for (const needle of needles) {
    let from = 0
    while (total < FREQ_SCAN_CAP) {
      const index = hay.indexOf(needle, from)
      if (index < 0) break
      total++
      from = index + needle.length
    }
    if (total >= FREQ_SCAN_CAP) break
  }
  return total
}

/** Build hits from rowids: metadata, snippet, first-match line and score. */
function buildHits(
  db: DatabaseSync,
  plan: HitPlan,
  rowids: readonly number[],
  scores: ReadonlyMap<number, number>,
  withFrequency = false,
): BuiltHits {
  const statement = db.prepare(DOC_SQL)
  const hits: ContentHit[] = []
  const frequency: number[] = []
  const needles = withFrequency
    ? plan.terms.filter(term => term !== '').map(term => plan.caseSensitive ? term : term.toLowerCase())
    : []
  for (const rowid of rowids) {
    const row = statement.get(rowid) as DocRow | undefined
    if (row === undefined || typeof row.body !== 'string') continue
    const located = locateMatch(row.body, plan.terms, plan.caseSensitive, plan.wholeWord)
    const line = located === null ? undefined : lineOf(row.body, located.index)
    const score = scores.get(rowid)
    const hit: ContentHit = {
      kind: row.kind === 'session' ? 'session' : 'file',
      path: typeof row.path === 'string' ? row.path : '',
      title: typeof row.title === 'string' ? row.title : '',
      snippet: makeSnippet(row.body, located),
      score: score === undefined ? 0 : score,
      ...(typeof row.session_id === 'string' && row.session_id !== '' ? { sessionId: row.session_id } : {}),
      ...(typeof row.message_id === 'string' && row.message_id !== '' ? { messageId: row.message_id } : {}),
      ...(typeof row.node_key === 'string' && row.node_key !== '' ? { nodeKey: row.node_key } : {}),
      ...(line === undefined ? {} : { line }),
    }
    hits.push(hit)
    if (withFrequency) frequency.push(countTermFrequency(row.body, needles, plan.caseSensitive))
  }
  return { hits, frequency }
}

/** Candidate rowids for one page (no post-filter). */
function pageRowids(
  db: DatabaseSync,
  plan: QueryPlan,
  limit: number,
  offset: number,
  rankOrder: boolean,
): { rowids: number[]; scores: Map<number, number> } {
  const scores = new Map<number, number>()
  const sql = rankOrder
    ? `SELECT rowid AS rowid, rank AS score FROM docs WHERE ${plan.pageWhere} ORDER BY rank LIMIT ? OFFSET ?`
    : `SELECT rowid AS rowid FROM docs WHERE ${plan.pageWhere} LIMIT ? OFFSET ?`
  const rows = db.prepare(sql).all(...plan.pageParams, limit, offset) as Array<{ rowid?: number; score?: number }>
  const rowids: number[] = []
  for (const row of rows) {
    if (typeof row.rowid !== 'number') continue
    rowids.push(row.rowid)
    if (typeof row.score === 'number') scores.set(row.rowid, row.score)
  }
  return { rowids, scores }
}

/**
 * Candidate rowids for one wide page, fetched per document kind (0.20.2, P0-1).
 *
 * The adaptive-rank wide path skips bm25 and used to page in raw rowid order. A
 * full content build indexes sessions before files, so for a common word
 * (the/function/error) the lowest rowids — and therefore the whole page — were
 * session documents. Fetching the file page and the session page separately
 * makes the composition explicit: files fill the requested page first, and
 * sessions only fill slots the file page leaves empty, at most
 * WIDE_SESSION_MAX_SHARE of the requested page. A page a file-rich query
 * returns is therefore all files (the research prototype measured 100% files
 * versus 100% sessions before the fix).
 *
 * Kind filters go through docs_meta rowid sets instead of the FTS UNINDEXED
 * kind column: the session set is small, so the file page can skip it cheaply
 * even when the match list starts with thousands of session rows, and the
 * session page never has to materialize every file body to test the column.
 */
function widePageRowids(db: DatabaseSync, plan: QueryPlan, limit: number, offset: number): number[] {
  const fileRows = kindPageRowids(db, plan, 'file', limit, offset)
  const remaining = limit - fileRows.length
  const sessionQuota = Math.min(remaining, Math.floor(limit * WIDE_SESSION_MAX_SHARE))
  if (sessionQuota <= 0) return fileRows
  return fileRows.concat(kindPageRowids(db, plan, 'session', sessionQuota, offset))
}

/** One kind's page from the unranked matcher, in rowid order. */
function kindPageRowids(db: DatabaseSync, plan: QueryPlan, kind: 'file' | 'session', limit: number, offset: number): number[] {
  // Schema v4: the kind code is an integer docs_meta column; the rowid set still
  // drives the FTS probe exactly like the v3 text kind did.
  const sessionRowids = metaRowidsByKind(DOC_KIND_SESSION)
  const kindWhere = kind === 'file'
    ? ' AND rowid NOT IN (' + sessionRowids + ')'
    : ' AND rowid IN (' + sessionRowids + ')'
  const rows = db
    .prepare(`SELECT rowid AS rowid FROM docs WHERE ${plan.pageWhere}${kindWhere} LIMIT ? OFFSET ?`)
    .all(...plan.pageParams, limit, offset) as Array<{ rowid?: number }>
  const rowids: number[] = []
  for (const row of rows) {
    if (typeof row.rowid !== 'number') continue
    rowids.push(row.rowid)
  }
  return rowids
}

/** Exact COUNT over one WHERE fragment. */
function exactCount(db: DatabaseSync, where: string, params: readonly (string | number)[]): number {
  const row = db.prepare(`SELECT count(*) AS n FROM docs WHERE ${where}`).get(...params) as { n?: number } | undefined
  return Number(row?.n ?? 0)
}

/** Count up to limit + 1 rows: exact below the cap, bounded at the cap. */
function boundedCount(db: DatabaseSync, where: string, params: readonly (string | number)[], limit: number): ContentCount {
  const row = db
    .prepare(`SELECT count(*) AS n FROM (SELECT rowid FROM docs WHERE ${where} LIMIT ?)`)
    .get(...params, limit + 1) as { n?: number } | undefined
  const value = Number(row?.n ?? 0)
  if (value > limit) return { value: limit, kind: 'bounded', limit }
  return { value, kind: 'exact' }
}

/** Exact count over the plan's column filter fragment. */
function planExactCount(db: DatabaseSync, plan: QueryPlan): number {
  return exactCount(db, plan.countWhere, plan.countParams)
}

/** Bounded count over the plan's column filter fragment. */
function planBoundedCount(db: DatabaseSync, plan: QueryPlan, limit: number): ContentCount {
  return boundedCount(db, plan.countWhere, plan.countParams, limit)
}

/**
 * Count a workspace-scoped match set as its two narrow halves.
 *
 * Only possible when SQLite can drive each half from the docs_meta rowid set:
 * the guard counts the prefix candidates first and gives up (returns null) when
 * the rowid list would be broad enough to make random FTS probes slower than
 * the combined column scan.
 */
function compositeCount(db: DatabaseSync, plan: QueryPlan, limit: number): ContentCount | null {
  const composite = plan.composite
  if (composite === undefined) return null
  const candidates = db.prepare(COMPOSITE_CANDIDATE_SQL).get(composite.candidatePattern) as { n?: number } | undefined
  if (Number(candidates?.n ?? 0) > COMPOSITE_ROWID_LIMIT) return null
  const file = boundedCount(db, composite.fileWhere, composite.fileParams, limit)
  const session = composite.sessionWhere === null
    ? { value: 0, kind: 'exact' as const }
    : boundedCount(db, composite.sessionWhere, composite.sessionParams, limit)
  const total = file.value + session.value
  if (file.kind === 'bounded' || session.kind === 'bounded' || total > limit) return { value: limit, kind: 'bounded', limit }
  return { value: total, kind: 'exact' }
}

/**
 * Bounded count of the raw match set, ignoring every scope filter.
 *
 * bm25 sort cost is driven by how many documents match at all, not by how many
 * survive the scope filter: a session-scoped query for a word present in every
 * document still ranks the whole match set. One bounded count of the matcher
 * alone is the cheapest predictor of that cost (a few hundred microseconds) and
 * is what decides adaptive rank ordering.
 */
function matchProbe(db: DatabaseSync, plan: QueryPlan, limit: number): ContentCount {
  const row = db
    .prepare(`SELECT count(*) AS n FROM (SELECT rowid FROM docs WHERE ${plan.matchWhere} LIMIT ?)`)
    .get(...plan.matchParams, limit + 1) as { n?: number } | undefined
  const value = Number(row?.n ?? 0)
  if (value > limit) return { value: limit, kind: 'bounded', limit }
  return { value, kind: 'exact' }
}

/** Result for a query the caller cancelled before it could finish. */
function cancelledResult(): ContentSearchResult {
  return { hits: [], count: { value: 0, kind: 'unknown' }, warnings: ['content-search-cancelled'], error: 'content-search-cancelled' }
}

/**
 * Number of path separators: a cheap "is this near the root" signal for wide,
 * unranked pages.
 */
function pathDepth(path: string): number {
  let depth = 0
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index)
    if (code === 0x2f || code === 0x5c) depth++
  }
  return depth
}

/**
 * Cheap relevance heuristic for a wide page that skipped bm25.
 *
 * At most MAX_LIMIT hits are in hand, so any JS sort is free. Order: term
 * frequency (bounded sample), then documents whose title contains a query
 * term, then shallower paths (a word that appears everywhere usually means a
 * file near a root), then earlier match lines, then path order so a page is
 * deterministic. Frequency is 0 for callers that did not ask for samples.
 */
function lightSortHits(hits: ContentHit[], plan: HitPlan, frequency?: readonly number[]): ContentHit[] {
  const needles = plan.terms.filter(term => term !== '').map(term => plan.caseSensitive ? term : term.toLowerCase())
  const decorated = hits.map((hit, order) => {
    const title = plan.caseSensitive ? hit.title : hit.title.toLowerCase()
    let titleHits = 0
    for (const needle of needles) if (title.includes(needle)) titleHits++
    return {
      hit,
      order,
      freq: frequency?.[order] ?? 0,
      titleHits,
      depth: pathDepth(hit.path),
      line: hit.line ?? Number.MAX_SAFE_INTEGER,
    }
  })
  decorated.sort((a, b) =>
    b.freq - a.freq
    || b.titleHits - a.titleHits
    || a.depth - b.depth
    || a.line - b.line
    || a.hit.path.localeCompare(b.hit.path)
    || a.order - b.order)
  return decorated.map(entry => entry.hit)
}

/**
 * Sort one wide page group by kind.
 *
 * The file page and the session page are each re-sorted with the cheap
 * heuristic; files stay in front of sessions (P0-1 file priority). Frequency
 * samples arrive aligned with the unsorted hit list, so they are split by kind
 * here.
 */
function lightSortWideGroups(hits: ContentHit[], plan: HitPlan, frequency: readonly number[]): ContentHit[] {
  const files: ContentHit[] = []
  const sessions: ContentHit[] = []
  const fileFreq: number[] = []
  const sessionFreq: number[] = []
  for (const [index, hit] of hits.entries()) {
    const sample = frequency[index] ?? 0
    if (hit.kind === 'session') {
      sessions.push(hit)
      sessionFreq.push(sample)
    } else {
      files.push(hit)
      fileFreq.push(sample)
    }
  }
  return [...lightSortHits(files, plan, fileFreq), ...lightSortHits(sessions, plan, sessionFreq)]
}

/** A literal substring predicate for one term, matched against one column. */
function literalMatcher(column: string, term: string, caseSensitive: boolean): { sql: string; param: string } {
  // GLOB is byte-exact (case-sensitive) and works for any length; LIKE with an
  // explicit ESCAPE is the case-insensitive (ASCII folding) form. Both reuse
  // the same escaping helpers the FTS path uses.
  if (caseSensitive) return { sql: column + ' GLOB ?', param: '*' + escapeGlob(term) + '*' }
  return { sql: column + " LIKE ? ESCAPE '\\'", param: '%' + escapeLike(term) + '%' }
}

/**
 * Column names of the FTS5 content table backing `docs`, or null when the table
 * is not a regular (internally contented) FTS5 table.
 *
 * A full scan of the FTS5 virtual table costs ~300 ms of fixed startup on a
 * multi-GB corpus (the iterator materialises its position lists), which would
 * blow the fallback budget before any row is read. The content table is an
 * ordinary table whose `id` is the document rowid, so a bounded rowid range
 * scans in a millisecond. Columns are mapped from the `docs` column order
 * (c0 = first declared column), so a future schema column order does not
 * silently read the wrong column; if the content table is ever absent (an
 * external-content or contentless FTS5 schema) the caller falls back to the
 * virtual table, which is correct but slower.
 */
function shortFallbackContentTable(
  db: DatabaseSync,
): { body: string; kind: string; path: string; sessionId: string | null } | null {
  try {
    const exists = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'docs_content'")
      .get() as { ok?: number } | undefined
    if (exists === undefined) return null
    const columns = db.prepare('PRAGMA table_info(docs)').all() as Array<{ cid?: number; name?: string }>
    const indexes = new Map<string, number>()
    for (const column of columns) {
      if (typeof column.cid !== 'number' || typeof column.name !== 'string') continue
      indexes.set(column.name, column.cid)
    }
    const body = indexes.get('body')
    const kind = indexes.get('kind')
    const path = indexes.get('path')
    if (body === undefined || kind === undefined || path === undefined) return null
    const sessionId = indexes.get('session_id')
    return {
      body: 'c' + String(body),
      kind: 'c' + String(kind),
      path: 'c' + String(path),
      sessionId: sessionId === undefined ? null : 'c' + String(sessionId),
    }
  } catch {
    return null
  }
}

/** All terms present as (optionally whole-word) substrings of one body. */
function containsAllTerms(body: string, terms: readonly string[], caseSensitive: boolean, wholeWord: boolean): boolean {
  if (wholeWord) return matchesWholeWord(body, terms, caseSensitive)
  const hay = caseSensitive ? body : body.toLowerCase()
  for (const term of terms) {
    if (term === '') continue
    if (!hay.includes(caseSensitive ? term : term.toLowerCase())) return false
  }
  return true
}

/** Call context for the bounded short-query fallback. */
interface ShortFallbackContext {
  limit: number
  offset: number
  countMode: ContentCountMode
  countLimit: number
  pathPrefix: string | null
}

/**
 * Bounded fallback for a 2-codepoint query (0.20.2, P0-2).
 *
 * The trigram index cannot serve a term shorter than three codepoints, so
 * 'ai', 'js', '索引' used to be rejected outright. With shortQueryFallback this
 * path answers them instead, deterministically bounded in four ways:
 *
 * 1. Name hits first: documents whose stored path contains every term, newest
 *    first. A name match fills page slots before any body scan runs.
 * 2. The remaining slots come from a body scan split into explicit rowid-range
 *    chunks, so cancellation and the wall clock are observed between chunks
 *    (the whole query stops at SHORT_QUERY_FALLBACK_MAX_MS plus at most one
 *    chunk). SQL predicates carry an escaped LIKE/GLOB and the scan is a plain
 *    sequential walk of docs_content, never a full FTS match.
 * 3. The page stops the scan as soon as it is full; the count then reports a
 *    bounded floor instead of paying for a full exact count.
 * 4. Whole-word post-filtering reads bodies by rowid for the (few) SQL matches.
 *
 * File documents are returned when file scope is active. A pure session scope
 * (panel "this conversation") enumerates the one indexed session log and
 * matches its bodies in JS; there is no file page to prefer there.
 */
function shortQueryFallbackSearch(
  db: DatabaseSync,
  check: ContentQueryCheck,
  options: ContentSearchOptions,
  context: ShortFallbackContext,
): ContentSearchResult {
  const warnings = new Set<string>(check.warnings)
  warnings.add('content-query-short-fallback')
  const deadline = performance.now() + SHORT_QUERY_FALLBACK_MAX_MS
  const cancelled = (): boolean => typeof options.isCancelled === 'function' && options.isCancelled()
  const caseSensitive = options.caseSensitive === true
  const wholeWord = options.wholeWord === true
  const terms = check.terms
  const hitPlan: HitPlan = { terms, caseSensitive, wholeWord }
  const sessionPath = options.sessionPath ?? null
  const fileHitsAllRoots = options.fileHitsAllRoots === true
  const excluded = options.excludeSessions === true
    || (options.allowedSessionIds !== undefined && options.allowedSessionIds.length === 0)
  // Mirrors pageFilters: a pure session scope only admits that session log, so
  // it has no file document to hit; every other scope searches file documents.
  const sessionOnlyScope = sessionPath !== null && context.pathPrefix === null && !fileHitsAllRoots
  const filesInScope = !sessionOnlyScope
  if (sessionOnlyScope && excluded) {
    // The scope filter admits only session documents and the caller excluded
    // sessions: no document can match, so there is nothing to scan.
    return { hits: [], count: emptyCount(context.countMode), warnings: [...warnings], shortQueryFallback: true }
  }
  let wallClockHit = false

  if (filesInScope) {
    // Name hits: path matches from docs_meta joined to the normalized paths
    // dictionary (schema v4); still a small-table scan, newest first.
    const nameRows: number[] = []
    let nameComplete = true
    const nameLimit = Math.min(
      SHORT_QUERY_NAME_MAX_LIMIT,
      Math.max(SHORT_QUERY_NAME_MIN_LIMIT, context.offset + context.limit + 1),
    )
    if (nameLimit > 0) {
      const nameWhere: string[] = ['m.kind_id = ' + String(DOC_KIND_FILE)]
      const nameParams: Array<string | number> = []
      if (context.pathPrefix !== null) {
        nameWhere.push("p.path LIKE ? ESCAPE '\\'")
        nameParams.push(escapeLike(context.pathPrefix) + '%')
      }
      for (const term of terms) {
        const matcher = literalMatcher('p.path', term, caseSensitive)
        nameWhere.push(matcher.sql)
        nameParams.push(matcher.param)
      }
      const rows = db
        .prepare(`SELECT m.rowid AS rowid FROM docs_meta m JOIN paths p ON p.id = m.path_id WHERE ${nameWhere.join(' AND ')} ORDER BY m.mtime DESC LIMIT ?`)
        .all(...nameParams, nameLimit) as Array<{ rowid?: number }>
      for (const row of rows) {
        if (typeof row.rowid !== 'number') continue
        nameRows.push(row.rowid)
      }
      nameComplete = nameRows.length < nameLimit
    }
    if (cancelled()) return cancelledResult()
    const namePage = nameRows.slice(context.offset, context.offset + context.limit)
    const nameSet = new Set(nameRows)
    const bodyLimit = context.limit - namePage.length
    // A page already full of name hits needs no body scan at all.
    const bodyOffset = context.offset >= nameRows.length ? context.offset - nameRows.length : 0

    const bodyRows: number[] = []
    let bodyMatched = 0
    // A page already filled by name hits leaves no body slot; the unscanned
    // body hits then make the count a bounded floor instead of an exact count.
    let bodyStopped = bodyLimit <= 0
    if (bodyLimit > 0) {
      // Scan the FTS5 content table when it exists: it is an ordinary table
      // with the document rowid as INTEGER PRIMARY KEY, so one 512-row chunk
      // costs ~1 ms. Scanning the docs virtual table instead costs ~300 ms of
      // fixed FTS iterator startup per statement on a multi-GB corpus (measured
      // on the 4.1 GB live snapshot), which would exhaust the budget in six
      // chunks before the page filled.
      const contentColumns = shortFallbackContentTable(db)
      const table = contentColumns !== null ? 'docs_content' : 'docs'
      const key = contentColumns !== null ? 'id' : 'rowid'
      const bodyColumn = contentColumns !== null ? contentColumns.body : 'body'
      const kindColumn = contentColumns !== null ? contentColumns.kind : 'kind'
      const pathColumn = contentColumns !== null ? contentColumns.path : 'path'
      const bodyWhere: string[] = [kindColumn + " = 'file'"]
      const bodyParams: Array<string | number> = []
      if (context.pathPrefix !== null) {
        bodyWhere.push(pathColumn + " LIKE ? ESCAPE '\\'")
        bodyParams.push(escapeLike(context.pathPrefix) + '%')
      }
      for (const term of terms) {
        const matcher = literalMatcher(bodyColumn, term, caseSensitive)
        bodyWhere.push(matcher.sql)
        bodyParams.push(matcher.param)
      }
      const maxRow = db.prepare('SELECT max(rowid) AS n FROM docs_meta').get() as { n?: number } | undefined
      const maxRowid = Number(maxRow?.n ?? 0)
      const chunk = db.prepare(
        `SELECT ${key} AS rowid FROM ${table} WHERE ${key} > ? AND ${key} <= ? AND ${bodyWhere.join(' AND ')} ORDER BY ${key}`,
      )
      const bodyStatement = wholeWord
        ? db.prepare(`SELECT ${bodyColumn} AS body FROM ${table} WHERE ${key} = ?`)
        : null
      let chunkRows = SHORT_QUERY_FALLBACK_CHUNK_ROWS
      let cursor = 0
      while (cursor < maxRowid) {
        if (cancelled()) return cancelledResult()
        if (performance.now() >= deadline) {
          wallClockHit = true
          bodyStopped = true
          break
        }
        const high = Math.min(maxRowid, cursor + chunkRows)
        const chunkStarted = performance.now()
        const rows = chunk.all(cursor, high, ...bodyParams) as Array<{ rowid?: number }>
        // Shrink the next chunk when this one was slow (for example a run of
        // multi-MB extracted documents), so one chunk cannot overshoot the
        // remaining wall clock by much.
        if (performance.now() - chunkStarted > SHORT_QUERY_FALLBACK_SLOW_CHUNK_MS) {
          chunkRows = Math.max(SHORT_QUERY_FALLBACK_MIN_CHUNK_ROWS, Math.floor(chunkRows / 2))
        }
        for (const row of rows) {
          const rowid = row.rowid
          if (typeof rowid !== 'number' || nameSet.has(rowid)) continue
          if (bodyStatement !== null) {
            const body = (bodyStatement.get(rowid) as { body?: string } | undefined)?.body
            if (typeof body !== 'string' || !matchesWholeWord(body, terms, caseSensitive)) continue
          }
          bodyMatched++
          if (bodyMatched > bodyOffset && bodyRows.length < bodyLimit) bodyRows.push(rowid)
          if (bodyRows.length >= bodyLimit) {
            bodyStopped = true
            break
          }
          if (context.countMode !== 'none' && bodyMatched > context.countLimit) {
            bodyStopped = true
            break
          }
        }
        if (bodyStopped) break
        cursor = high
      }
    }

    const hits = buildHits(db, hitPlan, [...namePage, ...bodyRows], new Map()).hits
    const known = nameRows.length + bodyMatched
    return {
      hits,
      count: shortFallbackCount(known, nameComplete, bodyStopped, wallClockHit, context, warnings),
      warnings: [...warnings],
      shortQueryFallback: true,
    }
  }

  // Pure session scope: one session log, bodies matched in JS under the deadline.
  // Schema v4: the log path resolves through the paths dictionary and the kind
  // is the persisted integer code (session docs may share that log path).
  const sessionRows = (db
    .prepare('SELECT m.rowid AS rowid FROM docs_meta m JOIN paths p ON p.id = m.path_id WHERE p.path = ? AND m.kind_id = ' + String(DOC_KIND_SESSION) + ' ORDER BY m.rowid')
    .all(sessionPath) as Array<{ rowid?: number }>)
    .map(row => row.rowid)
    .filter((rowid): rowid is number => typeof rowid === 'number')
  const sessionColumns = shortFallbackContentTable(db)
  const sessionStatement = sessionColumns !== null && sessionColumns.sessionId !== null
    ? db.prepare(`SELECT ${sessionColumns.body} AS body, ${sessionColumns.sessionId} AS session_id FROM docs_content WHERE id = ?`)
    : db.prepare('SELECT body AS body, session_id AS session_id FROM docs WHERE rowid = ?')
  const allowedSessions = options.allowedSessionIds
  const archivedSessions = options.excludeArchivedSessions ?? []
  const pageRows: number[] = []
  let matched = 0
  let stopped = false
  for (const rowid of sessionRows) {
    if (cancelled()) return cancelledResult()
    if (performance.now() >= deadline) {
      wallClockHit = true
      stopped = true
      break
    }
    const row = sessionStatement.get(rowid) as { body?: string; session_id?: string | null } | undefined
    if (row === undefined || typeof row.body !== 'string') continue
    const sessionId = typeof row.session_id === 'string' ? row.session_id : null
    if (allowedSessions !== undefined && (sessionId === null || !allowedSessions.includes(sessionId))) continue
    if (sessionId !== null && archivedSessions.includes(sessionId)) continue
    if (!containsAllTerms(row.body, terms, caseSensitive, wholeWord)) continue
    matched++
    if (matched > context.offset && pageRows.length < context.limit) pageRows.push(rowid)
    if (pageRows.length >= context.limit) {
      stopped = true
      break
    }
    if (context.countMode !== 'none' && matched > context.countLimit) {
      stopped = true
      break
    }
  }
  const hits = buildHits(db, hitPlan, pageRows, new Map()).hits
  return {
    hits,
    count: shortFallbackCount(matched, true, stopped, wallClockHit, context, warnings),
    warnings: [...warnings],
    shortQueryFallback: true,
  }
}

/**
 * Count for the short-query fallback: exact only when the scan finished without
 * observing the page-full, count-cap or deadline stop; otherwise the known
 * number of matches becomes a bounded floor.
 */
function shortFallbackCount(
  known: number,
  nameComplete: boolean,
  stopped: boolean,
  wallClockHit: boolean,
  context: ShortFallbackContext,
  warnings: Set<string>,
): ContentCount {
  if (wallClockHit) warnings.add('content-query-short-fallback-truncated')
  if (context.countMode === 'none') return { value: 0, kind: 'unknown' }
  if (stopped || !nameComplete || known > context.countLimit) {
    warnings.add('bounded-count')
    return { value: Math.min(known, context.countLimit), kind: 'bounded', limit: context.countLimit }
  }
  return { value: known, kind: 'exact' }
}

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
export function configureSearchConnection(db: DatabaseSync): void {
  for (const sql of SEARCH_PRAGMAS) {
    try { db.exec(sql) } catch { /* optional tuning */ }
  }
}

/** A plan with a whole-word post-filter. */
interface WholeWordScan {
  rowids: number[]
  count: ContentCount
  warnings: string[]
  error?: string
}

/**
 * Scan candidates for whole-word matches under a hard budget.
 *
 * Reading every candidate body in JS is the only correct way to apply the
 * ASCII word-boundary rule, but a common word in a multi-GB corpus would keep
 * the worker (and the query) busy for minutes. Rows, body bytes and wall clock
 * are all capped: on any cap the scan stops, keeps the rowids found so far and
 * reports a bounded count plus a `scan-capped` warning. Session-scoped scans go
 * through the same budget, so a huge session cannot run unbounded either.
 *
 * The candidate query never uses bm25: the whole-word post-filter rewrites the
 * result set, so the rank order of the candidates is not the order of the hits.
 */
function scanWholeWord(
  db: DatabaseSync,
  plan: QueryPlan,
  limit: number,
  offset: number,
  countMode: ContentCountMode,
  countLimit: number,
  sessionScoped: boolean,
  budget: { maxRows: number; maxBytes: number; maxMs: number },
  isCancelled?: () => boolean,
): WholeWordScan {
  const warnings = new Set<string>()
  const rowids: number[] = []
  const iterator = db.prepare(`SELECT rowid AS rowid FROM docs WHERE ${plan.pageWhere}`).iterate(...plan.pageParams)
  const bodyStatement = db.prepare('SELECT body FROM docs WHERE rowid = ?')
  const deadline = performance.now() + budget.maxMs
  let count = 0
  let scannedRows = 0
  let scannedBytes = 0
  let capped = false
  let exhausted = true
  for (const raw of iterator) {
    if (isCancelled?.() === true) return { rowids: [], count: { value: 0, kind: 'unknown' }, warnings: ['content-search-cancelled'], error: 'content-search-cancelled' }
    scannedRows++
    if (scannedRows > budget.maxRows || scannedBytes >= budget.maxBytes || performance.now() > deadline) {
      capped = true
      exhausted = false
      break
    }
    const rowid = (raw as { rowid?: number }).rowid
    if (typeof rowid !== 'number') continue
    const row = bodyStatement.get(rowid) as { body?: string } | undefined
    if (row === undefined || typeof row.body !== 'string') continue
    scannedBytes += row.body.length
    if (!matchesWholeWord(row.body, plan.terms, plan.caseSensitive)) continue
    count++
    if (count > offset && rowids.length < limit) rowids.push(rowid)
    if (countMode === 'none') {
      if (rowids.length >= limit) {
        // The page is full; no count was requested, so stopping is safe.
        exhausted = false
        break
      }
    } else if (!sessionScoped && count > countLimit) {
      exhausted = false
      break
    }
  }
  if (capped) warnings.add('scan-capped')
  let result: ContentCount
  if (countMode === 'none') {
    result = { value: 0, kind: 'unknown' }
  } else if (count > countLimit) {
    // Above the cap: report the known floor, never an exact count we did not
    // finish. Global whole-word counts are deliberately bounded.
    warnings.add('bounded-count')
    result = { value: countLimit, kind: 'bounded', limit: countLimit }
  } else if (capped || !exhausted) {
    result = { value: count, kind: 'bounded', limit: countLimit }
  } else {
    result = { value: count, kind: 'exact' }
  }
  return { rowids, count: result, warnings: [...warnings] }
}

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
 * Short queries (0.20.2, P0-2): with options.shortQueryFallback a 2-codepoint
 * query is answered by the bounded name+body fallback (see
 * shortQueryFallbackSearch) instead of being rejected; the result carries
 * shortQueryFallback: true and a 'content-query-short-fallback' warning.
 * One-codepoint queries stay rejected.
 *
 * Counting (0.20.0, P1-3): the page uses rowid-subquery filters while the count
 * uses docs-column filters, and wide filtered sets report a bounded count
 * instead of paying an O(match-set) exact COUNT.
 *
 * Cancellation: synchronous by design, so it only observes an already-aborted
 * signal or a cancellation hook between SQL statements and scan rows; the async
 * layer converts a cancelled result into an AbortError rejection.
 */
export function searchContent(
  db: DatabaseSync,
  query: string,
  limit: number,
  options: ContentSearchOptions = {},
): ContentSearchResult {
  const capped = clampLimit(limit)
  const matchMode = options.matchMode ?? 'normal'
  const countMode = options.count ?? 'exact'
  const countLimit = clampCountLimit(options.countLimit)
  const degraded = options.degrade === true
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : null
  const cancelled = (): boolean => isCancelled !== null && isCancelled()
  if (options.signal?.aborted === true || cancelled()) return cancelledResult()

  if (matchMode === 'regex') {
    return {
      hits: [],
      count: { value: 0, kind: 'unknown' },
      warnings: ['content-regex-paused'],
      error: 'content-regex-not-supported',
    }
  }

  const check = checkContentQuery(query, matchMode, { allowShort: options.shortQueryFallback === true })
  const warnings = [...check.warnings]
  if (!check.ok) {
    return {
      hits: [],
      count: { value: 0, kind: 'unknown' },
      warnings,
      error: check.error ?? 'content-query-invalid',
    }
  }
  if (check.terms.length === 0) return { hits: [], count: emptyCount(countMode), warnings }

  const pathPrefix = normalizePathPrefix(options.pathPrefix)
  // P0-2: a 2-codepoint query is answered by the bounded fallback instead of
  // the trigram matcher. The fallback owns its own scope filters and page.
  if (check.short) {
    return shortQueryFallbackSearch(db, check, options, {
      limit: capped,
      offset,
      countMode,
      countLimit,
      pathPrefix,
    })
  }
  const plan = buildPlan(check.terms, {
    caseSensitive: options.caseSensitive === true,
    wholeWord: options.wholeWord === true,
    phrase: check.phrase,
    sessionPath: options.sessionPath ?? null,
    pathPrefix,
    excludeSessions: options.excludeSessions === true,
    fileHitsAllRoots: options.fileHitsAllRoots === true,
    archivedExcluded: options.excludeArchivedSessions ?? [],
    allowedSessions: options.allowedSessionIds === undefined ? null : options.allowedSessionIds,
  })
  if (plan === null) return { hits: [], count: emptyCount(countMode), warnings }

  // The degraded profile keeps the worst query cheap: bounded counting and no
  // bm25 sort. scanWholeWord already self-limits, so it only needs the count cap.
  const effectiveCountLimit = degraded ? Math.min(countLimit, DEGRADED_COUNT_LIMIT) : countLimit
  if (degraded) warnings.push('query-degraded')

  if (plan.wholeWord) {
    // Only a pure session scope may count without a bound; a workspace/file
    // prefix still scans a potentially large corpus, so keep counts bounded.
    const sessionScoped = options.sessionPath != null && pathPrefix === null && options.excludeSessions !== true && options.fileHitsAllRoots !== true
    const scanned = scanWholeWord(db, plan, capped, offset, countMode, effectiveCountLimit, sessionScoped, resolveScanBudget(options.scanBudget), isCancelled ?? undefined)
    for (const warning of scanned.warnings) warnings.push(warning)
    if (scanned.error !== undefined) return { hits: [], count: { value: 0, kind: 'unknown' }, warnings: [...new Set(warnings)], error: scanned.error }
    const hits = buildHits(db, plan, scanned.rowids, new Map()).hits
    return { hits, count: scanned.count, warnings: [...new Set(warnings)] }
  }

  // P0-6: one bounded probe of the raw match set decides whether bm25 ranking
  // is affordable. Scope filters are intentionally ignored here: the rank cost
  // is driven by the matcher, so a session-scoped query for a word present in
  // every document is just as expensive to rank.
  let rankOrder = plan.rankCapable && !degraded
  let wide = false
  if (rankOrder && options.rankAdaptive !== false) {
    wide = matchProbe(db, plan, RANK_ADAPTIVE_THRESHOLD).kind === 'bounded'
    rankOrder = !wide
  }
  if (cancelled()) return cancelledResult()

  let count: ContentCount
  if (countMode === 'none') {
    count = { value: 0, kind: 'unknown' }
  } else {
    // A wide or full-scan set first tries the split workspace count: two narrow
    // rowid-driven halves instead of one OR-clause scan over every match.
    const split = wide || plan.countBounded || degraded ? compositeCount(db, plan, effectiveCountLimit) : null
    if (countMode === 'bounded' || plan.countBounded || degraded || (wide && plan.filtered)) {
      // GLOB bodies, the degraded profile and wide filtered sets cannot be
      // counted exactly without reading the whole match set: report the floor.
      count = split ?? planBoundedCount(db, plan, effectiveCountLimit)
      if (count.kind === 'bounded') warnings.push('bounded-count')
    } else {
      // Unfiltered FTS counts are cheap even for tens of thousands of matches.
      count = { value: planExactCount(db, plan), kind: 'exact' }
    }
  }
  if (cancelled()) return cancelledResult()

  // Narrow sets keep the exact bm25 order (unchanged 0.20.1 behavior). A wide
  // unranked set pages per document kind (P0-1): files first, sessions capped,
  // each group re-sorted in-page by the cheap frequency/title/depth/line
  // heuristic. Other unranked paths (GLOB bodies, the degraded profile) keep
  // one rowid page but still get the in-page re-sort.
  let hits: ContentHit[]
  if (rankOrder) {
    const page = pageRowids(db, plan, capped, offset, true)
    hits = buildHits(db, plan, page.rowids, page.scores).hits
  } else if (wide && plan.canHitFiles && plan.canHitSessions) {
    const built = buildHits(db, plan, widePageRowids(db, plan, capped, offset), new Map(), true)
    hits = lightSortWideGroups(built.hits, plan, built.frequency)
  } else {
    const page = pageRowids(db, plan, capped, offset, false)
    const built = buildHits(db, plan, page.rowids, new Map(), true)
    hits = lightSortHits(built.hits, plan, built.frequency)
  }
  return { hits, count, warnings: [...new Set(warnings)] }
}
