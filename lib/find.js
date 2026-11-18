/**
 * locator_find — search file bodies and DSH session messages.
 * @module dsh-locator/find
 */
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { encodeSessionRef, fileRef, freshnessFor, sha256File } from "./refs.js";
import { withinRoots } from "./reveal.js";
import { applyOutputBudget, rerankHits } from "./scope.js";
const HIT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        kind: { type: 'string', enum: ['file', 'session', 'dir'], required: true },
        path: { type: 'string', required: true },
        name: { type: 'string', description: 'Base name for name-index hits (mode names).' },
        title: { type: 'string' },
        snippet: { type: 'string' },
        sessionId: { type: 'string' },
        messageId: { type: 'string' },
        nodeKey: { type: 'string' },
        line: { type: 'integer', description: '1-based line of the first match in the stored body (file hits).' },
        score: { type: 'number' },
        size: { type: 'integer', description: 'File size in bytes when known (name hits).' },
        mtime: { type: 'integer', description: 'Modification time in Unix milliseconds when known (name hits).' },
        dir: { type: 'boolean', description: 'True for a directory hit (name mode).' },
        context: { type: 'array', items: { type: 'string' }, description: 'Lines around the hit line, when contextLines > 0.' },
        contextStart: { type: 'integer', description: '1-based line number of context[0].' },
        format: { type: 'string', description: 'Extracted document format (pdf, docx, xlsx, pptx, epub) for file hits whose body came from a document.' },
        ref: { type: 'string', description: 'Citable evidence reference: dsh-session: URI for session hits, ref://file for file hits.' },
        seq: { type: 'integer', description: 'Session event sequence of this message when the content index stored a session-event ref for it.' },
        eventRef: { type: 'string', description: 'Full ref://session-event?sid=...&seq=N evidence reference for the indexed event, when one was stored.' },
        hash: { type: 'string', description: 'sha256 of the file bytes when cheap to compute (files up to 2 MiB).' },
        refStatus: {
            type: 'string',
            enum: ['fresh', 'stale', 'missing', 'unknown'],
            description: 'Short freshness label for the evidence ref (same value as freshness.state).',
        },
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
/** The additive locator_find hit schema, shared with locator_search mode content. */
export const CONTENT_HIT_SCHEMA = HIT;
/** The additive per-result budget block (see scope.ts applyOutputBudget). */
export const BUDGET_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        limitChars: { type: 'integer', description: 'Configured soft cap in characters (0 = disabled).' },
        usedChars: { type: 'integer', description: 'Characters of the JSON payload actually returned.' },
        truncated: { type: 'boolean', description: 'True when at least one hit was dropped to satisfy the cap.' },
        dropped: { type: 'integer', description: 'Hits dropped by the budget.' },
    },
};
/**
 * Content-index state shared by the locator_find and locator_status output
 * schemas. Keep it in sync with ContentState: the host validates every tool
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
        refs: {
            type: 'object',
            additionalProperties: false,
            properties: {
                total: { type: 'integer', description: 'Distinct evidence ref identities stored in the content index.' },
                byKind: { type: 'object', additionalProperties: true, description: 'Distinct ref identities per kind (url, session-event, spill, attachment).' },
            },
        },
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
/** Files bigger than this are never re-read just to add context lines. */
const CONTEXT_MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Upper bound for the contextLines argument; keeps one hit a few KB at most. */
export const CONTEXT_MAX_LINES = 10;
/**
 * Attach citable evidence metadata to content hits. Hashing is capped per file
 * so a tool call cannot read a huge artifact just to label a hit.
 */
export async function enrichContentHits(hits, content, callerCwd) {
    const visibility = callerCwd === undefined ? 'roots' : 'workspace';
    // One query per involved session attaches the event seq/ref that the same
    // content build stored for each indexed message. Older/embedder fakes may not
    // implement the lookup; those hits simply keep their canonical session ref.
    const eventRefsBySession = new Map();
    if (typeof content.sessionEventRefs === 'function') {
        const idsBySession = new Map();
        for (const hit of hits) {
            if (hit.kind !== 'session' || hit.sessionId === undefined || hit.messageId === undefined)
                continue;
            const ids = idsBySession.get(hit.sessionId);
            if (ids === undefined)
                idsBySession.set(hit.sessionId, [hit.messageId]);
            else
                ids.push(hit.messageId);
        }
        for (const [sessionId, messageIds] of idsBySession) {
            eventRefsBySession.set(sessionId, content.sessionEventRefs(sessionId, messageIds));
        }
    }
    return await Promise.all(hits.map(async (hit) => {
        const observedAt = Date.now();
        if (hit.kind === 'session' && hit.sessionId !== undefined) {
            // The output schema declares indexedAt as an integer; derived/SQLite ages
            // can be fractional, so truncate here like ref-tools.ts does.
            const indexedAtRaw = content.indexedMtime('session', hit.path, hit.messageId);
            const indexedAt = indexedAtRaw === undefined ? undefined : Math.trunc(indexedAtRaw);
            let currentMtime;
            try {
                currentMtime = (await stat(hit.path)).mtimeMs;
            }
            catch {
                currentMtime = undefined;
            }
            const event = hit.messageId === undefined ? undefined : eventRefsBySession.get(hit.sessionId)?.get(hit.messageId);
            const freshness = freshnessFor(indexedAt, currentMtime, observedAt);
            return {
                ...hit,
                ...(event === undefined ? {} : { seq: event.seq, eventRef: event.ref }),
                ref: encodeSessionRef(hit.sessionId),
                provenance: { origin: 'index', sessionId: hit.sessionId, ...(hit.messageId === undefined ? {} : { messageId: hit.messageId }), ...(indexedAt === undefined ? {} : { indexedAt }) },
                freshness,
                permissions: { read: 'allowed', visibility: 'session', reason: 'session messages are scoped to the caller workspace' },
                refStatus: freshness.state,
            };
        }
        const indexedAtRaw = content.indexedMtime('file', hit.path);
        const indexedAt = indexedAtRaw === undefined ? undefined : Math.trunc(indexedAtRaw);
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
        // Carry the hit line into the ref so locator_cite detail mode can quote the
        // exact matched source line instead of the file head.
        if (typeof hit.line === 'number' && hit.line > 0)
            refInput.line = hit.line;
        const freshness = freshnessFor(indexedAt, currentMtime, observedAt);
        return {
            ...hit,
            ref: fileRef(refInput),
            ...(hash === null ? {} : { hash }),
            provenance: { origin: 'index', path: hit.path, ...(indexedAt === undefined ? {} : { indexedAt }) },
            freshness,
            permissions: { read: 'allowed', visibility, reason: 'file hits come from the configured index roots' },
            refStatus: freshness.state,
        };
    }));
}
/**
 * Run one content query with the same workspace/session authorization
 * locator_find always applied. Extracted so locator_search mode "content" can
 * reuse the exact rules instead of duplicating them.
 */
export async function runContentSearchRequest(content, request, roots, allowCrossWorkspaceSessions, caller = {}) {
    const state = content.status();
    const query = request.query.trim();
    const offset = request.offset;
    const scope = request.scope;
    // Caller identity is needed for every scope: "all" must not turn into
    // "read every session in the index" for an authenticated agent.
    const callerSessionId = caller.sessionId;
    const callerCwd = caller.cwd;
    const requestedSessionId = typeof request.sessionId === 'string' && request.sessionId.trim() !== '' ? request.sessionId.trim() : undefined;
    const allowedSessions = content.authorizedSessionIds(callerCwd, callerSessionId);
    if (requestedSessionId !== undefined && !allowedSessions.has(requestedSessionId)) {
        return {
            ok: false,
            error: 'content-scope-denied',
            warnings: ['session-not-authorized'],
            hits: [],
            state,
            scope,
        };
    }
    if (request.pathPrefix !== undefined && request.pathPrefix !== '') {
        if (!roots.some(root => withinRoots(request.pathPrefix, [root]))) {
            return { ok: false, error: 'content-path-denied', warnings: ['path-outside-roots'], hits: [], state, scope };
        }
    }
    // A cwd outside every configured root has no indexed workspace subset.
    const cwdIsIndexed = callerCwd !== undefined && roots.some(root => withinRoots(callerCwd, [root]));
    const fileHitsAllRoots = callerSessionId !== undefined && !cwdIsIndexed;
    const sessionFilter = requestedSessionId ?? (scope === 'workspace' ? callerSessionId : undefined);
    // scope "all" keeps every file searchable but sessions stay limited to the
    // caller's authorized set unless the operator opts into cross-workspace reads.
    const restrictSessions = scope === 'all' && !allowCrossWorkspaceSessions && callerSessionId !== undefined;
    const options = {
        ...(fileHitsAllRoots ? { fileHitsAllRoots: true } : {}),
        // Before the active session settles the session id is not indexed yet;
        // workspace scope must still search file bodies in that window.
        ...(scope === 'workspace' || requestedSessionId !== undefined ? { sessionUnavailable: 'files-only' } : {}),
        ...(request.matchMode === undefined ? {} : { matchMode: request.matchMode }),
        ...(request.caseSensitive === undefined ? {} : { caseSensitive: request.caseSensitive }),
        ...(request.wholeWord === undefined ? {} : { wholeWord: request.wholeWord }),
        ...(sessionFilter === undefined ? {} : { sessionId: sessionFilter }),
        ...(restrictSessions ? { allowedSessionIds: [...allowedSessions] } : {}),
        ...(request.count === undefined ? {} : { count: request.count }),
        ...(request.countLimit === undefined ? {} : { countLimit: request.countLimit }),
        ...(request.filesOnly === true ? { excludeSessions: true } : {}),
        ...(offset === 0 ? {} : { offset }),
        ...(request.pathPrefix !== undefined && request.pathPrefix !== ''
            ? { pathPrefix: request.pathPrefix }
            : !cwdIsIndexed || scope === 'all' ? {} : { pathPrefix: callerCwd }),
    };
    const result = await content.search(query, request.limit, options);
    if (result.error !== undefined) {
        return { ok: false, error: result.error, warnings: result.warnings, hits: [], state, scope };
    }
    const hits = await enrichContentHits(result.hits, content, callerCwd);
    return {
        ok: true,
        hits,
        count: result.count,
        warnings: result.warnings,
        state,
        scope,
        ...(scope === 'workspace' && callerSessionId !== undefined && !cwdIsIndexed ? { scopeFallback: 'cwd-not-indexed; files searched across configured roots' } : {}),
    };
}
/**
 * Read a bounded window of lines around one hit line. Files that are missing,
 * non-text-sized or unreadable simply get no context; context is an additive
 * convenience, never a reason to fail the query.
 */
export async function readContextLines(path, line, contextLines) {
    if (contextLines <= 0 || !Number.isFinite(line) || line < 1)
        return undefined;
    const window = Math.min(CONTEXT_MAX_LINES, Math.trunc(contextLines));
    try {
        const info = await stat(path);
        if (!info.isFile() || info.size > CONTEXT_MAX_FILE_BYTES)
            return undefined;
        const text = await readFile(path, 'utf8');
        const all = text.split('\n');
        const center = Math.min(all.length, Math.trunc(line));
        const start = Math.max(1, center - window);
        const end = Math.min(all.length, center + window);
        return {
            start,
            lines: all.slice(start - 1, end).map(contextLine => contextLine.replace(/\r$/, '')),
        };
    }
    catch {
        return undefined;
    }
}
/** Parse one mode argument, defaulting to "content". */
export function parseFindMode(value) {
    return value === 'names' || value === 'count' ? value : 'content';
}
/** Build the locator_find tool. */
export function makeFindTool(content, ensure, roots = [], allowCrossWorkspaceSessions = false, options = {}) {
    const modeLimit = options.rt === undefined ? 100 : Math.max(1, Math.trunc(options.rt.config.maxResults));
    return defineTool({
        name: 'locator_find',
        description: [
            'Search the **contents** of text files and DSH session messages (dsh-locator).',
            '',
            'Use it when the user remembers a phrase, a sentence, a decision or a code snippet rather than a file name. locator_search searches names and paths; this searches bodies and returns snippets plus sessionId/messageId for session hits, so the result can be opened at its source.',
            '',
            'Modes: content (default) searches bodies; names searches the file-name index with the Everything-style query language; count only counts body matches. contextLines adds surrounding source lines to file hits. Every result reports totalCount, truncated, nextOffset and a budget block so a caller can page or narrow instead of guessing.',
            '',
            'Content is substring search over an FTS5 trigram index: every term must be at least 3 characters (shorter queries are rejected with content-query-too-short instead of scanning the whole corpus). Text files are capped by contentMaxFileBytes; session logs are decompressed from $DSH_HOME/sessions.',
            '',
            'By default it searches the caller workspace: the current session for session hits and files under the caller cwd when that cwd is inside an indexed root. If the cwd is outside every indexed root, file hits cover the indexed roots (there is no workspace subset to restrict to); pass scope "all" to search every indexed file (session hits still stay limited to the caller workspace unless the operator enables cross-workspace session reads). Every hit carries a citable ref plus provenance, hash, freshness metadata and a short refStatus.',
        ].join('\n'),
        parameters: {
            query: { type: 'string', required: true, description: 'Words or a phrase to find in file/session content (or a name query in mode names).' },
            mode: { type: 'string', enum: ['names', 'content', 'count'], description: 'content (default) searches bodies; names searches the file-name index; count only returns the match count.' },
            limit: { type: 'integer', description: 'Maximum hits (default 30) for content mode / names mode; clamped to the configured maximum.' },
            headLimit: { type: 'integer', description: 'Explicit page-size cap (alias of limit, min of both is used).' },
            offset: { type: 'integer', description: 'Skip this many ranked hits (pagination). Use nextOffset from the previous page.' },
            contextLines: { type: 'integer', description: 'Lines of surrounding file content to include with file hits (0-10, default 0).' },
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
                    mode: { type: 'string', enum: ['names', 'content', 'count'] },
                    offset: { type: 'integer' },
                    total: { type: 'integer', description: 'Engine name-index total (mode names).' },
                    totalCount: { type: 'integer', description: 'Total matches when the index knows it (engine total or content count).' },
                    indexing: { type: 'boolean', description: 'The name index is still scanning (mode names; results are partial).' },
                    nextOffset: { type: 'integer', description: 'Offset of the next page; absent when this page is the last one.' },
                    truncated: { type: 'boolean', description: 'More hits exist beyond this result (page, scope or budget).' },
                    hits: { type: 'array', items: HIT },
                    budget: BUDGET_SCHEMA,
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
                    const detail = v.warnings !== undefined && v.warnings.length > 0 ? ' (' + [...new Set(v.warnings)].join(', ') + ')' : '';
                    return [{ type: 'text', text: 'locator_find failed: ' + (v.error ?? 'unknown') + detail }];
                }
                const mode = v.mode ?? 'content';
                const lines = (v.hits ?? []).map((hit, index) => {
                    const ref = hit.kind === 'session' && (hit.sessionId !== undefined || hit.messageId !== undefined)
                        ? '\n   session ' + String(hit.sessionId ?? '') + (hit.messageId === undefined ? '' : ' message ' + String(hit.messageId))
                        : '';
                    const evidence = hit.ref === undefined ? '' : '\n   ref ' + hit.ref + (hit.refStatus === undefined ? (hit.freshness?.state === undefined ? '' : ' (' + hit.freshness.state + ')') : ' (' + hit.refStatus + ')');
                    const label = hit.title ?? hit.name ?? basename(hit.path ?? '');
                    const readDenied = hit.permissions?.read === 'denied' ? '\n   read denied by scope rules' : '';
                    const context = hit.context === undefined || hit.context.length === 0
                        ? ''
                        : '\n' + hit.context.map((line, lineIndex) => '   ' + String((hit.contextStart ?? 1) + lineIndex) + ': ' + line).join('\n');
                    return String(index + 1) + '. [' + hit.kind + '] ' + label + ' — ' + (hit.snippet ?? '') + '\n   ' + (hit.path ?? '') + (typeof hit.line === 'number' ? ' (line ' + String(hit.line) + ')' : '') + ref + evidence + readDenied + context;
                });
                const count = v.count === undefined
                    ? ''
                    : v.count.kind === 'bounded'
                        ? ', count ≥ ' + String(v.count.value)
                        : v.count.kind === 'exact'
                            ? ', count ' + String(v.count.value)
                            : '';
                const warnings = [...new Set([...(v.warnings ?? []), ...(v.state?.warnings ?? [])])];
                const notes = [
                    v.state?.building ? ' (index still building)' : '',
                    v.state?.truncated === true ? ' (content budget reached: raise contentMaxTotalBytes or trim contentExcludes; later files are not searchable)' : '',
                    warnings.length > 0 ? ' (warnings: ' + warnings.join(', ') + ')' : '',
                ].join('');
                const scopeNote = v.scope === undefined ? '' : ' (scope: ' + v.scope + (v.scopeFallback === undefined ? '' : '; ' + v.scopeFallback) + ')';
                const pageNote = v.truncated === true || v.nextOffset !== undefined
                    ? '\n(truncated' + (v.nextOffset === undefined ? '' : '; nextOffset ' + String(v.nextOffset)) + (v.budget?.dropped === undefined || v.budget.dropped === 0 ? '' : '; ' + String(v.budget.dropped) + ' hit(s) over the ' + String(v.budget.limitChars ?? 0) + '-char budget') + ')'
                    : '';
                const modeNote = mode === 'content' ? '' : ' (mode: ' + mode + ')';
                return [{ type: 'text', text: String(v.hits?.length ?? 0) + ' content hit(s)' + count + modeNote + scopeNote + notes + pageNote + '\n' + lines.join('\n') }];
            },
        },
        async execute(args, exec) {
            ensure?.();
            const query = args.query.trim();
            const state = content.status();
            if (query === '')
                return { ok: false, query, error: 'query is empty', state };
            const mode = parseFindMode(args.mode);
            const requestedLimit = args.headLimit ?? args.limit ?? 30;
            const limit = Math.max(1, Math.min(modeLimit, Math.trunc(requestedLimit)));
            const offset = Math.max(0, Math.trunc(args.offset ?? 0));
            const scope = args.scope === 'all' ? 'all' : 'workspace';
            const caller = {
                ...(exec?.agent?.session?.id === undefined ? {} : { sessionId: exec.agent.session.id }),
                ...(exec?.agent?.session?.header?.cwd === undefined ? {} : { cwd: exec.agent.session.header.cwd }),
            };
            const budgetChars = options.budgetChars ?? 8_000;
            const scopeRules = options.scope;
            const contextLines = Math.max(0, Math.min(CONTEXT_MAX_LINES, Math.trunc(args.contextLines ?? 0)));
            if (mode === 'names')
                return await runNamesMode(query, limit, offset, args, caller, options.rt, scopeRules, budgetChars, contextLines);
            const request = {
                query,
                limit,
                offset,
                scope,
                ...(typeof args.sessionId === 'string' && args.sessionId.trim() !== '' ? { sessionId: args.sessionId } : {}),
                ...(args.matchMode === undefined ? {} : { matchMode: args.matchMode }),
                ...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive }),
                ...(args.wholeWord === undefined ? {} : { wholeWord: args.wholeWord }),
                ...(args.count === undefined ? {} : { count: args.count }),
                ...(args.countLimit === undefined ? {} : { countLimit: args.countLimit }),
                ...(args.pathPrefix === undefined || args.pathPrefix === '' ? {} : { pathPrefix: args.pathPrefix }),
            };
            const result = await runContentSearchRequest(content, mode === 'count' ? { ...request, count: request.count ?? 'exact', limit: 1, offset: 0 } : request, roots, allowCrossWorkspaceSessions, caller);
            if (!result.ok) {
                return { ok: false, query, offset, mode, error: result.error, warnings: result.warnings, hits: [], state: result.state };
            }
            if (mode === 'count') {
                const total = result.count.kind === 'unknown' ? undefined : result.count.value;
                return {
                    ok: true,
                    query,
                    mode,
                    offset: 0,
                    hits: [],
                    count: result.count,
                    ...(total === undefined ? {} : { totalCount: total }),
                    truncated: result.count.kind === 'bounded',
                    warnings: result.warnings,
                    state: result.state,
                    scope,
                    ...(result.scopeFallback === undefined ? {} : { scopeFallback: result.scopeFallback }),
                };
            }
            const warnings = [...result.warnings];
            let filtered = result.hits;
            let scopeDropped = 0;
            if (scopeRules !== undefined) {
                const scoped = scopeRules.filterContent(result.hits);
                filtered = scoped.hits;
                scopeDropped = scoped.dropped;
                if (scoped.dropped > 0)
                    warnings.push('scope-filtered:' + String(scoped.dropped));
            }
            // Optional external rerank hook: never fatal, only reorders.
            if (options.rerankCommand !== undefined && options.rerankCommand.trim() !== '' && filtered.length > 1) {
                const reranked = await rerankHits(options.rerankCommand, query, filtered);
                filtered = reranked.hits;
                warnings.push(...reranked.warnings);
            }
            if (contextLines > 0) {
                filtered = await Promise.all(filtered.map(async (hit) => {
                    if (hit.kind !== 'file' || hit.line === undefined)
                        return hit;
                    const context = await readContextLines(hit.path, hit.line, contextLines);
                    return context === undefined ? hit : { ...hit, context: context.lines, contextStart: context.start };
                }));
            }
            const budgeted = applyOutputBudget(filtered, budgetChars);
            const total = result.count.kind === 'unknown' ? undefined : result.count.value;
            const pageFull = result.hits.length >= limit;
            const truncated = pageFull || budgeted.budget.truncated || budgeted.budget.dropped > 0;
            // A lossy page (scope/budget dropped rows) advances past the whole
            // consumed content page so a later page cannot duplicate kept hits.
            const lossy = scopeDropped > 0 || budgeted.budget.dropped > 0;
            const nextOffset = truncated ? offset + (lossy ? result.hits.length : budgeted.items.length) : undefined;
            return {
                ok: true,
                query,
                mode,
                offset,
                hits: budgeted.items,
                count: result.count,
                ...(total === undefined ? {} : { totalCount: total }),
                ...(nextOffset === undefined ? {} : { nextOffset }),
                truncated,
                budget: budgeted.budget,
                warnings: [...new Set(warnings)],
                state: result.state,
                scope,
                ...(result.scopeFallback === undefined ? {} : { scopeFallback: result.scopeFallback }),
            };
        },
    });
}
/** One name-index page rendered in the locator_find hit shape. */
async function runNamesMode(query, limit, offset, args, caller, rt, scopeRules, budgetChars, contextLines) {
    if (rt === undefined)
        return { ok: false, query, offset, mode: 'names', error: 'name-index-unavailable' };
    try {
        rt.start();
        const result = await rt.search({
            query,
            limit,
            offset,
            sort: args.sort ?? 'name',
            desc: args.desc ?? false,
            regex: args.regex ?? false,
            caseSensitive: args.caseSensitive ?? false,
            wholeWord: args.wholeWord ?? false,
            filesOnly: args.filesOnly ?? false,
            dirsOnly: args.dirsOnly ?? false,
        });
        const observedAt = Date.now();
        const cwdIsIndexed = caller.cwd !== undefined && rt.roots.some(root => withinRoots(caller.cwd, [root]));
        const visibility = cwdIsIndexed ? 'workspace' : 'roots';
        const mapped = result.hits.map(hit => {
            const readable = scopeRules?.readability(hit.path) ?? { read: 'allowed', reason: 'name hits come from the configured index roots' };
            return {
                kind: hit.dir ? 'dir' : 'file',
                path: hit.path,
                name: hit.name,
                size: hit.size,
                mtime: hit.mtime,
                dir: hit.dir,
                ...(hit.dir || readable.read !== 'allowed' ? {} : { ref: fileRef({ path: hit.path, mtime: hit.mtime, size: hit.size }) }),
                freshness: { state: 'unknown', observedAt, mtime: hit.mtime },
                refStatus: 'unknown',
                permissions: { read: readable.read, visibility, reason: readable.reason },
            };
        });
        const scoped = scopeRules === undefined ? { hits: mapped, dropped: 0 } : scopeRules.filterSearchable(mapped);
        const budgeted = applyOutputBudget(scoped.hits, budgetChars);
        const truncated = result.truncated || scoped.dropped > 0 || budgeted.budget.dropped > 0;
        const warnings = contextLines > 0 ? ['context-lines-ignored-in-names-mode'] : [];
        if (scoped.dropped > 0)
            warnings.push('scope-filtered:' + String(scoped.dropped));
        const lossy = scoped.dropped > 0 || budgeted.budget.dropped > 0;
        const nextPage = truncated ? offset + (lossy ? mapped.length : budgeted.items.length) : undefined;
        return {
            ok: true,
            query,
            mode: 'names',
            offset: result.offset,
            hits: budgeted.items,
            total: result.total,
            totalCount: result.total,
            ...(nextPage === undefined ? {} : { nextOffset: nextPage }),
            truncated,
            budget: budgeted.budget,
            warnings,
            ...(caller.cwd === undefined ? {} : { scope: 'workspace' }),
            indexing: result.indexing === true,
        };
    }
    catch (error) {
        return { ok: false, query, offset, mode: 'names', error: error instanceof Error ? error.message : String(error) };
    }
}
//# sourceMappingURL=find.js.map