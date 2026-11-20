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
import { sep } from 'node:path';
/** Shortest text a trigram tokenizer can index. */
const TRIGRAM_MIN = 3;
/** Query entry limits: no unbounded parsing, no unbounded SQL. */
const MAX_QUERY_CODEPOINTS = 256;
const MAX_QUERY_TERMS = 32;
const MAX_LIMIT = 100;
const DEFAULT_COUNT_LIMIT = 1000;
const MAX_COUNT_LIMIT = 5000;
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 120;
const SNIPPET_MAX = 400;
/** Whole-word post-filter defaults (rows, body bytes, wall clock). */
const SCAN_MAX_ROWS = 5_000;
const SCAN_MAX_BYTES = 64 * 1024 * 1024;
const SCAN_MAX_MS = 800;
/**
 * Raw match count above which bm25 ordering stops paying for itself. The probe
 * that reads it is a bounded count (a few hundred microseconds); ranking costs
 * O(matches) and is the dominant cost for common words on a multi-GB corpus.
 */
export const RANK_ADAPTIVE_THRESHOLD = 2_000;
/** Counting cap applied while the worker is in its degraded profile. */
export const DEGRADED_COUNT_LIMIT = 500;
/**
 * Candidate-rowid cap for the split workspace count. Above it the rowid probe
 * list is so broad that the combined column count wins; below it the two narrow
 * halves are an order of magnitude cheaper.
 */
const COMPOSITE_ROWID_LIMIT = 5_000;
/** docs_meta candidate count used as the split-count guard. */
const COMPOSITE_CANDIDATE_SQL = "SELECT count(*) AS n FROM docs_meta WHERE path LIKE ? ESCAPE '\\'";
/** Read-only connection pragmas for content search (worker and embedders). */
const SEARCH_PRAGMAS = [
    'PRAGMA busy_timeout = 5000',
    'PRAGMA query_only = ON',
    'PRAGMA cache_size = -16384',
    'PRAGMA mmap_size = 268435456',
    'PRAGMA temp_store = MEMORY',
];
/** Bytes that count as "inside a word", matching the name engine. */
const WORD_BYTE = /[A-Za-z0-9_]/;
/** Control bytes: file names cannot contain them, so name patterns drop them. */
const CONTROL_CHARS = /[\u0000-\u001f]/;
/**
 * Control bytes rejected in a content query. Tab/LF/CR stay allowed: they are
 * ordinary term separators in normal mode and explicit escapes in extended
 * mode. NUL and the other C0 bytes must never reach SQLite.
 */
const QUERY_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
/** Text escaped for an FTS5 quoted phrase (`"` doubled). */
export function quoteFts(text) {
    return '"' + text.replace(/"/g, '""') + '"';
}
/** Escape a literal for SQLite GLOB (`*`, `?`, `[`, `]`). */
export function escapeGlob(text) {
    return text.replace(/[*?[\]]/g, ch => (ch === ']' ? '[]]' : '[' + ch + ']'));
}
/** Escape a literal for SQL LIKE with `ESCAPE '\'`. */
export function escapeLike(text) {
    return text.replace(/[\\%_]/g, ch => '\\' + ch);
}
/**
 * Decode Notepad++-style extended escapes: `\n`, `\r`, `\t`, `\0`, `\\`,
 * `\xNN`. Unknown escapes are kept literally with a warning.
 */
export function decodeExtended(input) {
    const warnings = new Set();
    let text = '';
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch !== '\\') {
            text += ch;
            continue;
        }
        const next = input[i + 1];
        if (next === undefined) {
            warnings.add('extended-trailing-backslash');
            text += '\\';
            continue;
        }
        switch (next) {
            case 'n':
                text += '\n';
                i++;
                continue;
            case 'r':
                text += '\r';
                i++;
                continue;
            case 't':
                text += '\t';
                i++;
                continue;
            case '0':
                text += '\0';
                warnings.add('extended-control-char');
                i++;
                continue;
            case '\\':
                text += '\\';
                i++;
                continue;
            case 'x': {
                const hex = input.slice(i + 2, i + 4);
                if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
                    return { ok: false, text: '', warnings: [...warnings], error: 'invalid-escape' };
                }
                const code = Number.parseInt(hex, 16);
                text += String.fromCharCode(code);
                if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
                    warnings.add('extended-control-char');
                i += 3;
                continue;
            }
            default:
                warnings.add('extended-unknown-escape');
                text += '\\' + next;
                i++;
        }
    }
    return { ok: true, text, warnings: [...warnings] };
}
/**
 * Extended decoding for file names: names cannot contain control characters, so
 * they are dropped from the pattern and reported instead of silently matching
 * nothing.
 */
export function decodeExtendedForNames(input) {
    const decoded = decodeExtended(input);
    if (!decoded.ok)
        return decoded;
    const kept = decoded.text.replace(CONTROL_CHARS, '');
    if (kept !== decoded.text)
        decoded.warnings.push('name-extended-control-char');
    return { ...decoded, text: kept };
}
/** Length in Unicode code points, so emoji count as one character. */
function codePointCount(text) {
    return Array.from(text).length;
}
/** Whether text still contains a byte the content query must reject. */
function hasControlChars(text) {
    return QUERY_CONTROL_CHARS.test(text);
}
/** Split a normal-mode query on whitespace, dropping empty terms. */
function splitTerms(text) {
    return text.split(/\s+/).map(part => part.replace(/^"|"$/g, '')).filter(part => part !== '');
}
/** Split decoded extended text into words for the entry checks. */
function splitWords(text) {
    return text.split(/\s+/).filter(part => part !== '');
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
export function checkContentQuery(query, matchMode) {
    const warnings = [];
    const text = query.trim();
    if (text === '')
        return { ok: true, terms: [], phrase: false, warnings };
    if (codePointCount(text) > MAX_QUERY_CODEPOINTS) {
        return { ok: false, terms: [], phrase: false, warnings, error: 'content-query-too-long' };
    }
    if (hasControlChars(text)) {
        // A NUL (or other C0 byte) in the query must never be passed to SQLite:
        // some string paths would stop at it and turn the query into "match
        // everything". Reject it explicitly instead.
        return { ok: false, terms: [], phrase: false, warnings, error: 'invalid-control-char' };
    }
    if (matchMode === 'extended') {
        const decoded = decodeExtended(text);
        warnings.push(...decoded.warnings);
        if (!decoded.ok) {
            return { ok: false, terms: [], phrase: false, warnings, error: decoded.error ?? 'invalid-escape' };
        }
        if (hasControlChars(decoded.text)) {
            return { ok: false, terms: [], phrase: false, warnings, error: 'invalid-control-char' };
        }
        const words = splitWords(decoded.text);
        if (words.length === 0)
            return { ok: true, terms: [], phrase: true, warnings };
        if (words.length > MAX_QUERY_TERMS) {
            return { ok: false, terms: [], phrase: true, warnings, error: 'content-query-too-many-terms' };
        }
        if (words.some(word => codePointCount(word) < TRIGRAM_MIN)) {
            return { ok: false, terms: [], phrase: true, warnings, error: 'content-query-too-short' };
        }
        return { ok: true, terms: [decoded.text], phrase: true, warnings };
    }
    const terms = splitTerms(text);
    if (terms.length > MAX_QUERY_TERMS) {
        return { ok: false, terms: [], phrase: false, warnings, error: 'content-query-too-many-terms' };
    }
    if (terms.some(term => codePointCount(term) < TRIGRAM_MIN)) {
        return { ok: false, terms: [], phrase: false, warnings, error: 'content-query-too-short' };
    }
    return { ok: true, terms, phrase: false, warnings };
}
/** Whether `index` starts a whole-word occurrence of `length` bytes. */
export function isWholeWord(hay, index, length) {
    const left = index === 0 || !WORD_BYTE.test(hay[index - 1] ?? '');
    const end = index + length;
    const right = end >= hay.length || !WORD_BYTE.test(hay[end] ?? '');
    return left && right;
}
/** First whole-word (or plain) occurrence of any term, or null. */
export function locateMatch(body, terms, caseSensitive, wholeWord) {
    const hay = caseSensitive ? body : body.toLowerCase();
    let best = null;
    for (const term of terms) {
        if (term === '')
            continue;
        const needle = caseSensitive ? term : term.toLowerCase();
        let from = 0;
        while (from <= hay.length) {
            const index = hay.indexOf(needle, from);
            if (index < 0)
                break;
            if (!wholeWord || isWholeWord(hay, index, needle.length)) {
                if (best === null || index < best.index)
                    best = { index, length: needle.length };
                break;
            }
            from = index + 1;
        }
    }
    return best;
}
/** Every term must appear as a whole word (normal mode) or the literal must
 *  have non-word edges (extended mode is a single "term"). */
function matchesWholeWord(body, terms, caseSensitive) {
    for (const term of terms) {
        if (term === '')
            continue;
        if (locateMatch(body, [term], caseSensitive, true) === null)
            return false;
    }
    return true;
}
/** 1-based line number of a byte offset. */
export function lineOf(body, index) {
    let line = 1;
    let from = 0;
    for (;;) {
        const next = body.indexOf('\n', from);
        if (next < 0 || next >= index)
            return line;
        line++;
        from = next + 1;
    }
}
/** Bounded, single-line snippet around the first match. */
function makeSnippet(body, located) {
    if (located === null) {
        const flat = body.replace(/\s+/g, ' ').trim();
        return flat.length > SNIPPET_MAX ? flat.slice(0, SNIPPET_MAX - 1) + '…' : flat;
    }
    const start = Math.max(0, located.index - SNIPPET_BEFORE);
    const end = Math.min(body.length, located.index + located.length + SNIPPET_AFTER);
    const flat = body.slice(start, end).replace(/\s+/g, ' ');
    const text = (start > 0 ? '…' : '') + flat + (end < body.length ? '…' : '');
    return text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX - 1) + '…' : text;
}
function emptyCount(mode) {
    if (mode === 'none')
        return { value: 0, kind: 'unknown' };
    return { value: 0, kind: 'exact' };
}
function clampLimit(limit) {
    return Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limit) ? Math.trunc(limit) : MAX_LIMIT));
}
function clampCountLimit(limit) {
    if (limit === undefined || !Number.isFinite(limit))
        return DEFAULT_COUNT_LIMIT;
    return Math.max(1, Math.min(MAX_COUNT_LIMIT, Math.trunc(limit)));
}
/** A positive integer override, or the default when unset/invalid. */
function budgetValue(value, fallback) {
    if (value === undefined || !Number.isFinite(value) || value < 0)
        return fallback;
    return Math.trunc(value);
}
function resolveScanBudget(budget) {
    return {
        maxRows: budgetValue(budget?.maxRows, SCAN_MAX_ROWS),
        maxBytes: budgetValue(budget?.maxBytes, SCAN_MAX_BYTES),
        maxMs: budgetValue(budget?.maxMs, SCAN_MAX_MS),
    };
}
/** Normalize the optional path-prefix filter; keep the platform separator. */
function normalizePathPrefix(prefix) {
    if (typeof prefix !== 'string')
        return null;
    const trimmed = prefix.trim();
    if (trimmed === '')
        return null;
    if (trimmed.endsWith('/') || trimmed.endsWith('\\'))
        return trimmed;
    return trimmed + sep;
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
function pageFilters(filters) {
    const { sessionPath, pathPrefix, excludeSessions, fileHitsAllRoots, archivedExcluded, allowedSessions } = filters;
    const sql = [];
    const params = [];
    if (sessionPath !== null && pathPrefix !== null) {
        // Workspace scope has two halves: session rows from the caller's session
        // log, file rows under the caller's cwd. They must be composed by kind —
        // ANDing the two path filters matched no row at all (0.11.0–0.11.6 bug),
        // so file bodies were never searchable in workspace scope.
        sql.push(" AND ((kind = 'session' AND rowid IN (SELECT rowid FROM docs_meta WHERE path = ?)) OR (kind = 'file' AND rowid IN (SELECT rowid FROM docs_meta WHERE path LIKE ? ESCAPE '\\')))");
        params.push(sessionPath, escapeLike(pathPrefix) + '%');
    }
    else if (sessionPath !== null && fileHitsAllRoots) {
        // The caller cwd is outside every indexed root: file documents come from
        // the whole index, session documents still from the caller's session log.
        sql.push(" AND ((kind = 'session' AND rowid IN (SELECT rowid FROM docs_meta WHERE path = ?)) OR kind = 'file')");
        params.push(sessionPath);
    }
    else if (sessionPath !== null) {
        // Pure session scope (panel "this conversation", sessionId-only requests).
        sql.push(' AND rowid IN (SELECT rowid FROM docs_meta WHERE path = ?)');
        params.push(sessionPath);
    }
    else if (pathPrefix !== null) {
        // File scope without a session: session rows stay available as before.
        sql.push(" AND (kind = 'session' OR rowid IN (SELECT rowid FROM docs_meta WHERE path LIKE ? ESCAPE '\\'))");
        params.push(escapeLike(pathPrefix) + '%');
    }
    if (excludeSessions)
        sql.push(" AND kind = 'file'");
    if (allowedSessions !== null) {
        // Caller authorization for session documents; file documents are scoped by
        // the roots/cwd filters instead. An empty allow-list keeps only files.
        if (allowedSessions.length === 0)
            sql.push(" AND kind = 'file'");
        else {
            sql.push(` AND (kind = 'file' OR session_id IN (${allowedSessions.map(() => '?').join(', ')}))`);
            params.push(...allowedSessions);
        }
    }
    if (archivedExcluded.length > 0) {
        // Archived session logs are indexed but hidden by default; file documents
        // have no session id and must stay visible.
        sql.push(` AND (kind = 'file' OR session_id IS NULL OR session_id NOT IN (${archivedExcluded.map(() => '?').join(', ')}))`);
        params.push(...archivedExcluded);
    }
    return { sql: sql.join(''), params };
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
 */
function countFilters(filters) {
    const { sessionPath, pathPrefix, excludeSessions, fileHitsAllRoots, archivedExcluded, allowedSessions } = filters;
    const sql = [];
    const params = [];
    if (sessionPath !== null && pathPrefix !== null) {
        sql.push(" AND ((kind = 'session' AND path = ?) OR (kind = 'file' AND path LIKE ? ESCAPE '\\'))");
        params.push(sessionPath, escapeLike(pathPrefix) + '%');
    }
    else if (sessionPath !== null && fileHitsAllRoots) {
        sql.push(" AND ((kind = 'session' AND path = ?) OR kind = 'file')");
        params.push(sessionPath);
    }
    else if (sessionPath !== null) {
        sql.push(' AND rowid IN (SELECT rowid FROM docs_meta WHERE path = ?)');
        params.push(sessionPath);
    }
    else if (pathPrefix !== null) {
        sql.push(" AND (kind = 'session' OR path LIKE ? ESCAPE '\\')");
        params.push(escapeLike(pathPrefix) + '%');
    }
    if (excludeSessions)
        sql.push(" AND kind = 'file'");
    if (allowedSessions !== null) {
        if (allowedSessions.length === 0)
            sql.push(" AND kind = 'file'");
        else {
            sql.push(` AND (kind = 'file' OR session_id IN (${allowedSessions.map(() => '?').join(', ')}))`);
            params.push(...allowedSessions);
        }
    }
    if (archivedExcluded.length > 0) {
        sql.push(` AND (kind = 'file' OR session_id IS NULL OR session_id NOT IN (${archivedExcluded.map(() => '?').join(', ')}))`);
        params.push(...archivedExcluded);
    }
    return { sql: sql.join(''), params };
}
/**
 * Build the split count plan for workspace scope, if this plan has one.
 *
 * File documents are filtered by the cwd prefix only; session documents by the
 * session log path plus the caller/archived authorization filters (file
 * documents have no session id, so those filters never apply to them).
 */
function compositeCountPlan(filters, matchWhere, matchParams) {
    const { sessionPath, pathPrefix, excludeSessions, allowedSessions, archivedExcluded } = filters;
    if (sessionPath === null || pathPrefix === null)
        return null;
    const pattern = escapeLike(pathPrefix) + '%';
    const fileWhere = matchWhere + " AND kind = 'file' AND rowid IN (SELECT rowid FROM docs_meta WHERE path LIKE ? ESCAPE '\\')";
    const sessionParams = [...matchParams, sessionPath];
    let sessionWhere = matchWhere + " AND kind = 'session' AND rowid IN (SELECT rowid FROM docs_meta WHERE path = ?)";
    if (excludeSessions === true || (allowedSessions !== null && allowedSessions.length === 0)) {
        sessionWhere = null;
        sessionParams.length = 0;
    }
    else if (allowedSessions !== null) {
        sessionWhere += ` AND session_id IN (${allowedSessions.map(() => '?').join(', ')})`;
        sessionParams.push(...allowedSessions);
    }
    if (sessionWhere !== null && archivedExcluded.length > 0) {
        sessionWhere += ` AND (session_id IS NULL OR session_id NOT IN (${archivedExcluded.map(() => '?').join(', ')}))`;
        sessionParams.push(...archivedExcluded);
    }
    return { fileWhere, fileParams: [...matchParams, pattern], sessionWhere, sessionParams, candidatePattern: pattern };
}
function buildPlan(terms, options) {
    const { caseSensitive, wholeWord, phrase } = options;
    if (terms.length === 0)
        return null;
    const filters = {
        sessionPath: options.sessionPath,
        pathPrefix: options.pathPrefix,
        excludeSessions: options.excludeSessions,
        fileHitsAllRoots: options.fileHitsAllRoots,
        archivedExcluded: options.archivedExcluded,
        allowedSessions: options.allowedSessions,
    };
    const page = pageFilters(filters);
    const count = countFilters(filters);
    const filtered = page.sql !== '';
    const plan = (matchWhere, matchParams, rankCapable, countBounded) => {
        const composite = compositeCountPlan(filters, matchWhere, matchParams);
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
            ...(composite === null ? {} : { composite }),
        };
    };
    if (phrase) {
        const literal = terms[0];
        if (caseSensitive)
            return plan('body GLOB ?', ['*' + escapeGlob(literal) + '*'], false, true);
        return plan('docs MATCH ?', [quoteFts(literal)], true, false);
    }
    if (caseSensitive) {
        return plan(terms.map(() => 'body GLOB ?').join(' AND '), terms.map(term => '*' + escapeGlob(term) + '*'), false, true);
    }
    return plan('docs MATCH ?', [terms.map(quoteFts).join(' AND ')], true, false);
}
const DOC_SQL = `SELECT d.kind AS kind, d.path AS path, d.title AS title,
  d.session_id AS session_id, d.message_id AS message_id, d.body AS body,
  m.node_key AS node_key
  FROM docs d LEFT JOIN docs_meta m ON m.rowid = d.rowid
  WHERE d.rowid = ?`;
/** Build hits from rowids: metadata, snippet, first-match line and score. */
function buildHits(db, plan, rowids, scores) {
    const statement = db.prepare(DOC_SQL);
    const hits = [];
    for (const rowid of rowids) {
        const row = statement.get(rowid);
        if (row === undefined || typeof row.body !== 'string')
            continue;
        const located = locateMatch(row.body, plan.terms, plan.caseSensitive, plan.wholeWord);
        const line = located === null ? undefined : lineOf(row.body, located.index);
        const score = scores.get(rowid);
        const hit = {
            kind: row.kind === 'session' ? 'session' : 'file',
            path: typeof row.path === 'string' ? row.path : '',
            title: typeof row.title === 'string' ? row.title : '',
            snippet: makeSnippet(row.body, located),
            score: score === undefined ? 0 : score,
            ...(typeof row.session_id === 'string' && row.session_id !== '' ? { sessionId: row.session_id } : {}),
            ...(typeof row.message_id === 'string' && row.message_id !== '' ? { messageId: row.message_id } : {}),
            ...(typeof row.node_key === 'string' && row.node_key !== '' ? { nodeKey: row.node_key } : {}),
            ...(line === undefined ? {} : { line }),
        };
        hits.push(hit);
    }
    return hits;
}
/** Candidate rowids for one page (no post-filter). */
function pageRowids(db, plan, limit, offset, rankOrder) {
    const scores = new Map();
    const sql = rankOrder
        ? `SELECT rowid AS rowid, rank AS score FROM docs WHERE ${plan.pageWhere} ORDER BY rank LIMIT ? OFFSET ?`
        : `SELECT rowid AS rowid FROM docs WHERE ${plan.pageWhere} LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(...plan.pageParams, limit, offset);
    const rowids = [];
    for (const row of rows) {
        if (typeof row.rowid !== 'number')
            continue;
        rowids.push(row.rowid);
        if (typeof row.score === 'number')
            scores.set(row.rowid, row.score);
    }
    return { rowids, scores };
}
/** Exact COUNT over one WHERE fragment. */
function exactCount(db, where, params) {
    const row = db.prepare(`SELECT count(*) AS n FROM docs WHERE ${where}`).get(...params);
    return Number(row?.n ?? 0);
}
/** Count up to limit + 1 rows: exact below the cap, bounded at the cap. */
function boundedCount(db, where, params, limit) {
    const row = db
        .prepare(`SELECT count(*) AS n FROM (SELECT rowid FROM docs WHERE ${where} LIMIT ?)`)
        .get(...params, limit + 1);
    const value = Number(row?.n ?? 0);
    if (value > limit)
        return { value: limit, kind: 'bounded', limit };
    return { value, kind: 'exact' };
}
/** Exact count over the plan's column filter fragment. */
function planExactCount(db, plan) {
    return exactCount(db, plan.countWhere, plan.countParams);
}
/** Bounded count over the plan's column filter fragment. */
function planBoundedCount(db, plan, limit) {
    return boundedCount(db, plan.countWhere, plan.countParams, limit);
}
/**
 * Count a workspace-scoped match set as its two narrow halves.
 *
 * Only possible when SQLite can drive each half from the docs_meta rowid set:
 * the guard counts the prefix candidates first and gives up (returns null) when
 * the rowid list would be broad enough to make random FTS probes slower than
 * the combined column scan.
 */
function compositeCount(db, plan, limit) {
    const composite = plan.composite;
    if (composite === undefined)
        return null;
    const candidates = db.prepare(COMPOSITE_CANDIDATE_SQL).get(composite.candidatePattern);
    if (Number(candidates?.n ?? 0) > COMPOSITE_ROWID_LIMIT)
        return null;
    const file = boundedCount(db, composite.fileWhere, composite.fileParams, limit);
    const session = composite.sessionWhere === null
        ? { value: 0, kind: 'exact' }
        : boundedCount(db, composite.sessionWhere, composite.sessionParams, limit);
    const total = file.value + session.value;
    if (file.kind === 'bounded' || session.kind === 'bounded' || total > limit)
        return { value: limit, kind: 'bounded', limit };
    return { value: total, kind: 'exact' };
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
function matchProbe(db, plan, limit) {
    const row = db
        .prepare(`SELECT count(*) AS n FROM (SELECT rowid FROM docs WHERE ${plan.matchWhere} LIMIT ?)`)
        .get(...plan.matchParams, limit + 1);
    const value = Number(row?.n ?? 0);
    if (value > limit)
        return { value: limit, kind: 'bounded', limit };
    return { value, kind: 'exact' };
}
/** Result for a query the caller cancelled before it could finish. */
function cancelledResult() {
    return { hits: [], count: { value: 0, kind: 'unknown' }, warnings: ['content-search-cancelled'], error: 'content-search-cancelled' };
}
/**
 * Number of path separators: a cheap "is this near the root" signal for wide,
 * unranked pages.
 */
function pathDepth(path) {
    let depth = 0;
    for (let index = 0; index < path.length; index++) {
        const code = path.charCodeAt(index);
        if (code === 0x2f || code === 0x5c)
            depth++;
    }
    return depth;
}
/**
 * Cheap relevance heuristic for a wide page that skipped bm25.
 *
 * At most MAX_LIMIT hits are in hand, so any JS sort is free. Documents whose
 * title contains a query term come first, then shallower paths (a word that
 * appears everywhere usually means a file near a root), then earlier match
 * lines, then path order so a page is deterministic.
 */
function lightSortHits(hits, plan) {
    const needles = plan.terms.filter(term => term !== '').map(term => plan.caseSensitive ? term : term.toLowerCase());
    const decorated = hits.map((hit, order) => {
        const title = plan.caseSensitive ? hit.title : hit.title.toLowerCase();
        let titleHits = 0;
        for (const needle of needles)
            if (title.includes(needle))
                titleHits++;
        return { hit, order, titleHits, depth: pathDepth(hit.path), line: hit.line ?? Number.MAX_SAFE_INTEGER };
    });
    decorated.sort((a, b) => b.titleHits - a.titleHits
        || a.depth - b.depth
        || a.line - b.line
        || a.hit.path.localeCompare(b.hit.path)
        || a.order - b.order);
    return decorated.map(entry => entry.hit);
}
/**
 * Put a read-only content connection into the search profile (P2).
 *
 * Search workers each get a 16 MiB page cache and a 256 MiB mmap window so
 * repeated queries keep their FTS pages warm without touching the build
 * connection. Failures are ignored: an older SQLite or a filesystem that
 * rejects mmap must never stop search from working.
 */
export function configureSearchConnection(db) {
    for (const sql of SEARCH_PRAGMAS) {
        try {
            db.exec(sql);
        }
        catch { /* optional tuning */ }
    }
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
function scanWholeWord(db, plan, limit, offset, countMode, countLimit, sessionScoped, budget, isCancelled) {
    const warnings = new Set();
    const rowids = [];
    const iterator = db.prepare(`SELECT rowid AS rowid FROM docs WHERE ${plan.pageWhere}`).iterate(...plan.pageParams);
    const bodyStatement = db.prepare('SELECT body FROM docs WHERE rowid = ?');
    const deadline = performance.now() + budget.maxMs;
    let count = 0;
    let scannedRows = 0;
    let scannedBytes = 0;
    let capped = false;
    let exhausted = true;
    for (const raw of iterator) {
        if (isCancelled?.() === true)
            return { rowids: [], count: { value: 0, kind: 'unknown' }, warnings: ['content-search-cancelled'], error: 'content-search-cancelled' };
        scannedRows++;
        if (scannedRows > budget.maxRows || scannedBytes >= budget.maxBytes || performance.now() > deadline) {
            capped = true;
            exhausted = false;
            break;
        }
        const rowid = raw.rowid;
        if (typeof rowid !== 'number')
            continue;
        const row = bodyStatement.get(rowid);
        if (row === undefined || typeof row.body !== 'string')
            continue;
        scannedBytes += row.body.length;
        if (!matchesWholeWord(row.body, plan.terms, plan.caseSensitive))
            continue;
        count++;
        if (count > offset && rowids.length < limit)
            rowids.push(rowid);
        if (countMode === 'none') {
            if (rowids.length >= limit) {
                // The page is full; no count was requested, so stopping is safe.
                exhausted = false;
                break;
            }
        }
        else if (!sessionScoped && count > countLimit) {
            exhausted = false;
            break;
        }
    }
    if (capped)
        warnings.add('scan-capped');
    let result;
    if (countMode === 'none') {
        result = { value: 0, kind: 'unknown' };
    }
    else if (count > countLimit) {
        // Above the cap: report the known floor, never an exact count we did not
        // finish. Global whole-word counts are deliberately bounded.
        warnings.add('bounded-count');
        result = { value: countLimit, kind: 'bounded', limit: countLimit };
    }
    else if (capped || !exhausted) {
        result = { value: count, kind: 'bounded', limit: countLimit };
    }
    else {
        result = { value: count, kind: 'exact' };
    }
    return { rowids, count: result, warnings: [...warnings] };
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
 * Counting (0.20.0, P1-3): the page uses rowid-subquery filters while the count
 * uses docs-column filters, and wide filtered sets report a bounded count
 * instead of paying an O(match-set) exact COUNT.
 *
 * Cancellation: synchronous by design, so it only observes an already-aborted
 * signal or a cancellation hook between SQL statements and scan rows; the async
 * layer converts a cancelled result into an AbortError rejection.
 */
export function searchContent(db, query, limit, options = {}) {
    const capped = clampLimit(limit);
    const matchMode = options.matchMode ?? 'normal';
    const countMode = options.count ?? 'exact';
    const countLimit = clampCountLimit(options.countLimit);
    const degraded = options.degrade === true;
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : null;
    const cancelled = () => isCancelled !== null && isCancelled();
    if (options.signal?.aborted === true || cancelled())
        return cancelledResult();
    if (matchMode === 'regex') {
        return {
            hits: [],
            count: { value: 0, kind: 'unknown' },
            warnings: ['content-regex-paused'],
            error: 'content-regex-not-supported',
        };
    }
    const check = checkContentQuery(query, matchMode);
    const warnings = [...check.warnings];
    if (!check.ok) {
        return {
            hits: [],
            count: { value: 0, kind: 'unknown' },
            warnings,
            error: check.error ?? 'content-query-invalid',
        };
    }
    if (check.terms.length === 0)
        return { hits: [], count: emptyCount(countMode), warnings };
    const pathPrefix = normalizePathPrefix(options.pathPrefix);
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
    });
    if (plan === null)
        return { hits: [], count: emptyCount(countMode), warnings };
    // The degraded profile keeps the worst query cheap: bounded counting and no
    // bm25 sort. scanWholeWord already self-limits, so it only needs the count cap.
    const effectiveCountLimit = degraded ? Math.min(countLimit, DEGRADED_COUNT_LIMIT) : countLimit;
    if (degraded)
        warnings.push('query-degraded');
    if (plan.wholeWord) {
        // Only a pure session scope may count without a bound; a workspace/file
        // prefix still scans a potentially large corpus, so keep counts bounded.
        const sessionScoped = options.sessionPath != null && pathPrefix === null && options.excludeSessions !== true && options.fileHitsAllRoots !== true;
        const scanned = scanWholeWord(db, plan, capped, offset, countMode, effectiveCountLimit, sessionScoped, resolveScanBudget(options.scanBudget), isCancelled ?? undefined);
        for (const warning of scanned.warnings)
            warnings.push(warning);
        if (scanned.error !== undefined)
            return { hits: [], count: { value: 0, kind: 'unknown' }, warnings: [...new Set(warnings)], error: scanned.error };
        const hits = buildHits(db, plan, scanned.rowids, new Map());
        return { hits, count: scanned.count, warnings: [...new Set(warnings)] };
    }
    // P0-6: one bounded probe of the raw match set decides whether bm25 ranking
    // is affordable. Scope filters are intentionally ignored here: the rank cost
    // is driven by the matcher, so a session-scoped query for a word present in
    // every document is just as expensive to rank.
    let rankOrder = plan.rankCapable && !degraded;
    let wide = false;
    if (rankOrder && options.rankAdaptive !== false) {
        wide = matchProbe(db, plan, RANK_ADAPTIVE_THRESHOLD).kind === 'bounded';
        rankOrder = !wide;
    }
    if (cancelled())
        return cancelledResult();
    let count;
    if (countMode === 'none') {
        count = { value: 0, kind: 'unknown' };
    }
    else {
        // A wide or full-scan set first tries the split workspace count: two narrow
        // rowid-driven halves instead of one OR-clause scan over every match.
        const split = wide || plan.countBounded || degraded ? compositeCount(db, plan, effectiveCountLimit) : null;
        if (countMode === 'bounded' || plan.countBounded || degraded || (wide && plan.filtered)) {
            // GLOB bodies, the degraded profile and wide filtered sets cannot be
            // counted exactly without reading the whole match set: report the floor.
            count = split ?? planBoundedCount(db, plan, effectiveCountLimit);
            if (count.kind === 'bounded')
                warnings.push('bounded-count');
        }
        else {
            // Unfiltered FTS counts are cheap even for tens of thousands of matches.
            count = { value: planExactCount(db, plan), kind: 'exact' };
        }
    }
    if (cancelled())
        return cancelledResult();
    const page = pageRowids(db, plan, capped, offset, rankOrder);
    let hits = buildHits(db, plan, page.rowids, page.scores);
    if (!rankOrder)
        hits = lightSortHits(hits, plan);
    return { hits, count, warnings: [...new Set(warnings)] };
}
//# sourceMappingURL=content-search.js.map