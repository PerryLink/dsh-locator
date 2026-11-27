/**
 * locator_find — the single AI-first search entry point of dsh-locator 0.22.0.
 *
 * One call covers the four legacy search surfaces: file names (locator_search),
 * file/session bodies (locator_find), code symbols (locator_symbol) and file
 * metadata filtering. The tool keeps the reviewed search engines untouched and
 * only re-shapes their results into the shared agent envelope (see
 * agent-core.ts): a compact item budget, an opaque continuation cursor and a
 * closed error-code set.
 *
 * Mode `auto` merges every source its `kinds` allow instead of resolving to a
 * single first-non-empty source (0.23): symbol declarations (identifier-shaped
 * queries only, headings excluded), body hits from the content index, and
 * file/dir names. The streams are merged by a stable rank (symbol exact, then
 * body BM25/coverage, then symbol prefix, then name prefix/substring), rows
 * with the same identity are merged into one item with `why`/`sources` union,
 * and the page's continuation cursor (v2) pins the consumed position of every
 * source so pagination neither loses nor re-fetches a row. Single-source modes
 * keep emitting the v1 cursor, and a v1 cursor is only accepted there.
 * @module dsh-locator/agent-find
 */
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { AGENT_BUDGET_SCHEMA, AGENT_COVERAGE_SCHEMA, AGENT_DEFAULT_MAX_CHARS, AGENT_DETAILS, AGENT_ERROR_INFO_SCHEMA, AGENT_FIND_MODES, AGENT_ITEM_SCHEMA, AGENT_MAX_LIMIT, AGENT_MIN_BUDGET_CHARS, AGENT_PAGE_SCHEMA, AGENT_SCOPE_MODES, AGENT_SCOPE_SCHEMA, AGENT_SUCCESS_BASE_SCHEMA, agentSuccess, applyItemBudget, clampLimit, coverageNote, CURSOR_SEEN_MAX, decodeCursor, encodeCursor, encodeCursorV2, errorMessage, identityTokenHash, makeCoverage, makeError, makeTiming, queryHashOf, resolveMaxChars, trimItem, } from "./agent-core.js";
import { contentScopeOptionsOf, runContentSearchRequest, } from "./find.js";
import { fileRef } from "./refs.js";
import { withinRoots } from "./reveal.js";
import { fetchNamePage, pageAdvance } from "./scope.js";
/** Registered tool name. */
const TOOL_NAME = 'locator_find';
/** Raw content rows one page may scan while filling past filtered rows. */
const BODY_MAX_ROWS = 250;
/** Content windows one page may fetch while filling. */
const BODY_MAX_WINDOWS = 4;
/** Symbol rows fetched before paging (the store caps at 200 itself). */
const SYMBOL_MAX_MATCHES = 200;
/** Name-index rows one page may scan while filling past filtered rows. */
const NAME_MAX_ROWS = 250;
/** Auto merge batch floor: one batch always fetches at least this many raw rows. */
const AUTO_BATCH_MIN = 20;
/** Auto merge batch cap: name/content search pages are capped at 100 rows each. */
const AUTO_BATCH_MAX = 100;
/** Raw rows one auto source may scan for a single page (scope/where filters). */
const AUTO_PULL_MAX_ROWS = 1_000;
/** Active merge sources in tie-break priority order (same as the CLI parity surface). */
const AUTO_SOURCE_ORDER = ['symbol', 'body', 'name'];
/* ------------------------------------------------------------------------- */
/* Parameter and output schemas                                                */
/* ------------------------------------------------------------------------- */
const FIND_PARAMETERS = {
    query: { type: 'string', required: true, description: 'Words/phrase, name fragment or identifier. Empty is rejected.' },
    mode: { type: 'string', enum: ['auto', 'name', 'body', 'symbol'], description: 'auto (merge symbol/body/name by kinds), name, body or symbol.' },
    kinds: { type: 'array', items: { type: 'string', enum: ['file', 'dir', 'session', 'symbol'] }, description: 'Row kinds to return (default all).' },
    where: {
        type: 'object',
        additionalProperties: false,
        properties: {
            pathPrefix: { type: 'string', description: 'Only rows under this directory (inside the roots).' },
            ext: { type: 'array', items: { type: 'string' }, description: 'Only these lower-case extensions (no dot).' },
            modifiedAfter: { type: 'string', description: 'ISO-8601 time or epoch-ms mtime lower bound.' },
            minSize: { type: 'integer', description: 'Minimum file size in bytes.' },
        },
        description: 'Metadata filters applied before paging.',
    },
    scope: { type: 'string', enum: ['workspace', 'roots', 'all'], description: 'workspace (cwd/session), roots (all roots) or all (+cross-workspace sessions).' },
    limit: { type: 'integer', description: 'Items per page (default 10, max 50).' },
    cursor: { type: 'string', description: 'Opaque page.nextCursor; mutually exclusive with offset.' },
    offset: { type: 'integer', description: 'Legacy row offset (prefer cursor).' },
    maxChars: { type: 'integer', description: 'Item budget in characters (default 6000; 0 = unlimited).' },
    detail: { type: 'string', enum: ['compact', 'standard', 'full'], description: 'compact (default), standard (+freshness) or full (+ids/hash/permissions).' },
    count: { type: 'string', enum: ['exact', 'bounded', 'none'], description: 'exact (default), bounded or none (none omits all counts).' },
    includeArchived: { type: 'boolean', description: 'Search archived sessions in body results too (default false).' },
};
const FIND_COUNTS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        total: { type: 'integer', description: 'Primary match count when known.' },
        totalKind: { type: 'string', enum: ['exact', 'bounded', 'unknown'], description: 'Confidence of total.' },
        nameTotal: { type: 'integer', description: 'Name-index match count (name mode).' },
        bodyTotal: { type: 'integer', description: 'Content-index match count (body mode).' },
        bodyKind: { type: 'string', enum: ['exact', 'bounded', 'unknown'], description: 'Confidence of bodyTotal.' },
        symbolTotal: { type: 'integer', description: 'Symbol match count (symbol mode).' },
    },
};
const FIND_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ...AGENT_SUCCESS_BASE_SCHEMA.properties,
        query: { type: 'string' },
        mode: { type: 'string', enum: ['auto', 'name', 'body', 'symbol'] },
        resolvedMode: { type: 'string', enum: ['name', 'body', 'symbol', 'mixed'] },
        detail: { type: 'string', enum: ['compact', 'standard', 'full'] },
        scope: AGENT_SCOPE_SCHEMA,
        items: { type: 'array', items: AGENT_ITEM_SCHEMA },
        page: AGENT_PAGE_SCHEMA,
        counts: FIND_COUNTS_SCHEMA,
        coverage: AGENT_COVERAGE_SCHEMA,
        budget: AGENT_BUDGET_SCHEMA,
        error: AGENT_ERROR_INFO_SCHEMA,
    },
};
/* ------------------------------------------------------------------------- */
/* Small value helpers                                                        */
/* ------------------------------------------------------------------------- */
/** Whether a value is the uniform failure envelope. */
function isFailure(value) {
    return typeof value === 'object' && value !== null && value.ok === false;
}
/** Whether a value is a non-array object. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}
/** Lower-case extension of a path without the dot (empty when none). */
function extensionOf(path) {
    const name = basename(path);
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1)
        return '';
    return name.slice(dot + 1).toLowerCase();
}
/** Whether path is prefix itself or lives below it (separator-normalized). */
function underPrefix(path, prefix) {
    const normalizedPath = path.replace(/\\/g, '/');
    const normalizedPrefix = prefix.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalizedPath === normalizedPrefix || normalizedPath.startsWith(normalizedPrefix + '/');
}
/** Why a name hit matched: prefix vs substring. */
function whyName(query, name) {
    const needle = query.trim().toLowerCase();
    return needle !== '' && name.toLowerCase().startsWith(needle) ? 'name:prefix' : 'name:substring';
}
/** Why a symbol hit matched. */
function whySymbol(query, name) {
    if (name === query)
        return 'symbol:exact';
    return name.toLowerCase().startsWith(query.toLowerCase()) ? 'symbol:prefix' : 'symbol:substring';
}
/** Whether the query can be an exact symbol identifier (auto-mode probe). */
function isIdentifierLike(query) {
    return Array.from(query).length >= 2 && /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(query);
}
/** Whether the query has a term the trigram body index can serve (3+ characters). */
function hasBodyTerm(query) {
    return /[\p{L}\p{N}_]{3,}/u.test(query);
}
/**
 * Whether an auto query is identifier-shaped enough to enable the symbol source.
 *
 * 0.23 (P0-3): a bare common lowercase word such as "config" must not select
 * the symbol source, otherwise prose queries get hijacked by variable names and
 * markdown headings. The extra signal is a capital letter, underscore, dollar
 * sign or digit — the shapes that are almost always code identifiers.
 * Explicit mode "symbol" is unaffected.
 * @param query - trimmed caller query.
 * @returns true when auto should merge symbol declarations for this query.
 */
function isAutoSymbolQuery(query) {
    if (isIdentifierLike(query) === false)
        return false;
    return /[\p{Lu}_$0-9]/u.test(query);
}
/** Whether any where filter is set (drives the counts-ignore-where note). */
function hasWhere(where) {
    return where.pathPrefix !== undefined || where.ext !== undefined || where.modifiedAfter !== undefined || where.minSize !== undefined;
}
/**
 * Whether a where filter is applied to rows but not to the index count.
 * The content count honors pathPrefix (it is pushed into the SQL), but the
 * ext/size/mtime filters only run over returned rows.
 */
function countFilteringWhere(where) {
    return where.ext !== undefined || where.modifiedAfter !== undefined || where.minSize !== undefined;
}
/** Parse an ISO-8601 time or an epoch-millisecond string; undefined when invalid. */
function parseModifiedAfter(value) {
    const text = value.trim();
    if (text === '')
        return undefined;
    if (/^\d{10,16}$/.test(text)) {
        const numeric = Number(text);
        return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : undefined;
}
/** Read one path's size/mtime, memoized per tool call. */
async function fileMetadata(path, cache) {
    if (cache.has(path))
        return cache.get(path);
    let value;
    try {
        const info = await stat(path);
        value = { size: info.size, mtime: info.mtimeMs };
    }
    catch {
        value = undefined;
    }
    cache.set(path, value);
    return value;
}
/** Whether a row passes the where filters (size/mtime need metadata, path filters do not). */
function whereMatches(path, meta, where) {
    if (where.pathPrefix !== undefined && !underPrefix(path, where.pathPrefix))
        return false;
    if (where.ext !== undefined && where.ext.length > 0 && where.ext.includes(extensionOf(path)) === false)
        return false;
    if (where.modifiedAfter !== undefined && (meta === undefined || meta.mtime < where.modifiedAfter))
        return false;
    if (where.minSize !== undefined && (meta === undefined || meta.size < where.minSize))
        return false;
    return true;
}
/** Deduplicate coverage notes by code+message while keeping first order. */
function dedupeNotes(notes) {
    const seen = new Set();
    const out = [];
    for (const note of notes) {
        const key = note.code + '\u0000' + note.message;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(note);
    }
    return out;
}
/** Current engine index generation, when the running engine reports one. */
function generationOf(rt) {
    const generation = rt.status.engine?.generation;
    return typeof generation === 'number' && Number.isInteger(generation) && generation > 0 ? generation : undefined;
}
/** Stable dedupe key of one body row: one message occurrence, or one file path. */
function bodyRowKey(hit) {
    if (hit.kind === 'session') {
        return 'session\u0000' + (hit.sessionId ?? hit.path) + '\u0000' + (hit.messageId ?? '');
    }
    return 'file\u0000' + hit.path;
}
/** Map one legacy content-index error string onto the closed agent error code. */
function mapContentError(raw) {
    switch (raw) {
        case 'content-query-too-short':
        case 'query-empty':
            return { code: 'query-too-short' };
        case 'content-query-too-long':
        case 'content-query-too-many-terms':
        case 'content-query-invalid':
        case 'content-regex-not-supported':
        case 'query-invalid':
            return { code: 'query-invalid' };
        case 'content-scope-denied':
        case 'session-not-authorized':
        case 'content-path-denied':
            return { code: 'scope-denied' };
        case 'content-index-unavailable':
        case 'name-index-unavailable':
            return { code: 'index-unavailable' };
        case 'content-index-building':
        case 'content-build-running':
            return { code: 'index-building' };
        case 'content-search-cancelled':
        case 'request-aborted':
            return { code: 'cancelled' };
        default:
            return { code: 'internal', retryable: true, remediation: 'The index query failed; retry once and check locator_status.' };
    }
}
/** Build one failure envelope for the current call. */
function fail(ctx, code, message, extra = {}) {
    return makeError(code, message, { tool: TOOL_NAME, ...extra, timing: makeTiming(ctx.started) });
}
/** Whether one body row is visible under the configured scope rules. */
function contentRowVisible(ctx, hit) {
    const scope = ctx.options.scope;
    if (scope === undefined)
        return true;
    return scope.isSearchable(hit.path) && scope.isIndexable(hit.path) && scope.isReadable(hit.path);
}
/** Project one enriched content hit into the item superset. */
function contentItem(hit) {
    const kind = hit.kind === 'session' ? 'session' : 'file';
    const item = {
        kind,
        path: hit.path,
        title: hit.title === '' ? basename(hit.path) : hit.title,
        why: ['body:terms'],
        ...(hit.snippet === '' ? {} : { snippet: hit.snippet }),
        ...(hit.line === undefined ? {} : { line: hit.line }),
        ...(typeof hit.score === 'number' && Number.isFinite(hit.score) ? { score: hit.score } : {}),
        ...(hit.ref === undefined ? {} : { ref: hit.ref }),
        ...(hit.refStatus === undefined ? {} : { refStatus: hit.refStatus }),
        ...(hit.freshness === undefined ? {} : { freshness: hit.freshness }),
        ...(hit.hash === undefined ? {} : { hash: hit.hash }),
        ...(hit.permissions === undefined ? {} : { permissions: hit.permissions }),
        ...(hit.provenance === undefined ? {} : { provenance: hit.provenance }),
        ...(hit.seq === undefined ? {} : { seq: hit.seq }),
        ...(hit.eventRef === undefined ? {} : { eventRef: hit.eventRef }),
        ...(hit.sessionId === undefined ? {} : { sessionId: hit.sessionId }),
        ...(hit.messageId === undefined ? {} : { messageId: hit.messageId }),
        ...(hit.format === undefined ? {} : { format: hit.format }),
    };
    if (kind === 'file') {
        const extension = extensionOf(hit.path);
        if (extension !== '')
            item.ext = extension;
    }
    return item;
}
/** Project one symbol row into the item superset. */
function symbolItem(ctx, match) {
    return {
        kind: 'symbol',
        path: match.path,
        title: match.name,
        name: match.name,
        line: match.line,
        why: [whySymbol(ctx.query, match.name)],
        language: match.language,
        ...(match.scope === undefined ? {} : { symbolScope: match.scope }),
        ref: fileRef({ path: match.path }),
    };
}
/** Project one name-index hit into the item superset (shared by name and auto modes). */
function buildNameItem(ctx, hit, observedAt, cwdIsIndexed) {
    const kind = hit.dir ? 'dir' : 'file';
    const visibility = ctx.effectiveScope === 'all' || ctx.effectiveScope === 'roots' || !cwdIsIndexed ? 'roots' : 'workspace';
    const readable = ctx.options.scope?.readability(hit.path) ?? { read: 'allowed', reason: 'name hits come from the configured index roots' };
    const item = {
        kind,
        path: hit.path,
        title: hit.name,
        why: [whyName(ctx.query, hit.name)],
        size: hit.size,
        mtime: hit.mtime,
        dir: hit.dir,
        refStatus: 'unknown',
        freshness: { state: 'unknown', observedAt, mtime: hit.mtime },
        permissions: { read: readable.read, visibility, reason: readable.reason },
    };
    const extension = extensionOf(hit.path);
    if (extension !== '')
        item.ext = extension;
    if (!hit.dir && readable.read === 'allowed')
        item.ref = fileRef({ path: hit.path, mtime: hit.mtime, size: hit.size });
    return item;
}
/**
 * Attach the stored session-event seq/ref to session hits that carry only the
 * canonical session ref.
 *
 * The content enricher only pays for event refs on evidence-bearing rows
 * (detail full and the first evidenceLimit rows), but a compact/standard find
 * page must stay readable: locator_read accepts ref://session-event refs and
 * rejects the session-level dsh-session: ref. One lookup per involved session
 * keeps the cost bounded (a page has few sessions).
 * @param content - content store with the optional sessionEventRefs lookup.
 * @param hits - already enriched content hits.
 * @returns the hits with eventRef/seq filled in where the store has them.
 */
async function attachSessionEventRefs(content, hits) {
    if (typeof content.sessionEventRefs !== 'function')
        return [...hits];
    const idsBySession = new Map();
    for (const hit of hits) {
        if (hit.kind !== 'session' || hit.eventRef !== undefined)
            continue;
        if (hit.sessionId === undefined || hit.messageId === undefined)
            continue;
        const ids = idsBySession.get(hit.sessionId);
        if (ids === undefined)
            idsBySession.set(hit.sessionId, [hit.messageId]);
        else if (ids.includes(hit.messageId) === false)
            ids.push(hit.messageId);
    }
    if (idsBySession.size === 0)
        return [...hits];
    const refsBySession = new Map();
    for (const [sessionId, messageIds] of idsBySession) {
        try {
            refsBySession.set(sessionId, content.sessionEventRefs(sessionId, messageIds));
        }
        catch {
            // Older/foreign databases keep hits without event refs.
        }
    }
    return hits.map(hit => {
        if (hit.kind !== 'session' || hit.eventRef !== undefined)
            return hit;
        if (hit.sessionId === undefined || hit.messageId === undefined)
            return hit;
        const event = refsBySession.get(hit.sessionId)?.get(hit.messageId);
        if (event === undefined)
            return hit;
        return { ...hit, seq: event.seq, eventRef: event.ref };
    });
}
/** Fill the declared size/mtime evidence fields of a full-detail file item. */
async function withFileStats(item, cache) {
    if (item.kind !== 'file' || item.size !== undefined && item.mtime !== undefined)
        return item;
    const meta = await fileMetadata(item.path, cache);
    if (meta === undefined)
        return item;
    return { ...item, size: item.size ?? meta.size, mtime: item.mtime ?? Math.trunc(meta.mtime) };
}
/* ------------------------------------------------------------------------- */
/* Request validation                                                         */
/* ------------------------------------------------------------------------- */
/**
 * Validate and normalize one raw locator_find argument object.
 *
 * The tool schema already enforces JSON types, but (as with the legacy tools)
 * direct embedders call execute() with hand-built objects, so every range and
 * cross-field rule is re-checked here and reported through the uniform failure
 * envelope instead of a thrown error.
 * @param rt - runtime (roots + configured page cap).
 * @param options - factory options (embedder maxChars default).
 * @param rawArgs - raw argument object.
 * @param started - call start timestamp for timing.
 * @returns the normalized request or the failure envelope.
 */
function normalizeRequest(rt, options, rawArgs, started) {
    const failEarly = (code, message, extra = {}) => makeError(code, message, { tool: TOOL_NAME, ...extra, timing: makeTiming(started) });
    const raw = isRecord(rawArgs) ? rawArgs : {};
    const query = typeof raw.query === 'string' ? raw.query.trim() : '';
    if (query === '')
        return failEarly('invalid-argument', 'query is required and must be a non-empty string');
    const queryLength = Array.from(query).length;
    if (queryLength > 512)
        return failEarly('query-invalid', 'query is longer than 512 characters');
    const mode = raw.mode === undefined ? 'auto' : AGENT_FIND_MODES.includes(raw.mode) ? raw.mode : 'invalid';
    if (mode === 'invalid')
        return failEarly('invalid-argument', 'mode must be one of auto, name, body, symbol');
    if ((mode === 'body' || mode === 'auto') && queryLength > 256)
        return failEarly('query-invalid', 'body queries are limited to 256 characters');
    const scopeRequested = raw.scope === undefined ? 'workspace' : AGENT_SCOPE_MODES.includes(raw.scope) ? raw.scope : 'invalid';
    if (scopeRequested === 'invalid')
        return failEarly('invalid-argument', 'scope must be one of workspace, roots, all');
    const detail = raw.detail === undefined ? 'compact' : AGENT_DETAILS.includes(raw.detail) ? raw.detail : 'invalid';
    if (detail === 'invalid')
        return failEarly('invalid-argument', 'detail must be one of compact, standard, full');
    const countMode = raw.count === undefined ? 'exact' : raw.count === 'exact' || raw.count === 'bounded' || raw.count === 'none' ? raw.count : undefined;
    if (countMode === undefined)
        return failEarly('invalid-argument', 'count must be one of exact, bounded, none');
    let includeArchived = false;
    if (raw.includeArchived !== undefined) {
        if (typeof raw.includeArchived !== 'boolean')
            return failEarly('invalid-argument', 'includeArchived must be a boolean');
        includeArchived = raw.includeArchived;
    }
    const allKinds = ['file', 'dir', 'session', 'symbol'];
    let kinds = [...allKinds];
    if (raw.kinds !== undefined) {
        if (Array.isArray(raw.kinds) === false)
            return failEarly('invalid-argument', 'kinds must be an array of file/dir/session/symbol');
        const selected = [];
        for (const entry of raw.kinds) {
            if (typeof entry !== 'string' || allKinds.includes(entry) === false) {
                return failEarly('invalid-argument', 'kinds may only contain file, dir, session or symbol');
            }
            if (selected.includes(entry) === false)
                selected.push(entry);
        }
        if (selected.length === 0)
            return failEarly('invalid-argument', 'kinds must not be empty');
        kinds = selected;
    }
    const where = {};
    if (raw.where !== undefined) {
        if (isRecord(raw.where) === false)
            return failEarly('invalid-argument', 'where must be an object');
        const rawWhere = raw.where;
        if (rawWhere.pathPrefix !== undefined) {
            if (typeof rawWhere.pathPrefix !== 'string' || rawWhere.pathPrefix.trim() === '') {
                return failEarly('invalid-argument', 'where.pathPrefix must be a non-empty directory path');
            }
            const prefix = rawWhere.pathPrefix.trim();
            if (withinRoots(prefix, rt.roots) === false) {
                return failEarly('scope-denied', 'where.pathPrefix is outside the configured index roots', { remediation: 'The path must be inside the configured index roots.' });
            }
            where.pathPrefix = prefix;
        }
        if (rawWhere.ext !== undefined) {
            if (Array.isArray(rawWhere.ext) === false)
                return failEarly('invalid-argument', 'where.ext must be an array of extensions');
            const extensions = [];
            for (const entry of rawWhere.ext) {
                if (typeof entry !== 'string')
                    return failEarly('invalid-argument', 'where.ext may only contain strings');
                const extension = entry.trim().toLowerCase().replace(/^\./, '');
                if (extension !== '' && extensions.includes(extension) === false)
                    extensions.push(extension);
            }
            if (extensions.length === 0)
                return failEarly('invalid-argument', 'where.ext must contain at least one extension');
            extensions.sort();
            where.ext = extensions;
        }
        if (rawWhere.modifiedAfter !== undefined) {
            if (typeof rawWhere.modifiedAfter !== 'string')
                return failEarly('invalid-argument', 'where.modifiedAfter must be an ISO-8601 time or epoch-millisecond string');
            const modifiedAfter = parseModifiedAfter(rawWhere.modifiedAfter);
            if (modifiedAfter === undefined) {
                return failEarly('invalid-argument', 'where.modifiedAfter is not a valid ISO-8601 time or epoch-millisecond string');
            }
            where.modifiedAfter = modifiedAfter;
        }
        if (rawWhere.minSize !== undefined) {
            if (typeof rawWhere.minSize !== 'number' || Number.isInteger(rawWhere.minSize) === false || rawWhere.minSize < 0) {
                return failEarly('invalid-argument', 'where.minSize must be a non-negative integer');
            }
            where.minSize = rawWhere.minSize;
        }
    }
    const configuredMax = typeof rt.config?.maxResults === 'number' && Number.isFinite(rt.config.maxResults) && rt.config.maxResults > 0
        ? Math.trunc(rt.config.maxResults)
        : AGENT_MAX_LIMIT;
    const limitCap = Math.max(1, Math.min(AGENT_MAX_LIMIT, configuredMax));
    if (raw.limit !== undefined) {
        if (typeof raw.limit !== 'number' || Number.isInteger(raw.limit) === false || raw.limit < 1) {
            return failEarly('invalid-argument', 'limit must be an integer of at least 1');
        }
    }
    const limit = clampLimit(raw.limit, limitCap);
    const hasCursor = raw.cursor !== undefined;
    const hasOffset = raw.offset !== undefined;
    if (hasCursor) {
        if (typeof raw.cursor !== 'string' || raw.cursor.trim() === '')
            return failEarly('invalid-argument', 'cursor must be a non-empty opaque cursor string');
        if (hasOffset)
            return failEarly('invalid-argument', 'cursor and offset are mutually exclusive');
    }
    let explicitOffset;
    if (hasOffset) {
        if (typeof raw.offset !== 'number' || Number.isInteger(raw.offset) === false || raw.offset < 0) {
            return failEarly('invalid-argument', 'offset must be a non-negative integer');
        }
        explicitOffset = raw.offset;
    }
    let maxChars = options.maxChars === undefined ? AGENT_DEFAULT_MAX_CHARS : resolveMaxChars(options.maxChars, AGENT_DEFAULT_MAX_CHARS);
    if (raw.maxChars !== undefined) {
        if (typeof raw.maxChars !== 'number' || Number.isInteger(raw.maxChars) === false || raw.maxChars < 0) {
            return failEarly('invalid-argument', 'maxChars must be a non-negative integer (0 disables the budget)');
        }
        maxChars = raw.maxChars;
    }
    if (maxChars > 0 && maxChars < AGENT_MIN_BUDGET_CHARS) {
        return failEarly('budget-too-small', 'maxChars is too small for one result item (minimum ' + String(AGENT_MIN_BUDGET_CHARS) + ')', {
            remediation: 'Raise maxChars to at least ' + String(AGENT_MIN_BUDGET_CHARS) + ' or use detail:"compact".',
        });
    }
    if (mode === 'symbol' && kinds.includes('symbol') === false)
        return failEarly('invalid-argument', 'mode symbol requires kinds to include symbol');
    if (mode === 'body' && kinds.includes('file') === false && kinds.includes('session') === false) {
        return failEarly('invalid-argument', 'mode body requires kinds to include file or session');
    }
    if (mode === 'name' && kinds.includes('file') === false && kinds.includes('dir') === false) {
        return failEarly('invalid-argument', 'mode name requires kinds to include file or dir');
    }
    return {
        query,
        mode,
        kinds,
        where,
        scopeRequested,
        limit,
        ...(explicitOffset === undefined ? {} : { explicitOffset }),
        ...(hasCursor ? { cursor: raw.cursor.trim() } : {}),
        maxChars,
        detail,
        countMode,
        includeArchived,
    };
}
/* ------------------------------------------------------------------------- */
/* Mode handlers                                                              */
/* ------------------------------------------------------------------------- */
/** Resolve the effective scope for the first page, widening a non-indexed cwd. */
function initialScope(requested, caller, rt) {
    if (requested !== 'workspace')
        return { effective: requested };
    const cwd = caller.cwd;
    const cwdIndexed = cwd !== undefined && rt.roots.some(root => withinRoots(cwd, [root]));
    if (cwd === undefined || cwdIndexed === false) {
        return { effective: 'roots', fallbackReason: 'cwd-not-indexed; searched every configured root' };
    }
    return { effective: 'workspace' };
}
/** Build one name-mode page (file/dir rows from the name index). */
async function runNameMode(ctx) {
    const rt = ctx.rt;
    const callerCwd = ctx.caller.cwd;
    const cwdIsIndexed = callerCwd !== undefined && rt.roots.some(root => withinRoots(callerCwd, [root]));
    const narrowToCwd = ctx.effectiveScope === 'workspace' && cwdIsIndexed && callerCwd !== undefined;
    const filesOnly = ctx.kinds.has('file') && ctx.kinds.has('dir') === false;
    const dirsOnly = ctx.kinds.has('dir') && ctx.kinds.has('file') === false;
    const filtering = narrowToCwd
        || ctx.where.pathPrefix !== undefined
        || ctx.where.ext !== undefined
        || ctx.where.modifiedAfter !== undefined
        || ctx.where.minSize !== undefined
        || ctx.kinds.has('file') === false
        || ctx.kinds.has('dir') === false;
    const configuredMax = typeof rt.config?.maxResults === 'number' && rt.config.maxResults > 0 ? Math.trunc(rt.config.maxResults) : AGENT_MAX_LIMIT;
    const fetchSize = filtering ? Math.min(configuredMax, Math.max(ctx.limit * 5, 50)) : ctx.limit;
    const notes = [];
    try {
        rt.start();
        const window = await fetchNamePage(async (page) => await rt.search({
            query: ctx.query,
            limit: page.limit,
            offset: page.offset,
            sort: 'name',
            desc: false,
            regex: false,
            caseSensitive: false,
            wholeWord: false,
            filesOnly,
            dirsOnly,
        }), {
            offset: ctx.offset,
            limit: ctx.limit,
            fetchSize,
            maxRows: filtering ? NAME_MAX_ROWS : Math.max(ctx.limit, 1),
            keep: hit => {
                if (narrowToCwd && callerCwd !== undefined && !withinRoots(hit.path, [callerCwd]))
                    return 'narrow';
                const kind = hit.dir ? 'dir' : 'file';
                if (!ctx.kinds.has(kind))
                    return 'scope';
                if (ctx.options.scope !== undefined && !ctx.options.scope.isSearchable(hit.path))
                    return 'scope';
                if (!whereMatches(hit.path, { size: hit.size, mtime: hit.mtime }, ctx.where))
                    return 'scope';
                return 'keep';
            },
        });
        const observedAt = Date.now();
        const rows = window.items.map((hit, index) => ({
            item: buildNameItem(ctx, hit, observedAt, cwdIsIndexed),
            offset: window.indices[index] ?? ctx.offset + index,
        }));
        const advance = pageAdvance({
            offset: ctx.offset,
            fetchedRows: window.rawConsumed,
            keptIndices: window.indices,
            dropped: window.dropped,
            more: window.more,
        });
        if (window.scopeDropped > 0)
            notes.push(coverageNote('scope-filtered', String(window.scopeDropped) + ' row(s) removed by the configured scope rules or where filters.', 'info'));
        if (window.narrowed > 0)
            notes.push(coverageNote('workspace-filtered', String(window.narrowed) + ' row(s) outside the caller workspace ignored.', 'info'));
        if (window.indexing === true)
            notes.push(coverageNote('index-building', 'The name index is still scanning; this page is partial.', 'warn'));
        if (narrowToCwd && ctx.countMode !== 'none')
            notes.push(coverageNote('total-is-global', 'counts.total is the match count across every configured root, not just the workspace.', 'info'));
        // Name-mode counts are exact name-index totals; where filters are applied to
        // rows only, so say so instead of pretending the total was filtered.
        const counts = ctx.countMode === 'none'
            ? {}
            : { total: window.total, totalKind: 'exact', nameTotal: window.total };
        if (ctx.countMode !== 'none' && hasWhere(ctx.where)) {
            notes.push(coverageNote('counts-ignore-where', 'counts.* are the unfiltered name-index totals; where filters apply to returned rows only.', 'info'));
        }
        return {
            rows,
            more: advance.hasMore,
            ...(advance.nextOffset === undefined ? {} : { nextOffset: advance.nextOffset }),
            counts,
            coverage: makeCoverage({ indexing: window.indexing === true, notes }),
            empty: rows.length === 0,
        };
    }
    catch (error) {
        return fail(ctx, 'index-unavailable', 'name index search failed: ' + errorMessage(error), {
            retryable: true,
            details: { cause: errorMessage(error) },
        });
    }
}
/** Build one body-mode page (file/session content rows from the content index). */
async function runBodyMode(ctx) {
    const content = ctx.content;
    if (content === undefined) {
        return fail(ctx, 'index-unavailable', 'the content index is disabled in this profile', {
            remediation: 'Enable the content index or pass mode:"name".',
            nextTools: ['locator_status'],
        });
    }
    if (typeof content.search !== 'function')
        return fail(ctx, 'index-unavailable', 'this content store does not support body search');
    try {
        ctx.ensure?.();
    }
    catch (error) {
        return fail(ctx, 'index-unavailable', 'the content index failed to start: ' + errorMessage(error), {
            retryable: true,
            details: { cause: errorMessage(error) },
        });
    }
    const contentScope = ctx.effectiveScope === 'workspace' ? 'workspace' : 'all';
    const allowCross = ctx.effectiveScope === 'all' && ctx.options.allowCrossWorkspaceSessions === true;
    const pageWant = Math.min(100, Math.max(ctx.limit * 4, 20));
    const rows = [];
    const dropped = [];
    const warnings = [];
    const seen = new Set();
    let cursor = Math.max(0, ctx.offset);
    let consumed = 0;
    let unscanned = 0;
    let calls = 0;
    let more = true;
    let lastCount;
    let lastState;
    let scopeFallbackNote;
    let workspaceEmpty = false;
    let shortQueryFallback = false;
    let unverified = 0;
    while (rows.length < ctx.limit && consumed < BODY_MAX_ROWS && calls < BODY_MAX_WINDOWS) {
        const want = Math.min(pageWant, BODY_MAX_ROWS - consumed);
        if (want <= 0)
            break;
        const request = {
            query: ctx.query,
            limit: want,
            offset: cursor,
            scope: contentScope,
            detail: ctx.detail === 'compact' ? 'compact' : 'full',
            ...(ctx.detail === 'compact' ? {} : { evidenceLimit: ctx.limit, ...(ctx.detail === 'full' ? { includeHash: true } : {}) }),
            count: ctx.countMode,
            ...(ctx.where.pathPrefix === undefined ? {} : { pathPrefix: ctx.where.pathPrefix }),
            ...(ctx.includeArchived ? { includeArchived: true } : {}),
        };
        let result;
        try {
            result = await runContentSearchRequest(content, request, ctx.rt.roots, allowCross, ctx.caller, contentScopeOptionsOf(ctx.rt));
        }
        catch (error) {
            return fail(ctx, 'internal', 'content search failed: ' + errorMessage(error), {
                retryable: true,
                details: { cause: errorMessage(error) },
            });
        }
        calls += 1;
        if (!result.ok) {
            const mapped = mapContentError(result.error);
            return fail(ctx, mapped.code, mapped.code === 'internal' ? result.error : undefined, {
                ...(mapped.retryable === undefined ? {} : { retryable: mapped.retryable }),
                ...(mapped.remediation === undefined ? {} : { remediation: mapped.remediation }),
                details: { cause: result.error },
            });
        }
        lastState = result.state;
        lastCount = result.count;
        for (const warning of result.warnings)
            warnings.push(warning);
        if (result.scopeFallback !== undefined)
            scopeFallbackNote = String(result.scopeFallback);
        if (result.workspaceEmpty === true)
            workspaceEmpty = true;
        if (result.shortQueryFallback === true)
            shortQueryFallback = true;
        // Compact pages must stay readable: attach the stored session-event refs
        // even though the content enricher only paid for them on full-detail rows.
        const hits = await attachSessionEventRefs(content, result.hits);
        if (hits.length === 0) {
            more = false;
            break;
        }
        for (let index = 0; index < hits.length; index++) {
            const hit = hits[index];
            const rawIndex = cursor + index;
            if (rows.length >= ctx.limit) {
                unscanned += 1;
                continue;
            }
            const kind = hit.kind === 'session' ? 'session' : 'file';
            if (!ctx.kinds.has(kind)) {
                dropped.push({ index: rawIndex, reason: 'scope' });
                continue;
            }
            if (!contentRowVisible(ctx, hit)) {
                dropped.push({ index: rawIndex, reason: 'scope' });
                continue;
            }
            const needsStat = ctx.where.modifiedAfter !== undefined || ctx.where.minSize !== undefined;
            const meta = needsStat ? await fileMetadata(hit.path, ctx.statCache) : undefined;
            if (!whereMatches(hit.path, meta, ctx.where)) {
                if (needsStat && meta === undefined)
                    unverified += 1;
                dropped.push({ index: rawIndex, reason: 'scope' });
                continue;
            }
            const key = bodyRowKey(hit);
            if (seen.has(key)) {
                dropped.push({ index: rawIndex, reason: 'scope' });
                continue;
            }
            seen.add(key);
            const item = contentItem(hit);
            rows.push({ item: ctx.detail === 'full' && item.kind === 'file' ? await withFileStats(item, ctx.statCache) : item, offset: rawIndex });
        }
        consumed += hits.length;
        cursor += hits.length;
        const exactCount = result.count.kind === 'exact' ? result.count.value : undefined;
        more = hits.length >= want && (exactCount === undefined || cursor < exactCount);
    }
    if (unscanned > 0)
        more = true;
    if (lastCount !== undefined && lastCount.kind === 'exact' && cursor < lastCount.value)
        more = true;
    const advance = pageAdvance({
        offset: ctx.offset,
        fetchedRows: consumed,
        keptIndices: rows.map(row => row.offset),
        dropped,
        more,
    });
    const counts = {};
    if (lastCount !== undefined && lastCount.kind !== 'unknown' && ctx.countMode !== 'none') {
        counts.bodyTotal = lastCount.value;
        counts.bodyKind = lastCount.kind;
        counts.total = lastCount.value;
        counts.totalKind = lastCount.kind;
    }
    const notes = [];
    // The content count is computed before ext/size/mtime filters are applied to
    // rows; say so instead of presenting an unfiltered number as the page total.
    if (ctx.countMode !== 'none' && countFilteringWhere(ctx.where) && counts.bodyTotal !== undefined) {
        notes.push(coverageNote('counts-ignore-where', 'counts.* are the unfiltered content-index totals; where filters apply to returned rows only.', 'info'));
    }
    if (workspaceEmpty)
        notes.push(coverageNote('workspace-empty', 'No body matches under the caller workspace.', 'info'));
    if (scopeFallbackNote !== undefined)
        notes.push(coverageNote('content-scope-fallback', 'content index widened the body scope: ' + scopeFallbackNote, 'info'));
    if (shortQueryFallback)
        notes.push(coverageNote('query-degraded', 'The query was answered by the bounded short-query fallback; this page is approximate.', 'warn'));
    if (unverified > 0)
        notes.push(coverageNote('where-unverified', String(unverified) + ' row(s) were excluded because where.modifiedAfter/minSize could not be verified.', 'warn'));
    const uniqueWarnings = [...new Set(warnings)];
    if (uniqueWarnings.length > 0)
        notes.push(coverageNote('content-warnings', uniqueWarnings.slice(0, 6).join(', '), 'info'));
    if (lastState !== undefined && lastState.building === true)
        notes.push(coverageNote('index-building', 'The content index is still building; this page is partial.', 'warn'));
    return {
        rows,
        more: advance.hasMore,
        ...(advance.nextOffset === undefined ? {} : { nextOffset: advance.nextOffset }),
        counts,
        coverage: makeCoverage({
            indexing: lastState !== undefined && lastState.building === true,
            indexTruncated: lastState !== undefined && lastState.truncated === true,
            notes,
        }),
        empty: rows.length === 0,
    };
}
/** Build one symbol-mode page (declarations from the symbols table). */
async function runSymbolMode(ctx) {
    const content = ctx.content;
    if (content === undefined) {
        return fail(ctx, 'index-unavailable', 'the symbol index is disabled in this profile (content index off)', {
            remediation: 'Enable the content index or pass mode:"name".',
            nextTools: ['locator_status'],
        });
    }
    if (typeof content.findSymbols !== 'function')
        return fail(ctx, 'index-unavailable', 'this content store does not support symbol search');
    try {
        ctx.ensure?.();
    }
    catch (error) {
        return fail(ctx, 'index-unavailable', 'the content index failed to start: ' + errorMessage(error), {
            retryable: true,
            details: { cause: errorMessage(error) },
        });
    }
    let matches;
    try {
        matches = content.findSymbols(ctx.query, SYMBOL_MAX_MATCHES);
    }
    catch (error) {
        return fail(ctx, 'internal', 'symbol lookup failed: ' + errorMessage(error), {
            retryable: true,
            details: { cause: errorMessage(error) },
        });
    }
    const callerCwd = ctx.caller.cwd;
    const cwdIsIndexed = callerCwd !== undefined && ctx.rt.roots.some(root => withinRoots(callerCwd, [root]));
    const narrowToCwd = ctx.effectiveScope === 'workspace' && cwdIsIndexed && callerCwd !== undefined;
    const visible = [];
    let unverified = 0;
    for (const match of matches) {
        if (narrowToCwd && callerCwd !== undefined && !withinRoots(match.path, [callerCwd]))
            continue;
        const scope = ctx.options.scope;
        if (scope !== undefined && !(scope.isSearchable(match.path) && scope.isIndexable(match.path) && scope.isReadable(match.path)))
            continue;
        const needsStat = ctx.where.modifiedAfter !== undefined || ctx.where.minSize !== undefined;
        const meta = needsStat ? await fileMetadata(match.path, ctx.statCache) : undefined;
        if (!whereMatches(match.path, meta, ctx.where)) {
            if (needsStat && meta === undefined)
                unverified += 1;
            continue;
        }
        visible.push(match);
    }
    const start = Math.max(0, Math.trunc(ctx.offset));
    const pageMatches = visible.slice(start, start + ctx.limit);
    const rows = pageMatches.map((match, index) => ({ item: symbolItem(ctx, match), offset: start + index }));
    const more = start + rows.length < visible.length;
    const notes = [];
    if (matches.length >= SYMBOL_MAX_MATCHES) {
        notes.push(coverageNote('symbol-cap', 'Symbol matches are capped at ' + String(SYMBOL_MAX_MATCHES) + '; narrow the query for exact coverage.', 'info'));
    }
    if (unverified > 0)
        notes.push(coverageNote('where-unverified', String(unverified) + ' symbol row(s) were excluded because where.modifiedAfter/minSize could not be verified.', 'warn'));
    const totalKind = matches.length >= SYMBOL_MAX_MATCHES ? 'bounded' : 'exact';
    // counts.symbolTotal is already narrowed by workspace/scope/where, so it is
    // not a global number; count:none omits it like every other mode.
    const counts = ctx.countMode === 'none' ? {} : { total: visible.length, totalKind, symbolTotal: visible.length };
    return {
        rows,
        more,
        ...(more ? { nextOffset: start + rows.length } : {}),
        counts,
        coverage: makeCoverage({ notes }),
        empty: rows.length === 0,
    };
}
/** Create one idle source stream positioned at a consumed offset. */
function autoSourceState(source, start) {
    return {
        source,
        fetchOffset: start,
        consumed: start,
        buffer: [],
        done: false,
        sawRows: start > 0,
        pulled: 0,
        totalKind: 'exact',
    };
}
/**
 * Sources one auto request merges, in priority order, plus notes for a skipped
 * source. Mirrors the CLI/MCP parity surface: symbol only for identifier-shaped
 * queries (or an explicit symbol-only kinds list), body only when the query has
 * a 3+ character term, name for file/dir kinds. There is no "first non-empty
 * source" resolution any more — every active source contributes to one page.
 * @param ctx - find context (kinds + query).
 * @param notes - coverage notes sink.
 * @returns the active sources in priority order.
 */
function autoSourcesFor(ctx, notes) {
    const sources = [];
    if (ctx.kinds.has('symbol')) {
        const symbolOnly = ctx.kinds.size === 1;
        if (symbolOnly || isAutoSymbolQuery(ctx.query))
            sources.push('symbol');
    }
    if (ctx.kinds.has('file') || ctx.kinds.has('session')) {
        if (hasBodyTerm(ctx.query))
            sources.push('body');
        else
            notes.push(coverageNote('body-skipped', 'The query has no 3+ character term for the body index; searched names/symbols only.', 'info'));
    }
    if (ctx.kinds.has('file') || ctx.kinds.has('dir'))
        sources.push('name');
    return sources;
}
/** Stable dedupe identity of one row: one file path, one session message, one declaration. */
function autoIdentityKey(item) {
    if (item.kind === 'symbol')
        return 'symbol\u0000' + item.path + '\u0000' + String(item.line ?? '');
    if (item.kind === 'session')
        return 'session\u0000' + (item.sessionId ?? item.path) + '\u0000' + (item.messageId ?? '');
    return (item.kind === 'dir' ? 'dir\u0000' : 'file\u0000') + item.path;
}
/** Rank tier of one merged row (lower is better); same order as the CLI parity surface. */
function autoTierOf(item) {
    const why = item.why ?? [];
    if (why.includes('symbol:exact'))
        return 0;
    if (why.includes('body:terms'))
        return 1;
    if (why.includes('symbol:prefix'))
        return 2;
    if (why.includes('symbol:substring'))
        return 3;
    if (why.includes('name:prefix'))
        return 4;
    return 5;
}
/** Query terms used for the body coverage tie-break. */
function autoQueryTerms(query) {
    return (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(term => term.length > 0);
}
/** Number of query terms present in a body snippet (coverage tie-break). */
function autoBodyCoverage(item, terms) {
    const snippet = item.snippet?.toLowerCase();
    if (snippet === undefined || terms.length === 0)
        return 0;
    let covered = 0;
    for (const term of terms)
        if (snippet.includes(term))
            covered += 1;
    return covered;
}
/** Path depth (separator count) used as a name-mode tie-break (shallower first). */
function pathDepth(path) {
    return path.replace(/\\/g, '/').split('/').length;
}
/**
 * Compare two merge candidates: symbol exact, body (coverage then BM25), symbol
 * prefix/substring, name prefix/substring, then path depth, recency and path as
 * stable tie-breaks. 0 keeps the current best (source priority order).
 */
function compareAutoCandidates(a, b, terms) {
    const tierA = autoTierOf(a.item);
    const tierB = autoTierOf(b.item);
    if (tierA !== tierB)
        return tierA - tierB;
    if (tierA === 1) {
        const coverageDiff = autoBodyCoverage(b.item, terms) - autoBodyCoverage(a.item, terms);
        if (coverageDiff !== 0)
            return coverageDiff;
    }
    const scoreA = typeof a.item.score === 'number' ? a.item.score : Number.MAX_SAFE_INTEGER;
    const scoreB = typeof b.item.score === 'number' ? b.item.score : Number.MAX_SAFE_INTEGER;
    if (scoreA !== scoreB)
        return scoreA - scoreB;
    const depthDiff = pathDepth(a.item.path) - pathDepth(b.item.path);
    if (depthDiff !== 0)
        return depthDiff;
    const mtimeA = typeof a.item.mtime === 'number' ? a.item.mtime : 0;
    const mtimeB = typeof b.item.mtime === 'number' ? b.item.mtime : 0;
    if (mtimeA !== mtimeB)
        return mtimeB - mtimeA;
    return 0;
}
/** Merge a duplicate row into the item already emitted for the same identity. */
function mergeAutoItems(target, duplicate, duplicateSource) {
    const why = [...(target.why ?? [])];
    for (const label of duplicate.why ?? [])
        if (why.includes(label) === false)
            why.push(label);
    if (why.length > 0)
        target.why = why;
    const sources = [...(target.sources ?? [])];
    const duplicateSources = duplicate.sources ?? [duplicateSource];
    for (const source of duplicateSources)
        if (sources.includes(source) === false)
            sources.push(source);
    if (sources.length > 0)
        target.sources = sources;
    if (target.snippet === undefined && duplicate.snippet !== undefined) {
        target.snippet = duplicate.snippet;
        if (duplicate.line !== undefined)
            target.line = duplicate.line;
    }
    if (target.size === undefined && duplicate.size !== undefined)
        target.size = duplicate.size;
    if (target.mtime === undefined && duplicate.mtime !== undefined)
        target.mtime = duplicate.mtime;
    if (target.ref === undefined && duplicate.ref !== undefined)
        target.ref = duplicate.ref;
}
/** Build the counts block of one auto page (per-source totals; no hidden exactness). */
function buildAutoCounts(ctx, active, state, notes) {
    if (ctx.countMode === 'none')
        return {};
    const counts = {};
    let total = 0;
    let totalKnown = true;
    let totalKind = 'exact';
    for (const source of active) {
        const current = state[source];
        if (current.total === undefined) {
            totalKnown = false;
            continue;
        }
        if (source === 'name')
            counts.nameTotal = current.total;
        else if (source === 'body') {
            counts.bodyTotal = current.total;
            counts.bodyKind = current.totalKind;
        }
        else
            counts.symbolTotal = current.total;
        total += current.total;
        if (current.totalKind === 'bounded')
            totalKind = 'bounded';
    }
    if (ctx.countMode === 'bounded' && totalKind === 'exact')
        totalKind = 'bounded';
    if (totalKnown) {
        counts.total = total;
        counts.totalKind = totalKind;
    }
    if (active.length > 1 && ctx.countMode === 'exact') {
        notes.push(coverageNote('counts-approximate', 'counts.total sums the per-source match counts (deduplicated rows are not subtracted).', 'info'));
        if (counts.totalKind === 'exact')
            counts.totalKind = 'bounded';
    }
    return counts;
}
/**
 * Build one cross-source auto page: fetch a batch from every active source,
 * pick the best head by rank, dedupe by identity (merging why/sources), and
 * keep the per-source consumed positions for the v2 continuation cursor.
 * Empty workspace body results are retried against every root once (with a
 * note) instead of silently losing cross-root body hits.
 * @param ctx - find context (offset already resolved from the v2 cursor).
 * @returns the merged page or the uniform failure envelope.
 */
async function runAutoMerge(ctx) {
    const notes = [];
    const active = autoSourcesFor(ctx, notes);
    if (active.length === 0) {
        // session-only kinds + an all-short query: the body index is the only
        // source that could answer, and it rejected the query.
        if ((ctx.kinds.has('file') || ctx.kinds.has('session')) && ctx.kinds.has('file') === false && ctx.kinds.has('dir') === false && ctx.kinds.has('symbol') === false) {
            return fail(ctx, 'query-too-short', 'the query has no 3+ character term for the content index', {
                remediation: 'Use a 3+ character query term, or include file/dir kinds so the name index can answer.',
                nextTools: ['locator_find'],
            });
        }
        return fail(ctx, 'invalid-argument', 'kinds excludes every source mode:"auto" can search');
    }
    const cursorV2 = ctx.cursor !== undefined && ctx.cursor.v === 2 ? ctx.cursor : undefined;
    const start = (source) => cursorV2 === undefined ? ctx.offset : cursorV2.offsets[source] ?? 0;
    if (cursorV2 === undefined && ctx.offset > 0) {
        notes.push(coverageNote('offset-approximate', 'offset applies to every source independently in cross-source auto mode; prefer page.nextCursor.', 'info'));
    }
    const wanted = new Set(active);
    const state = {
        name: autoSourceState('name', start('name')),
        body: autoSourceState('body', start('body')),
        symbol: autoSourceState('symbol', start('symbol')),
    };
    const rootScope = ctx.effectiveScope === 'workspace' ? 'workspace' : 'all';
    for (const source of active)
        if (source === 'body')
            state.body.bodyScope = rootScope;
    const allowCross = ctx.effectiveScope === 'all' && ctx.options.allowCrossWorkspaceSessions === true;
    const callerCwd = ctx.caller.cwd;
    const cwdIsIndexed = callerCwd !== undefined && ctx.rt.roots.some(root => withinRoots(callerCwd, [root]));
    const narrowToCwd = ctx.effectiveScope === 'workspace' && cwdIsIndexed && callerCwd !== undefined;
    const filesOnly = ctx.kinds.has('file') && ctx.kinds.has('dir') === false;
    const dirsOnly = ctx.kinds.has('dir') && ctx.kinds.has('file') === false;
    const configuredMax = typeof ctx.rt.config?.maxResults === 'number' && ctx.rt.config.maxResults > 0 ? Math.trunc(ctx.rt.config.maxResults) : AUTO_BATCH_MAX;
    const batch = Math.max(1, Math.min(AUTO_BATCH_MAX, configuredMax, Math.max(ctx.limit * 3, AUTO_BATCH_MIN)));
    const observedAt = Date.now();
    const queryTerms = autoQueryTerms(ctx.query);
    let indexing = false;
    let indexTruncated = false;
    const pullName = async (current) => {
        try {
            ctx.rt.start();
            const page = await ctx.rt.search({
                query: ctx.query,
                limit: batch,
                offset: current.fetchOffset,
                sort: 'name',
                desc: false,
                regex: false,
                caseSensitive: false,
                wholeWord: false,
                filesOnly,
                dirsOnly,
            });
            const first = current.fetchOffset;
            current.fetchOffset = first + page.hits.length;
            current.pulled += page.hits.length;
            if (typeof page.total === 'number' && Number.isFinite(page.total))
                current.total = page.total;
            current.totalKind = 'exact';
            if (page.indexing === true) {
                indexing = true;
                notes.push(coverageNote('index-building', 'The name index is still scanning; this page is partial.', 'warn'));
            }
            for (let index = 0; index < page.hits.length; index++) {
                const hit = page.hits[index];
                if (hit === undefined)
                    continue;
                if (narrowToCwd && callerCwd !== undefined && !withinRoots(hit.path, [callerCwd]))
                    continue;
                const kind = hit.dir ? 'dir' : 'file';
                if (ctx.kinds.has(kind) === false)
                    continue;
                if (ctx.options.scope !== undefined && !ctx.options.scope.isSearchable(hit.path))
                    continue;
                if (!whereMatches(hit.path, { size: hit.size, mtime: hit.mtime }, ctx.where))
                    continue;
                current.buffer.push({ source: 'name', item: buildNameItem(ctx, hit, observedAt, cwdIsIndexed), pos: first + index });
                current.sawRows = true;
            }
            const exhausted = page.hits.length === 0
                || (current.total !== undefined ? current.fetchOffset >= current.total : page.truncated !== true);
            if (exhausted)
                current.done = true;
        }
        catch (error) {
            current.done = true;
            current.failure = fail(ctx, 'index-unavailable', 'name index search failed: ' + errorMessage(error), {
                retryable: true,
                details: { cause: errorMessage(error) },
            });
            notes.push(coverageNote('name-unavailable', 'The name source is unavailable: ' + errorMessage(error), 'warn'));
        }
    };
    const pullBody = async (current) => {
        const content = ctx.content;
        if (content === undefined || typeof content.search !== 'function') {
            current.done = true;
            current.failure = fail(ctx, 'index-unavailable', 'the content index is disabled in this profile', {
                remediation: 'Enable the content index or pass mode:"name".',
                nextTools: ['locator_status'],
            });
            notes.push(coverageNote('body-unavailable', 'The body source is unavailable: the content index is disabled in this profile.', 'warn'));
            return;
        }
        try {
            ctx.ensure?.();
        }
        catch (error) {
            current.done = true;
            current.failure = fail(ctx, 'index-unavailable', 'the content index failed to start: ' + errorMessage(error), { retryable: true });
            notes.push(coverageNote('body-unavailable', 'The body source is unavailable: ' + errorMessage(error), 'warn'));
            return;
        }
        const scope = current.bodyScope ?? rootScope;
        const request = {
            query: ctx.query,
            limit: batch,
            offset: current.fetchOffset,
            scope,
            detail: ctx.detail === 'compact' ? 'compact' : 'full',
            ...(ctx.detail === 'compact' ? {} : { evidenceLimit: batch, ...(ctx.detail === 'full' ? { includeHash: true } : {}) }),
            count: ctx.countMode,
            ...(ctx.where.pathPrefix === undefined ? {} : { pathPrefix: ctx.where.pathPrefix }),
            ...(ctx.includeArchived ? { includeArchived: true } : {}),
        };
        let result;
        try {
            result = await runContentSearchRequest(content, request, ctx.rt.roots, allowCross, ctx.caller, contentScopeOptionsOf(ctx.rt));
        }
        catch (error) {
            current.done = true;
            current.failure = fail(ctx, 'internal', 'content search failed: ' + errorMessage(error), { retryable: true });
            notes.push(coverageNote('body-unavailable', 'The body source failed: ' + errorMessage(error), 'warn'));
            return;
        }
        if (!result.ok) {
            const mapped = mapContentError(result.error);
            current.done = true;
            current.failure = fail(ctx, mapped.code, mapped.code === 'internal' ? result.error : undefined, {
                ...(mapped.retryable === undefined ? {} : { retryable: mapped.retryable }),
                ...(mapped.remediation === undefined ? {} : { remediation: mapped.remediation }),
                details: { cause: result.error },
            });
            notes.push(coverageNote('body-unavailable', 'The body source is unavailable: ' + result.error, 'warn'));
            return;
        }
        // A workspace body page that is empty must not hide cross-root hits: retry
        // the body source once against every configured root and say so.
        const canWiden = rootScope === 'workspace' && scope === 'workspace' && current.fetchOffset === 0
            && current.retriedScope !== true && ctx.where.pathPrefix === undefined;
        if (canWiden && result.hits.length === 0) {
            current.retriedScope = true;
            current.bodyScope = 'all';
            notes.push(coverageNote('auto-body-scope-fallback', 'body search had no workspace match; widened the body source to every configured root.', 'info'));
            return;
        }
        if (result.state.building === true) {
            indexing = true;
            notes.push(coverageNote('index-building', 'The content index is still building; this page is partial.', 'warn'));
        }
        if (result.state.truncated === true)
            indexTruncated = true;
        for (const warning of result.warnings)
            notes.push(coverageNote('content-warning', warning, 'info'));
        if (result.scopeFallback !== undefined)
            notes.push(coverageNote('content-scope-fallback', 'content index widened the body scope: ' + String(result.scopeFallback), 'info'));
        if (result.workspaceEmpty === true)
            notes.push(coverageNote('workspace-empty', 'No body matches under the caller workspace.', 'info'));
        if (result.shortQueryFallback === true)
            notes.push(coverageNote('query-degraded', 'The query was answered by the bounded short-query fallback; this page is approximate.', 'warn'));
        const hits = await attachSessionEventRefs(content, result.hits);
        const first = current.fetchOffset;
        current.fetchOffset = first + result.hits.length;
        current.pulled += result.hits.length;
        if (result.count.kind !== 'unknown') {
            current.total = result.count.value;
            current.totalKind = result.count.kind;
        }
        for (let index = 0; index < hits.length; index++) {
            const hit = hits[index];
            if (hit === undefined)
                continue;
            const kind = hit.kind === 'session' ? 'session' : 'file';
            if (ctx.kinds.has(kind) === false)
                continue;
            if (!contentRowVisible(ctx, hit))
                continue;
            const needsStat = ctx.where.modifiedAfter !== undefined || ctx.where.minSize !== undefined;
            const meta = needsStat ? await fileMetadata(hit.path, ctx.statCache) : undefined;
            if (!whereMatches(hit.path, meta, ctx.where))
                continue;
            let item = contentItem(hit);
            if (ctx.detail === 'full' && item.kind === 'file')
                item = await withFileStats(item, ctx.statCache);
            current.buffer.push({ source: 'body', item, pos: first + index });
            current.sawRows = true;
        }
        const exhausted = result.hits.length === 0
            || (result.count.kind === 'exact' ? current.fetchOffset >= result.count.value : result.hits.length < request.limit);
        if (exhausted)
            current.done = true;
    };
    const pullSymbol = async (current) => {
        if (current.pulled > 0)
            return;
        const content = ctx.content;
        if (content === undefined || typeof content.findSymbols !== 'function') {
            current.done = true;
            current.failure = fail(ctx, 'index-unavailable', 'the symbol index is disabled in this profile (content index off)', {
                remediation: 'Enable the content index or pass mode:"name".',
                nextTools: ['locator_status'],
            });
            notes.push(coverageNote('symbol-unavailable', 'The symbol source is unavailable: the content index is disabled in this profile.', 'warn'));
            return;
        }
        try {
            ctx.ensure?.();
            const matches = content.findSymbols(ctx.query, SYMBOL_MAX_MATCHES);
            current.pulled = 1;
            current.totalKind = matches.length >= SYMBOL_MAX_MATCHES ? 'bounded' : 'exact';
            if (matches.length >= SYMBOL_MAX_MATCHES) {
                notes.push(coverageNote('symbol-cap', 'Symbol matches are capped at ' + String(SYMBOL_MAX_MATCHES) + '; narrow the query for exact coverage.', 'info'));
            }
            const visible = [];
            let unverified = 0;
            for (const match of matches) {
                // 0.23 (P0-3): markdown headings are prose titles, not identifiers; they
                // never enter the auto merge (explicit mode "symbol" still returns them).
                if (match.kind === 'heading')
                    continue;
                if (narrowToCwd && callerCwd !== undefined && !withinRoots(match.path, [callerCwd]))
                    continue;
                const scope = ctx.options.scope;
                if (scope !== undefined && !(scope.isSearchable(match.path) && scope.isIndexable(match.path) && scope.isReadable(match.path)))
                    continue;
                const needsStat = ctx.where.modifiedAfter !== undefined || ctx.where.minSize !== undefined;
                const meta = needsStat ? await fileMetadata(match.path, ctx.statCache) : undefined;
                if (!whereMatches(match.path, meta, ctx.where)) {
                    if (needsStat && meta === undefined)
                        unverified += 1;
                    continue;
                }
                visible.push(match);
            }
            if (unverified > 0)
                notes.push(coverageNote('where-unverified', String(unverified) + ' symbol row(s) were excluded because where.modifiedAfter/minSize could not be verified.', 'warn'));
            current.total = visible.length;
            current.sawRows = visible.length > 0;
            const from = Math.min(current.fetchOffset, visible.length);
            for (let index = from; index < visible.length; index++) {
                const match = visible[index];
                if (match === undefined)
                    continue;
                current.buffer.push({ source: 'symbol', item: symbolItem(ctx, match), pos: index });
            }
            current.fetchOffset = visible.length;
            current.done = true;
        }
        catch (error) {
            current.done = true;
            current.failure = fail(ctx, 'internal', 'symbol lookup failed: ' + errorMessage(error), { retryable: true });
            notes.push(coverageNote('symbol-unavailable', 'The symbol source is unavailable: ' + errorMessage(error), 'warn'));
        }
    };
    /** Fetch one batch for a source, unless it is done, buffered or scan-capped. */
    const pull = async (current) => {
        if (current.done || current.buffer.length > 0)
            return;
        if (current.pulled >= AUTO_PULL_MAX_ROWS)
            return;
        if (current.source === 'name')
            await pullName(current);
        else if (current.source === 'body')
            await pullBody(current);
        else
            await pullSymbol(current);
    };
    /** File identities already returned on earlier pages (bounded v2 cursor memory). */
    const seenEarlier = new Set(cursorV2?.seen ?? []);
    let filteredDuplicates = 0;
    const emitted = [];
    const seen = new Map();
    while (emitted.length < ctx.limit) {
        let best;
        let bestState;
        for (const source of AUTO_SOURCE_ORDER) {
            if (wanted.has(source) === false)
                continue;
            const current = state[source];
            // Keep pulling until this source has a head: a pull can legitimately
            // return nothing once (the body workspace-empty widening retries).
            while (current.buffer.length === 0 && current.done === false && current.pulled < AUTO_PULL_MAX_ROWS) {
                const before = current.fetchOffset;
                const scopeBefore = current.bodyScope;
                await pull(current);
                if (current.fetchOffset === before && current.bodyScope === scopeBefore && current.buffer.length === 0)
                    break;
            }
            const head = current.buffer[0];
            if (head === undefined)
                continue;
            if (best === undefined || compareAutoCandidates(head, best, queryTerms) < 0) {
                best = head;
                bestState = current;
            }
        }
        if (best === undefined || bestState === undefined)
            break;
        bestState.buffer.shift();
        bestState.sawRows = true;
        if (best.pos + 1 > bestState.consumed)
            bestState.consumed = best.pos + 1;
        const key = autoIdentityKey(best.item);
        const existing = seen.get(key);
        if (existing !== undefined) {
            mergeAutoItems(existing, best.item, best.source);
            continue;
        }
        // A later page can meet the same file again from another source (body vs
        // name); the cursor-level identity memory keeps the page union duplicate-free.
        const identity = best.item.kind === 'file' ? identityTokenHash(best.item.path) : '';
        if (identity !== '' && seenEarlier.has(identity)) {
            filteredDuplicates += 1;
            continue;
        }
        const item = { ...best.item, sources: [best.source] };
        seen.set(key, item);
        emitted.push({ candidate: best, item, identity });
    }
    if (filteredDuplicates > 0) {
        notes.push(coverageNote('duplicate-filtered', String(filteredDuplicates) + ' row(s) were already returned on an earlier page and were skipped.', 'info'));
    }
    // Rows that were fetched and filtered out are permanently skipped; rows still
    // buffered are not consumed yet (the next page refetches from the frontier).
    for (const source of active) {
        const current = state[source];
        const frontier = current.buffer.length > 0 ? current.buffer[0]?.pos : current.fetchOffset;
        if (frontier !== undefined && frontier > current.consumed)
            current.consumed = frontier;
    }
    const counts = buildAutoCounts(ctx, active, state, notes);
    const nameCountsStale = counts.nameTotal !== undefined && hasWhere(ctx.where);
    const bodyCountsStale = counts.bodyTotal !== undefined && countFilteringWhere(ctx.where);
    if (ctx.countMode !== 'none' && (nameCountsStale || bodyCountsStale)) {
        notes.push(coverageNote('counts-ignore-where', 'counts.* are the unfiltered index totals; where filters apply to returned rows only.', 'info'));
    }
    const contributing = AUTO_SOURCE_ORDER.filter(source => wanted.has(source) && state[source].sawRows);
    const resolvedMode = contributing.length > 1
        ? 'mixed'
        : contributing.length === 1
            ? contributing[0]
            : wanted.has('name') ? 'name' : wanted.has('body') ? 'body' : 'symbol';
    const failures = AUTO_SOURCE_ORDER
        .filter(source => wanted.has(source))
        .map(source => state[source].failure)
        .filter((value) => value !== undefined);
    if (emitted.length === 0 && failures.length === active.length)
        return failures[0];
    // A filtered source can burn the per-page scan cap without filling the page;
    // keep paging (the cursor frontier advanced) and say why this page is short.
    const scanCapped = active.some(source => {
        const current = state[source];
        return current.done === false && current.buffer.length === 0 && current.pulled >= AUTO_PULL_MAX_ROWS;
    });
    if (scanCapped) {
        notes.push(coverageNote('auto-scan-capped', 'A source hit the per-page scan cap of ' + String(AUTO_PULL_MAX_ROWS) + ' raw rows; narrow the query or use a single mode for exhaustive paging.', 'warn'));
    }
    const streamsHaveMore = active.some(source => {
        const current = state[source];
        return current.buffer.length > 0 || current.done === false;
    });
    const more = streamsHaveMore && (emitted.length >= ctx.limit || scanCapped);
    const cursorOffsets = {};
    for (const source of active)
        cursorOffsets[source] = state[source].consumed;
    return {
        rows: emitted.map((entry, index) => ({ item: entry.item, offset: index })),
        more,
        counts,
        coverage: makeCoverage({ indexing, indexTruncated, notes }),
        empty: emitted.length === 0,
        resolvedMode,
        cursorOffsets,
        rowSources: emitted.map(entry => ({ source: entry.candidate.source, pos: entry.candidate.pos })),
        rowIdentities: emitted.map(entry => entry.identity),
    };
}
/** Dispatch one resolved mode. */
async function runMode(mode, ctx) {
    if (mode === 'symbol')
        return await runSymbolMode(ctx);
    if (mode === 'body')
        return await runBodyMode(ctx);
    return await runNameMode(ctx);
}
/* ------------------------------------------------------------------------- */
/* Tool invocation                                                           */
/* ------------------------------------------------------------------------- */
/**
 * Run one fully-validated locator_find call.
 *
 * Resolves the mode, pins the cursor scope/mode, fetches one page from the
 * chosen source, applies the detail preset and the item budget, and assembles
 * the success/failure envelope. Empty page one in workspace scope is widened
 * to every configured root exactly once (never silently).
 * @param rt - locator runtime.
 * @param content - optional content index (body/symbol modes).
 * @param ensure - lazy content boot hook.
 * @param options - factory options.
 * @param caller - caller session/cwd identity.
 * @param rawArgs - raw argument object.
 * @param started - call start timestamp.
 * @returns the success or failure envelope.
 */
export async function runAgentFind(rt, content, ensure, options, caller, rawArgs, started) {
    const failNow = (code, message, extra = {}) => makeError(code, message, { tool: TOOL_NAME, ...extra, timing: makeTiming(started) });
    const normalized = normalizeRequest(rt, options, rawArgs, started);
    if (isFailure(normalized))
        return normalized;
    const whereHash = {};
    if (normalized.where.pathPrefix !== undefined)
        whereHash.pathPrefix = normalized.where.pathPrefix;
    if (normalized.where.ext !== undefined)
        whereHash.ext = [...normalized.where.ext];
    if (normalized.where.modifiedAfter !== undefined)
        whereHash.modifiedAfter = normalized.where.modifiedAfter;
    if (normalized.where.minSize !== undefined)
        whereHash.minSize = normalized.where.minSize;
    const hashParts = {
        query: normalized.query,
        mode: normalized.mode,
        scope: normalized.scopeRequested,
        kinds: [...normalized.kinds].sort(),
        where: whereHash,
    };
    // Only add the flag when it is set so 0.22-issued v1 cursors keep matching.
    if (normalized.includeArchived)
        hashParts.includeArchived = true;
    const queryHash = queryHashOf(hashParts);
    let cursorPayload;
    if (normalized.cursor !== undefined) {
        const decoded = decodeCursor(normalized.cursor);
        if (decoded === undefined)
            return failNow('cursor-invalid', 'cursor is not a valid locator_find cursor');
        if (decoded.queryHash !== queryHash)
            return failNow('cursor-invalid', 'cursor does not belong to this query, mode or scope');
        if (normalized.mode === 'auto') {
            // Cross-source auto pagination pins one position per source, which only
            // the v2 payload can carry. A v1 cursor (0.22 auto page) cannot be resumed.
            if (decoded.v !== 2) {
                return failNow('cursor-invalid', 'auto pagination needs the v2 cursor issued by this version; re-run the query without a cursor');
            }
            if (decoded.mode !== 'auto')
                return failNow('cursor-invalid', 'cursor was issued for mode ' + decoded.mode + ', not auto');
            const requestKinds = [...normalized.kinds].sort();
            if (decoded.kinds !== undefined && (decoded.kinds.length !== requestKinds.length || decoded.kinds.some((kind, index) => kind !== requestKinds[index]))) {
                return failNow('cursor-invalid', 'cursor kinds do not match this request; re-run the query without a cursor');
            }
            if ((decoded.includeArchived === true) !== normalized.includeArchived) {
                return failNow('cursor-invalid', 'cursor was issued with a different includeArchived value; re-run the query without a cursor');
            }
        }
        else if (decoded.mode !== normalized.mode) {
            return failNow('cursor-invalid', 'cursor was issued for mode ' + decoded.mode + ', not ' + normalized.mode);
        }
        const decodedScope = decoded.scope;
        if (decodedScope !== undefined && decodedScope !== normalized.scopeRequested) {
            const allowedWidening = normalized.scopeRequested === 'workspace' && decodedScope === 'roots';
            if (!allowedWidening)
                return failNow('cursor-invalid', 'cursor scope does not match the requested scope');
        }
        cursorPayload = decoded;
    }
    let offset = normalized.explicitOffset ?? 0;
    if (cursorPayload !== undefined) {
        if (cursorPayload.v === 1)
            offset = cursorPayload.offset;
        else if (cursorPayload.mode === 'auto')
            offset = (cursorPayload.offsets.name ?? 0) + (cursorPayload.offsets.body ?? 0) + (cursorPayload.offsets.symbol ?? 0);
        else if (cursorPayload.mode === 'name')
            offset = cursorPayload.offsets.name ?? 0;
        else if (cursorPayload.mode === 'body')
            offset = cursorPayload.offsets.body ?? 0;
        else
            offset = cursorPayload.offsets.symbol ?? 0;
    }
    let effectiveScope;
    let fallbackReason;
    if (cursorPayload?.scope !== undefined) {
        effectiveScope = cursorPayload.scope;
        if (effectiveScope !== normalized.scopeRequested)
            fallbackReason = 'continued from a cursor issued after a workspace widening';
    }
    else {
        const initial = initialScope(normalized.scopeRequested, caller, rt);
        effectiveScope = initial.effective;
        fallbackReason = initial.fallbackReason;
    }
    const ctx = {
        rt,
        content,
        ensure,
        options,
        caller,
        query: normalized.query,
        mode: normalized.mode,
        kinds: new Set(normalized.kinds),
        where: normalized.where,
        detail: normalized.detail,
        limit: normalized.limit,
        offset,
        countMode: normalized.countMode,
        maxChars: normalized.maxChars,
        queryHash,
        effectiveScope,
        cursor: cursorPayload,
        started,
        includeArchived: normalized.includeArchived,
        statCache: new Map(),
    };
    const run = async (context) => normalized.mode === 'auto'
        ? await runAutoMerge(context)
        : await runMode(normalized.mode, context);
    let page = await run(ctx);
    if (isFailure(page))
        return page;
    let scopeFallback = effectiveScope !== normalized.scopeRequested;
    if (page.rows.length === 0 && ctx.effectiveScope === 'workspace' && ctx.offset === 0 && cursorPayload === undefined) {
        const widened = await run({ ...ctx, effectiveScope: 'roots', offset: 0 });
        if (isFailure(widened)) {
            page.coverage.notes.push(coverageNote('scope-fallback-failed', 'widening the workspace to roots failed: ' + widened.error.message, 'warn'));
        }
        else {
            page = widened;
            ctx.effectiveScope = 'roots';
            effectiveScope = 'roots';
            scopeFallback = true;
            fallbackReason = 'workspace-empty; searched every configured root';
        }
    }
    const resolvedMode = normalized.mode === 'auto' ? page.resolvedMode ?? 'name' : normalized.mode;
    const trimmedRows = page.rows.map(row => ({ item: trimItem(row.item, normalized.detail), offset: row.offset }));
    const budgeted = applyItemBudget(trimmedRows.map(row => row.item), normalized.maxChars);
    const keptRows = trimmedRows.slice(0, budgeted.items.length);
    let more = page.more;
    let nextCursor;
    const generation = generationOf(rt);
    if (normalized.mode === 'auto') {
        const offsets = { ...(page.cursorOffsets ?? {}) };
        if (budgeted.dropped > 0) {
            // Budget-deferred rows must stay reachable: rewind each source to its
            // first deferred row so the next page re-fetches it (and nothing else).
            more = true;
            const rowSources = page.rowSources ?? [];
            for (let index = budgeted.items.length; index < rowSources.length; index++) {
                const entry = rowSources[index];
                if (entry === undefined)
                    continue;
                offsets[entry.source] = Math.min(offsets[entry.source] ?? 0, entry.pos);
            }
        }
        if (more) {
            // Carry forward the file identities already returned so a path met again
            // from another source on a later page is skipped instead of duplicated.
            const previousSeen = cursorPayload !== undefined && cursorPayload.v === 2 ? cursorPayload.seen ?? [] : [];
            const nextSeen = [...previousSeen];
            const rowIdentities = page.rowIdentities ?? [];
            for (let index = 0; index < keptRows.length && index < rowIdentities.length; index++) {
                const identity = rowIdentities[index];
                if (identity !== undefined && identity !== '' && nextSeen.includes(identity) === false)
                    nextSeen.push(identity);
            }
            const seen = nextSeen.length > CURSOR_SEEN_MAX ? nextSeen.slice(nextSeen.length - CURSOR_SEEN_MAX) : nextSeen;
            nextCursor = encodeCursorV2({
                v: 2,
                mode: 'auto',
                queryHash,
                offsets,
                scope: effectiveScope,
                ...(generation === undefined ? {} : { generation }),
                kinds: [...normalized.kinds].sort(),
                ...(normalized.includeArchived ? { includeArchived: true } : {}),
                ...(seen.length === 0 ? {} : { seen }),
            });
        }
    }
    else {
        let nextOffset = page.nextOffset;
        if (budgeted.dropped > 0) {
            more = true;
            const firstDeferred = trimmedRows[budgeted.items.length];
            if (firstDeferred !== undefined)
                nextOffset = firstDeferred.offset;
        }
        if (!more)
            nextOffset = undefined;
        if (more && nextOffset === undefined)
            more = false;
        if (more && nextOffset !== undefined) {
            nextCursor = encodeCursor({
                v: 1,
                mode: normalized.mode,
                queryHash,
                offset: nextOffset,
                scope: effectiveScope,
                ...(generation === undefined ? {} : { generation }),
            });
        }
    }
    const pageBlock = {
        limit: normalized.limit,
        returned: keptRows.length,
        more,
        ...(nextCursor === undefined ? {} : { nextCursor }),
    };
    const notes = [...page.coverage.notes];
    if (scopeFallback)
        notes.push(coverageNote('scope-fallback', fallbackReason ?? 'searched every configured root', 'info'));
    if (budgeted.dropped > 0) {
        notes.push(coverageNote('budget-truncated', String(budgeted.dropped) + ' item(s) deferred by maxChars; continue with page.nextCursor.', 'info'));
    }
    if (cursorPayload?.generation !== undefined && generation !== undefined && cursorPayload.generation !== generation) {
        notes.push(coverageNote('index-generation-changed', 'The index changed since the cursor was issued; later pages may shift.', 'warn'));
    }
    // A page can come back empty while more rows wait behind it (scope/where
    // filters). Say that instead of claiming there are no matches at all.
    if (keptRows.length === 0 && more) {
        notes.push(coverageNote('empty-page-more', 'No row on this page survived the scope/where filters; pass page.nextCursor to continue.', 'info'));
    }
    if (keptRows.length === 0 && more === false) {
        notes.push(coverageNote('no-matches', 'No matches for this query in the searched scope.', 'info'));
    }
    const coverage = {
        indexing: page.coverage.indexing,
        indexTruncated: page.coverage.indexTruncated,
        notes: dedupeNotes(notes),
    };
    const scopeEcho = {
        requested: normalized.scopeRequested,
        effective: effectiveScope,
        fallback: scopeFallback,
        ...(fallbackReason === undefined ? {} : { fallbackReason }),
    };
    return agentSuccess(TOOL_NAME, {
        query: normalized.query,
        mode: normalized.mode,
        resolvedMode,
        detail: normalized.detail,
        scope: scopeEcho,
        items: budgeted.items,
        page: pageBlock,
        counts: page.counts,
        coverage,
        budget: budgeted.budget,
    }, makeTiming(started));
}
/* ------------------------------------------------------------------------- */
/* locator_find factory                                                       */
/* ------------------------------------------------------------------------- */
/** Build the locator_find tool. */
export function makeAgentFindTool(rt, content, ensure, options = {}) {
    return defineTool({
        name: TOOL_NAME,
        description: [
            'Find files, directories, content and code symbols in the local indexes (dsh-locator). Single search entry point.',
            'mode auto (default) merges the sources its kinds allow: code symbols (identifier-shaped queries), content bodies (3+ char terms), file/dir names; same-path rows merge why+sources.',
            'Single-source modes page one index exhaustively. Pass page.nextCursor back as cursor (never with offset); page.more=false ends the set. coverage.notes explains fallbacks. detail compact omits evidence; standard adds freshness; full adds ids/hash/permissions. maxChars (default 6,000) caps the items payload.',
        ].join('\n'),
        parameters: FIND_PARAMETERS,
        output: {
            schema: FIND_OUTPUT,
            render: (_args, value) => {
                const v = value;
                if (v.ok !== true) {
                    const code = v.error?.code ?? 'internal';
                    const message = v.error?.message ?? 'unknown error';
                    const remediation = v.error?.remediation === undefined ? '' : '\n' + v.error.remediation;
                    return [{ type: 'text', text: 'locator_find failed (' + code + '): ' + message + remediation }];
                }
                const items = v.items ?? [];
                const scope = v.scope;
                const scopeNote = scope === undefined ? '' : ' (scope: ' + String(scope.effective ?? scope.requested ?? '') + (scope.fallback === true ? '; widened from ' + String(scope.requested ?? 'workspace') : '') + ')';
                const took = v.timing?.tookMs === undefined ? '' : ' in ' + v.timing.tookMs.toFixed(1) + ' ms';
                const lines = ['locator_find ' + JSON.stringify(v.query ?? '') + ' [' + String(v.mode ?? 'auto') + ' -> ' + String(v.resolvedMode ?? '?') + ']: ' + String(items.length) + ' item(s)' + took + scopeNote];
                for (let index = 0; index < items.length; index++) {
                    const item = items[index];
                    const label = item.title ?? item.name ?? item.path ?? '';
                    const snippet = item.snippet === undefined ? '' : ' — ' + item.snippet;
                    const line = item.line === undefined ? '' : ':' + String(item.line);
                    const ref = item.ref === undefined ? '' : '\n     ref ' + item.ref;
                    lines.push(String(index + 1) + '. [' + String(item.kind ?? 'file') + '] ' + label + snippet + '\n     ' + String(item.path ?? '') + line + ref);
                }
                const page = v.page;
                if (page?.more === true)
                    lines.push('(more: pass page.nextCursor back as cursor)');
                const dropped = v.budget?.dropped ?? 0;
                if (dropped > 0)
                    lines.push('(budget: ' + String(dropped) + ' item(s) deferred by maxChars ' + String(v.budget?.limitChars ?? '') + ')');
                const notes = v.coverage?.notes ?? [];
                if (notes.length > 0)
                    lines.push('(notes: ' + notes.map(note => String(note.message ?? note.code ?? '')).join(' | ') + ')');
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        // Every branch only reads the two indexes; sibling calls may overlap.
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const started = Date.now();
            const caller = {
                ...(exec?.agent?.session?.id === undefined ? {} : { sessionId: exec.agent.session.id }),
                ...(exec?.agent?.session?.header?.cwd === undefined ? {} : { cwd: exec.agent.session.header.cwd }),
            };
            const result = await runAgentFind(rt, content, ensure, options, caller, args, started);
            return result;
        },
    });
}
/** Host parameter DSL of locator_find (source of truth for generated MCP/CLI JSON Schema). */
export const AGENT_FIND_PARAMETERS = FIND_PARAMETERS;
/** Host output DSL of locator_find (source of truth for generated MCP/CLI JSON Schema). */
export const AGENT_FIND_OUTPUT = FIND_OUTPUT;
//# sourceMappingURL=agent-find.js.map