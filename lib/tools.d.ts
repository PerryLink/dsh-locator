/**
 * Agent-facing tools: locator_search, locator_status and locator_rebuild.
 * @module dsh-locator/tools
 */
import type { ContentIndex } from './content.ts';
import type { LocatorRuntime } from './runtime.ts';
/** Validated rebuild scope: only narrowing of the configured roots/excludes is allowed. */
export interface RebuildScope {
    roots?: string[];
    excludes?: string[];
}
/** Validation result for one `locator_rebuild` argument pair. */
export type RebuildScopeResult = {
    ok: true;
    roots?: string[];
    excludes?: string[];
} | {
    ok: false;
    error: string;
};
/**
 * Restrict a `locator_rebuild` request to the configured scope.
 *
 * Root replacement is the dangerous knob: letting the model pick an arbitrary
 * absolute path would turn a search tool into a disk-indexer for directories
 * the operator never configured. A requested root must therefore canonicalize
 * (symlinks resolved) to a configured root or a directory below one; requested
 * excludes must be draw from the configured exclude list. Everything is passed
 * through the same canonicalization as `/reveal`/`/open`.
 * @param roots - requested replacement roots, if any.
 * @param excludes - requested replacement excludes, if any.
 * @param configuredRoots - the plugin's configured (resolved) roots.
 * @param configuredExcludes - the plugin's configured excludes.
 * @returns the canonical narrowed scope, or the first refusal.
 */
export declare function validateRebuildArguments(roots: readonly string[] | undefined, excludes: readonly string[] | undefined, configuredRoots: readonly string[], configuredExcludes: readonly string[]): RebuildScopeResult;
/** Build the locator_search tool. */
export declare function makeSearchTool(rt: LocatorRuntime): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Build the locator_status tool. */
export declare function makeStatusTool(rt: LocatorRuntime, content?: ContentIndex): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Build the locator_rebuild tool. */
export declare function makeRebuildTool(rt: LocatorRuntime): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=tools.d.ts.map