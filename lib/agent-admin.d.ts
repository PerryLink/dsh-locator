/**
 * locator_admin — deferred-loading maintenance actions for the 0.22.0 interface.
 *
 * One tool routes the three existing maintenance factories (locator_rebuild,
 * locator_reindex, locator_export) through the shared envelope instead of
 * registering three always-visible tools. The underlying business logic is
 * reused verbatim: this module only validates/routes arguments and maps the
 * legacy result/error shapes onto the closed agent error set.
 * @module dsh-locator/agent-admin
 */
import type { ContentIndex } from './content.ts';
import type { LocatorRuntime } from './runtime.ts';
import { type AgentErrorInfo } from './agent-core.ts';
/** Deferred-loading maintenance tool: writes and can be slow. */
export declare const ADMIN_ACTIONS: readonly ["rebuild", "reindex", "export"];
/** Wiring for the admin tool; the plugin passes its runtime/content/ensure hook. */
export interface AgentAdminToolOptions {
    rt: LocatorRuntime;
    content?: ContentIndex;
    ensure?: () => void;
}
/** Union of the legacy rebuild/reindex/export result shapes this module reads. */
interface LegacyAdminResult {
    ok: boolean;
    started?: boolean;
    full?: boolean;
    path?: string;
    rows?: number;
    bytes?: number;
    tookMs?: number;
    error?: string;
    errorInfo?: {
        code?: string;
        hint?: string;
    };
}
/** Map one legacy maintenance failure onto the closed agent error set. */
export declare function adminErrorOf(value: LegacyAdminResult): AgentErrorInfo;
/** Build the locator_admin tool (deferLoading: write operations, loaded on demand). */
export declare function makeAgentAdminTool(options: AgentAdminToolOptions): import("@deepseek-ai/dsh-tools").ToolDefinition;
export {};
//# sourceMappingURL=agent-admin.d.ts.map