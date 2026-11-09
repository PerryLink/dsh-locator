/**
 * `locator_export` — write a read-only SQLite mirror of the index.
 *
 * The engine keeps its compact snapshot; this tool streams the index page by
 * page and writes a normal SQLite database so external tools can query it.
 * `node:sqlite` is loaded lazily: hosts below Node 22.5 get a clear error
 * instead of a plugin that fails to load.
 * @module dsh-locator/export
 */
import type { LocatorRuntime } from './runtime.ts';
/** Build the locator_export tool. */
export declare function makeExportTool(rt: LocatorRuntime): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=export.d.ts.map