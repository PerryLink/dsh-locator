/**
 * locator_read — the AI-first read/citation tool of the 0.22.0 interface.
 *
 * It resolves one ref (or a bounded batch of refs, or a workspace file path)
 * through the same evidence layer as locator_resolve/locator_cite and returns
 * verbatim, whole-line excerpts plus the citation-ready quote form. The shared
 * envelope contract (apiVersion "2026-11", closed error codes) is imported from
 * src/agent-core.ts.
 * @module dsh-locator/agent-read
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve as resolvePath } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { AGENT_BUDGET_SCHEMA, AGENT_ERROR_CODES, AGENT_ERROR_INFO_SCHEMA, AGENT_SUCCESS_BASE_SCHEMA, agentFailure, agentSuccess, makeError, makeTiming, } from "./agent-core.js";
import { fileRef, parseRef } from "./refs.js";
import { makeCiteTool, makeResolveTool } from "./ref-tools.js";
import { resolveWithinRoots } from "./reveal.js";
import { readableDenial } from "./scope.js";
/**
 * Build one structured error block with the shared per-code defaults; the
 * contract builder fills retryability/remediation/nextTools, and embedding
 * tools reuse the block inside per-item errors or agentFailure envelopes.
 */
function errorInfo(code, message, extra = {}) {
    return makeError(code, message, extra).error;
}
// ---------------------------------------------------------------------------
// locator_read
// ---------------------------------------------------------------------------
/** Emit one failure envelope (bridges the contract builder to the schema type). */
function fail(code, message, options = {}) {
    return makeError(code, message, options);
}
/** Emit an already-built failure envelope. */
function failureEnvelope(tool, error, timing) {
    return agentFailure(tool, error, timing);
}
/** Emit one success envelope (fields are validated by the declared schema). */
function succeed(tool, fields, timing) {
    return agentSuccess(tool, fields, timing);
}
const TOOL = 'locator_read';
/** Hard cap on refs[] per call (the schema cap is advisory on model input). */
export const READ_MAX_REFS = 20;
/** Hard cap on window (lines added on each side of the target line). */
export const READ_MAX_WINDOW = 20;
/** Default and hard caps for one excerpt's text budget. */
export const READ_DEFAULT_MAX_BYTES = 2_000;
export const READ_MAX_BYTES = 65_536;
/** One line is never returned longer than this (mirrors locator_resolve). */
export const READ_MAX_LINE_CHARS = 65_536;
const READ_CHUNK_BYTES = 64 * 1024;
const READ_MODES = ['meta', 'excerpt', 'quote'];
const REF_KINDS = ['file', 'session', 'url', 'session-event', 'spill', 'attachment'];
const REF_STATUSES = ['fresh', 'stale', 'missing', 'tombstoned', 'unknown'];
const FRESHNESS_STATES = ['fresh', 'stale', 'missing', 'unknown'];
const VISIBILITIES = ['workspace', 'roots', 'session', 'external'];
const READ_PERMISSIONS = ['allowed', 'denied'];
const PROVENANCE_ORIGINS = ['index', 'tool', 'session', 'web'];
const READ_ITEM_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ref: { type: 'string' },
        kind: { type: 'string', enum: REF_KINDS },
        title: { type: 'string' },
        path: { type: 'string' },
        sessionId: { type: 'string' },
        messageId: { type: 'string' },
        seq: { type: 'integer' },
        line: { type: 'integer', description: '1-based target line the excerpt is centered on.' },
        startLine: { type: 'integer', description: '1-based first line actually returned.' },
        endLine: { type: 'integer', description: '1-based last line actually returned.' },
        lineCount: { type: 'integer', description: 'Total lines in the file when the read reached end of file.' },
        excerpt: { type: 'string', description: 'Verbatim whole lines; always contains the target line whole.' },
        markdown: { type: 'string', description: 'quote mode: markdown blockquote plus citation link and fallback.' },
        hash: { type: 'string' },
        size: { type: 'integer' },
        status: { type: 'string', enum: REF_STATUSES },
        checkedAt: { type: 'integer' },
        truncated: { type: 'boolean', description: 'The excerpt dropped window lines or sliced long lines to fit maxBytes.' },
        anchor: {
            type: 'object',
            additionalProperties: false,
            properties: { line: { type: 'integer' }, charStart: { type: 'integer' }, charEnd: { type: 'integer' } },
        },
        freshness: {
            type: 'object',
            additionalProperties: false,
            properties: {
                state: { type: 'string', enum: FRESHNESS_STATES },
                observedAt: { type: 'integer' },
                mtime: { type: 'integer' },
            },
        },
        permissions: {
            type: 'object',
            additionalProperties: false,
            properties: {
                read: { type: 'string', enum: READ_PERMISSIONS },
                visibility: { type: 'string', enum: VISIBILITIES },
                reason: { type: 'string' },
            },
        },
        provenance: {
            type: 'object',
            additionalProperties: false,
            properties: {
                origin: { type: 'string', enum: PROVENANCE_ORIGINS },
                path: { type: 'string' },
                sessionId: { type: 'string' },
                messageId: { type: 'string' },
                url: { type: 'string' },
                indexedAt: { type: 'integer' },
            },
        },
        warnings: { type: 'array', items: { type: 'string' } },
        error: AGENT_ERROR_INFO_SCHEMA,
    },
};
/** Explicit per-excerpt vs whole-batch limits (0.23.0, additive). */
const READ_LIMITS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        perExcerptChars: { type: 'integer', required: true, description: 'Effective per-excerpt cap: maxBytes after clamping.' },
        batchLimitChars: { type: 'integer', required: true, description: 'Sum of the per-excerpt caps for this call (worst case if every excerpt filled its cap). Excerpts are capped independently.' },
        maxChars: { type: 'integer', required: true, description: 'Batch-level text budget in force. Always 0 today: the batch is never re-trimmed across excerpts; lower maxBytes when the total payload matters.' },
        maxRefs: { type: 'integer', required: true, description: 'Hard cap on targets per call.' },
    },
};
const READ_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ...AGENT_SUCCESS_BASE_SCHEMA.properties,
        items: { type: 'array', items: READ_ITEM_SCHEMA },
        counts: {
            type: 'object',
            additionalProperties: false,
            properties: {
                requested: { type: 'integer', required: true, description: 'Targets read after collapsing duplicates.' },
                returned: { type: 'integer', required: true },
                failed: { type: 'integer', required: true },
                duplicates: { type: 'integer', description: 'Repeated refs collapsed before reading (same ref string).' },
                linesDropped: { type: 'integer', description: 'Window lines dropped so each excerpt respects perExcerptChars.' },
            },
        },
        budget: AGENT_BUDGET_SCHEMA,
        limits: READ_LIMITS_SCHEMA,
        error: AGENT_ERROR_INFO_SCHEMA,
    },
};
/** One unified scope-denied row for a notReadable path (no bytes are read). */
function notReadableOutcome(target, path, reason) {
    return {
        ok: false,
        targetKind: target.kind,
        target: target.value,
        error: errorInfo(AGENT_ERROR_CODES.scopeDenied, 'path matches a configured notReadable glob: ' + path, {
            remediation: 'This path is readable-blocked by the operator (notReadable). Pick a readable file, or ask the operator to relax the rule; locator_status(full) reports the effective rules.',
            details: { path, reason },
        }),
    };
}
/** Read one target and return its row or a structured error. */
async function readTarget(target, mode, line, window, maxBytes, ctx) {
    const outcome = target.kind === 'ref'
        ? await readRef(target.ref, mode, line, window, maxBytes, ctx)
        : await readPath(target.path, mode, line, window, maxBytes, ctx);
    return outcome;
}
/** Read one parsed ref: authorize through locator_resolve, then read bytes. */
async function readRef(rawRef, mode, lineArg, window, maxBytes, ctx) {
    const ref = rawRef.trim();
    const parsed = parseRef(ref);
    if (parsed === undefined) {
        return {
            ok: false,
            targetKind: 'ref',
            target: ref,
            error: errorInfo(AGENT_ERROR_CODES.invalidArgument, 'unsupported or malformed ref: ' + ref.slice(0, 120), {
                remediation: 'Pass a ref returned by locator_find (ref://file?... / ref://session-event?... or dsh-session:...).',
            }),
        };
    }
    // Metadata-only ref kinds are rejected before resolution, so the error does
    // not depend on whether a content index happens to be configured.
    if (mode !== 'meta' && parsed.kind === 'url') {
        return {
            ok: false,
            targetKind: 'ref',
            target: ref,
            error: errorInfo(AGENT_ERROR_CODES.invalidArgument, 'URL refs are metadata-only: they have no local content to excerpt', {
                remediation: 'Use as: "meta" for a URL ref, or read the page with web_fetch.',
            }),
        };
    }
    if (mode !== 'meta' && parsed.kind === 'session') {
        return {
            ok: false,
            targetKind: 'ref',
            target: ref,
            error: errorInfo(AGENT_ERROR_CODES.invalidArgument, 'a session-level ref has no single message body to excerpt', {
                remediation: 'Use the eventRef (ref://session-event?sid=...&seq=N) that locator_find returns for session hits (pass detail:"full" if the compact row omitted it), or pass as: "meta" for session metadata.',
            }),
        };
    }
    const resolved = await resolveView(ctx, ref);
    if (resolved === undefined) {
        return { ok: false, targetKind: 'ref', target: ref, error: errorInfo(AGENT_ERROR_CODES.internal, 'locator_resolve returned no value for this ref') };
    }
    if (resolved.ok !== true)
        return { ok: false, targetKind: 'ref', target: ref, error: resolveFailure(resolved) };
    const base = itemFromResolved(resolved, { ref });
    if (mode === 'meta')
        return { ok: true, item: { ...base, ...metaFieldsOf(parsed, resolved, lineArg) }, dropped: 0 };
    if (parsed.kind === 'session-event') {
        const citation = await citeView(ctx, [ref], 'exact', maxBytes);
        const exact = citation?.citations?.[0]?.exact;
        if (typeof exact !== 'string' || exact === '') {
            return { ok: false, targetKind: 'ref', target: ref, error: errorInfo(AGENT_ERROR_CODES.notFound, 'the session event has no readable text', { remediation: 'The event log may be unavailable; call locator_status to check the content index.' }) };
        }
        const markdown = citation?.citations?.[0]?.markdown;
        const item = {
            ...base,
            ...(parsed.seq === undefined ? {} : { seq: parsed.seq }),
            ...(resolved.provenance?.sessionId === undefined ? {} : { sessionId: resolved.provenance.sessionId }),
            excerpt: exact,
            ...(mode === 'quote'
                ? { markdown: typeof markdown === 'string' && markdown !== '' ? markdown : quoteMarkdown(exact.split('\n'), '[' + ref + '](' + ref + ')', undefined) }
                : {}),
        };
        return { ok: true, item, dropped: 0 };
    }
    if (parsed.kind === 'spill') {
        if (resolved.status === 'missing') {
            return { ok: false, targetKind: 'ref', target: ref, error: errorInfo(AGENT_ERROR_CODES.notFound, 'the spill file is missing: ' + parsed.path, { remediation: 'The tool-output spill was removed; use locator_find to locate the evidence again.' }) };
        }
        return await readFileContent(resolved, { ref, path: parsed.path, line: lineArg ?? 1, fallback: parsed.path }, mode, window, maxBytes, ctx);
    }
    if (parsed.kind === 'attachment') {
        const citation = await citeView(ctx, [ref], 'exact', maxBytes);
        const found = citation?.citations?.[0]?.fallback;
        if (typeof found !== 'string' || found === '') {
            return { ok: false, targetKind: 'ref', target: ref, error: errorInfo(AGENT_ERROR_CODES.notFound, 'the attachment file is missing', { remediation: 'The attachment object was removed from the local store.' }) };
        }
        return await readFileContent(resolved, { ref, path: found, line: lineArg ?? 1, fallback: found }, mode, window, maxBytes, ctx);
    }
    // Unreachable after the pre-resolution mode checks, but it narrows the
    // parsed ref to a file for the remaining code path.
    if (parsed.kind === 'url' || parsed.kind === 'session') {
        return { ok: false, targetKind: 'ref', target: ref, error: errorInfo(AGENT_ERROR_CODES.invalidArgument, 'this ref kind has no readable content') };
    }
    // File refs: the canonical authorized path comes back in provenance.
    const path = resolved.provenance?.path;
    if (typeof path !== 'string' || path === '') {
        return { ok: false, targetKind: 'ref', target: ref, error: errorInfo(AGENT_ERROR_CODES.internal, 'file ref resolved without a path') };
    }
    return await readFileContent(resolved, { ref, path, line: lineArg ?? parsed.line ?? 1, fallback: path }, mode, window, maxBytes, ctx);
}
/** Read one workspace file path: authorize it, build its ref, then read the ref. */
async function readPath(rawPath, mode, lineArg, window, maxBytes, ctx) {
    const input = rawPath.trim();
    const cwd = ctx.cwd ?? process.cwd();
    const absolute = isAbsolute(input) ? input : resolvePath(cwd, input);
    const authorized = resolveWithinRoots(absolute, ctx.roots);
    if (authorized === undefined) {
        return {
            ok: false,
            targetKind: 'path',
            target: input,
            error: errorInfo(AGENT_ERROR_CODES.scopeDenied, 'path is outside every indexed root: ' + input, {
                remediation: 'Use an absolute path under one of the configured index roots (locator_status reports roots).',
            }),
        };
    }
    // Security fence (0.23.0 P0-1): deny before stat/existence checks, so a
    // notReadable path answers scope-denied even when it exists.
    const denial = ctx.scope === undefined ? undefined : readableDenial(ctx.scope, authorized.path);
    if (denial !== undefined)
        return notReadableOutcome({ kind: 'path', value: input }, authorized.path, denial);
    if (!authorized.exists) {
        return { ok: false, targetKind: 'path', target: input, error: errorInfo(AGENT_ERROR_CODES.notFound, 'file does not exist: ' + authorized.path) };
    }
    let mtime = 0;
    let size = 0;
    try {
        const info = statSync(authorized.path);
        if (!info.isFile()) {
            return {
                ok: false,
                targetKind: 'path',
                target: input,
                error: errorInfo(AGENT_ERROR_CODES.invalidArgument, 'locator_read reads files, not directories: ' + authorized.path, {
                    remediation: 'To list or match directories use locator_find with kinds:["dir"]; pass a file path to read its lines.',
                }),
            };
        }
        mtime = info.mtimeMs;
        size = info.size;
    }
    catch {
        return { ok: false, targetKind: 'path', target: input, error: errorInfo(AGENT_ERROR_CODES.notFound, 'file could not be read: ' + authorized.path) };
    }
    const line = lineArg ?? 1;
    const ref = fileRef({ path: authorized.path, mtime, size, line });
    return await readRef(ref, mode, line, window, maxBytes, ctx);
}
/** Read a whole-line window around the target line and shape one row. */
async function readFileContent(resolved, target, mode, window, maxBytes, ctx) {
    // Security fence (defense in depth): the resolve tool already refuses a
    // notReadable path, but never open a byte of one even if an embedder wired
    // an unscoped resolve tool. Deny before the missing check so existence is
    // not leaked either.
    const denial = ctx.scope === undefined ? undefined : readableDenial(ctx.scope, target.path);
    if (denial !== undefined)
        return notReadableOutcome({ kind: 'ref', value: target.ref }, target.path, denial);
    if (resolved.status === 'missing') {
        return { ok: false, targetKind: 'ref', target: target.ref, error: errorInfo(AGENT_ERROR_CODES.notFound, 'evidence file is missing: ' + target.path, { remediation: 'The file moved or was deleted after indexing; search again with locator_find.' }) };
    }
    const result = readLineWindow(target.path, target.line, window, maxBytes);
    if (!result.ok) {
        return result.reason === 'line-out-of-range'
            ? {
                ok: false,
                targetKind: 'ref',
                target: target.ref,
                error: errorInfo(AGENT_ERROR_CODES.notFound, 'line ' + String(target.line) + ' is beyond the end of ' + target.path + (result.lineCount === undefined ? '' : ' (' + String(result.lineCount) + ' lines)'), {
                    remediation: 'Use a line inside the file, or omit line to read from line 1.',
                }),
            }
            : {
                ok: false,
                targetKind: 'ref',
                target: target.ref,
                error: errorInfo(AGENT_ERROR_CODES.internal, 'could not read ' + target.path, { remediation: 'The file may be unreadable; check its permissions.' }),
            };
    }
    const found = result.window;
    const excerpt = found.lines.join('\n');
    const warnings = [...(resolved.warnings ?? [])];
    if (found.truncated && !warnings.includes('excerpt-truncated'))
        warnings.push('excerpt-truncated');
    const item = {
        ...itemFromResolved(resolved, {}),
        ref: target.ref,
        path: target.path,
        line: target.line,
        startLine: found.startLine,
        endLine: found.endLine,
        ...(found.lineCount === undefined ? {} : { lineCount: found.lineCount }),
        excerpt,
        ...(found.truncated ? { truncated: true } : {}),
        ...(warnings.length === 0 ? {} : { warnings }),
    };
    if (mode !== 'quote')
        return { ok: true, item, dropped: found.dropped };
    const link = await compactCitation(ctx, target.ref, target.path);
    return { ok: true, item: { ...item, markdown: quoteMarkdown(found.lines, link, target.fallback) }, dropped: found.dropped };
}
/** Compact citation link for one ref, with a local fallback if cite fails. */
async function compactCitation(ctx, ref, path) {
    const view = await citeView(ctx, [ref], 'compact', 1);
    const markdown = view?.citations?.[0]?.markdown;
    return typeof markdown === 'string' && markdown !== '' ? markdown : '[' + basename(path) + '](' + ref + ')';
}
/** Markdown quote block plus citation link and fallback (mirrors locator_cite). */
function quoteMarkdown(lines, link, fallback) {
    const blocks = [lines.map(line => '> ' + line).join('\n'), link];
    if (fallback !== undefined && fallback !== '') {
        blocks.push(/^https?:\/\//.test(fallback) ? '[fallback](' + fallback + ')' : 'fallback: ' + fallback);
    }
    return blocks.join('\n\n');
}
/** Copy the resolved evidence block into a read row, then apply one override. */
function itemFromResolved(resolved, extra) {
    return {
        ...(resolved.ref === undefined ? {} : { ref: resolved.ref }),
        ...(resolved.kind === undefined ? {} : { kind: resolved.kind }),
        ...(resolved.title === undefined ? {} : { title: resolved.title }),
        ...(resolved.size === undefined ? {} : { size: resolved.size }),
        ...(resolved.hash === undefined ? {} : { hash: resolved.hash }),
        ...(resolved.status === undefined ? {} : { status: resolved.status }),
        ...(resolved.checkedAt === undefined ? {} : { checkedAt: resolved.checkedAt }),
        ...(resolved.anchor === undefined ? {} : { anchor: resolved.anchor }),
        ...(resolved.freshness === undefined ? {} : { freshness: resolved.freshness }),
        ...(resolved.permissions === undefined ? {} : { permissions: resolved.permissions }),
        ...(resolved.provenance === undefined ? {} : { provenance: resolved.provenance }),
        ...(resolved.warnings === undefined || resolved.warnings.length === 0 ? {} : { warnings: [...resolved.warnings] }),
        ...extra,
    };
}
/**
 * Top-level identity fields for meta rows (0.23.0): the old meta row only had
 * them nested in provenance/anchor, which made "read the metadata, then decide"
 * loops expensive. file → path+line, session/session-event → sessionId (+seq).
 */
function metaFieldsOf(parsed, resolved, lineArg) {
    const fields = {};
    if (parsed.kind === 'file') {
        const path = resolved.provenance?.path;
        if (typeof path === 'string' && path !== '')
            fields.path = path;
        const line = lineArg ?? parsed.line ?? resolved.anchor?.line;
        if (line !== undefined)
            fields.line = line;
        return fields;
    }
    if (parsed.kind === 'session' || parsed.kind === 'session-event') {
        fields.sessionId = parsed.sessionId;
        if (parsed.kind === 'session-event')
            fields.seq = parsed.seq;
    }
    return fields;
}
const RESOLVE_FAILURES = {
    'content-path-denied': errorInfo(AGENT_ERROR_CODES.scopeDenied, 'path is outside every indexed root', {
        remediation: 'Read a path under one of the configured index roots (locator_status reports them).',
    }),
    'content-scope-denied': errorInfo(AGENT_ERROR_CODES.scopeDenied, 'the ref is not authorized from this workspace', {
        remediation: 'Use a ref produced inside this workspace/session.',
    }),
    'content-index-unavailable': errorInfo(AGENT_ERROR_CODES.indexUnavailable, 'the content index is unavailable in this profile', {
        retryable: false,
        remediation: 'Read a file ref instead, or enable the content index in the plugin configuration.',
    }),
    'invalid-ref': errorInfo(AGENT_ERROR_CODES.invalidArgument, 'unsupported or malformed ref', {
        remediation: 'Pass a ref returned by locator_find.',
    }),
};
/** Map a locator_resolve failure onto the closed agent error set. */
function resolveFailure(resolved) {
    // A notReadable fence is reported as content-scope-denied + path-not-readable
    // by locator_resolve (same convention as locator_outline/locator_symbol).
    if (resolved.warnings?.includes('path-not-readable') === true) {
        return errorInfo(AGENT_ERROR_CODES.scopeDenied, 'path matches a configured notReadable glob', {
            remediation: 'The operator marked this path unreadable (notReadable). Pick a readable file, or ask them to relax the rule; locator_status detail:"full" shows the effective rules.',
        });
    }
    const known = resolved.error === undefined ? undefined : RESOLVE_FAILURES[resolved.error];
    if (known !== undefined)
        return known;
    return errorInfo(AGENT_ERROR_CODES.internal, resolved.error === undefined ? 'locator_resolve failed without a message' : 'locator_resolve failed: ' + resolved.error);
}
/** Invoke the locator_resolve tool without letting a thrown error escape. */
async function resolveView(ctx, ref) {
    try {
        const value = await ctx.resolveTool.execute({ ref }, ctx.exec);
        return typeof value === 'object' && value !== null ? value : undefined;
    }
    catch {
        return undefined;
    }
}
/** Invoke the locator_cite tool for one ref set. */
async function citeView(ctx, refs, detail, maxBytes) {
    try {
        const value = await ctx.citeTool.execute({ refs, format: 'markdown', detail, maxBytes }, ctx.exec);
        return typeof value === 'object' && value !== null ? value : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Read one bounded line window by streaming the file, then assemble the
 * excerpt: the target line is always present whole, neighbours are added only
 * while they fit maxBytes.
 */
function readLineWindow(path, center, window, maxBytes) {
    const start = Math.max(1, center - window);
    const end = center + window;
    let fd;
    try {
        fd = openSync(path, 'r');
    }
    catch {
        return { ok: false, reason: 'read-failed' };
    }
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    const collected = new Map();
    let carry = '';
    let lineNo = 0;
    let eof = false;
    let slicedLine = false;
    try {
        scan: for (;;) {
            let read = 0;
            try {
                read = readSync(fd, buffer, 0, buffer.length, null);
            }
            catch {
                return { ok: false, reason: 'read-failed' };
            }
            if (read <= 0) {
                eof = true;
                break;
            }
            const chunk = carry + decoder.write(buffer.subarray(0, read));
            const parts = chunk.split('\n');
            carry = parts.pop() ?? '';
            for (const raw of parts) {
                lineNo += 1;
                if (lineNo >= start && lineNo <= end) {
                    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
                    const capped = text.length > READ_MAX_LINE_CHARS ? text.slice(0, READ_MAX_LINE_CHARS) : text;
                    if (capped.length !== text.length)
                        slicedLine = true;
                    collected.set(lineNo, capped);
                }
                if (lineNo >= end)
                    break scan;
            }
        }
        if (eof) {
            const tail = carry + decoder.end();
            if (tail !== '') {
                lineNo += 1;
                if (lineNo >= start && lineNo <= end) {
                    const text = tail.endsWith('\r') ? tail.slice(0, -1) : tail;
                    const capped = text.length > READ_MAX_LINE_CHARS ? text.slice(0, READ_MAX_LINE_CHARS) : text;
                    if (capped.length !== text.length)
                        slicedLine = true;
                    collected.set(lineNo, capped);
                }
            }
        }
    }
    finally {
        closeSync(fd);
    }
    if (lineNo < center) {
        return eof ? { ok: false, reason: 'line-out-of-range', lineCount: lineNo } : { ok: false, reason: 'line-out-of-range' };
    }
    const centerLine = collected.get(center);
    if (centerLine === undefined)
        return { ok: false, reason: 'line-out-of-range', ...(eof ? { lineCount: lineNo } : {}) };
    const availableEnd = eof ? Math.min(end, lineNo) : end;
    const requested = Math.max(1, availableEnd - start + 1);
    let startLine = center;
    let endLine = center;
    let bytes = centerLine.length;
    const lines = [centerLine];
    for (let line = center + 1; line <= availableEnd; line++) {
        const text = collected.get(line);
        if (text === undefined)
            break;
        if (bytes + 1 + text.length > maxBytes)
            break;
        lines.push(text);
        endLine = line;
        bytes += 1 + text.length;
    }
    for (let line = center - 1; line >= start; line--) {
        const text = collected.get(line);
        if (text === undefined)
            break;
        if (bytes + 1 + text.length > maxBytes)
            break;
        lines.unshift(text);
        startLine = line;
        bytes += 1 + text.length;
    }
    const included = endLine - startLine + 1;
    const dropped = Math.max(0, requested - included);
    const truncated = slicedLine || dropped > 0 || centerLine.length > maxBytes;
    return {
        ok: true,
        window: {
            startLine,
            endLine,
            lines,
            dropped,
            truncated,
            ...(eof ? { lineCount: lineNo } : {}),
        },
    };
}
/**
 * Per-call budget block. limitChars is the batch ceiling (perExcerptChars ×
 * targets) and usedChars counts the verbatim excerpt characters actually
 * returned; read never drops rows (dropped stays 0), while window lines
 * trimmed inside an excerpt are reported as counts.linesDropped plus the row's
 * truncated flag/warnings.
 */
function readBudget(items, maxBytes, requested) {
    let usedChars = 0;
    for (const item of items)
        usedChars += item.excerpt?.length ?? 0;
    return {
        limitChars: maxBytes * Math.max(1, requested),
        usedChars,
        truncated: items.some(item => item.truncated === true),
        dropped: 0,
    };
}
/** Explicit per-excerpt vs whole-batch limits so the budget block is unambiguous. */
function readLimits(maxBytes, requested, maxRefs) {
    return {
        perExcerptChars: maxBytes,
        batchLimitChars: maxBytes * Math.max(1, requested),
        maxChars: 0,
        maxRefs,
    };
}
/** Format a byte-ish size for the text rendering. */
function formatSize(bytes) {
    if (bytes < 1024)
        return String(bytes) + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return value.toFixed(value >= 10 ? 0 : 1) + ' ' + (units[unit] ?? 'TB');
}
/** Build the locator_read tool. */
export function makeAgentReadTool(rt, content, options = {}) {
    const maxRefs = Math.max(1, Math.min(READ_MAX_REFS, Math.trunc(options.maxRefs ?? READ_MAX_REFS)));
    const scope = options.scope;
    // The nested resolve/cite tools receive the same scope: their denial is the
    // authoritative authorization check, and read's own fences are defense in depth.
    const resolveTool = makeResolveTool(rt, content, scope === undefined ? {} : { scope });
    const citeTool = makeCiteTool({ ...(content === undefined ? {} : { content }), roots: rt.roots, ...(scope === undefined ? {} : { scope }) });
    return defineTool({
        name: TOOL,
        description: [
            'Read a file/session ref from locator_find, a batch of refs, or a file path (dsh-locator).',
            '',
            'Pass exactly one of ref, refs[] (1-20, duplicates collapsed), or path (inside configured roots). as: meta = evidence; excerpt (default) = verbatim whole lines around line; quote = blockquote + citation + fallback. window 0-20 adds context; maxBytes caps each excerpt independently (default 2000, max 65536) — the batch is never re-trimmed, see limits.',
            '',
            'Use it instead of shell cat/head when the answer needs exact cited lines; every item keeps ref/status/freshness.',
        ].join('\n'),
        parameters: {
            ref: { type: 'string', description: 'One ref from locator_find.' },
            refs: { type: 'array', items: { type: 'string' }, description: '1-20 refs; per-ref failures appear as item.error.' },
            path: { type: 'string', description: 'File path inside the configured roots.' },
            line: { type: 'integer', description: '1-based target line (default: the ref anchor, else 1).' },
            window: { type: 'integer', description: 'Context lines per side, 0-20 (default 0).' },
            as: { type: 'string', enum: READ_MODES, description: 'meta (evidence only), excerpt (default, verbatim lines), or quote (blockquote + citation + fallback).' },
            maxBytes: { type: 'integer', description: 'Per-excerpt cap in characters (default 2000, max 65536); excerpts are capped independently.' },
        },
        output: {
            schema: READ_OUTPUT,
            render: (args, value) => {
                const v = value;
                if (v.ok !== true) {
                    const err = v.error;
                    const detail = err === undefined ? '' : ' — ' + (err.remediation ?? '');
                    return [{ type: 'text', text: 'locator_read failed: ' + (err?.code ?? 'internal') + ': ' + (err?.message ?? 'unknown error') + detail }];
                }
                const mode = args.as ?? 'excerpt';
                const counts = v.counts;
                const header = 'locator_read: ' + String(counts?.returned ?? 0) + ' item(s)' + (counts === undefined || counts.failed === 0 ? '' : ', ' + String(counts.failed) + ' failed') + (v.budget?.truncated === true ? ' (truncated)' : '');
                const blocks = [header];
                const items = v.items ?? [];
                for (let index = 0; index < items.length; index++) {
                    const item = items[index];
                    if (item === undefined)
                        continue;
                    if (item.error !== undefined) {
                        blocks.push(String(index + 1) + '. [' + (item.ref ?? item.path ?? 'target') + '] ' + item.error.code + ': ' + item.error.message + (item.error.remediation === undefined ? '' : '\n   → ' + item.error.remediation));
                        continue;
                    }
                    const title = item.title ?? item.path ?? item.ref ?? '';
                    const location = item.startLine === undefined || item.endLine === undefined
                        ? item.line === undefined ? '' : ' (line ' + String(item.line) + ')'
                        : ' (lines ' + String(item.startLine) + '-' + String(item.endLine) + ')';
                    blocks.push(String(index + 1) + '. [' + (item.kind ?? 'ref') + '] ' + title + location + (item.status === undefined ? '' : ' · ' + item.status));
                    if (item.ref !== undefined)
                        blocks.push('   ref ' + item.ref);
                    if (item.size !== undefined)
                        blocks.push('   size ' + formatSize(item.size));
                    if (mode === 'quote' && item.markdown !== undefined) {
                        blocks.push('', item.markdown);
                    }
                    else if (item.excerpt !== undefined) {
                        blocks.push('   ---');
                        for (const line of item.excerpt.split('\n'))
                            blocks.push('   ' + line);
                    }
                    if (item.warnings !== undefined && item.warnings.length > 0)
                        blocks.push('   warnings: ' + item.warnings.join(', '));
                }
                if (v.budget !== undefined) {
                    const perExcerpt = v.limits?.perExcerptChars ?? 0;
                    const lineDrops = v.counts?.linesDropped ?? 0;
                    blocks.push('(budget: used ' + String(v.budget.usedChars) + '/' + String(v.budget.limitChars) + ' chars · per-excerpt cap ' + String(perExcerpt) + ' chars' + (lineDrops === 0 ? '' : ', ' + String(lineDrops) + ' line(s) dropped') + ' · no batch re-trimming)');
                }
                return [{ type: 'text', text: blocks.join('\n') }];
            },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const startedAt = Date.now();
            const timing = makeTiming(startedAt);
            const mode = args.as === 'meta' || args.as === 'quote' ? args.as : 'excerpt';
            const refArg = typeof args.ref === 'string' ? args.ref.trim() : '';
            const pathArg = typeof args.path === 'string' ? args.path.trim() : '';
            const refsInput = Array.isArray(args.refs) ? args.refs.map(ref => ref.trim()).filter(ref => ref !== '') : undefined;
            // 0.23.0: collapse repeated refs before reading them (same string, first
            // occurrence keeps its position); counts.duplicates reports how many.
            const refsArg = refsInput === undefined ? undefined : [...new Set(refsInput)];
            const duplicates = refsInput === undefined || refsArg === undefined ? 0 : refsInput.length - refsArg.length;
            const provided = (refArg === '' ? 0 : 1) + (refsArg === undefined ? 0 : 1) + (pathArg === '' ? 0 : 1);
            if (provided !== 1) {
                return fail(AGENT_ERROR_CODES.invalidArgument, 'provide exactly one of ref, refs[], or path', {
                    tool: TOOL,
                    timing,
                    remediation: 'ref reads one ref, refs[] reads up to ' + String(maxRefs) + ', path reads a workspace file without a ref.',
                });
            }
            if (args.window !== undefined && (!Number.isInteger(args.window) || args.window < 0 || args.window > READ_MAX_WINDOW)) {
                return fail(AGENT_ERROR_CODES.invalidArgument, 'window must be an integer between 0 and ' + String(READ_MAX_WINDOW), { tool: TOOL, timing });
            }
            if (args.line !== undefined && (!Number.isInteger(args.line) || args.line < 1)) {
                return fail(AGENT_ERROR_CODES.invalidArgument, 'line must be a positive integer', { tool: TOOL, timing });
            }
            const requestedMaxBytes = typeof args.maxBytes === 'number' && Number.isFinite(args.maxBytes) ? Math.trunc(args.maxBytes) : READ_DEFAULT_MAX_BYTES;
            if (requestedMaxBytes < 1) {
                return fail(AGENT_ERROR_CODES.invalidArgument, 'maxBytes must be a positive integer', { tool: TOOL, timing });
            }
            const maxBytes = Math.min(READ_MAX_BYTES, requestedMaxBytes);
            const targetWindow = args.window ?? 0;
            const targets = refsArg === undefined
                ? [refArg === '' ? { kind: 'path', path: pathArg } : { kind: 'ref', ref: refArg }]
                : refsArg.map(ref => ({ kind: 'ref', ref }));
            if (targets.length === 0) {
                return fail(AGENT_ERROR_CODES.invalidArgument, 'refs must contain 1-' + String(maxRefs) + ' refs', { tool: TOOL, timing });
            }
            if (targets.length > maxRefs) {
                return fail(AGENT_ERROR_CODES.invalidArgument, 'too many refs: ' + String(targets.length) + ' (at most ' + String(maxRefs) + ')', {
                    tool: TOOL,
                    timing,
                    remediation: 'Split the batch or raise its focus; locator_find returns refs in pages.',
                });
            }
            const cwd = exec?.agent?.session?.header?.cwd;
            const ctx = {
                roots: rt.roots,
                ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
                exec,
                resolveTool,
                citeTool,
                ...(scope === undefined ? {} : { scope }),
            };
            const outcomes = [];
            for (const target of targets)
                outcomes.push(await readTarget(target, mode, args.line, targetWindow, maxBytes, ctx));
            const failed = outcomes.filter(outcome => !outcome.ok);
            const single = refsArg === undefined;
            if (single && failed.length === 1) {
                const failure = failed[0];
                if (failure !== undefined && !failure.ok)
                    return failureEnvelope(TOOL, failure.error, timing);
            }
            if (failed.length === outcomes.length && outcomes.length > 0) {
                const first = failed[0];
                const error = first !== undefined && !first.ok ? first.error : errorInfo(AGENT_ERROR_CODES.internal, 'all targets failed');
                return fail(error.code, String(failed.length) + '/' + String(outcomes.length) + ' targets failed; first error: ' + error.message, {
                    tool: TOOL,
                    timing,
                    ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
                    details: { codes: failed.map(outcome => outcome.ok ? '' : outcome.error.code) },
                });
            }
            const items = outcomes.map(outcome => outcome.ok
                ? outcome.item
                : {
                    ...(outcome.targetKind === 'ref' ? { ref: outcome.target } : { path: outcome.target }),
                    error: outcome.error,
                });
            const dropped = outcomes.reduce((total, outcome) => total + (outcome.ok ? outcome.dropped : 0), 0);
            return succeed(TOOL, {
                items,
                counts: {
                    requested: outcomes.length,
                    returned: outcomes.length - failed.length,
                    failed: failed.length,
                    duplicates,
                    linesDropped: dropped,
                },
                budget: readBudget(items, maxBytes, outcomes.length),
                limits: readLimits(maxBytes, outcomes.length, maxRefs),
            }, timing);
        },
    });
}
export { READ_MODES };
//# sourceMappingURL=agent-read.js.map