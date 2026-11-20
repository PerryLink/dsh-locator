/**
 * locator_explore — one question, several lexical probes, one evidence digest.
 *
 * The tool exists for the case where a single locator_search/locator_find call
 * is too narrow and the caller has no subagent budget to fan out: it derives
 * name and body queries from the question, runs them in parallel, merges the
 * hits by evidence identity, and returns a bounded summary plus citable refs.
 * No LLM or network call is involved; the "answer" is a ranked digest the
 * calling agent can reason about.
 * @module dsh-locator/explore
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BUDGET_SCHEMA, contentScopeOptionsOf, runContentSearchRequest } from "./find.js";
import { fileRef } from "./refs.js";
import { withinRoots } from "./reveal.js";
import { applyOutputBudget, DEFAULT_OUTPUT_BUDGET_CHARS } from "./scope.js";
const PLANS = {
    quick: { nameQueries: 2, contentQueries: 1, limit: 10, perQuery: 8 },
    medium: { nameQueries: 3, contentQueries: 2, limit: 20, perQuery: 8 },
    deep: { nameQueries: 4, contentQueries: 4, limit: 40, perQuery: 10 },
};
/** Words that carry no retrieval signal in a question. */
const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'what', 'where', 'which', 'who', 'whom', 'how', 'why',
    'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'at', 'a', 'an', 'that', 'this',
    'it', 'do', 'does', 'did', 'find', 'search', 'all', 'from', 'about', 'me', 'my', 'our',
    'tell', 'show', 'give', 'which', 'when', 'should', 'could', 'would', 'there', 'their',
]);
/**
 * Turn a free-form question into ranked lexical probes.
 *
 * Name probes keep 2+ character words (the name index matches substrings); body
 * probes keep 3+ character words, because the FTS5 trigram tokenizer rejects
 * shorter terms. Quoted phrases in the question become extra name probes. The
 * ordering is stable and de-duplicated so a repeated run is reproducible.
 * @param question - the user question.
 * @param plan - thoroughness preset.
 * @returns deduplicated name and content query strings.
 */
export function exploreQueries(question, plan) {
    const phrases = [];
    for (const match of question.matchAll(/"([^"]{2,80})"/g)) {
        const phrase = match[1]?.trim();
        if (phrase !== undefined && phrase !== '')
            phrases.push(phrase);
    }
    const words = [];
    const seen = new Set();
    for (const match of question.matchAll(/[\p{L}\p{N}_]{2,}/gu)) {
        const word = match[0];
        const key = word.toLowerCase();
        if (STOP_WORDS.has(key) || seen.has(key))
            continue;
        seen.add(key);
        words.push(word);
    }
    const longWords = words.filter(word => Array.from(word).length >= 3);
    const names = [...new Set([...phrases, ...words.slice(0, plan.nameQueries * 2)])].slice(0, plan.nameQueries);
    const content = [];
    if (longWords.length > 0) {
        const windows = [];
        if (plan.contentQueries <= 1) {
            windows.push(longWords.slice(0, 4));
        }
        else {
            const width = Math.max(2, Math.ceil(longWords.length / plan.contentQueries));
            for (let start = 0; start < longWords.length && windows.length < plan.contentQueries; start += Math.max(1, width - 1)) {
                windows.push(longWords.slice(start, start + Math.min(4, width + 1)));
            }
        }
        for (const window of windows) {
            if (window.length === 0)
                continue;
            const query = window.join(' ');
            if (!content.includes(query))
                content.push(query);
        }
    }
    return {
        names: names.map(query => query.replace(/[()]/g, '').trim()).filter(query => query !== ''),
        content,
    };
}
const REF_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        path: { type: 'string', required: true },
        kind: { type: 'string', enum: ['file', 'session', 'dir'], required: true },
        origin: { type: 'string', enum: ['name', 'content'] },
        title: { type: 'string' },
        snippet: { type: 'string' },
        line: { type: 'integer' },
        sessionId: { type: 'string' },
        messageId: { type: 'string' },
        ref: { type: 'string', description: 'Citable evidence reference for this occurrence (absent when not readable).' },
        refStatus: { type: 'string', enum: ['fresh', 'stale', 'missing', 'unknown'] },
        score: { type: 'number' },
        read: { type: 'string', enum: ['allowed', 'denied'] },
        visibility: { type: 'string', enum: ['workspace', 'roots', 'session', 'external'] },
    },
};
const EXPLORE_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true },
        question: { type: 'string' },
        thoroughness: { type: 'string', enum: ['quick', 'medium', 'deep'] },
        summary: { type: 'string', description: 'Deterministic digest of what was found (no LLM involved).' },
        refs: { type: 'array', items: REF_SCHEMA },
        queries: {
            type: 'object',
            additionalProperties: false,
            properties: {
                names: { type: 'array', items: { type: 'string' } },
                content: { type: 'array', items: { type: 'string' } },
            },
        },
        counts: {
            type: 'object',
            additionalProperties: false,
            properties: {
                nameHits: { type: 'integer' },
                contentHits: { type: 'integer' },
                refs: { type: 'integer' },
                deduped: { type: 'integer' },
            },
        },
        truncated: { type: 'boolean' },
        budget: BUDGET_SCHEMA,
        tookMs: { type: 'number' },
        /** Set when the content store had to widen a workspace scope (e.g. 'global'). */
        scopeFallback: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
        error: { type: 'string' },
    },
};
/** One name hit in the merged shape. */
function nameRef(hit, scope, cwdIsIndexed) {
    const readable = scope?.readability(hit.path) ?? { read: 'allowed', reason: 'name hit inside the configured roots' };
    const visibility = cwdIsIndexed ? 'workspace' : 'roots';
    return {
        path: hit.path,
        kind: hit.dir ? 'dir' : 'file',
        origin: 'name',
        title: hit.name,
        ...(hit.dir || readable.read !== 'allowed' ? {} : { ref: fileRef({ path: hit.path, mtime: hit.mtime, size: hit.size }) }),
        refStatus: 'unknown',
        read: readable.read,
        visibility,
    };
}
/** One enriched content hit in the merged shape. */
function contentRef(hit) {
    return {
        path: hit.path,
        kind: hit.kind,
        origin: 'content',
        ...(hit.title === '' ? {} : { title: hit.title }),
        ...(hit.snippet === '' ? {} : { snippet: hit.snippet }),
        ...(hit.line === undefined ? {} : { line: hit.line }),
        ...(hit.sessionId === undefined ? {} : { sessionId: hit.sessionId }),
        ...(hit.messageId === undefined ? {} : { messageId: hit.messageId }),
        ref: hit.ref,
        refStatus: hit.refStatus,
        score: hit.score,
        read: hit.permissions.read,
        visibility: hit.permissions.visibility,
    };
}
/** Deduplicate key: one file path, or one session message occurrence. */
function refKey(ref) {
    if (ref.kind === 'session')
        return ref.sessionId === undefined ? ref.path : ref.sessionId + '\u0000' + (ref.messageId ?? '') + '\u0000' + ref.path;
    return ref.path;
}
/** Build the deterministic summary line for a result page. */
export function exploreSummary(question, refs, counts) {
    const files = refs.filter(ref => ref.kind === 'file').length;
    const sessions = refs.filter(ref => ref.kind === 'session').length;
    const dirs = refs.filter(ref => ref.kind === 'dir').length;
    const parts = [String(refs.length) + ' evidence ref(s)', String(files) + ' file', String(sessions) + ' session', String(dirs) + ' dir'];
    const top = refs.slice(0, 3).map(ref => {
        const label = ref.title ?? ref.path;
        return ref.snippet === undefined ? label : label + ': ' + ref.snippet.slice(0, 120);
    });
    return 'locator_explore ' + JSON.stringify(question) + ' — ' + parts.join(', ') + ' from ' + String(counts.nameHits) + ' name / ' + String(counts.contentHits) + ' content hit(s).' +
        (top.length === 0 ? '' : ' Top: ' + top.join(' | '));
}
/** Build the locator_explore tool. */
export function makeExploreTool(rt, options) {
    const scopeRules = options.scope;
    const budgetChars = options.budgetChars ?? DEFAULT_OUTPUT_BUDGET_CHARS;
    return defineTool({
        name: 'locator_explore',
        description: [
            'Explore one question across the local file-name and content indexes (dsh-locator).',
            '',
            'It derives several name and body queries from the question, runs them in parallel, merges the hits by evidence identity and returns a bounded digest: a deterministic summary, citable refs (ref://file and dsh-session:) and the queries it used. No LLM or network call is involved, and no subagent is required.',
            '',
            'Use it for open-ended questions like "where did we decide the retry policy" when a single locator_search or locator_find call is too narrow. Thoroughness: quick (default) runs 2 name + 1 content query, medium 3 + 2, deep 4 + 4; every level is bounded by the configured output budget. Prefer locator_find with an exact phrase when you already know it, and locator_resolve to verify one ref.',
        ].join('\n'),
        parameters: {
            question: { type: 'string', required: true, description: 'The natural-language question or topic to explore.' },
            thoroughness: { type: 'string', enum: ['quick', 'medium', 'deep'], description: 'Search depth (default quick).' },
            limit: { type: 'integer', description: 'Maximum refs to return (default and cap depend on thoroughness, at most 40).' },
            scope: { type: 'string', enum: ['workspace', 'all'], description: 'workspace (default) keeps file hits under the caller cwd when it is indexed; all searches every configured root.' },
            maxChars: { type: 'integer', description: 'Result budget in characters; defaults to the configured outputBudgetChars (0 = unlimited).' },
        },
        output: {
            schema: EXPLORE_OUTPUT,
            render: (_args, value) => {
                const v = value;
                if (!v.ok)
                    return [{ type: 'text', text: 'locator_explore failed: ' + (v.error ?? 'unknown error') }];
                const lines = [v.summary ?? ''];
                for (const ref of v.refs ?? []) {
                    const head = '  [' + String(ref.kind) + '] ' + (ref.title ?? ref.path);
                    const body = ref.snippet === undefined ? '' : ' — ' + ref.snippet.slice(0, 200);
                    const evidence = ref.ref === undefined ? '' : '\n     ref ' + ref.ref + (ref.refStatus === undefined ? '' : ' (' + ref.refStatus + ')');
                    const location = ref.kind === 'session' ? '\n     session ' + (ref.sessionId ?? '') + (ref.messageId === undefined ? '' : ' message ' + ref.messageId) : '\n     ' + ref.path + (ref.line === undefined ? '' : ' (line ' + String(ref.line) + ')');
                    lines.push(head + body + location + evidence);
                }
                const queries = v.queries;
                if (queries !== undefined)
                    lines.push('  queries: names=' + JSON.stringify(queries.names ?? []) + ' content=' + JSON.stringify(queries.content ?? []));
                if (v.scopeFallback !== undefined)
                    lines.push('  scope fallback: ' + v.scopeFallback);
                if (v.warnings !== undefined && v.warnings.length > 0)
                    lines.push('  warnings: ' + [...new Set(v.warnings)].join(', '));
                if (v.truncated === true)
                    lines.push('  (truncated by the result budget; narrow the question or use locator_find)');
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        async execute(args, exec) {
            const started = Date.now();
            const question = args.question.trim();
            if (question === '') {
                return { ok: false, question, refs: [], error: 'question is empty' };
            }
            const thoroughness = args.thoroughness === 'medium' || args.thoroughness === 'deep' ? args.thoroughness : 'quick';
            const plan = PLANS[thoroughness];
            const maxRefs = Math.max(1, Math.min(40, Math.trunc(args.limit ?? plan.limit)));
            const scope = args.scope === 'all' ? 'all' : 'workspace';
            const queryBudget = typeof args.maxChars === 'number' && Number.isFinite(args.maxChars) ? Math.trunc(args.maxChars) : budgetChars;
            const caller = {
                ...(exec?.agent?.session?.id === undefined ? {} : { sessionId: exec.agent.session.id }),
                ...(exec?.agent?.session?.header?.cwd === undefined ? {} : { cwd: exec.agent.session.header.cwd }),
            };
            const callerCwd = caller.cwd;
            const cwdIsIndexed = callerCwd !== undefined && options.roots.some(root => withinRoots(callerCwd, [root]));
            const probes = exploreQueries(question, plan);
            const warnings = [];
            const nameTasks = probes.names.map(async (query) => {
                try {
                    rt.start();
                    const result = await rt.search({
                        query,
                        limit: plan.perQuery,
                        offset: 0,
                        sort: 'name',
                        desc: false,
                        regex: false,
                        caseSensitive: false,
                        wholeWord: false,
                        filesOnly: false,
                        dirsOnly: false,
                    });
                    return { hits: result.hits, indexing: result.indexing === true };
                }
                catch (error) {
                    warnings.push('name-query-failed:' + messageOf(error).slice(0, 120));
                    return { hits: [], indexing: false };
                }
            });
            let contentScopeFallback;
            const contentTasks = options.content === undefined
                ? []
                : probes.content.map(async (query) => {
                    try {
                        options.ensure?.();
                        const result = await runContentSearchRequest(options.content, {
                            query,
                            limit: plan.perQuery,
                            offset: 0,
                            scope: scope,
                        }, options.roots, options.allowCrossWorkspaceSessions === true, caller, contentScopeOptionsOf(rt));
                        if (!result.ok) {
                            warnings.push('content-query-failed:' + result.error);
                            return [];
                        }
                        if (result.scopeFallback !== undefined)
                            contentScopeFallback = result.scopeFallback;
                        return result.hits;
                    }
                    catch (error) {
                        warnings.push('content-query-failed:' + messageOf(error).slice(0, 120));
                        return [];
                    }
                });
            const [namePages, contentPages] = await Promise.all([Promise.all(nameTasks), Promise.all(contentTasks)]);
            if (options.content === undefined)
                warnings.push('content-index-unavailable');
            const merged = new Map();
            let nameHits = 0;
            let contentHits = 0;
            let deduped = 0;
            for (const page of namePages) {
                for (const hit of page.hits) {
                    nameHits++;
                    if (scope === 'workspace' && cwdIsIndexed && !withinRoots(hit.path, [callerCwd]))
                        continue;
                    const ref = nameRef(hit, scopeRules, cwdIsIndexed);
                    if (scopeRules !== undefined && !scopeRules.isSearchable(ref.path))
                        continue;
                    const key = refKey(ref);
                    if (merged.has(key)) {
                        deduped++;
                        continue;
                    }
                    merged.set(key, ref);
                }
            }
            for (const page of contentPages) {
                for (const hit of page) {
                    contentHits++;
                    if (scopeRules !== undefined && !scopeRules.contentVisible(hit.path))
                        continue;
                    const ref = contentRef(hit);
                    const key = refKey(ref);
                    const existing = merged.get(key);
                    if (existing !== undefined) {
                        deduped++;
                        // A content hit carries the snippet and a verified ref; let it win
                        // over the corresponding name hit in the merged digest.
                        merged.set(key, { ...existing, ...ref, origin: 'content' });
                        continue;
                    }
                    merged.set(key, ref);
                }
            }
            const ranked = [...merged.values()].sort((left, right) => {
                const origin = (left.origin === 'content' ? 0 : 1) - (right.origin === 'content' ? 0 : 1);
                if (origin !== 0)
                    return origin;
                const score = (right.score ?? 0) - (left.score ?? 0);
                if (score !== 0)
                    return score;
                return left.path.localeCompare(right.path);
            }).slice(0, maxRefs);
            const budgeted = applyOutputBudget(ranked, queryBudget);
            const truncated = budgeted.budget.dropped > 0 || (ranked.length < merged.size && merged.size > maxRefs);
            const counts = { nameHits, contentHits, refs: budgeted.items.length, deduped };
            return {
                ok: true,
                question,
                thoroughness,
                summary: exploreSummary(question, budgeted.items, counts),
                refs: budgeted.items,
                queries: probes,
                counts,
                truncated,
                budget: budgeted.budget,
                tookMs: Date.now() - started,
                ...(contentScopeFallback === undefined ? {} : { scopeFallback: contentScopeFallback }),
                warnings: [...new Set(warnings)],
            };
        },
    });
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=explore.js.map