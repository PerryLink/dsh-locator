/**
 * locator_find — search file bodies and DSH session messages.
 * @module dsh-locator/find
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
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
/** Build the locator_find tool. */
export function makeFindTool(content, ensure, roots = []) {
    return defineTool({
        name: 'locator_find',
        description: [
            'Search the **contents** of text files and DSH session messages (dsh-locator).',
            '',
            'Use it when the user remembers a phrase, a sentence, a decision or a code snippet rather than a file name. `locator_search` searches names and paths; this searches bodies and returns snippets plus `sessionId`/`messageId` for session hits, so the result can be opened at its source.',
            '',
            'Content is substring search over an FTS5 trigram index: every term must be at least 3 characters (shorter queries are rejected with `content-query-too-short` instead of scanning the whole corpus). Text files are capped by `contentMaxFileBytes`; session logs are decompressed from `$DSH_HOME/sessions`.',
            '',
            'By default it searches the caller workspace: the current session for session hits and files under the caller cwd when that cwd is inside an indexed root. If the cwd is outside every indexed root, file hits cover the indexed roots (there is no workspace subset to restrict to); pass `scope: "all"` to explicitly search every indexed file/session.',
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
                    return `${String(index + 1)}. [${hit.kind}] ${hit.title ?? ''} — ${hit.snippet ?? ''}\n   ${hit.path ?? ''}${typeof hit.line === 'number' ? ` (line ${String(hit.line)})` : ''}${ref}`;
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
                return [{ type: 'text', text: `${String(v.hits?.length ?? 0)} content hit(s)${count}${notes}\n${lines.join('\n')}` }];
            },
        },
        async execute(args, exec) {
            ensure?.();
            const query = args.query.trim();
            if (query === '')
                return { ok: false, error: 'query is empty' };
            const limit = Math.max(1, Math.min(100, args.limit ?? 30));
            const offset = Math.max(0, Math.trunc(args.offset ?? 0));
            const scope = args.scope === 'all' ? 'all' : 'workspace';
            const callerSessionId = scope === 'workspace' ? exec?.agent?.session?.id : undefined;
            const callerCwd = scope === 'workspace' ? exec?.agent?.session?.header?.cwd : undefined;
            // A cwd outside every configured root has no indexed workspace subset.
            // Restricting file hits to it would return nothing even though the user's
            // indexed files are searchable; omit the path filter in that case.
            const cwdIsIndexed = callerCwd !== undefined && roots.some(root => withinRoots(callerCwd, [root]));
            // When there is a caller session but its cwd is outside every indexed
            // root, there is no workspace file subset: search file bodies across the
            // indexed roots while session hits stay limited to the caller session.
            const fileHitsAllRoots = scope === 'workspace' && callerSessionId !== undefined && !cwdIsIndexed;
            const options = {
                ...(fileHitsAllRoots ? { fileHitsAllRoots: true } : {}),
                // Before the active session settles the session id is not indexed yet;
                // workspace scope must still search file bodies in that window.
                ...(scope === 'workspace' ? { sessionUnavailable: 'files-only' } : {}),
                ...(args.matchMode === undefined ? {} : { matchMode: args.matchMode }),
                ...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive }),
                ...(args.wholeWord === undefined ? {} : { wholeWord: args.wholeWord }),
                ...(args.sessionId !== undefined && args.sessionId !== ''
                    ? { sessionId: args.sessionId }
                    : callerSessionId === undefined ? {} : { sessionId: String(callerSessionId) }),
                ...(args.count === undefined ? {} : { count: args.count }),
                ...(args.countLimit === undefined ? {} : { countLimit: args.countLimit }),
                ...(offset === 0 ? {} : { offset }),
                ...(args.pathPrefix !== undefined && args.pathPrefix !== ''
                    ? { pathPrefix: args.pathPrefix }
                    : !cwdIsIndexed ? {} : { pathPrefix: callerCwd }),
            };
            const result = await content.search(query, limit, options);
            const state = content.status();
            if (result.error !== undefined) {
                return { ok: false, query, offset, error: result.error, warnings: result.warnings, hits: [], state };
            }
            return { ok: true, query, offset, hits: result.hits, count: result.count, warnings: result.warnings, state };
        },
    });
}
//# sourceMappingURL=find.js.map