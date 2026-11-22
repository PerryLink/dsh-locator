/**
 * locator_status — the AI-first brief/full status tool of the 0.22.0 interface.
 *
 * detail:"brief" (default) reduces the legacy status payload to the few fields
 * a model needs to decide whether the index is usable (well under 600 chars),
 * while detail:"full" reuses the legacy locator_status payload and renderer
 * unchanged. The shared envelope contract is imported from src/agent-core.ts.
 * @module dsh-locator/agent-status
 */
import type { ContentIndex } from './content.ts';
import type { LocatorRuntime } from './runtime.ts';
import type { Scope } from './scope.ts';
/** The brief payload is designed to stay under this serialized size. */
export declare const STATUS_BRIEF_MAX_CHARS = 600;
/** Build the locator_status tool. */
export declare function makeAgentStatusTool(rt: LocatorRuntime, content?: ContentIndex, scope?: Scope): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=agent-status.d.ts.map