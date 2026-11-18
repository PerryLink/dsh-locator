/**
 * locator_resolve and locator_cite: turn refs into metadata/excerpts and
 * human/agent-readable citations. These tools never return content the caller
 * is not authorized to read (session refs follow the same workspace rule as
 * locator_find; file refs must stay inside the configured roots).
 *
 * 0.19.0 adds the auditable evidence layer: locator_resolve reports an
 * additive status/checkedAt/anchor, URL refs can be revalidated with a
 * conditional HTTP request, and locator_cite gained a detail: "exact" mode
 * that quotes the verbatim evidence plus a fallback locator.
 * @module dsh-locator/ref-tools
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { checkUrlFreshness, decodeSessionRef, freshnessFor, normalizeUrl, parseRef, parseUrlFreshnessMeta, recallUrlFreshness, refStatusForFreshness, rememberUrlFreshness, sha256File, urlFreshnessMetaPatch, urlRef, } from "./refs.js";
import { resolveWithinRoots } from "./reveal.js";
/** Read at most maxBytes from the head of one file (text excerpt helper). */
function readHead(path, maxBytes) {
    let fd;
    try {
        fd = openSync(path, 'r');
        const buffer = Buffer.alloc(Math.min(maxBytes, 64 * 1024));
        const read = readSync(fd, buffer, 0, buffer.length, 0);
        return buffer.subarray(0, read).toString('utf8');
    }
    catch {
        return undefined;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
/** Trim the trailing CR of one physical line and cap its length. */
function lineExcerpt(raw, maxChars) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    return { text: text.slice(0, maxChars), charStart: 0, charEnd: Math.min(text.length, maxChars) };
}
/**
 * Read one 1-based line verbatim by streaming the file (bounded memory). Used
 * by cite detail mode when the ref carries the cited line from locator_find.
 */
function readLineExcerpt(path, line, maxChars) {
    if (!Number.isInteger(line) || line <= 0)
        return undefined;
    let fd;
    try {
        fd = openSync(path, 'r');
        const buffer = Buffer.alloc(64 * 1024);
        let current = 1;
        let carry = '';
        for (;;) {
            let read = 0;
            try {
                read = readSync(fd, buffer, 0, buffer.length, null);
            }
            catch {
                return undefined;
            }
            if (read <= 0)
                break;
            const chunk = carry + buffer.subarray(0, read).toString('utf8');
            const parts = chunk.split('\n');
            carry = parts.pop() ?? '';
            for (const raw of parts) {
                if (current === line)
                    return lineExcerpt(raw, maxChars);
                current += 1;
            }
        }
        if (current === line && carry !== '')
            return lineExcerpt(carry, maxChars);
        return undefined;
    }
    catch {
        return undefined;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
/** First line of one file, used when the ref carries no line anchor. */
function firstLineExcerpt(path, maxChars) {
    const head = readHead(path, maxChars + 4096);
    if (head === undefined)
        return undefined;
    const raw = head.split('\n')[0] ?? '';
    const excerpt = lineExcerpt(raw, maxChars);
    return excerpt.text === '' ? undefined : excerpt;
}
/** Slice the verbatim cited line (or first line) of one file. */
function fileExact(path, parsed, maxBytes) {
    if (parsed.line !== undefined) {
        const line = readLineExcerpt(path, parsed.line, 65536);
        if (line === undefined)
            return {};
        const start = Math.max(0, Math.min(parsed.charStart ?? 0, line.text.length));
        const wantedEnd = parsed.charEnd === undefined ? line.text.length : Math.min(parsed.charEnd, line.text.length);
        const end = Math.max(start, Math.min(wantedEnd, start + maxBytes));
        return { exact: line.text.slice(start, end), offsets: { line: parsed.line, charStart: start, charEnd: end } };
    }
    const first = firstLineExcerpt(path, maxBytes);
    return first === undefined ? {} : { exact: first.text, offsets: { charStart: first.charStart, charEnd: first.charEnd } };
}
/**
 * Compare one file ref against the current bytes with a cheap stat first and a
 * hash only when the metadata moved. A ref whose mtime+size still match does
 * not re-read the file, which is what keeps repeated resolves cheap.
 */
async function inspectFileRef(path, snapshot, indexedAt) {
    let info;
    try {
        info = statSync(path);
    }
    catch {
        return { status: 'missing' };
    }
    if (!info.isFile())
        return { status: 'missing' };
    const mtime = info.mtimeMs;
    const size = info.size;
    const hasMtime = snapshot.mtime !== undefined;
    const hasSize = snapshot.size !== undefined;
    const hasHash = snapshot.sha256 !== undefined;
    const mtimeMatches = hasMtime ? Math.abs(mtime - snapshot.mtime) < 1 : undefined;
    const sizeMatches = hasSize ? size === snapshot.size : undefined;
    if (sizeMatches === false)
        return { status: 'stale', mtime, size };
    if (mtimeMatches === false) {
        if (hasHash) {
            const current = await sha256File(path);
            if (current !== null)
                return { status: current === snapshot.sha256 ? 'fresh' : 'stale', mtime, size, hash: current };
        }
        return { status: 'stale', mtime, size };
    }
    if (mtimeMatches === true || sizeMatches === true) {
        return {
            status: 'fresh',
            mtime,
            size,
            ...(hasHash ? { hash: snapshot.sha256 } : {}),
        };
    }
    // No mtime/size validator: compare the hash when the ref carries one, so a
    // sha256-only ref still flips to stale when the bytes changed.
    const hash = await sha256File(path);
    if (hasHash) {
        if (hash === null)
            return { status: 'unknown', mtime, size };
        return { status: hash === snapshot.sha256 ? 'fresh' : 'stale', mtime, size, hash };
    }
    const status = indexedAt === undefined
        ? 'fresh'
        : Math.abs(mtime - indexedAt) < 1 ? 'fresh' : 'stale';
    return { status, mtime, size, ...(hash === null ? {} : { hash }) };
}
const RESOLVE_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true },
        ref: { type: 'string' },
        kind: { type: 'string', enum: ['file', 'session', 'url', 'session-event', 'spill', 'attachment'] },
        hash: { type: 'string' },
        size: { type: 'integer' },
        title: { type: 'string' },
        excerpt: { type: 'string' },
        status: { type: 'string', enum: ['fresh', 'stale', 'missing', 'tombstoned', 'unknown'], description: 'Lifecycle status of the cited evidence.' },
        checkedAt: { type: 'integer', description: 'Epoch ms of the check that produced status.' },
        anchor: {
            type: 'object',
            additionalProperties: false,
            properties: {
                line: { type: 'integer' },
                charStart: { type: 'integer' },
                charEnd: { type: 'integer' },
            },
        },
        provenance: {
            type: 'object',
            additionalProperties: false,
            properties: {
                origin: { type: 'string', enum: ['index', 'tool', 'session', 'web'] },
                path: { type: 'string' },
                sessionId: { type: 'string' },
                messageId: { type: 'string' },
                url: { type: 'string' },
                indexedAt: { type: 'integer' },
            },
        },
        freshness: {
            type: 'object',
            additionalProperties: false,
            properties: {
                state: { type: 'string', enum: ['fresh', 'stale', 'missing', 'unknown'] },
                observedAt: { type: 'integer' },
                mtime: { type: 'integer' },
            },
        },
        permissions: {
            type: 'object',
            additionalProperties: false,
            properties: {
                read: { type: 'string', enum: ['allowed', 'denied'] },
                visibility: { type: 'string', enum: ['workspace', 'roots', 'session', 'external'] },
                reason: { type: 'string' },
            },
        },
        error: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
    },
};
/** Character anchor schema shared by cite offsets. */
const CITE_OFFSETS = {
    type: 'object',
    additionalProperties: false,
    properties: {
        line: { type: 'integer' },
        charStart: { type: 'integer' },
        charEnd: { type: 'integer' },
    },
};
const CITE_CITATION = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ref: { type: 'string' },
        kind: { type: 'string', enum: ['file', 'session', 'url', 'session-event', 'spill', 'attachment'] },
        label: { type: 'string' },
        markdown: { type: 'string' },
        mention: { type: 'string' },
        title: { type: 'string' },
        exact: { type: 'string', description: 'Verbatim cited text (detail: exact only).' },
        offsets: CITE_OFFSETS,
        checkedAt: { type: 'integer' },
        status: { type: 'string', enum: ['fresh', 'stale', 'missing', 'tombstoned', 'unknown'] },
        visibility: { type: 'string', enum: ['workspace', 'roots', 'session', 'external'] },
        fallback: { type: 'string', description: 'HTTPS URL or absolute path to open the evidence without the ref.' },
    },
};
const CITE_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true },
        format: { type: 'string', enum: ['markdown', 'json', 'mention'] },
        citations: { type: 'array', items: CITE_CITATION },
        warnings: { type: 'array', items: { type: 'string' } },
        error: { type: 'string' },
    },
};
/** Root of the local attachment store (matches @deepseek-ai/attachment-local). */
function attachmentsRoot() {
    const home = process.env.DSH_HOME;
    return join(home === undefined || home === '' ? join(homedir(), '.dsh') : home, 'attachments', 'v1');
}
/** File-host candidates for one attachment digest (images first, then files). */
function attachmentCandidates(sha256) {
    const prefix = sha256.slice(0, 2);
    const root = attachmentsRoot();
    return [
        { path: join(root, 'objects', prefix, sha256), kind: 'image' },
        { path: join(root, 'file-objects', prefix, sha256), kind: 'file' },
    ];
}
/** Authorized occurrences of one ref key shared by the new ref kinds. */
function authorizedOccurrences(content, refKey, callerCwd, callerSessionId) {
    const allowed = content.authorizedSessionIds(callerCwd, callerSessionId);
    return content.refsFor(refKey).filter(row => allowed.has(row.sessionId));
}
/** Warning code reported when a miss is answered from the persisted marker. */
const MISSING_STATE_CACHED = 'missing-state-cached';
/**
 * Whether any occurrence already carries the persisted missing marker written
 * by an earlier resolve (stored in the additive refs.meta JSON column).
 */
function refMarkedMissing(rows) {
    for (const row of rows) {
        if (row.meta === null || row.meta === '')
            continue;
        try {
            const parsed = JSON.parse(row.meta);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
                && parsed.missing === true)
                return true;
        }
        catch { /* unparseable legacy metadata is not a marker */ }
    }
    return false;
}
/**
 * Persist the lazy missing marker for one ref exactly once. Writing is
 * best-effort: resolution never fails because the marker could not be stored.
 */
function persistRefMissing(content, refKey) {
    if (typeof content.markRefMissing !== 'function')
        return;
    try {
        content.markRefMissing(refKey);
    }
    catch { /* marker is an optimization only */ }
}
/**
 * Remember one URL observation in-process and, when the content index exposes
 * the additive setRefMeta writer, persist it in the refs.meta column so a later
 * process can answer with a conditional request.
 */
function persistUrlObservation(content, refKey, record) {
    rememberUrlFreshness(refKey, record);
    if (content === undefined)
        return;
    const writer = content;
    if (typeof writer.setRefMeta !== 'function')
        return;
    try {
        writer.setRefMeta(refKey, urlFreshnessMetaPatch(record));
    }
    catch { /* metadata is additive best-effort */ }
}
/** Read the newest persisted URL observation for one ref (authorized rows only). */
function findUrlObservation(content, refKey, callerCwd, callerSessionId) {
    if (content !== undefined) {
        for (const row of authorizedOccurrences(content, refKey, callerCwd, callerSessionId)) {
            const record = parseUrlFreshnessMeta(row.meta);
            if (record !== undefined)
                return record;
        }
    }
    return recallUrlFreshness(refKey);
}
/** Map a lifecycle status onto the freshness state the older schema exposes. */
function freshnessStateOf(status) {
    return status === 'fresh' ? 'fresh' : status === 'stale' ? 'stale' : status === 'missing' ? 'missing' : 'unknown';
}
/** Build the freshness block for one URL observation. */
function urlFreshness(record, observedAt) {
    return { state: freshnessStateOf(record.status), observedAt };
}
/** One denied resolve result. */
function deniedResult(parsed, kind) {
    return {
        ok: false,
        ref: parsed.ref,
        kind,
        error: 'content-scope-denied',
        warnings: ['ref-not-authorized'],
        permissions: { read: 'denied', visibility: 'session', reason: 'no authorized session occurrence for this ref (caller cwd differs)' },
    };
}
/** Extract the caller identity from one tool execution context. */
function callerOf(exec) {
    const sessionId = exec?.agent?.session?.id;
    const cwd = exec?.agent?.session?.header?.cwd;
    return {
        ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
        ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
    };
}
/** Build the locator_resolve tool. */
export function makeResolveTool(rt, content, options = {}) {
    return defineTool({
        name: 'locator_resolve',
        description: [
            'Resolve one dsh-locator evidence ref into its metadata (provenance, hash, freshness, permissions, lifecycle status) and, optionally, a bounded excerpt.',
            '',
            'Refs come from locator_find/locator_search hits: dsh-session: URIs for session messages and ref://file?... for files. Session refs are only resolvable for the caller session and sessions whose immutable cwd equals the caller cwd; file refs must stay inside the configured index roots.',
            '',
            'The additive status field is fresh, stale, missing (target gone), tombstoned (a previous resolve persisted a missing marker) or unknown; checkedAt says when that observation was made. URL refs are metadata-only unless the operator enabled urlFreshness: then one bounded conditional HTTP request (5 s timeout, no crawling, no robots fetch) revalidates the target, and unreachable targets report stale instead of missing.',
            '',
            'Use it to verify that a citation is still fresh, or to quote a bounded excerpt instead of re-reading a whole file.',
        ].join('\n'),
        parameters: {
            ref: { type: 'string', required: true, description: 'Ref string from a hit (dsh-session: URI or ref://file?...).' },
            mode: { type: 'string', enum: ['meta', 'excerpt'], description: 'meta (default) returns metadata only; excerpt also returns a bounded excerpt (the cited line when the ref carries one).' },
            maxBytes: { type: 'integer', description: 'Excerpt size cap in bytes (default 2048, at most 65536).' },
            messageId: { type: 'string', description: 'For session refs: the message id to excerpt (optional).' },
        },
        output: {
            schema: RESOLVE_OUTPUT,
            render: (_args, value) => {
                const v = value;
                if (!v.ok)
                    return [{ type: 'text', text: 'locator_resolve failed: ' + (v.error ?? 'unknown error') + (v.warnings === undefined || v.warnings.length === 0 ? '' : ' (' + v.warnings.join(', ') + ')') }];
                const parts = ['locator_resolve ' + (v.kind ?? 'ref') + ' ' + (v.ref ?? '')];
                if (v.title !== undefined)
                    parts.push('title: ' + v.title);
                if (v.size !== undefined)
                    parts.push('size: ' + String(v.size));
                if (v.hash !== undefined)
                    parts.push('sha256: ' + v.hash);
                if (v.freshness?.state !== undefined)
                    parts.push('freshness: ' + v.freshness.state);
                if (v.status !== undefined)
                    parts.push('status: ' + v.status);
                if (v.checkedAt !== undefined)
                    parts.push('checkedAt: ' + new Date(v.checkedAt).toISOString());
                if (v.permissions?.visibility !== undefined)
                    parts.push('visibility: ' + v.permissions.visibility);
                const head = parts.join(' · ');
                return [{ type: 'text', text: v.excerpt === undefined ? head : head + '\n---\n' + v.excerpt }];
            },
        },
        async execute(args, exec) {
            const observedAt = Date.now();
            const parsed = parseRef(args.ref.trim());
            if (parsed === undefined)
                return { ok: false, error: 'invalid-ref', warnings: ['unsupported-or-malformed-ref'] };
            const mode = args.mode === 'excerpt' ? 'excerpt' : 'meta';
            const maxBytes = Math.max(1, Math.min(65536, Math.trunc(args.maxBytes ?? 2048)));
            const caller = callerOf(exec);
            if (parsed.kind === 'session') {
                if (content === undefined)
                    return { ok: false, ref: parsed.ref, kind: 'session', error: 'content-index-unavailable' };
                const allowed = content.authorizedSessionIds(caller.cwd, caller.sessionId);
                if (!allowed.has(parsed.sessionId)) {
                    return {
                        ok: false,
                        ref: parsed.ref,
                        kind: 'session',
                        error: 'content-scope-denied',
                        warnings: ['session-not-authorized'],
                        permissions: { read: 'denied', visibility: 'session', reason: 'target session cwd differs from the caller cwd' },
                    };
                }
                const messageId = typeof args.messageId === 'string' && args.messageId !== '' ? args.messageId : undefined;
                const indexedAt = messageId === undefined ? content.sessionIndexedMtime(parsed.sessionId) : content.indexedMtime('session', '', messageId);
                const body = messageId === undefined ? undefined : content.sessionBody(parsed.sessionId, messageId);
                const excerpt = mode === 'excerpt' ? body?.slice(0, maxBytes) : undefined;
                const provenance = { origin: 'index', sessionId: parsed.sessionId, ...(messageId === undefined ? {} : { messageId }), ...(indexedAt === undefined ? {} : { indexedAt: Math.trunc(indexedAt) }) };
                const freshness = freshnessFor(indexedAt, indexedAt, observedAt);
                return {
                    ok: true,
                    ref: parsed.ref,
                    kind: 'session',
                    title: 'session ' + parsed.sessionId.slice(0, 12) + (messageId === undefined ? '' : ' message ' + messageId),
                    ...(body === undefined ? {} : { size: body.length }),
                    provenance,
                    freshness,
                    status: refStatusForFreshness(freshness.state),
                    checkedAt: observedAt,
                    permissions: { read: 'allowed', visibility: 'session', reason: 'caller workspace authorization' },
                    ...(excerpt === undefined ? {} : { excerpt }),
                };
            }
            if (parsed.kind === 'file') {
                const authorized = resolveWithinRoots(parsed.path, rt.roots);
                if (authorized === undefined) {
                    return {
                        ok: false,
                        ref: parsed.ref,
                        kind: 'file',
                        error: 'content-path-denied',
                        warnings: ['path-outside-roots'],
                        permissions: { read: 'denied', visibility: 'roots', reason: 'path is outside every indexed root' },
                    };
                }
                const indexedAt = content?.indexedMtime('file', authorized.path);
                const snapshot = {
                    ...(parsed.mtime === undefined ? {} : { mtime: parsed.mtime }),
                    ...(parsed.size === undefined ? {} : { size: parsed.size }),
                    ...(parsed.sha256 === undefined ? {} : { sha256: parsed.sha256 }),
                };
                const state = await inspectFileRef(authorized.path, snapshot, indexedAt);
                const exact = mode === 'excerpt' && state.status !== 'missing' ? fileExact(authorized.path, parsed, maxBytes) : undefined;
                const anchorFromRef = {
                    ...(parsed.line === undefined ? {} : { line: parsed.line }),
                    ...(parsed.charStart === undefined ? {} : { charStart: parsed.charStart }),
                    ...(parsed.charEnd === undefined ? {} : { charEnd: parsed.charEnd }),
                };
                const anchor = exact?.offsets ?? (Object.keys(anchorFromRef).length === 0 ? undefined : anchorFromRef);
                return {
                    ok: true,
                    ref: parsed.ref,
                    kind: 'file',
                    title: basename(authorized.path),
                    ...(state.size === undefined ? {} : { size: state.size }),
                    ...(state.hash === undefined ? {} : { hash: state.hash }),
                    provenance: { origin: 'index', path: authorized.path, ...(indexedAt === undefined ? {} : { indexedAt: Math.trunc(indexedAt) }) },
                    freshness: {
                        state: freshnessStateOf(state.status),
                        observedAt,
                        ...(state.mtime === undefined ? {} : { mtime: Math.trunc(state.mtime) }),
                    },
                    status: state.status,
                    checkedAt: observedAt,
                    ...(anchor === undefined ? {} : { anchor }),
                    permissions: { read: 'allowed', visibility: 'roots', reason: 'path is inside the configured roots' },
                    ...(exact?.exact === undefined ? {} : { excerpt: exact.exact }),
                    ...(state.status === 'missing' ? { warnings: ['file-missing'] } : {}),
                };
            }
            if (parsed.kind === 'session-event') {
                if (content === undefined)
                    return { ok: false, ref: parsed.ref, kind: 'session-event', error: 'content-index-unavailable' };
                const allowed = content.authorizedSessionIds(caller.cwd, caller.sessionId);
                if (!allowed.has(parsed.sessionId))
                    return deniedResult(parsed, 'session-event');
                const indexedAt = content.sessionIndexedMtime(parsed.sessionId);
                const raw = mode === 'excerpt' ? await content.sessionEventBody(parsed.sessionId, parsed.seq, maxBytes * 2) : undefined;
                const excerpt = raw?.slice(0, maxBytes);
                const status = mode === 'excerpt' ? (raw === undefined ? 'missing' : 'fresh') : (indexedAt === undefined ? 'unknown' : 'fresh');
                return {
                    ok: true,
                    ref: parsed.ref,
                    kind: 'session-event',
                    title: 'session ' + parsed.sessionId.slice(0, 12) + ' event ' + String(parsed.seq),
                    ...(raw === undefined ? {} : { size: raw.length }),
                    provenance: { origin: 'session', sessionId: parsed.sessionId, ...(indexedAt === undefined ? {} : { indexedAt: Math.trunc(indexedAt) }) },
                    freshness: { state: freshnessStateOf(status), observedAt },
                    status,
                    checkedAt: observedAt,
                    ...(excerpt === undefined ? {} : { anchor: { charStart: 0, charEnd: excerpt.length } }),
                    permissions: { read: 'allowed', visibility: 'session', reason: 'caller workspace authorization' },
                    ...(excerpt === undefined ? {} : { excerpt }),
                    warnings: raw === undefined && mode === 'excerpt' ? ['event-log-unavailable'] : [],
                };
            }
            if (parsed.kind === 'spill') {
                if (content === undefined)
                    return { ok: false, ref: parsed.ref, kind: 'spill', error: 'content-index-unavailable' };
                const occurrences = authorizedOccurrences(content, parsed.ref, caller.cwd, caller.sessionId);
                if (occurrences.length === 0)
                    return deniedResult(parsed, 'spill');
                if (refMarkedMissing(occurrences)) {
                    // A previous resolve already proved this path missing: answer from the
                    // stored marker instead of re-statting it on every call.
                    const ownerId = occurrences[0]?.sessionId;
                    return {
                        ok: true,
                        ref: parsed.ref,
                        kind: 'spill',
                        title: basename(parsed.path),
                        provenance: { origin: 'tool', ...(ownerId === undefined ? {} : { sessionId: ownerId }), ...(occurrences[0]?.messageId === undefined ? {} : { messageId: occurrences[0].messageId }) },
                        freshness: { state: 'missing', observedAt },
                        status: 'tombstoned',
                        checkedAt: observedAt,
                        permissions: { read: 'allowed', visibility: 'session', reason: 'authorized session occurrence' },
                        warnings: ['spill-file-missing', MISSING_STATE_CACHED],
                    };
                }
                let resolvedPath;
                let size;
                try {
                    if (!statSync(parsed.path).isFile())
                        return { ok: true, ref: parsed.ref, kind: 'spill', error: 'spill-not-a-file', status: 'missing', checkedAt: observedAt, freshness: { state: 'missing', observedAt }, warnings: ['spill-not-a-file'] };
                    resolvedPath = realpathSync(parsed.path);
                    size = statSync(resolvedPath).size;
                }
                catch {
                    resolvedPath = undefined;
                }
                const ownerId = occurrences[0]?.sessionId;
                const ownerHash = ownerId === undefined ? undefined : createHash('sha256').update(ownerId).digest('hex').slice(0, 12);
                const dirName = resolvedPath === undefined ? '' : basename(dirname(resolvedPath));
                const owned = ownerHash === undefined ? true : dirName === 'session-' + ownerHash;
                const excerpt = mode === 'excerpt' && resolvedPath !== undefined ? readHead(resolvedPath, maxBytes) : undefined;
                if (resolvedPath === undefined)
                    persistRefMissing(content, parsed.ref);
                return {
                    ok: true,
                    ref: parsed.ref,
                    kind: 'spill',
                    title: resolvedPath === undefined ? basename(parsed.path) : basename(resolvedPath),
                    ...(size === undefined ? {} : { size }),
                    provenance: { origin: 'tool', ...(ownerId === undefined ? {} : { sessionId: ownerId }), ...(occurrences[0]?.messageId === undefined ? {} : { messageId: occurrences[0].messageId }) },
                    freshness: resolvedPath === undefined ? { state: 'missing', observedAt } : { state: 'fresh', observedAt, mtime: Math.trunc(statSync(resolvedPath).mtimeMs) },
                    status: resolvedPath === undefined ? 'missing' : 'fresh',
                    checkedAt: observedAt,
                    permissions: { read: 'allowed', visibility: 'session', reason: 'authorized session occurrence' },
                    ...(excerpt === undefined ? {} : { excerpt }),
                    warnings: [
                        ...(resolvedPath === undefined ? ['spill-file-missing'] : []),
                        ...(owned ? [] : ['spill-owner-mismatch']),
                    ],
                };
            }
            if (parsed.kind === 'attachment') {
                if (content === undefined)
                    return { ok: false, ref: parsed.ref, kind: 'attachment', error: 'content-index-unavailable' };
                const occurrences = authorizedOccurrences(content, parsed.ref, caller.cwd, caller.sessionId);
                if (occurrences.length === 0)
                    return deniedResult(parsed, 'attachment');
                if (refMarkedMissing(occurrences)) {
                    return {
                        ok: true,
                        ref: parsed.ref,
                        kind: 'attachment',
                        title: occurrences[0]?.title ?? 'attachment ' + parsed.sha256.slice(0, 12),
                        provenance: { origin: 'session', ...(occurrences[0]?.sessionId === undefined ? {} : { sessionId: occurrences[0].sessionId }), ...(occurrences[0]?.messageId === undefined ? {} : { messageId: occurrences[0].messageId }) },
                        freshness: { state: 'missing', observedAt },
                        status: 'tombstoned',
                        checkedAt: observedAt,
                        permissions: { read: 'allowed', visibility: 'session', reason: 'authorized session occurrence' },
                        warnings: ['attachment-missing', MISSING_STATE_CACHED],
                    };
                }
                const found = attachmentCandidates(parsed.sha256).find(candidate => existsSync(candidate.path));
                const excerpt = mode === 'excerpt' && found !== undefined && found.kind === 'file' ? readHead(found.path, maxBytes) : undefined;
                if (found === undefined)
                    persistRefMissing(content, parsed.ref);
                return {
                    ok: true,
                    ref: parsed.ref,
                    kind: 'attachment',
                    title: occurrences[0]?.title ?? 'attachment ' + parsed.sha256.slice(0, 12),
                    ...(found === undefined ? {} : { size: statSync(found.path).size }),
                    provenance: { origin: 'session', ...(occurrences[0]?.sessionId === undefined ? {} : { sessionId: occurrences[0].sessionId }), ...(occurrences[0]?.messageId === undefined ? {} : { messageId: occurrences[0].messageId }) },
                    freshness: found === undefined ? { state: 'missing', observedAt } : { state: 'fresh', observedAt, mtime: Math.trunc(statSync(found.path).mtimeMs) },
                    status: found === undefined ? 'missing' : 'fresh',
                    checkedAt: observedAt,
                    permissions: { read: 'allowed', visibility: 'session', reason: 'authorized session occurrence' },
                    ...(excerpt === undefined ? {} : { excerpt }),
                    ...(found === undefined ? { warnings: ['attachment-missing'] } : {}),
                };
            }
            // URL refs: metadata only by default; opt-in conditional revalidation.
            const normalized = normalizeUrl(parsed.url);
            const occurrences = content === undefined ? [] : authorizedOccurrences(content, parsed.ref, caller.cwd, caller.sessionId);
            const indexedAt = occurrences[0]?.indexedAt;
            const observation = findUrlObservation(content, parsed.ref, caller.cwd, caller.sessionId);
            const provenance = { origin: 'web', url: normalized, ...(indexedAt === undefined ? {} : { indexedAt: Math.trunc(indexedAt) }) };
            const permissions = { read: 'allowed', visibility: 'external', reason: 'external URL metadata; no network read' };
            if (options.urlFreshness === true) {
                const check = await checkUrlFreshness(normalized, observation, {
                    ...(options.urlFreshnessTimeoutMs === undefined ? {} : { timeoutMs: options.urlFreshnessTimeoutMs }),
                    ...(options.urlFreshnessMaxBytes === undefined ? {} : { maxBytes: options.urlFreshnessMaxBytes }),
                });
                persistUrlObservation(content, parsed.ref, check.record);
                return {
                    ok: true,
                    ref: parsed.ref,
                    kind: 'url',
                    title: normalized,
                    ...(check.record.contentSha256 === undefined ? {} : { hash: check.record.contentSha256 }),
                    provenance,
                    freshness: urlFreshness(check.record, observedAt),
                    status: check.record.status,
                    checkedAt: check.record.checkedAt,
                    permissions,
                    ...(check.warnings.length === 0 ? {} : { warnings: check.warnings }),
                };
            }
            if (observation !== undefined) {
                return {
                    ok: true,
                    ref: parsed.ref,
                    kind: 'url',
                    title: normalized,
                    ...(observation.contentSha256 === undefined ? {} : { hash: observation.contentSha256 }),
                    provenance,
                    freshness: urlFreshness(observation, observedAt),
                    status: observation.status,
                    checkedAt: observation.checkedAt,
                    permissions,
                    warnings: ['url-freshness-cached'],
                };
            }
            return {
                ok: true,
                ref: parsed.ref,
                kind: 'url',
                title: normalized,
                provenance,
                freshness: { state: 'unknown', observedAt },
                status: 'unknown',
                permissions,
                warnings: ['url-not-fetched'],
            };
        },
    });
}
/** Build the compact citation (the pre-0.19.0 output) for one parsed ref. */
function compactCitation(parsed) {
    switch (parsed.kind) {
        case 'file': {
            const label = basename(parsed.path) || parsed.path;
            return { ref: parsed.ref, kind: 'file', label, markdown: '[' + label + '](' + parsed.ref + ')' };
        }
        case 'url': {
            const label = parsed.url;
            return { ref: parsed.ref, kind: 'url', label, markdown: '[' + label + '](' + parsed.ref + ')' };
        }
        case 'session-event': {
            const label = 'session ' + parsed.sessionId.slice(0, 12) + ' event ' + String(parsed.seq);
            return { ref: parsed.ref, kind: 'session-event', label, markdown: '[' + label + '](' + parsed.ref + ')' };
        }
        case 'spill': {
            const label = basename(parsed.path) || parsed.path;
            return { ref: parsed.ref, kind: 'spill', label, markdown: '[' + label + '](' + parsed.ref + ')' };
        }
        case 'attachment': {
            const label = 'attachment ' + parsed.sha256.slice(0, 12);
            return { ref: parsed.ref, kind: 'attachment', label, markdown: '[' + label + '](' + parsed.ref + ')' };
        }
        case 'session': {
            const label = 'session ' + parsed.sessionId.slice(0, 12);
            const mention = '@[' + label + '](' + parsed.ref + ')';
            return { ref: parsed.ref, kind: 'session', label, markdown: mention, mention };
        }
    }
}
/** Extract the human text of one session-event JSON line. */
function exactFromEventLine(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return undefined;
    const event = parsed;
    const data = typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data)
        ? event.data
        : {};
    const candidates = [data.content];
    const message = data.message;
    if (typeof message === 'object' && message !== null && !Array.isArray(message))
        candidates.push(message.content);
    for (const candidate of candidates) {
        if (!Array.isArray(candidate))
            continue;
        const text = candidate
            .filter((block) => typeof block === 'object' && block !== null
            && block.type === 'text'
            && typeof block.text === 'string')
            .map(block => block.text)
            .join('\n')
            .trim();
        if (text !== '')
            return text;
    }
    return undefined;
}
/** Render one detail-mode citation as a blockquote plus its compact link. */
function renderCitationMarkdown(base, fields) {
    const blocks = [];
    if (fields.exact !== undefined && fields.exact !== '') {
        blocks.push(fields.exact.split('\n').map(line => '> ' + line).join('\n'));
    }
    blocks.push(base.markdown);
    if (fields.fallback !== undefined && fields.fallback !== '') {
        blocks.push(/^https?:\/\//.test(fields.fallback) ? '[fallback](' + fields.fallback + ')' : 'fallback: ' + fields.fallback);
    }
    return blocks.join('\n\n');
}
/** Attach exact text / status / fallback to one citation (detail: exact). */
async function citationDetail(parsed, base, observedAt, maxBytes, options, caller) {
    const warnings = [];
    const fields = {};
    if (parsed.kind === 'file') {
        fields.title = base.label;
        fields.fallback = parsed.path;
        fields.visibility = 'roots';
        if (options.roots === undefined) {
            fields.status = 'unknown';
            warnings.push('roots-unavailable');
            return { fields, warnings };
        }
        const authorized = resolveWithinRoots(parsed.path, options.roots);
        if (authorized === undefined) {
            fields.status = 'unknown';
            warnings.push('path-outside-roots');
            return { fields, warnings };
        }
        const indexedAt = options.content?.indexedMtime('file', authorized.path);
        const snapshot = {
            ...(parsed.mtime === undefined ? {} : { mtime: parsed.mtime }),
            ...(parsed.size === undefined ? {} : { size: parsed.size }),
            ...(parsed.sha256 === undefined ? {} : { sha256: parsed.sha256 }),
        };
        const state = await inspectFileRef(authorized.path, snapshot, indexedAt);
        fields.status = state.status;
        fields.checkedAt = observedAt;
        if (state.status === 'missing') {
            warnings.push('file-missing');
            return { fields, warnings };
        }
        const exact = fileExact(authorized.path, parsed, maxBytes);
        if (exact.exact !== undefined)
            fields.exact = exact.exact;
        if (exact.offsets !== undefined)
            fields.offsets = exact.offsets;
        return { fields, warnings };
    }
    if (parsed.kind === 'url') {
        fields.title = parsed.url;
        fields.fallback = parsed.url;
        fields.visibility = 'external';
        const observation = findUrlObservation(options.content, parsed.ref, caller.cwd, caller.sessionId);
        if (observation === undefined) {
            fields.status = 'unknown';
            warnings.push('url-not-checked');
        }
        else {
            fields.status = observation.status;
            fields.checkedAt = observation.checkedAt;
        }
        return { fields, warnings };
    }
    if (parsed.kind === 'session-event') {
        fields.title = base.label;
        fields.visibility = 'session';
        if (options.content === undefined) {
            fields.status = 'unknown';
            warnings.push('content-index-unavailable');
            return { fields, warnings };
        }
        const allowed = options.content.authorizedSessionIds(caller.cwd, caller.sessionId);
        if (!allowed.has(parsed.sessionId)) {
            fields.status = 'unknown';
            warnings.push('ref-not-authorized');
            return { fields, warnings };
        }
        const raw = await options.content.sessionEventBody(parsed.sessionId, parsed.seq, Math.min(65536, Math.max(8192, maxBytes * 8)));
        const text = raw === undefined ? undefined : exactFromEventLine(raw);
        fields.checkedAt = observedAt;
        if (text === undefined) {
            fields.status = 'missing';
            warnings.push(raw === undefined ? 'event-log-unavailable' : 'event-text-unavailable');
            return { fields, warnings };
        }
        fields.status = 'fresh';
        fields.exact = text.slice(0, maxBytes);
        return { fields, warnings };
    }
    if (parsed.kind === 'session') {
        fields.title = 'session ' + parsed.sessionId.slice(0, 12);
        fields.visibility = 'session';
        if (options.content === undefined) {
            fields.status = 'unknown';
            warnings.push('content-index-unavailable');
            return { fields, warnings };
        }
        const allowed = options.content.authorizedSessionIds(caller.cwd, caller.sessionId);
        if (!allowed.has(parsed.sessionId)) {
            fields.status = 'unknown';
            warnings.push('ref-not-authorized');
            return { fields, warnings };
        }
        fields.status = options.content.sessionIndexedMtime(parsed.sessionId) === undefined ? 'unknown' : 'fresh';
        fields.checkedAt = observedAt;
        return { fields, warnings };
    }
    if (parsed.kind === 'spill') {
        fields.title = base.label;
        fields.fallback = parsed.path;
        fields.visibility = 'session';
        if (options.content === undefined) {
            fields.status = 'unknown';
            warnings.push('content-index-unavailable');
            return { fields, warnings };
        }
        const occurrences = authorizedOccurrences(options.content, parsed.ref, caller.cwd, caller.sessionId);
        if (occurrences.length === 0) {
            fields.status = 'unknown';
            warnings.push('ref-not-authorized');
            return { fields, warnings };
        }
        fields.checkedAt = observedAt;
        let exists = false;
        try {
            exists = statSync(parsed.path).isFile();
        }
        catch {
            exists = false;
        }
        if (!exists) {
            fields.status = 'missing';
            warnings.push('spill-file-missing');
            return { fields, warnings };
        }
        fields.status = 'fresh';
        const first = firstLineExcerpt(parsed.path, maxBytes);
        if (first !== undefined) {
            fields.exact = first.text;
            fields.offsets = { charStart: first.charStart, charEnd: first.charEnd };
        }
        return { fields, warnings };
    }
    fields.title = base.label;
    fields.visibility = 'session';
    if (options.content === undefined) {
        fields.status = 'unknown';
        warnings.push('content-index-unavailable');
        return { fields, warnings };
    }
    const occurrences = authorizedOccurrences(options.content, parsed.ref, caller.cwd, caller.sessionId);
    if (occurrences.length === 0) {
        fields.status = 'unknown';
        warnings.push('ref-not-authorized');
        return { fields, warnings };
    }
    const storedTitle = occurrences[0]?.title;
    if (typeof storedTitle === 'string' && storedTitle !== '')
        fields.title = storedTitle;
    fields.checkedAt = observedAt;
    const found = attachmentCandidates(parsed.sha256).find(candidate => existsSync(candidate.path));
    if (found === undefined) {
        fields.status = 'missing';
        warnings.push('attachment-missing');
        return { fields, warnings };
    }
    fields.status = 'fresh';
    fields.fallback = found.path;
    if (found.kind === 'file') {
        const first = firstLineExcerpt(found.path, maxBytes);
        if (first !== undefined) {
            fields.exact = first.text;
            fields.offsets = { charStart: first.charStart, charEnd: first.charEnd };
        }
    }
    return { fields, warnings };
}
/** Build the locator_cite tool. */
export function makeCiteTool(options = {}) {
    return defineTool({
        name: 'locator_cite',
        description: [
            'Render citations for dsh-locator evidence refs. Use it when the answer must point at a file or a session message with a stable reference instead of a bare path.',
            '',
            'Formats: markdown (default, [label](ref); session refs render as host mention syntax), mention (session refs only), json (structured entries).',
            '',
            'Pass detail: "exact" when the citation itself must carry the evidence: every entry then also reports title, the verbatim exact text (the cited file line, or the session-event text), offsets {line,charStart,charEnd} when known, checkedAt, status, visibility and a fallback HTTPS URL or absolute path. Markdown output quotes the exact text as a blockquote followed by the fallback link.',
        ].join('\n'),
        parameters: {
            refs: { type: 'array', items: { type: 'string' }, required: true, description: 'Up to 20 ref strings from locator_find/locator_search/locator_resolve.' },
            format: { type: 'string', enum: ['markdown', 'json', 'mention'], description: 'Citation format (default markdown).' },
            detail: { type: 'string', enum: ['exact', 'compact'], description: 'compact (default) preserves the short citation; exact adds verbatim evidence, offsets, status, visibility and fallback.' },
            maxBytes: { type: 'integer', description: 'Exact-text cap per citation in bytes (default 2048, at most 65536).' },
        },
        output: {
            schema: CITE_OUTPUT,
            render: (_args, value) => {
                const v = value;
                if (!v.ok) {
                    const detail = v.warnings !== undefined && v.warnings.length > 0 ? ' (' + v.warnings.join(', ') + ')' : '';
                    return [{ type: 'text', text: 'locator_cite failed: ' + (v.error ?? 'unknown error') + detail }];
                }
                return [{ type: 'text', text: (v.citations ?? []).map(citation => citation.markdown ?? citation.ref ?? '').join('\n') }];
            },
        },
        async execute(args, exec) {
            const format = args.format === 'mention' ? 'mention' : args.format === 'json' ? 'json' : 'markdown';
            const detail = args.detail === 'exact' ? 'exact' : 'compact';
            const maxBytes = Math.max(1, Math.min(65536, Math.trunc(args.maxBytes ?? 2048)));
            const refs = Array.isArray(args.refs) ? args.refs.filter((ref) => typeof ref === 'string' && ref.trim() !== '').slice(0, 20) : [];
            if (refs.length === 0)
                return { ok: false, format, citations: [], error: 'refs is empty' };
            const observedAt = Date.now();
            const caller = callerOf(exec);
            const warnings = [];
            const citations = [];
            for (const raw of refs) {
                const parsed = parseRef(raw.trim());
                if (parsed === undefined)
                    return { ok: false, format, citations: [], error: 'invalid-ref: ' + raw.slice(0, 80) };
                const base = compactCitation(parsed);
                if (detail === 'compact') {
                    citations.push(base);
                    continue;
                }
                const enriched = await citationDetail(parsed, base, observedAt, maxBytes, options, caller);
                for (const warning of enriched.warnings)
                    warnings.push(warning);
                const markdown = renderCitationMarkdown(base, enriched.fields);
                citations.push({ ...base, ...enriched.fields, markdown });
            }
            return {
                ok: true,
                format,
                citations,
                ...(warnings.length === 0 ? {} : { warnings }),
            };
        },
    });
}
/** Build a URL ref from one raw URL (used by future indexing work and tests). */
export function buildUrlRef(raw) {
    return urlRef(raw);
}
/** Decode a session ref back to its id (exported for tests/other modules). */
export function sessionIdOf(ref) {
    return decodeSessionRef(ref);
}
//# sourceMappingURL=ref-tools.js.map