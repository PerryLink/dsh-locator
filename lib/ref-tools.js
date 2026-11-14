/**
 * `locator_resolve` and `locator_cite`: turn refs into metadata/excerpts and
 * human/agent-readable citations. These tools never return content the caller
 * is not authorized to read (session refs follow the same workspace rule as
 * `locator_find`; file refs must stay inside the configured roots).
 * @module dsh-locator/ref-tools
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { decodeSessionRef, freshnessFor, normalizeUrl, parseRef, sha256File, urlRef } from "./refs.js";
import { resolveWithinRoots } from "./reveal.js";
/** Read at most `maxBytes` from the head of one file (text excerpt helper). */
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
const RESOLVE_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true },
        ref: { type: 'string' },
        kind: { type: 'string', enum: ['file', 'session', 'url'] },
        hash: { type: 'string' },
        size: { type: 'integer' },
        title: { type: 'string' },
        excerpt: { type: 'string' },
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
const CITE_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true },
        format: { type: 'string', enum: ['markdown', 'json', 'mention'] },
        citations: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ref: { type: 'string' },
                    kind: { type: 'string', enum: ['file', 'session', 'url'] },
                    label: { type: 'string' },
                    markdown: { type: 'string' },
                    mention: { type: 'string' },
                },
            },
        },
        error: { type: 'string' },
    },
};
/** Build the locator_resolve tool. */
export function makeResolveTool(rt, content) {
    return defineTool({
        name: 'locator_resolve',
        description: [
            'Resolve one dsh-locator evidence ref into its metadata (provenance, hash, freshness, permissions) and, optionally, a bounded excerpt.',
            '',
            'Refs come from `locator_find`/`locator_search` hits: `dsh-session:` URIs for session messages and `ref://file?...` for files. Session refs are only resolvable for the caller session and sessions whose immutable cwd equals the caller cwd; file refs must stay inside the configured index roots.',
            '',
            'Use it to verify that a citation is still fresh, or to quote a bounded excerpt instead of re-reading a whole file.',
        ].join('\n'),
        parameters: {
            ref: { type: 'string', required: true, description: 'Ref string from a hit (dsh-session: URI or ref://file?...).' },
            mode: { type: 'string', enum: ['meta', 'excerpt'], description: 'meta (default) returns metadata only; excerpt also returns a bounded head of the content.' },
            maxBytes: { type: 'integer', description: 'Excerpt size cap in bytes (default 2048, at most 65536).' },
            messageId: { type: 'string', description: 'For session refs: the message id to excerpt (optional).' },
        },
        output: {
            schema: RESOLVE_OUTPUT,
            render: (_args, value) => {
                const v = value;
                if (!v.ok)
                    return [{ type: 'text', text: `locator_resolve failed: ${v.error ?? 'unknown error'}${v.warnings === undefined || v.warnings.length === 0 ? '' : ` (${v.warnings.join(', ')})`}` }];
                const parts = [`locator_resolve ${v.kind ?? 'ref'} ${v.ref ?? ''}`];
                if (v.title !== undefined)
                    parts.push(`title: ${v.title}`);
                if (v.size !== undefined)
                    parts.push(`size: ${String(v.size)}`);
                if (v.hash !== undefined)
                    parts.push(`sha256: ${v.hash}`);
                if (v.freshness?.state !== undefined)
                    parts.push(`freshness: ${v.freshness.state}`);
                if (v.permissions?.visibility !== undefined)
                    parts.push(`visibility: ${v.permissions.visibility}`);
                const head = parts.join(' · ');
                return [{ type: 'text', text: v.excerpt === undefined ? head : `${head}\n---\n${v.excerpt}` }];
            },
        },
        async execute(args, exec) {
            const observedAt = Date.now();
            const parsed = parseRef(args.ref.trim());
            if (parsed === undefined)
                return { ok: false, error: 'invalid-ref', warnings: ['unsupported-or-malformed-ref'] };
            const mode = args.mode === 'excerpt' ? 'excerpt' : 'meta';
            const maxBytes = Math.max(1, Math.min(65536, Math.trunc(args.maxBytes ?? 2048)));
            const callerSessionId = exec?.agent?.session?.id;
            const callerCwd = exec?.agent?.session?.header?.cwd;
            if (parsed.kind === 'session') {
                if (content === undefined)
                    return { ok: false, ref: parsed.ref, kind: 'session', error: 'content-index-unavailable' };
                const allowed = content.authorizedSessionIds(callerCwd, callerSessionId);
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
                const provenance = { origin: 'index', sessionId: parsed.sessionId, ...(messageId === undefined ? {} : { messageId }), ...(indexedAt === undefined ? {} : { indexedAt }) };
                return {
                    ok: true,
                    ref: parsed.ref,
                    kind: 'session',
                    title: `session ${parsed.sessionId.slice(0, 12)}`,
                    ...(body === undefined ? {} : { size: body.length }),
                    provenance,
                    freshness: freshnessFor(indexedAt, indexedAt, observedAt),
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
                let currentMtime;
                let size;
                try {
                    const info = statSync(authorized.path);
                    currentMtime = info.mtimeMs;
                    size = info.size;
                }
                catch {
                    currentMtime = undefined;
                }
                if (currentMtime === undefined) {
                    return {
                        ok: true,
                        ref: parsed.ref,
                        kind: 'file',
                        title: basename(authorized.path),
                        provenance: { origin: 'index', path: authorized.path },
                        freshness: freshnessFor(undefined, undefined, observedAt),
                        permissions: { read: 'allowed', visibility: 'roots', reason: 'path is inside the configured roots' },
                        warnings: ['file-missing'],
                    };
                }
                const indexedAt = content?.indexedMtime('file', authorized.path);
                const hash = await sha256File(authorized.path);
                const excerpt = mode === 'excerpt' ? readHead(authorized.path, maxBytes) : undefined;
                return {
                    ok: true,
                    ref: parsed.ref,
                    kind: 'file',
                    title: basename(authorized.path),
                    ...(size === undefined ? {} : { size }),
                    ...(hash === null ? {} : { hash }),
                    provenance: { origin: 'index', path: authorized.path, ...(indexedAt === undefined ? {} : { indexedAt }) },
                    freshness: freshnessFor(indexedAt, currentMtime, observedAt),
                    permissions: { read: 'allowed', visibility: 'roots', reason: 'path is inside the configured roots' },
                    ...(excerpt === undefined ? {} : { excerpt }),
                };
            }
            // URL refs are metadata only: resolving them does not fetch the network.
            const normalized = normalizeUrl(parsed.url);
            return {
                ok: true,
                ref: parsed.ref,
                kind: 'url',
                title: normalized,
                provenance: { origin: 'web', url: normalized },
                freshness: { state: 'unknown', observedAt },
                permissions: { read: 'allowed', visibility: 'external', reason: 'external URL metadata; no network read' },
                warnings: ['url-not-fetched'],
            };
        },
    });
}
/** Build the locator_cite tool. */
export function makeCiteTool() {
    return defineTool({
        name: 'locator_cite',
        description: [
            'Render citations for dsh-locator evidence refs. Use it when the answer must point at a file or a session message with a stable reference instead of a bare path.',
            '',
            'Formats: `markdown` (default, `[label](ref)`; session refs render as host mention syntax), `mention` (session refs only), `json` (structured entries).',
        ].join('\n'),
        parameters: {
            refs: { type: 'array', items: { type: 'string' }, required: true, description: 'Up to 20 ref strings from locator_find/locator_search/locator_resolve.' },
            format: { type: 'string', enum: ['markdown', 'json', 'mention'], description: 'Citation format (default markdown).' },
        },
        output: {
            schema: CITE_OUTPUT,
            render: (_args, value) => {
                const v = value;
                if (!v.ok)
                    return [{ type: 'text', text: `locator_cite failed: ${v.error ?? 'unknown error'}` }];
                return [{ type: 'text', text: (v.citations ?? []).map(citation => citation.markdown ?? citation.ref ?? '').join('\n') }];
            },
        },
        async execute(args) {
            const format = args.format === 'mention' ? 'mention' : args.format === 'json' ? 'json' : 'markdown';
            const refs = Array.isArray(args.refs) ? args.refs.filter((ref) => typeof ref === 'string' && ref.trim() !== '').slice(0, 20) : [];
            if (refs.length === 0)
                return { ok: false, format, citations: [], error: 'refs is empty' };
            const citations = [];
            for (const raw of refs) {
                const parsed = parseRef(raw.trim());
                if (parsed === undefined)
                    return { ok: false, format, citations: [], error: `invalid-ref: ${raw.slice(0, 80)}` };
                if (parsed.kind === 'file') {
                    const label = basename(parsed.path) || parsed.path;
                    citations.push({ ref: parsed.ref, kind: 'file', label, markdown: `[${label}](${parsed.ref})` });
                    continue;
                }
                if (parsed.kind === 'url') {
                    const label = parsed.url;
                    citations.push({ ref: parsed.ref, kind: 'url', label, markdown: `[${label}](${parsed.ref})` });
                    continue;
                }
                const label = `session ${parsed.sessionId.slice(0, 12)}`;
                const mention = `@[${label}](${parsed.ref})`;
                citations.push({ ref: parsed.ref, kind: 'session', label, markdown: mention, mention });
            }
            return { ok: true, format, citations };
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