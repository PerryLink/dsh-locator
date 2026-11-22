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
 * Mode resolution (`auto`): a query that is an exact indexed identifier wins
 * (symbol), then body search when the content index is ready and the query has
 * a 3+ character term (body), then file-name search (name). The resolved mode
 * is echoed and pinned into the continuation cursor, so pages cannot flip
 * between sources mid-pagination.
 * @module dsh-locator/agent-find
 */
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { AGENT_BUDGET_SCHEMA, AGENT_COVERAGE_SCHEMA, AGENT_DEFAULT_MAX_CHARS, AGENT_DETAILS, AGENT_ERROR_INFO_SCHEMA, AGENT_FIND_MODES, AGENT_ITEM_SCHEMA, AGENT_MAX_LIMIT, AGENT_MIN_BUDGET_CHARS, AGENT_PAGE_SCHEMA, AGENT_SCOPE_MODES, AGENT_SCOPE_SCHEMA, AGENT_SUCCESS_BASE_SCHEMA, agentSuccess, applyItemBudget, clampLimit, coverageNote, decodeCursor, encodeCursor, errorMessage, makeCoverage, makeError, makeTiming, queryHashOf, resolveMaxChars, trimItem, } from "./agent-core.js";
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
/** Symbols inspected by the auto-mode exact-identifier probe. */
const AUTO_SYMBOL_PROBE = 20;
/** Name-index rows one page may scan while filling past filtered rows. */
const NAME_MAX_ROWS = 250;
/* ------------------------------------------------------------------------- */
/* Parameter and output schemas                                                */
/* ------------------------------------------------------------------------- */
const FIND_PARAMETERS = {
    query: { type: 'string', required: true, description: 'Words/phrase, name fragment or identifier. Empty is rejected.' },
    mode: { type: 'string', enum: ['auto', 'name', 'body', 'symbol'], description: 'auto (symbol->body->name), name, body or symbol.' },
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
    count: { type: 'string', enum: ['exact', 'bounded', 'none'], description: 'exact (default), bounded or none.' },
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
        resolvedMode: { type: 'string', enum: ['name', 'body', 'symbol'] },
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
/** Read the content state without letting a closing store fail the tool. */
function contentStateOf(content) {
    try {
        return content.status();
    }
    catch {
        return undefined;
    }
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
        const visibility = ctx.effectiveScope === 'all' || ctx.effectiveScope === 'roots' || !cwdIsIndexed ? 'roots' : 'workspace';
        const rows = window.items.map((hit, index) => {
            const kind = hit.dir ? 'dir' : 'file';
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
            return { item, offset: window.indices[index] ?? ctx.offset + index };
        });
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
        if (narrowToCwd)
            notes.push(coverageNote('total-is-global', 'counts.total is the match count across every configured root, not just the workspace.', 'info'));
        return {
            rows,
            more: advance.hasMore,
            ...(advance.nextOffset === undefined ? {} : { nextOffset: advance.nextOffset }),
            counts: { total: window.total, totalKind: 'exact', nameTotal: window.total },
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
            ...(ctx.countMode === 'none' ? {} : { count: ctx.countMode }),
            ...(ctx.where.pathPrefix === undefined ? {} : { pathPrefix: ctx.where.pathPrefix }),
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
        const hits = result.hits;
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
            rows.push({ item: contentItem(hit), offset: rawIndex });
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
    if (lastCount !== undefined && lastCount.kind !== 'unknown') {
        counts.bodyTotal = lastCount.value;
        counts.bodyKind = lastCount.kind;
        counts.total = lastCount.value;
        counts.totalKind = lastCount.kind;
    }
    const notes = [];
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
    if (narrowToCwd)
        notes.push(coverageNote('total-is-global', 'counts.total is the symbol count across every configured root, not just the workspace.', 'info'));
    const totalKind = matches.length >= SYMBOL_MAX_MATCHES ? 'bounded' : 'exact';
    return {
        rows,
        more,
        ...(more ? { nextOffset: start + rows.length } : {}),
        counts: { total: visible.length, totalKind, symbolTotal: visible.length },
        coverage: makeCoverage({ notes }),
        empty: rows.length === 0,
    };
}
/** Resolve one auto-mode request to the first source that can answer it. */
async function resolveAutoMode(ctx) {
    const notes = [];
    const content = ctx.content;
    if (content !== undefined) {
        if (ctx.kinds.has('symbol') && isIdentifierLike(ctx.query)) {
            try {
                ctx.ensure?.();
                if (typeof content.findSymbols === 'function') {
                    const symbols = content.findSymbols(ctx.query, AUTO_SYMBOL_PROBE);
                    if (symbols.some(match => match.name === ctx.query))
                        return { mode: 'symbol', notes };
                }
            }
            catch {
                // A failing symbol probe must never block the body/name fallbacks.
            }
        }
        if ((ctx.kinds.has('file') || ctx.kinds.has('session')) && hasBodyTerm(ctx.query)) {
            try {
                ctx.ensure?.();
                const state = contentStateOf(content);
                const freshEmpty = state !== undefined && state.building === true && state.files === 0 && state.sessions === 0 && state.messages === 0;
                if (!freshEmpty && typeof content.search === 'function') {
                    const probe = await runContentSearchRequest(content, {
                        query: ctx.query,
                        limit: 1,
                        offset: 0,
                        scope: ctx.effectiveScope === 'workspace' ? 'workspace' : 'all',
                        detail: 'compact',
                        count: 'none',
                    }, ctx.rt.roots, ctx.effectiveScope === 'all' && ctx.options.allowCrossWorkspaceSessions === true, ctx.caller, contentScopeOptionsOf(ctx.rt));
                    if (probe.ok && (probe.hits.length > 0 || (probe.count.kind === 'exact' && probe.count.value > 0))) {
                        return { mode: 'body', notes };
                    }
                    if (probe.ok) {
                        notes.push(coverageNote('auto-body-empty', 'body search had no match; auto fell back to name search', 'info'));
                    }
                    else {
                        notes.push(coverageNote('auto-body-unavailable', 'body search rejected the query (' + probe.error + '); auto fell back to name search', 'info'));
                    }
                }
            }
            catch (error) {
                notes.push(coverageNote('auto-body-failed', 'body probe failed (' + errorMessage(error).slice(0, 120) + '); auto fell back to name search', 'info'));
            }
        }
    }
    return { mode: 'name', notes };
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
async function runAgentFind(rt, content, ensure, options, caller, rawArgs, started) {
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
    const queryHash = queryHashOf({
        query: normalized.query,
        mode: normalized.mode,
        scope: normalized.scopeRequested,
        kinds: [...normalized.kinds].sort(),
        where: whereHash,
    });
    let cursorPayload;
    if (normalized.cursor !== undefined) {
        const decoded = decodeCursor(normalized.cursor);
        if (decoded === undefined)
            return failNow('cursor-invalid', 'cursor is not a valid locator_find cursor');
        if (decoded.queryHash !== queryHash)
            return failNow('cursor-invalid', 'cursor does not belong to this query, mode or scope');
        if (normalized.mode !== 'auto' && decoded.mode !== normalized.mode) {
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
    const offset = cursorPayload?.offset ?? normalized.explicitOffset ?? 0;
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
        statCache: new Map(),
    };
    let resolvedMode;
    const autoNotes = [];
    if (normalized.mode === 'auto') {
        if (cursorPayload !== undefined && cursorPayload.mode !== 'auto') {
            resolvedMode = cursorPayload.mode === 'symbol' ? 'symbol' : cursorPayload.mode === 'body' ? 'body' : 'name';
        }
        else {
            const resolution = await resolveAutoMode(ctx);
            if (isFailure(resolution))
                return resolution;
            resolvedMode = resolution.mode;
            autoNotes.push(...resolution.notes);
        }
    }
    else {
        resolvedMode = normalized.mode;
    }
    let page = await runMode(resolvedMode, ctx);
    if (isFailure(page))
        return page;
    let scopeFallback = effectiveScope !== normalized.scopeRequested;
    if (page.rows.length === 0 && ctx.effectiveScope === 'workspace' && ctx.offset === 0 && cursorPayload === undefined) {
        const widened = await runMode(resolvedMode, { ...ctx, effectiveScope: 'roots' });
        if (isFailure(widened)) {
            autoNotes.push(coverageNote('scope-fallback-failed', 'widening the workspace to roots failed: ' + widened.error.message, 'warn'));
        }
        else {
            page = widened;
            ctx.effectiveScope = 'roots';
            effectiveScope = 'roots';
            scopeFallback = true;
            fallbackReason = 'workspace-empty; searched every configured root';
        }
    }
    const trimmedRows = page.rows.map(row => ({ item: trimItem(row.item, normalized.detail), offset: row.offset }));
    const budgeted = applyItemBudget(trimmedRows.map(row => row.item), normalized.maxChars);
    const keptRows = trimmedRows.slice(0, budgeted.items.length);
    let more = page.more;
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
    const generation = generationOf(rt);
    const nextCursor = more && nextOffset !== undefined
        ? encodeCursor({
            v: 1,
            mode: resolvedMode,
            queryHash,
            offset: nextOffset,
            scope: effectiveScope,
            ...(generation === undefined ? {} : { generation }),
        })
        : undefined;
    const pageBlock = {
        limit: normalized.limit,
        returned: keptRows.length,
        more,
        ...(nextCursor === undefined ? {} : { nextCursor }),
    };
    const notes = [...autoNotes, ...page.coverage.notes];
    if (scopeFallback)
        notes.push(coverageNote('scope-fallback', fallbackReason ?? 'searched every configured root', 'info'));
    if (budgeted.dropped > 0) {
        notes.push(coverageNote('budget-truncated', String(budgeted.dropped) + ' item(s) deferred by maxChars; continue with page.nextCursor.', 'info'));
    }
    if (cursorPayload?.generation !== undefined && generation !== undefined && cursorPayload.generation !== generation) {
        notes.push(coverageNote('index-generation-changed', 'The index changed since the cursor was issued; later pages may shift.', 'warn'));
    }
    if (keptRows.length === 0)
        notes.push(coverageNote('no-matches', 'No matches for this query in the searched scope.', 'info'));
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
            'mode auto (default) picks symbol for an exact indexed identifier, else body when the content index has a 3+ character term, else name. Rows carry a ref and why they matched.',
            'Pass page.nextCursor back as cursor (never with offset); page.more=false ends the set. coverage.notes explains fallbacks. detail compact omits evidence; standard adds freshness; full adds ids/hash/permissions. maxChars (default 6,000) caps the items payload.',
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
//# sourceMappingURL=agent-find.js.map