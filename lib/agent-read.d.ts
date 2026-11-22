/**
 * locator_read — the AI-first read/citation tool of the 0.22.0 interface.
 *
 * It resolves one ref (or a bounded batch of refs, or a workspace file path)
 * through the same evidence layer as locator_resolve/locator_cite and returns
 * verbatim, whole-line excerpts plus the citation-ready quote form. The shared
 * envelope contract (apiVersion "2026-11", closed error codes) is imported from
 * src/agent-core.ts.
 * @module dsh-locator/agent-read
 */
import type { ContentIndex } from './content.ts';
import type { LocatorRuntime } from './runtime.ts';
/** Hard cap on refs[] per call (the schema cap is advisory on model input). */
export declare const READ_MAX_REFS = 20;
/** Hard cap on window (lines added on each side of the target line). */
export declare const READ_MAX_WINDOW = 20;
/** Default and hard caps for one excerpt's text budget. */
export declare const READ_DEFAULT_MAX_BYTES = 2000;
export declare const READ_MAX_BYTES = 65536;
/** One line is never returned longer than this (mirrors locator_resolve). */
export declare const READ_MAX_LINE_CHARS = 65536;
declare const READ_MODES: readonly ["meta", "excerpt", "quote"];
/** Options accepted by the read factory (reserved for embedder wiring). */
export interface AgentReadOptions {
    /** Override the maximum refs accepted in one call (tests/embedders only). */
    maxRefs?: number;
}
/** Build the locator_read tool. */
export declare function makeAgentReadTool(rt: LocatorRuntime, content?: ContentIndex, options?: AgentReadOptions): import("@deepseek-ai/dsh-tools").ToolDefinition;
export { READ_MODES };
//# sourceMappingURL=agent-read.d.ts.map