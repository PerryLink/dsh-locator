/**
 * locator_find — search file bodies and DSH session messages.
 * @module dsh-locator/find
 */
import { stat } from 'node:fs/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { encodeSessionRef, fileRef, freshnessFor, sha256File } from "./refs.js";
import { withinRoots } from "./reveal.js";
const HIT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        kind: { type: 'string', enum: ['file', 'session'], required: true },
        path: { type: 'string', required: true },
        title: { type: 'string' },
        snippet: { type: 'string' },
        sessionId: { type: 'string' },
        messageId: { type: 'string' },
        nodeKey: { type: 'string' },
        line: { type: 'integer', description: '1-based line of the first match in the stored body (file hits).' },
        score: { type: 'number' },
        ref: { type: 'string', description: 'Citable evidence reference: dsh-session: URI for session hits, ref://file for file hits.' },
        hash: { type: 'string', description: 'sha256 of the file bytes when cheap to compute (files up to 2 MiB).' },
        provenance: {
            type: 'object',
            additionalProperties: false,
            properties: {
                origin: { type: 'string', enum: ['index', 'tool', 'session', 'web'] },
                path: { type: 'string' },
                sessionId: { type: 'string' },
                messageId: { type: 'string' },
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
    },
};
/**
 * Content-index state shared by the `locator_find` and `locator_status` output
 * schemas. Keep it in sync with `ContentState`: the host validates every tool
 * result against the declared schema and rejects undeclared fields, so a state
 * field missing here makes the whole tool call fail as "invalid output".
 */
export const CONTENT_STATE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        building: { type: 'boolean' },
        files: { type: 'integer' },
        sessions: { type: 'integer' },
        messages: { type: 'integer' },
        truncated: { type: 'boolean' },
        updatedAt: { type: 'integer' },
        error: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' }, description: 'Non-fatal build problems, e.g. an unreadable session log.' },
        fullIndex: { type: 'boolean' },
        reasoningIndex: { type: 'boolean' },
        toolResultsIndex: { type: 'boolean' },
        progress: {
            type: 'object',
            additionalProperties: false,
            properties: {
                phase: { type: 'string' },
                scanned: { type: 'integer' },
                indexed: { type: 'integer' },
                total: { type: 'integer' },
                path: { type: 'string' },
                startedAt: { type: 'integer' },
            },
        },
    },
};
/**
 * Attach citable evidence metadata to content hits. Hashing is capped per file
 * so a tool call cannot read a huge artifact just to label a hit.
 */
async function enrichHits(hits, content, callerCwd) {
    const visibility = callerCwd === undefined ? 'roots' : 'workspace';
    return await Promise.all(hits.map(async (hit) => {
        const observedAt = Date.now();
        if (hit.kind === 'session' && hit.sessionId !== undefined) {
            const indexedAt = content.indexedMtime('session', hit.path, hit.messageId);
            let currentMtime;
            try {
                currentMtime = (await stat(hit.path)).mtimeMs;
            }
            catch {
                currentMtime = undefined;
            }
            return {
                ...hit,
                ref: encodeSessionRef(hit.sessionId),
                provenance: { origin: 'index', sessionId: hit.sessionId, ...(hit.messageId === undefined ? {} : { messageId: hit.messageId }), ...(indexedAt === undefined ? {} : { indexedAt }) },
                freshness: freshnessFor(indexedAt, currentMtime, observedAt),
                permissions: { read: 'allowed', visibility: 'session', reason: 'session messages are scoped to the caller workspace' },
            };
        }
        const indexedAt = content.indexedMtime('file', hit.path);
        let currentMtime;
        let size;
        try {
            const info = await stat(hit.path);
            currentMtime = info.mtimeMs;
            size = info.size;
        }
        catch {
            currentMtime = undefined;
        }
        const hash = currentMtime === undefined ? null : await sha256File(hit.path, 2 * 1024 * 1024);
        const refInput = { path: hit.path };
        if (currentMtime !== undefined)
            refInput.mtime = currentMtime;
        if (size !== undefined)
            refInput.size = size;
        if (hash !== null)
            refInput.sha256 = hash;
        return {
            ...hit,
            ref: fileRef(refInput),
            ...(hash === null ? {} : { hash }),
            provenance: { origin: 'index', path: hit.path, ...(indexedAt === undefined ? {} : { indexedAt }) },
            freshness: freshnessFor(indexedAt, currentMtime, observedAt),
            permissions: { read: 'allowed', visibility, reason: 'file hits come from the configured index roots' },
        };
    }));
}
/** Build the locator_find tool. */
export function makeFindTool(content, ensure, roots = [], allowCrossWorkspaceSessions = false) {
    return defineTool({
        name: 'locator_find',
        description: [
            'Search the **contents** of text files and DSH session messages (dsh-locator).',
            '',
            'Use it when the user remembers a phrase, a sentence, a decision or a code snippet rather than a file name. `locator_search` searches names and paths; this searches bodies and returns snippets plus `sessionId`/`messageId` for session hits, so the result can be opened at its source.',
            '',
            'Content is substring search over an FTS5 trigram index: every term must be at least 3 characters (shorter queries are rejected with `content-query-too-short` instead of scanning the whole corpus). Text files are capped by `contentMaxFileBytes`; session logs are decompressed from `$DSH_HOME/sessions`.',
            '',
            'By default it searches the caller workspace: the current session for session hits and files under the caller cwd when that cwd is inside an indexed root. If the cwd is outside every indexed root, file hits cover the indexed roots (there is no workspace subset to restrict to); pass `scope: "all"` to search every indexed file (session hits still stay limited to the caller workspace unless the operator enables cross-workspace session reads). Every hit carries a citable `ref` plus provenance, hash and freshness metadata.',
        ].join('\n'),
        parameters: {
            query: { type: 'string', required: true, description: 'Words or a phrase to find in file/session content.' },
            limit: { type: 'integer', description: 'Maximum hits (default 30, at most 100).' },
            offset: { type: 'integer', description: 'Skip this many ranked hits (pagination).' },
            matchMode: { type: 'string', enum: ['normal', 'extended'], description: 'normal: whitespace-separated substring terms. extended: one literal phrase with Notepad++ escapes (\\n, \\r, \\t, \\0, \\xNN, \\\\).' },
            caseSensitive: { type: 'boolean', description: 'Match letter case exactly.' },
            wholeWord: { type: 'boolean', description: 'Only match whole words ([A-Za-z0-9_] boundaries; CJK counts as non-word).' },
            sessionId: { type: 'string', description: 'Only search messages of one DSH session id (defaults to the caller session in workspace scope).' },
            scope: { type: 'string', enum: ['workspace', 'all'], description: 'workspace (default) restricts file hits to the caller workspace/cwd and session hits to the caller session; all searches every indexed file and session (explicit cross-workspace access).' },
            count: { type: 'string', enum: ['exact', 'bounded', 'none'], description: 'How much counting work to spend; bounded stops at countLimit.' },
            countLimit: { type: 'integer', description: 'Counting cap for bounded counts (default 1000, at most 5000).' },
            pathPrefix: { type: 'string', description: 'Only return file hits whose path starts with this directory (session hits are unaffected).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    query: { type: 'string' },
                    offset: { type: 'integer' },
                    hits: { type: 'array', items: HIT },
                    count: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            value: { type: 'integer' },
                            kind: { type: 'string', enum: ['exact', 'bounded', 'unknown'] },
                            limit: { type: 'integer' },
                        },
                    },
                    warnings: { type: 'array', items: { type: 'string' } },
                    state: CONTENT_STATE_SCHEMA,
                    scope: { type: 'string', enum: ['workspace', 'all'] },
                    scopeFallback: { type: 'string' },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                const v = value;
                if (!v.ok) {
                    const detail = v.warnings !== undefined && v.warnings.length > 0 ? ` (${[...new Set(v.warnings)].join(', ')})` : '';
                    return [{ type: 'text', text: `locator_find failed: ${v.error ?? 'unknown'}${detail}` }];
                }
                const lines = (v.hits ?? []).map((hit, index) => {
                    const ref = hit.kind === 'session' && (hit.sessionId !== undefined || hit.messageId !== undefined)
                        ? `\n   session ${String(hit.sessionId ?? '')}${hit.messageId === undefined ? '' : ` message ${String(hit.messageId)}`}`
                        : '';
                    const evidence = hit.ref === undefined ? '' : `\n   ref ${hit.ref}${hit.freshness?.state === undefined ? '' : ` (${hit.freshness.state})`}`;
                    return `${String(index + 1)}. [${hit.kind}] ${hit.title ?? ''} — ${hit.snippet ?? ''}\n   ${hit.path ?? ''}${typeof hit.line === 'number' ? ` (line ${String(hit.line)})` : ''}${ref}${evidence}`;
                });
                const count = v.count === undefined
                    ? ''
                    : v.count.kind === 'bounded'
                        ? `, count ≥ ${String(v.count.value)}`
                        : v.count.kind === 'exact'
                            ? `, count ${String(v.count.value)}`
                            : '';
                const warnings = [...new Set([...(v.warnings ?? []), ...(v.state?.warnings ?? [])])];
                const notes = [
                    v.state?.building ? ' (index still building)' : '',
                    v.state?.truncated === true ? ' (content budget reached: raise contentMaxTotalBytes or trim contentExcludes; later files are not searchable)' : '',
                    warnings.length > 0 ? ` (warnings: ${warnings.join(', ')})` : '',
                ].join('');
                const scopeNote = v.scope === undefined ? '' : ` (scope: ${v.scope}${v.scopeFallback === undefined ? '' : `; ${v.scopeFallback}`})`;
                return [{ type: 'text', text: `${String(v.hits?.length ?? 0)} content hit(s)${count}${scopeNote}${notes}\n${lines.join('\n')}` }];
            },
        },
        async execute(args, exec) {
            ensure?.();
            const query = args.query.trim();
            const state = content.status();
            if (query === '')
                return { ok: false, error: 'query is empty' };
            const limit = Math.max(1, Math.min(100, args.limit ?? 30));
            const offset = Math.max(0, Math.trunc(args.offset ?? 0));
            const scope = args.scope === 'all' ? 'all' : 'workspace';
            // Caller identity is needed for every scope: `all` must not turn into
            // "read every session in the index" for an authenticated agent.
            const callerSessionId = exec?.agent?.session?.id;
            const callerCwd = exec?.agent?.session?.header?.cwd;
            const requestedSessionId = typeof args.sessionId === 'string' && args.sessionId.trim() !== '' ? args.sessionId.trim() : undefined;
            const allowedSessions = content.authorizedSessionIds(callerCwd, callerSessionId);
            if (requestedSessionId !== undefined && !allowedSessions.has(requestedSessionId)) {
                return {
                    ok: false,
                    query,
                    offset,
                    error: 'content-scope-denied',
                    warnings: ['session-not-authorized'],
                    hits: [],
                    state,
                };
            }
            if (args.pathPrefix !== undefined && args.pathPrefix !== '') {
                if (!roots.some(root => withinRoots(args.pathPrefix, [root]))) {
                    return { ok: false, query, offset, error: 'content-path-denied', warnings: ['path-outside-roots'], hits: [], state };
                }
            }
            // A cwd outside every configured root has no indexed workspace subset.
            const cwdIsIndexed = callerCwd !== undefined && roots.some(root => withinRoots(callerCwd, [root]));
            const fileHitsAllRoots = callerSessionId !== undefined && !cwdIsIndexed;
            const sessionFilter = requestedSessionId ?? (scope === 'workspace' ? callerSessionId : undefined);
            // `scope: "all"` keeps every file searchable but sessions stay limited to
            // the caller's authorized set unless the operator opts into cross-workspace
            // session reads.
            const restrictSessions = scope === 'all' && !allowCrossWorkspaceSessions && callerSessionId !== undefined;
            const options = {
                ...(fileHitsAllRoots ? { fileHitsAllRoots: true } : {}),
                // Before the active session settles the session id is not indexed yet;
                // workspace scope must still search file bodies in that window.
                ...(scope === 'workspace' || requestedSessionId !== undefined ? { sessionUnavailable: 'files-only' } : {}),
                ...(args.matchMode === undefined ? {} : { matchMode: args.matchMode }),
                ...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive }),
                ...(args.wholeWord === undefined ? {} : { wholeWord: args.wholeWord }),
                ...(sessionFilter === undefined ? {} : { sessionId: sessionFilter }),
                ...(restrictSessions ? { allowedSessionIds: [...allowedSessions] } : {}),
                ...(args.count === undefined ? {} : { count: args.count }),
                ...(args.countLimit === undefined ? {} : { countLimit: args.countLimit }),
                ...(offset === 0 ? {} : { offset }),
                ...(args.pathPrefix !== undefined && args.pathPrefix !== ''
                    ? { pathPrefix: args.pathPrefix }
                    : !cwdIsIndexed || scope === 'all' ? {} : { pathPrefix: callerCwd }),
            };
            const result = await content.search(query, limit, options);
            if (result.error !== undefined) {
                return { ok: false, query, offset, error: result.error, warnings: result.warnings, hits: [], state };
            }
            const hits = await enrichHits(result.hits, content, callerCwd);
            return {
                ok: true,
                query,
                offset,
                hits,
                count: result.count,
                warnings: result.warnings,
                state,
                scope: scope,
                ...(scope === 'workspace' && callerSessionId !== undefined && !cwdIsIndexed ? { scopeFallback: 'cwd-not-indexed; files searched across configured roots' } : {}),
            };
        },
    });
}
//# sourceMappingURL=find.js.map