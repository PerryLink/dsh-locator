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
function buildPlan(terms, options) {
    const { caseSensitive, wholeWord, phrase, sessionPath, pathPrefix } = options;
    if (terms.length === 0)
        return null;
    // Only files live inside the workspace prefix. Session rows belong to the
    // session scope and are filtered by sessionPath/sessionId instead.
    const suffix = [];
    const suffixParams = [];
    if (sessionPath !== null) {
        suffix.push(' AND rowid IN (SELECT rowid FROM docs_meta WHERE path = ?)');
        suffixParams.push(sessionPath);
    }
    if (pathPrefix !== null) {
        suffix.push(" AND (kind = 'session' OR rowid IN (SELECT rowid FROM docs_meta WHERE path LIKE ? ESCAPE '\\'))");
        suffixParams.push(escapeLike(pathPrefix) + '%');
    }
    const sessionClause = suffix.join('');
    if (phrase) {
        const literal = terms[0];
        if (caseSensitive) {
            return {
                where: 'body GLOB ?' + sessionClause,
                params: ['*' + escapeGlob(literal) + '*', ...suffixParams],
                terms: [literal],
                caseSensitive,
                wholeWord,
                phrase,
                rankOrder: false,
                exactCount: true,
                boundedCount: true,
            };
        }
        return {
            where: 'docs MATCH ?' + sessionClause,
            params: [quoteFts(literal), ...suffixParams],
            terms: [literal],
            caseSensitive,
            wholeWord,
            phrase,
            rankOrder: true,
            exactCount: true,
            boundedCount: false,
        };
    }
    if (caseSensitive) {
        return {
            where: terms.map(() => 'body GLOB ?').join(' AND ') + sessionClause,
            params: [...terms.map(term => '*' + escapeGlob(term) + '*'), ...suffixParams],
            terms: [...terms],
            caseSensitive,
            wholeWord,
            phrase,
            rankOrder: false,
            exactCount: true,
            boundedCount: true,
        };
    }
    return {
        where: 'docs MATCH ?' + sessionClause,
        params: [terms.map(quoteFts).join(' AND '), ...suffixParams],
        terms: [...terms],
        caseSensitive,
        wholeWord,
        phrase,
        rankOrder: true,
        exactCount: true,
        boundedCount: false,
    };
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
function pageRowids(db, plan, limit, offset = 0) {
    const scores = new Map();
    const sql = plan.rankOrder
        ? `SELECT rowid AS rowid, rank AS score FROM docs WHERE ${plan.where} ORDER BY rank LIMIT ? OFFSET ?`
        : `SELECT rowid AS rowid FROM docs WHERE ${plan.where} LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(...plan.params, limit, offset);
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
/** Exact COUNT over the plan's WHERE fragment. */
function exactCount(db, plan) {
    const row = db.prepare(`SELECT count(*) AS n FROM docs WHERE ${plan.where}`).get(...plan.params);
    return Number(row?.n ?? 0);
}
/** Count up to `limit + 1` rows: exact below the cap, bounded at the cap. */
function boundedCount(db, plan, limit) {
    const row = db
        .prepare(`SELECT count(*) AS n FROM (SELECT rowid FROM docs WHERE ${plan.where} LIMIT ?)`)
        .get(...plan.params, limit + 1);
    const value = Number(row?.n ?? 0);
    if (value > limit)
        return { value: limit, kind: 'bounded', limit };
    return { value, kind: 'exact' };
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
 */
function scanWholeWord(db, plan, limit, offset, countMode, countLimit, sessionScoped, budget) {
    const warnings = new Set();
    const rowids = [];
    const sql = plan.rankOrder
        ? `SELECT rowid AS rowid FROM docs WHERE ${plan.where} ORDER BY rank`
        : `SELECT rowid AS rowid FROM docs WHERE ${plan.where}`;
    const iterator = db.prepare(sql).iterate(...plan.params);
    const bodyStatement = db.prepare('SELECT body FROM docs WHERE rowid = ?');
    const deadline = performance.now() + budget.maxMs;
    let count = 0;
    let scannedRows = 0;
    let scannedBytes = 0;
    let capped = false;
    let exhausted = true;
    for (const raw of iterator) {
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
 */
export function searchContent(db, query, limit, options = {}) {
    const capped = clampLimit(limit);
    const matchMode = options.matchMode ?? 'normal';
    const countMode = options.count ?? 'exact';
    const countLimit = clampCountLimit(options.countLimit);
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
    const plan = buildPlan(check.terms, {
        caseSensitive: options.caseSensitive === true,
        wholeWord: options.wholeWord === true,
        phrase: check.phrase,
        sessionPath: options.sessionPath ?? null,
        pathPrefix: normalizePathPrefix(options.pathPrefix),
    });
    if (plan === null)
        return { hits: [], count: emptyCount(countMode), warnings };
    if (plan.wholeWord) {
        const scanned = scanWholeWord(db, plan, capped, Math.max(0, Math.trunc(options.offset ?? 0)), countMode, countLimit, options.sessionPath != null, resolveScanBudget(options.scanBudget));
        for (const warning of scanned.warnings)
            warnings.push(warning);
        const hits = buildHits(db, plan, scanned.rowids, new Map());
        return { hits, count: scanned.count, warnings: [...new Set(warnings)] };
    }
    let count;
    if (countMode === 'none') {
        count = { value: 0, kind: 'unknown' };
    }
    else if (countMode === 'bounded') {
        count = boundedCount(db, plan, countLimit);
        if (count.kind === 'bounded')
            warnings.push('bounded-count');
    }
    else if (plan.exactCount && !plan.boundedCount) {
        count = { value: exactCount(db, plan), kind: 'exact' };
    }
    else {
        // GLOB patterns cannot count cheaply: cap the work and report the known
        // floor plus a warning.
        count = boundedCount(db, plan, countLimit);
        if (count.kind === 'bounded')
            warnings.push('bounded-count');
    }
    const page = pageRowids(db, plan, capped, Math.max(0, Math.trunc(options.offset ?? 0)));
    const hits = buildHits(db, plan, page.rowids, page.scores);
    return { hits, count, warnings: [...new Set(warnings)] };
}
//# sourceMappingURL=content-search.js.map