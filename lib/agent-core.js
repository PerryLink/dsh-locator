/**
 * Shared AI-first contract for the dsh-locator 0.22.0 tools
 * (locator_find / locator_read / locator_status / locator_admin).
 *
 * One envelope shape, one closed error-code set, one cursor format and one
 * detail/budget model, so every new tool answers in the same machine-readable
 * shape while the legacy tools keep their historical output. This module is a
 * dependency-light leaf: it imports only node:crypto and must stay importable
 * from every agent-facing tool (and from tests) without touching the runtime,
 * the content store or the engine.
 * @module dsh-locator/agent-core
 */
import { createHash } from 'node:crypto';
/** Version of the agent-facing wire contract; bumps only on a breaking change. */
export const AGENT_API_VERSION = '2026-11';
/** Default item budget in characters (the budget counts items only). */
export const AGENT_DEFAULT_MAX_CHARS = 6_000;
/** Smallest useful maxChars: below this one compact item cannot fit. */
export const AGENT_MIN_BUDGET_CHARS = 120;
/** Default page size. */
export const AGENT_DEFAULT_LIMIT = 10;
/** Hard cap on one page of items. */
export const AGENT_MAX_LIMIT = 50;
/** Compact snippets are cut at this many code points (the default detail). */
export const COMPACT_SNIPPET_CHARS = 160;
/** Standard snippets are cut at this many code points. */
export const STANDARD_SNIPPET_CHARS = 240;
/** Full snippets are cut at this many code points. */
export const FULL_SNIPPET_CHARS = 320;
/** Cursor payload version of the single-source contract (0.22; still accepted). */
export const CURSOR_VERSION = 1;
/** Cursor payload version of the cross-source auto contract (0.23). */
export const CURSOR_VERSION_V2 = 2;
/** Most file-identity hashes one v2 cursor remembers (bounded cursor size). */
export const CURSOR_SEEN_MAX = 96;
/** Search modes understood by locator_find (auto resolves symbol -> body -> name). */
export const AGENT_FIND_MODES = ['auto', 'name', 'body', 'symbol'];
/** Scope modes shared by the agent tools. */
export const AGENT_SCOPE_MODES = ['workspace', 'roots', 'all'];
/** Detail presets: compact (default) trims items hardest, full keeps evidence. */
export const AGENT_DETAILS = ['compact', 'standard', 'full'];
/** Closed machine-readable error codes of the agent envelope. */
export const AGENT_ERROR_CODES = {
    invalidArgument: 'invalid-argument',
    queryTooShort: 'query-too-short',
    queryInvalid: 'query-invalid',
    scopeDenied: 'scope-denied',
    scopeEmptyWorkspace: 'scope-empty-workspace',
    notFound: 'not-found',
    indexUnavailable: 'index-unavailable',
    indexBuilding: 'index-building',
    budgetTooSmall: 'budget-too-small',
    cursorInvalid: 'cursor-invalid',
    cancelled: 'cancelled',
    internal: 'internal',
};
/** Default retryability of each code (an explicit option can override it). */
export const AGENT_ERROR_RETRYABLE = {
    'invalid-argument': false,
    'query-too-short': false,
    'query-invalid': false,
    'scope-denied': false,
    'scope-empty-workspace': false,
    'not-found': false,
    'index-unavailable': true,
    'index-building': true,
    'budget-too-small': false,
    'cursor-invalid': false,
    'cancelled': true,
    'internal': false,
};
/** Default human message of each code (used when no message is supplied). */
export const AGENT_ERROR_MESSAGES = {
    'invalid-argument': 'the tool arguments are invalid',
    'query-too-short': 'the query is too short for the content index',
    'query-invalid': 'the query is not valid',
    'scope-denied': 'the requested scope is not allowed',
    'scope-empty-workspace': 'the caller workspace has no indexed content',
    'not-found': 'the requested object was not found',
    'index-unavailable': 'the index is not available',
    'index-building': 'the index is still building its first snapshot',
    'budget-too-small': 'maxChars is too small to return one item',
    'cursor-invalid': 'the cursor is invalid for this query',
    'cancelled': 'the request was cancelled',
    'internal': 'the locator hit an internal error',
};
/** Default actionable remediation of each code. */
export const AGENT_ERROR_REMEDIATION = {
    'invalid-argument': 'Check the argument types and ranges declared by the tool schema.',
    'query-too-short': 'Use at least 3 characters per body term, or pass mode:"name" to search file names.',
    'query-invalid': 'Rewrite the query with the documented word/phrase syntax.',
    'scope-denied': 'The path or session is outside the configured roots or the scope rules.',
    'scope-empty-workspace': 'Pass scope:"roots" or scope:"all" to search every configured root.',
    'not-found': 'Use locator_find to locate the path or ref first.',
    'index-unavailable': 'Retry once; if it persists, check index state with locator_status.',
    'index-building': 'Retry when locator_status reports building:false; partial results may still be returned.',
    'budget-too-small': 'Raise maxChars (at least 120) or use detail:"compact".',
    'cursor-invalid': 'Re-run the query without a cursor: cursors are bound to the query, mode and scope.',
    'cancelled': 'Retry the call.',
    'internal': 'Retry once; if it persists, check locator_status.',
};
/** Default follow-up tools advertised next to each code. */
export const AGENT_ERROR_NEXT_TOOLS = {
    'query-too-short': ['locator_find'],
    'query-invalid': ['locator_find'],
    'scope-denied': ['locator_status'],
    'scope-empty-workspace': ['locator_find'],
    'not-found': ['locator_find'],
    'index-unavailable': ['locator_status'],
    'index-building': ['locator_status'],
    'budget-too-small': ['locator_find'],
    'cursor-invalid': ['locator_find'],
    'internal': ['locator_status'],
};
/**
 * Build the uniform failure envelope for one error code.
 *
 * The message falls back to {@link AGENT_ERROR_MESSAGES}, retryability and
 * remediation to their per-code tables; explicit options win. This is the only
 * constructor the agent tools use, so every failure path shares one shape.
 * @param code - closed agent error code.
 * @param message - human message (defaults to the code message).
 * @param options - retryability/remediation/nextTools/details/tool/timing overrides.
 * @returns the failure envelope.
 */
export function makeError(code, message, options = {}) {
    const resolvedMessage = message !== undefined && message.trim() !== '' ? message : AGENT_ERROR_MESSAGES[code];
    const retryable = options.retryable ?? AGENT_ERROR_RETRYABLE[code];
    const remediation = options.remediation ?? AGENT_ERROR_REMEDIATION[code];
    const nextTools = options.nextTools ?? AGENT_ERROR_NEXT_TOOLS[code];
    const error = { code, message: resolvedMessage, retryable };
    if (remediation !== undefined && remediation !== '')
        error.remediation = remediation;
    if (nextTools !== undefined && nextTools.length > 0)
        error.nextTools = [...nextTools];
    if (options.details !== undefined)
        error.details = { ...options.details };
    return {
        apiVersion: AGENT_API_VERSION,
        ok: false,
        tool: options.tool ?? 'locator_find',
        error,
        ...(options.timing === undefined ? {} : { timing: options.timing }),
    };
}
/** Wrap an already-built error block in the failure envelope. */
export function agentFailure(tool, error, timing) {
    return {
        apiVersion: AGENT_API_VERSION,
        ok: false,
        tool,
        error,
        ...(timing === undefined ? {} : { timing }),
    };
}
/** Wrap one tool result in the uniform success envelope. */
export function agentSuccess(tool, fields, timing) {
    return {
        apiVersion: AGENT_API_VERSION,
        ok: true,
        tool,
        ...fields,
        ...(timing === undefined ? {} : { timing }),
    };
}
/** Measure one tool call from a start timestamp. */
export function makeTiming(startedAt) {
    return { tookMs: Math.max(0, Date.now() - startedAt) };
}
/** Build one coverage note. */
export function coverageNote(code, message, severity = 'info') {
    return { code, message, severity };
}
/** Build the coverage block (empty notes by default). */
export function makeCoverage(options = {}) {
    return {
        indexing: options.indexing === true,
        indexTruncated: options.indexTruncated === true,
        notes: [...(options.notes ?? [])],
    };
}
/** Message of an unknown thrown value, safe for envelopes. */
export function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
/** Fields a compact item keeps (session rows keep seq/eventRef so find -> read works). */
const COMPACT_ITEM_FIELDS = ['kind', 'path', 'title', 'line', 'snippet', 'why', 'sources', 'score', 'ref', 'seq', 'eventRef'];
/** Fields a standard item keeps (compact + evidence freshness). */
const STANDARD_ITEM_FIELDS = ['kind', 'path', 'title', 'line', 'snippet', 'why', 'sources', 'score', 'ref', 'refStatus', 'freshness', 'language', 'symbolScope', 'seq', 'eventRef'];
/** Fields a full item keeps (standard + identity/evidence details). */
const FULL_ITEM_FIELDS = ['kind', 'path', 'title', 'line', 'snippet', 'why', 'sources', 'score', 'ref', 'refStatus', 'freshness', 'language', 'symbolScope', 'name', 'size', 'mtime', 'modified', 'ext', 'dir', 'format', 'hash', 'permissions', 'provenance', 'sessionId', 'messageId', 'seq', 'eventRef', 'context', 'contextStart'];
/** Cut a snippet to the detail preset cap (code-point safe, appends an ellipsis). */
export function trimSnippet(text, detail = 'compact') {
    const limit = detail === 'full' ? FULL_SNIPPET_CHARS : detail === 'standard' ? STANDARD_SNIPPET_CHARS : COMPACT_SNIPPET_CHARS;
    const points = Array.from(text);
    if (points.length <= limit)
        return text;
    return points.slice(0, limit - 1).join('') + '\u2026';
}
/** Project one item onto the detail preset's field set (never mutates the input). */
export function trimItem(item, detail = 'compact') {
    const fields = detail === 'full' ? FULL_ITEM_FIELDS : detail === 'standard' ? STANDARD_ITEM_FIELDS : COMPACT_ITEM_FIELDS;
    const record = item;
    const out = {};
    for (const field of fields) {
        const value = record[field];
        if (value === undefined)
            continue;
        if (field === 'snippet' && typeof value === 'string') {
            out.snippet = trimSnippet(value, detail);
            continue;
        }
        if (Array.isArray(value) && value.length === 0)
            continue;
        out[field] = value;
    }
    return out;
}
/** Serialized cost estimate of one trimmed item, in characters. */
export function estimateItemChars(item) {
    const serialized = JSON.stringify(item);
    return serialized === undefined ? 0 : serialized.length;
}
/** Serialized cost estimate of an item list, in characters. */
export function estimateItemsChars(items) {
    let total = 0;
    for (const item of items)
        total += estimateItemChars(item);
    return total;
}
/**
 * Trim an item list so its serialized items stay inside maxChars.
 *
 * Only the variable item payload is measured (envelope/timing/coverage are
 * fixed cost); the first item is always kept so a single long snippet cannot
 * turn a valid hit into an empty page. maxChars <= 0 disables the trim.
 * @param items - already detail-trimmed items in result order.
 * @param maxChars - soft cap in characters; 0 or negative means unlimited.
 * @returns kept items, their budget report and the dropped count.
 */
export function applyItemBudget(items, maxChars) {
    const limitChars = Number.isFinite(maxChars) ? Math.max(0, Math.trunc(maxChars)) : 0;
    const limit = limitChars;
    if (limit <= 0) {
        return {
            items: [...items],
            budget: { limitChars: 0, usedChars: estimateItemsChars(items), truncated: false, dropped: 0 },
            dropped: 0,
        };
    }
    const kept = [];
    let used = 0;
    for (const item of items) {
        const size = estimateItemChars(item);
        if (kept.length > 0 && used + size > limit)
            break;
        kept.push(item);
        used += size;
    }
    const dropped = items.length - kept.length;
    return {
        items: kept,
        budget: { limitChars: limit, usedChars: used, truncated: dropped > 0 || used > limit, dropped },
        dropped,
    };
}
/** Deterministic short hash used to bind a cursor to one query request. */
export function queryHashOf(parts) {
    let text;
    try {
        text = JSON.stringify(parts) ?? String(parts);
    }
    catch {
        text = String(parts);
    }
    return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}
/** Encode one single-source (v1) cursor payload as an opaque base64url token. */
export function encodeCursor(payload) {
    const body = {
        v: CURSOR_VERSION,
        mode: payload.mode,
        queryHash: payload.queryHash,
        offset: Math.max(0, Math.trunc(payload.offset)),
        ...(payload.scope === undefined ? {} : { scope: payload.scope }),
        ...(payload.generation === undefined ? {} : { generation: payload.generation }),
    };
    return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}
/**
 * Encode one cross-source (v2) cursor payload as an opaque base64url token.
 *
 * Mirrors the parity surface implemented by scripts/locator-cli.mjs
 * (AGENT_CURSOR_VERSION = 2): v, mode, queryHash, offsets, scope, generation,
 * kinds and includeArchived, with the boolean omitted when false.
 * @param payload - v2 payload built from the page's per-source positions.
 * @returns the opaque token.
 */
export function encodeCursorV2(payload) {
    const offsets = {};
    if (typeof payload.offsets.name === 'number')
        offsets.name = Math.max(0, Math.trunc(payload.offsets.name));
    if (typeof payload.offsets.body === 'number')
        offsets.body = Math.max(0, Math.trunc(payload.offsets.body));
    if (typeof payload.offsets.symbol === 'number')
        offsets.symbol = Math.max(0, Math.trunc(payload.offsets.symbol));
    const body = {
        v: CURSOR_VERSION_V2,
        mode: payload.mode,
        queryHash: payload.queryHash,
        offsets,
        ...(payload.scope === undefined ? {} : { scope: payload.scope }),
        ...(payload.generation === undefined ? {} : { generation: payload.generation }),
        ...(payload.kinds === undefined ? {} : { kinds: [...payload.kinds] }),
        ...(payload.includeArchived === true ? { includeArchived: true } : {}),
        ...(payload.seen === undefined || payload.seen.length === 0 ? {} : { seen: [...payload.seen] }),
    };
    return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}
/** Short deterministic hash of one returned file identity (cursor dedupe memory). */
export function identityTokenHash(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}
/** Decode the shared token envelope of one cursor, or undefined when malformed. */
function decodeCursorRecord(cursor) {
    if (typeof cursor !== 'string')
        return undefined;
    const token = cursor.trim();
    if (token === '' || token.length > 2_048)
        return undefined;
    if (!/^[A-Za-z0-9_-]+$/.test(token))
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return undefined;
    return parsed;
}
/** Decode one v1 payload record, returning undefined for anything malformed. */
function decodeCursorV1(record) {
    if (typeof record.mode !== 'string' || AGENT_FIND_MODES.includes(record.mode) === false)
        return undefined;
    if (typeof record.queryHash !== 'string' || record.queryHash === '')
        return undefined;
    if (typeof record.offset !== 'number' || Number.isInteger(record.offset) === false || record.offset < 0)
        return undefined;
    const payload = {
        v: CURSOR_VERSION,
        mode: record.mode,
        queryHash: record.queryHash,
        offset: record.offset,
    };
    if (typeof record.scope === 'string' && AGENT_SCOPE_MODES.includes(record.scope)) {
        payload.scope = record.scope;
    }
    if (typeof record.generation === 'number' && Number.isInteger(record.generation) && record.generation > 0) {
        payload.generation = record.generation;
    }
    return payload;
}
/** Decode one v2 payload record, returning undefined for anything malformed. */
function decodeCursorV2(record) {
    if (typeof record.mode !== 'string' || AGENT_FIND_MODES.includes(record.mode) === false)
        return undefined;
    if (typeof record.queryHash !== 'string' || record.queryHash === '')
        return undefined;
    if (typeof record.offsets !== 'object' || record.offsets === null || Array.isArray(record.offsets))
        return undefined;
    const offsets = {};
    for (const [source, value] of Object.entries(record.offsets)) {
        if (source !== 'name' && source !== 'body' && source !== 'symbol')
            return undefined;
        if (typeof value !== 'number' || Number.isInteger(value) === false || value < 0)
            return undefined;
        offsets[source] = value;
    }
    const payload = {
        v: CURSOR_VERSION_V2,
        mode: record.mode,
        queryHash: record.queryHash,
        offsets,
    };
    if (typeof record.scope === 'string' && AGENT_SCOPE_MODES.includes(record.scope)) {
        payload.scope = record.scope;
    }
    if (typeof record.generation === 'number' && Number.isInteger(record.generation) && record.generation > 0) {
        payload.generation = record.generation;
    }
    if (Array.isArray(record.kinds)) {
        const kinds = [];
        for (const entry of record.kinds) {
            if (typeof entry !== 'string' || ['file', 'dir', 'session', 'symbol'].includes(entry) === false)
                return undefined;
            if (kinds.includes(entry) === false)
                kinds.push(entry);
        }
        payload.kinds = kinds;
    }
    if (record.includeArchived !== undefined) {
        if (typeof record.includeArchived !== 'boolean')
            return undefined;
        if (record.includeArchived)
            payload.includeArchived = true;
    }
    if (record.seen !== undefined) {
        if (Array.isArray(record.seen) === false || record.seen.length > CURSOR_SEEN_MAX)
            return undefined;
        const seen = [];
        for (const entry of record.seen) {
            if (typeof entry !== 'string' || /^[a-f0-9]{8,16}$/.test(entry) === false)
                return undefined;
            if (seen.includes(entry) === false)
                seen.push(entry);
        }
        if (seen.length > 0)
            payload.seen = seen;
    }
    return payload;
}
/** Decode one opaque cursor (v1 or v2), returning undefined for anything malformed. */
export function decodeCursor(cursor) {
    const record = decodeCursorRecord(cursor);
    if (record === undefined)
        return undefined;
    if (record.v === CURSOR_VERSION)
        return decodeCursorV1(record);
    if (record.v === CURSOR_VERSION_V2)
        return decodeCursorV2(record);
    return undefined;
}
/** Whether a decoded cursor belongs to the current request (query/mode binding). */
export function cursorMatches(payload, expected) {
    if (payload.queryHash !== expected.queryHash)
        return false;
    if (expected.mode === undefined || expected.mode === 'auto')
        return true;
    return payload.mode === expected.mode;
}
/** Coerce one caller limit into 1..max (fallback when absent/invalid). */
export function clampLimit(requested, max = AGENT_MAX_LIMIT, fallback = AGENT_DEFAULT_LIMIT) {
    const candidate = typeof requested === 'number' && Number.isFinite(requested) ? Math.trunc(requested) : fallback;
    return Math.max(1, Math.min(max, candidate));
}
/** Resolve one caller maxChars: absent uses the fallback, 0 disables, negatives clamp to 0. */
export function resolveMaxChars(requested, fallback = AGENT_DEFAULT_MAX_CHARS) {
    if (typeof requested !== 'number' || Number.isFinite(requested) === false)
        return fallback;
    return Math.max(0, Math.trunc(requested));
}
/** Declared timing block for output schemas. */
export const AGENT_TIMING_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        tookMs: { type: 'number', required: true, description: 'Milliseconds spent inside the tool call (never negative).' },
    },
};
/** Declared error block for output schemas. */
export const AGENT_ERROR_INFO_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        code: { type: 'string', required: true, enum: ['invalid-argument', 'query-too-short', 'query-invalid', 'scope-denied', 'scope-empty-workspace', 'not-found', 'index-unavailable', 'index-building', 'budget-too-small', 'cursor-invalid', 'cancelled', 'internal'], description: 'Stable machine-readable error code.' },
        message: { type: 'string', required: true, description: 'Human-readable message.' },
        retryable: { type: 'boolean', required: true, description: 'True when the same call may succeed on retry.' },
        remediation: { type: 'string', description: 'One actionable sentence for the caller.' },
        nextTools: { type: 'array', items: { type: 'string' }, description: 'Follow-up tools that can unblock the caller.' },
        details: { type: 'json', description: 'Extra machine-readable context (never contains file contents).' },
    },
};
/** Declared freshness block for output schemas. */
export const AGENT_FRESHNESS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        state: { type: 'string', required: true, enum: ['fresh', 'stale', 'missing', 'unknown'] },
        observedAt: { type: 'integer', description: 'Epoch ms of the observation behind this state.' },
        mtime: { type: 'integer', description: 'Current on-disk mtime in epoch ms, when observed.' },
    },
};
/** Declared permissions block for output schemas. */
export const AGENT_PERMISSIONS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        read: { type: 'string', required: true, enum: ['allowed', 'denied'] },
        visibility: { type: 'string', required: true, enum: ['workspace', 'roots', 'session', 'external'] },
        reason: { type: 'string' },
    },
};
/** Declared provenance block for output schemas. */
export const AGENT_PROVENANCE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        origin: { type: 'string', required: true, enum: ['index', 'tool', 'session', 'web'] },
        path: { type: 'string' },
        sessionId: { type: 'string' },
        messageId: { type: 'string' },
        indexedAt: { type: 'integer', description: 'Epoch ms when the index last stored this object.' },
        url: { type: 'string' },
        callId: { type: 'string' },
    },
};
/** Declared item block shared by the agent tools. */
export const AGENT_ITEM_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        kind: { type: 'string', required: true, enum: ['file', 'dir', 'session', 'symbol'] },
        path: { type: 'string', required: true },
        title: { type: 'string' },
        name: { type: 'string', description: 'Symbol declaration name (full detail only).' },
        line: { type: 'integer', description: '1-based matched/declaration line, when known.' },
        snippet: { type: 'string', description: 'Bounded matched text (compact: at most 160 code points).' },
        why: { type: 'array', items: { type: 'string' }, description: 'Why this row matched, e.g. "symbol:exact" or "body:terms".' },
        sources: { type: 'array', items: { type: 'string', enum: ['name', 'body', 'symbol'] }, description: 'Index sources that produced this row (auto mode; merged rows list every source).' },
        score: { type: 'number', description: 'Relevance score (content rank; lower is better for FTS5 bm25).' },
        ref: { type: 'string', description: 'Citable evidence ref (ref://file or dsh-session:...).' },
        refStatus: { type: 'string', enum: ['fresh', 'stale', 'missing', 'tombstoned', 'unknown'], description: 'Evidence freshness label (standard/full).' },
        freshness: AGENT_FRESHNESS_SCHEMA,
        hash: { type: 'string', description: 'sha256 of the file bytes (full detail only).' },
        permissions: AGENT_PERMISSIONS_SCHEMA,
        provenance: AGENT_PROVENANCE_SCHEMA,
        sessionId: { type: 'string', description: 'Session id for session rows (full detail only).' },
        messageId: { type: 'string', description: 'Message id for session rows (full detail only).' },
        seq: { type: 'integer', description: 'Indexed event sequence for session rows (compact/standard/full).' },
        eventRef: { type: 'string', description: 'Full ref://session-event?sid=...&seq=N reference for session rows (compact/standard/full).' },
        size: { type: 'integer', description: 'File size in bytes (full detail only).' },
        mtime: { type: 'integer', description: 'Modification time in epoch ms (full detail only).' },
        modified: { type: 'string', description: 'ISO-8601 modification time (full detail only).' },
        ext: { type: 'string', description: 'Lower-case file extension without the dot (full detail only).' },
        dir: { type: 'boolean', description: 'True for directory rows (full detail only).' },
        format: { type: 'string', description: 'Extracted document format (full detail only).' },
        language: { type: 'string', description: 'Symbol language (standard/full).' },
        symbolScope: { type: 'string', description: 'Enclosing type/namespace of a symbol (standard/full).' },
        context: { type: 'array', items: { type: 'string' }, description: 'Surrounding source lines for a body hit (full detail only).' },
        contextStart: { type: 'integer', description: '1-based line number of context[0] (full detail only).' },
    },
};
/** Declared page block for output schemas. */
export const AGENT_PAGE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        limit: { type: 'integer', required: true, description: 'Effective page-size cap for this call.' },
        returned: { type: 'integer', required: true, description: 'Items on this page (after budget trimming).' },
        more: { type: 'boolean', required: true, description: 'True when paging further can return more items.' },
        nextCursor: { type: 'string', description: 'Opaque continuation token; present only when more is true.' },
    },
};
/** Declared coverage block for output schemas. */
export const AGENT_COVERAGE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        indexing: { type: 'boolean', required: true, description: 'The index is still building; this page is partial.' },
        indexTruncated: { type: 'boolean', required: true, description: 'The content build dropped documents because of its size budget.' },
        notes: {
            type: 'array',
            required: true,
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    code: { type: 'string', required: true },
                    severity: { type: 'string', required: true, enum: ['info', 'warn', 'error'] },
                    message: { type: 'string', required: true },
                },
            },
        },
    },
};
/** Declared budget block for output schemas. */
export const AGENT_BUDGET_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        limitChars: { type: 'integer', required: true, description: 'Effective soft cap in characters; 0 means unlimited.' },
        usedChars: { type: 'integer', required: true, description: 'Characters the returned items serialize to.' },
        truncated: { type: 'boolean', required: true, description: 'True when items were dropped or the first item exceeds the cap.' },
        dropped: { type: 'integer', required: true, description: 'Items kept out of this page by the budget.' },
    },
};
/** Declared scope echo for output schemas. */
export const AGENT_SCOPE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        requested: { type: 'string', required: true, enum: ['workspace', 'roots', 'all'], description: 'Scope the caller asked for.' },
        effective: { type: 'string', required: true, enum: ['workspace', 'roots', 'all'], description: 'Scope actually searched (after a workspace fallback).' },
        fallback: { type: 'boolean', description: 'True when the effective scope was widened from the requested one.' },
        fallbackReason: { type: 'string', description: 'Why the scope was widened.' },
    },
};
/** Declared base success block for output schemas (spread into tool schemas). */
export const AGENT_SUCCESS_BASE_SCHEMA = {
    properties: {
        apiVersion: { type: 'string', required: true, description: 'Agent wire contract version.' },
        ok: { type: 'boolean', required: true },
        tool: { type: 'string', required: true, description: 'Tool that produced the result.' },
        timing: AGENT_TIMING_SCHEMA,
    },
};
/** Declared failure envelope for output schemas. */
export const AGENT_FAILURE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        apiVersion: { type: 'string', required: true, description: 'Agent wire contract version.' },
        ok: { type: 'boolean', required: true },
        tool: { type: 'string', required: true, description: 'Tool that produced the failure.' },
        error: { ...AGENT_ERROR_INFO_SCHEMA, required: true },
        timing: AGENT_TIMING_SCHEMA,
    },
};
/** Declared success envelope marker: spread AGENT_SUCCESS_BASE_SCHEMA.properties into a tool schema. */
export const AGENT_SUCCESS_SCHEMA = { ...AGENT_SUCCESS_BASE_SCHEMA };
//# sourceMappingURL=agent-core.js.map