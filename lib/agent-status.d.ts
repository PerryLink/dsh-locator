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
/**
 * The brief payload is designed to stay under this serialized size. 0.23.0
 * raised it from 600 to 1,400 because the brief now carries what P0-5 showed it
 * was hiding: the engine warning (e.g. degraded watching), the root list and
 * the content-truncated flag. The bundled limits (4 roots, 96 chars each;
 * 240-char warning) keep even the worst case under this ceiling; a realistic
 * brief with 2 roots and a warning stays around 700-900 chars.
 */
export declare const STATUS_BRIEF_MAX_CHARS = 1400;
/** Longest engine warning kept in the brief; longer ones are cut with an ellipsis. */
export declare const STATUS_BRIEF_WARNING_MAX_CHARS = 240;
/** Index roots listed in the brief; the rest stays counted only. */
export declare const STATUS_BRIEF_MAX_ROOTS = 4;
/** Longest root path kept in the brief. */
export declare const STATUS_BRIEF_ROOT_MAX_CHARS = 96;
/** Build the locator_status tool. */
export declare function makeAgentStatusTool(rt: LocatorRuntime, content?: ContentIndex, scope?: Scope): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=agent-status.d.ts.map