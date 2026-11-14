/**
 * `locator_resolve` and `locator_cite`: turn refs into metadata/excerpts and
 * human/agent-readable citations. These tools never return content the caller
 * is not authorized to read (session refs follow the same workspace rule as
 * `locator_find`; file refs must stay inside the configured roots).
 * @module dsh-locator/ref-tools
 */
import type { ContentIndex } from './content.ts';
import type { LocatorRuntime } from './runtime.ts';
/** Build the locator_resolve tool. */
export declare function makeResolveTool(rt: LocatorRuntime, content?: ContentIndex): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Build the locator_cite tool. */
export declare function makeCiteTool(): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Build a URL ref from one raw URL (used by future indexing work and tests). */
export declare function buildUrlRef(raw: string): string;
/** Decode a session ref back to its id (exported for tests/other modules). */
export declare function sessionIdOf(ref: string): string | undefined;
//# sourceMappingURL=ref-tools.d.ts.map