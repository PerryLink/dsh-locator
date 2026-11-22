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
    // 0.21.1 (AI-friendliness): pronoun/auxiliary probes such as "we" or "our"
    // only added unrelated name hits to the digest, and question scaffolding
    // words ("just", "also", "than") matched nearly every path.
    'we', 'us', 'you', 'your', 'they', 'them', 'its', 'i', 'am', 'been', 'being',
    'has', 'have', 'had', 'will', 'can', 'may', 'might', 'must', 'shall', 'just',
    'also', 'into', 'over', 'some', 'such', 'only', 'more', 'most', 'other', 'than',
    'then', 'these', 'those', 'via', 'per',
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
/** Maximum probe attributions kept per ref (keeps the digest bounded). */
const MAX_WHY = 6;
/** Append probe labels, de-duplicated and capped by {@link MAX_WHY}. */
function mergeWhy(existing, incoming) {
    const out = [];
    for (const label of [...(existing ?? []), ...(incoming ?? [])]) {
        if (!out.includes(label) && out.length < MAX_WHY)
            out.push(label);
    }
    return out;
}
/** Lower (more relevant) bm25 rank wins; an absent rank always loses to a number. */
function bestScore(left, right) {
    if (left === undefined)
        return right;
    if (right === undefined)
        return left;
    return Math.min(left, right);
}
/** Merge a duplicate name hit into an existing ref (probe attribution only). */
function mergeNameRef(existing, ref) {
    existing.why = mergeWhy(existing.why, ref.why);
}
/**
 * Merge one content hit into an existing ref. The content hit wins over a name
 * hit (snippet + verified ref + bm25 rank), and the best rank wins when several
 * content probes returned the same evidence row.
 */
function mergeContentRef(existing, ref) {
    const previousScore = existing.score;
    const score = bestScore(previousScore, ref.score);
    const betterRank = ref.score !== undefined && (previousScore === undefined || ref.score < previousScore);
    const matchedQuery = betterRank ? ref.matchedQuery ?? existing.matchedQuery : existing.matchedQuery ?? ref.matchedQuery;
    return {
        ...existing,
        ...ref,
        origin: 'content',
        why: mergeWhy(existing.why, ref.why),
        ...(score === undefined ? {} : { score }),
        ...(matchedQuery === undefined ? {} : { matchedQuery }),
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
        score: { type: 'number', description: 'BM25 rank from the content index (lower = more relevant); absent on name-index hits.' },
        matchedQuery: { type: 'string', description: 'Probe that best explains this ref; a better-ranked content probe wins over name hits.' },
        why: { type: 'array', items: { type: 'string' }, description: 'Every probe that matched this ref (origin:query), de-duplicated and capped.' },
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
                merged: { type: 'integer', description: 'Unique evidence refs after cross-probe de-duplication (before the ref cap and output budget).' },
                maxRefs: { type: 'integer', description: 'Effective ref cap used for this call.' },
            },
        },
        truncated: { type: 'boolean', description: 'True when the digest was cut by the ref cap and/or the output budget; see truncatedReason and budget.dropped.' },
        truncatedReason: {
            type: 'string',
            enum: ['maxRefs', 'budget', 'both'],
            description: 'Why the digest is truncated: the caller ref cap (maxRefs), the output budget, or both.',
        },
        budget: BUDGET_SCHEMA,
        tookMs: { type: 'number' },
        /** Set when the content store had to widen a workspace scope (e.g. 'global'). */
        scopeFallback: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
        error: { type: 'string' },
    },
};
/** One name hit in the merged shape. */
function nameRef(hit, scope, cwdIsIndexed, query) {
    const readable = scope?.readability(hit.path) ?? { read: 'allowed', reason: 'name hit inside the configured roots' };
    const visibility = cwdIsIndexed ? 'workspace' : 'roots';
    return {
        path: hit.path,
        kind: hit.dir ? 'dir' : 'file',
        origin: 'name',
        title: hit.name,
        ...(hit.dir || readable.read !== 'allowed' ? {} : { ref: fileRef({ path: hit.path, mtime: hit.mtime, size: hit.size }) }),
        refStatus: 'unknown',
        matchedQuery: query,
        why: ['name:' + query],
        read: readable.read,
        visibility,
    };
}
/** One enriched content hit in the merged shape. */
function contentRef(hit, query) {
    // Compact/embedded content hits may omit the evidence block; the merge keeps
    // whatever exists instead of failing the whole digest on a missing label.
    return {
        path: hit.path,
        kind: hit.kind,
        origin: 'content',
        ...(hit.title === '' ? {} : { title: hit.title }),
        ...(hit.snippet === '' ? {} : { snippet: hit.snippet }),
        ...(hit.line === undefined ? {} : { line: hit.line }),
        ...(hit.sessionId === undefined ? {} : { sessionId: hit.sessionId }),
        ...(hit.messageId === undefined ? {} : { messageId: hit.messageId }),
        ...(hit.ref === undefined ? {} : { ref: hit.ref }),
        ...(hit.refStatus === undefined ? {} : { refStatus: hit.refStatus }),
        ...(hit.score === undefined ? {} : { score: hit.score }),
        matchedQuery: query,
        why: ['content:' + query],
        read: hit.permissions?.read ?? 'allowed',
        visibility: hit.permissions?.visibility ?? (hit.kind === 'session' ? 'session' : 'roots'),
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
        deferLoading: true,
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
        // Every probe is an independent read-only index query; overlapping calls
        // share the runtime's read path and never mutate caller-visible state.
        isConcurrencySafe: () => true,
        output: {
            schema: EXPLORE_OUTPUT,
            render: (_args, value) => {
                const v = value;
                if (!v.ok)
                    return [{ type: 'text', text: 'locator_explore failed: ' + (v.error ?? 'unknown error') }];
                const lines = [v.summary ?? ''];
                for (const ref of v.refs ?? []) {
                    // Name-only hits need their probe shown (that is how the caller
                    // judges "why did this unrelated file appear"); content hits already
                    // carry the matched snippet, so keep their line lean.
                    const via = ref.origin !== 'name' || ref.matchedQuery === undefined ? '' : ' [q: ' + ref.matchedQuery.slice(0, 48) + ']';
                    const head = '  [' + String(ref.kind) + '] ' + (ref.title ?? ref.path) + via;
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
                if (v.truncated === true) {
                    const reason = v.truncatedReason === 'maxRefs'
                        ? 'the ref cap (maxRefs ' + String(v.counts?.maxRefs ?? '') + ')'
                        : v.truncatedReason === 'budget'
                            ? 'the output budget'
                            : v.truncatedReason === 'both'
                                ? 'the ref cap and the output budget'
                                : 'the result budget';
                    const dropped = v.budget?.dropped ?? 0;
                    lines.push('  (truncated by ' + reason + (dropped > 0 ? '; ' + String(dropped) + ' ref(s) dropped by the budget' : '') + '; narrow the question or use locator_find)');
                }
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
                    return { query, hits: result.hits, indexing: result.indexing === true };
                }
                catch (error) {
                    warnings.push('name-query-failed:' + messageOf(error).slice(0, 120));
                    return { query, hits: [], indexing: false };
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
                            return { query, hits: [] };
                        }
                        if (result.scopeFallback !== undefined)
                            contentScopeFallback = result.scopeFallback;
                        return { query, hits: result.hits };
                    }
                    catch (error) {
                        warnings.push('content-query-failed:' + messageOf(error).slice(0, 120));
                        return { query, hits: [] };
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
                    const ref = nameRef(hit, scopeRules, cwdIsIndexed, page.query);
                    if (scopeRules !== undefined && !scopeRules.isSearchable(ref.path))
                        continue;
                    const key = refKey(ref);
                    const existing = merged.get(key);
                    if (existing !== undefined) {
                        // 0.21.1: several name probes hitting the same path is one piece of
                        // evidence, not several refs. Keep the first occurrence and record
                        // every probe that matched (the caller can see why it surfaced).
                        deduped++;
                        mergeNameRef(existing, ref);
                        continue;
                    }
                    merged.set(key, ref);
                }
            }
            for (const page of contentPages) {
                for (const hit of page.hits) {
                    contentHits++;
                    if (scopeRules !== undefined && !scopeRules.contentVisible(hit.path))
                        continue;
                    const ref = contentRef(hit, page.query);
                    const key = refKey(ref);
                    const existing = merged.get(key);
                    if (existing !== undefined) {
                        // A content hit carries the snippet and a verified ref; let it win
                        // over the corresponding name hit in the merged digest. When
                        // several content probes return the same row, the best bm25 rank is
                        // kept instead of whichever probe happened to resolve last.
                        deduped++;
                        merged.set(key, mergeContentRef(existing, ref));
                        continue;
                    }
                    merged.set(key, ref);
                }
            }
            // 0.21.1: a name-only directory hit is noise once a content hit already
            // proves the interesting file inside it. Dropping it keeps the digest
            // budget for actual evidence instead of parent-directory names.
            const contentPaths = [];
            for (const ref of merged.values())
                if (ref.origin === 'content')
                    contentPaths.push(ref.path);
            if (contentPaths.length > 0) {
                for (const [key, ref] of [...merged]) {
                    if (ref.origin !== 'name' || ref.kind !== 'dir')
                        continue;
                    if (contentPaths.some(path => path !== ref.path && withinRoots(path, [ref.path]))) {
                        merged.delete(key);
                        deduped++;
                    }
                }
            }
            const numericScore = (ref) => typeof ref.score === 'number' && Number.isFinite(ref.score) ? ref.score : undefined;
            const ranked = [...merged.values()].sort((left, right) => {
                const leftScore = numericScore(left);
                const rightScore = numericScore(right);
                // Content hits carry an FTS5 bm25 rank where lower (more negative) is a
                // better match. This used to sort descending, which put the *least*
                // relevant hit first and made the summary/Top and the budget cut keep
                // the worst evidence. Hits without a rank (name-only) always sort after.
                if (leftScore !== undefined && rightScore !== undefined && leftScore !== rightScore)
                    return leftScore - rightScore;
                if (leftScore !== undefined && rightScore === undefined)
                    return -1;
                if (leftScore === undefined && rightScore !== undefined)
                    return 1;
                // A ref matched by more probes is stronger evidence than a one-probe
                // name hit; this is the name-hit relevance tie-breaker.
                const leftWhy = left.why?.length ?? 0;
                const rightWhy = right.why?.length ?? 0;
                if (leftWhy !== rightWhy)
                    return rightWhy - leftWhy;
                const origin = (left.origin === 'content' ? 0 : 1) - (right.origin === 'content' ? 0 : 1);
                if (origin !== 0)
                    return origin;
                return left.path.localeCompare(right.path);
            }).slice(0, maxRefs);
            const budgeted = applyOutputBudget(ranked, queryBudget);
            const droppedByMaxRefs = merged.size > maxRefs;
            const droppedByBudget = budgeted.budget.dropped > 0;
            const truncatedReason = droppedByMaxRefs && droppedByBudget
                ? 'both'
                : droppedByMaxRefs
                    ? 'maxRefs'
                    : droppedByBudget
                        ? 'budget'
                        : undefined;
            const counts = { nameHits, contentHits, refs: budgeted.items.length, deduped, merged: merged.size, maxRefs };
            return {
                ok: true,
                question,
                thoroughness,
                summary: exploreSummary(question, budgeted.items, counts),
                refs: budgeted.items,
                queries: probes,
                counts,
                truncated: truncatedReason !== undefined,
                ...(truncatedReason === undefined ? {} : { truncatedReason }),
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