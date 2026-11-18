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
import type { ContentIndex } from './content.ts';
import type { LocatorRuntime } from './runtime.ts';
import { type Scope } from './scope.ts';
/** Search depth presets; each bounds queries and per-query hit counts. */
export type Thoroughness = 'quick' | 'medium' | 'deep';
interface ExplorePlan {
    nameQueries: number;
    contentQueries: number;
    limit: number;
    perQuery: number;
}
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
export declare function exploreQueries(question: string, plan: ExplorePlan): {
    names: string[];
    content: string[];
};
/** One merged evidence ref returned by locator_explore. */
interface ExploreRef {
    path: string;
    kind: 'file' | 'session' | 'dir';
    origin: 'name' | 'content';
    title?: string;
    snippet?: string;
    line?: number;
    sessionId?: string;
    messageId?: string;
    ref?: string;
    refStatus?: 'fresh' | 'stale' | 'missing' | 'unknown';
    score?: number;
    read: 'allowed' | 'denied';
    visibility: 'workspace' | 'roots' | 'session' | 'external';
}
/** Options the plugin passes to makeExploreTool. */
export interface ExploreToolOptions {
    content?: ContentIndex;
    ensure?: () => void;
    roots: readonly string[];
    allowCrossWorkspaceSessions?: boolean;
    scope?: Scope;
    budgetChars?: number;
}
/** Build the deterministic summary line for a result page. */
export declare function exploreSummary(question: string, refs: readonly ExploreRef[], counts: {
    nameHits: number;
    contentHits: number;
}): string;
/** Build the locator_explore tool. */
export declare function makeExploreTool(rt: LocatorRuntime, options: ExploreToolOptions): import("@deepseek-ai/dsh-tools").ToolDefinition;
export {};
//# sourceMappingURL=explore.d.ts.map