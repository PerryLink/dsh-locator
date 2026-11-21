/**
 * Agent-facing tools: locator_search, locator_status and locator_rebuild.
 * @module dsh-locator/tools
 */
import type { ContentIndex } from './content.ts';
import { type LocatorRuntime } from './runtime.ts';
import { Scope } from './scope.ts';
/** Validated rebuild scope: only narrowing of the configured roots/excludes is allowed. */
export interface RebuildScope {
    roots?: string[];
    excludes?: string[];
}
/** Validation result for one locator_rebuild argument pair. */
export type RebuildScopeResult = {
    ok: true;
    roots?: string[];
    excludes?: string[];
} | {
    ok: false;
    error: string;
};
/**
 * Restrict a locator_rebuild request to the configured scope.
 *
 * Root replacement is the dangerous knob: letting the model pick an arbitrary
 * absolute path would turn a search tool into a disk-indexer for directories
 * the operator never configured. A requested root must therefore canonicalize
 * (symlinks resolved) to a configured root or a directory below one; requested
 * excludes must be drawn from the configured exclude list. Everything is passed
 * through the same canonicalization as /reveal and /open.
 * @param roots - requested replacement roots, if any.
 * @param excludes - requested replacement excludes, if any.
 * @param configuredRoots - the plugin's configured (resolved) roots.
 * @param configuredExcludes - the plugin's configured excludes.
 * @returns the canonical narrowed scope, or the first refusal.
 */
export declare function validateRebuildArguments(roots: readonly string[] | undefined, excludes: readonly string[] | undefined, configuredRoots: readonly string[], configuredExcludes: readonly string[]): RebuildScopeResult;
/** Optional collaborators for locator_search (content mode + scope + budget). */
export interface SearchToolOptions {
    /** Content index backing mode "content"/"count"; omitted disables those modes. */
    content?: ContentIndex;
    /** Lazy content boot hook. */
    ensure?: () => void;
    /** Layered ignore rules; omitted means no filtering. */
    scope?: Scope;
    /** Soft result budget in characters; omitted uses the catalog default. */
    budgetChars?: number;
}
/** Modes locator_search understands; the default keeps the historical behavior. */
export type SearchMode = 'names' | 'content' | 'count';
/** Parse one search mode, defaulting to "names". */
export declare function parseSearchMode(value: unknown): SearchMode;
/** Build the locator_search tool. */
export declare function makeSearchTool(rt: LocatorRuntime, options?: SearchToolOptions): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Build locator_outline: every stored symbol for one indexed file. */
export declare function makeOutlineTool(content: ContentIndex, ensure?: () => void, roots?: readonly string[], scope?: Scope, budgetChars?: number): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Build locator_symbol: find declarations by name across the index. */
export declare function makeSymbolTool(content: ContentIndex, ensure?: () => void, scope?: Scope, budgetChars?: number): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Build locator_repo_map: a token-budgeted repository structure digest. */
export declare function makeRepoMapTool(content: ContentIndex, ensure?: () => void, roots?: readonly string[], scope?: Scope, budgetChars?: number): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Build the locator_status tool. */
export declare function makeStatusTool(rt: LocatorRuntime, content?: ContentIndex, scope?: Scope): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Build the locator_rebuild tool. */
export declare function makeRebuildTool(rt: LocatorRuntime): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=tools.d.ts.map