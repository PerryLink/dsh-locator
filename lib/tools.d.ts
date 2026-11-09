/**
 * Agent-facing tools: locator_search, locator_status and locator_rebuild.
 * @module dsh-locator/tools
 */
import type { LocatorRuntime } from './runtime.ts';
/** Build the locator_search tool. */
export declare function makeSearchTool(rt: LocatorRuntime): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Build the locator_status tool. */
export declare function makeStatusTool(rt: LocatorRuntime): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Build the locator_rebuild tool. */
export declare function makeRebuildTool(rt: LocatorRuntime): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=tools.d.ts.map