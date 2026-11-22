/**
 * locator_find — the single AI-first search entry point of dsh-locator 0.22.0.
 *
 * One call covers the four legacy search surfaces: file names (locator_search),
 * file/session bodies (locator_find), code symbols (locator_symbol) and file
 * metadata filtering. The tool keeps the reviewed search engines untouched and
 * only re-shapes their results into the shared agent envelope (see
 * agent-core.ts): a compact item budget, an opaque continuation cursor and a
 * closed error-code set.
 *
 * Mode resolution (`auto`): a query that is an exact indexed identifier wins
 * (symbol), then body search when the content index is ready and the query has
 * a 3+ character term (body), then file-name search (name). The resolved mode
 * is echoed and pinned into the continuation cursor, so pages cannot flip
 * between sources mid-pagination.
 * @module dsh-locator/agent-find
 */
import type { ContentIndex } from './content.ts';
import { type AgentBudget, type AgentCoverage, type AgentDetail, type AgentFailureEnvelope, type AgentFindMode, type AgentItem, type AgentPage, type AgentScopeMode, type AgentSuccessBase } from './agent-core.ts';
import type { LocatorRuntime } from './runtime.ts';
import { type Scope } from './scope.ts';
/** One row kind locator_find can return. */
export type AgentFindKind = AgentItem['kind'];
/** Confidence of a match count. */
export type AgentFindCountKind = 'exact' | 'bounded' | 'unknown';
/** Scope actually searched after an automatic workspace widening. */
export interface AgentFindScopeEcho {
    /** Scope the caller asked for. */
    requested: AgentScopeMode;
    /** Scope actually searched. */
    effective: AgentScopeMode;
    /** True when effective differs from requested. */
    fallback: boolean;
    /** Why the scope was widened. */
    fallbackReason?: string;
}
/** Match counts known for this page (absent numbers are unknown). */
export interface AgentFindCounts {
    /** Primary match count when known. */
    total?: number;
    /** Confidence of total. */
    totalKind?: AgentFindCountKind;
    /** Name-index match count (name mode). */
    nameTotal?: number;
    /** Content-index match count (body mode). */
    bodyTotal?: number;
    /** Confidence of bodyTotal. */
    bodyKind?: AgentFindCountKind;
    /** Symbol match count (symbol mode). */
    symbolTotal?: number;
}
/** Optional collaborators of the locator_find factory. */
export interface AgentFindOptions {
    /** Layered ignore rules; omitted means no filtering beyond the index roots. */
    scope?: Scope;
    /** Allow body search to read sessions outside the caller workspace (scope all). */
    allowCrossWorkspaceSessions?: boolean;
    /** Embedder default for maxChars; the contract default is 6,000 characters. */
    maxChars?: number;
}
/** Success envelope of locator_find. */
export interface AgentFindSuccess extends AgentSuccessBase {
    /** Trimmed query. */
    query: string;
    /** Mode the caller asked for. */
    mode: AgentFindMode;
    /** Mode actually used after auto resolution. */
    resolvedMode: 'name' | 'body' | 'symbol';
    /** Detail preset used to trim the items. */
    detail: AgentDetail;
    /** Scope echo (requested vs effective). */
    scope: AgentFindScopeEcho;
    /** Result rows for this page. */
    items: AgentItem[];
    /** Page/cursor block. */
    page: AgentPage;
    /** Match counts. */
    counts: AgentFindCounts;
    /** Coverage/fallback notes. */
    coverage: AgentCoverage;
    /** Item budget report. */
    budget: AgentBudget;
}
/** Result of one locator_find call (success or uniform failure). */
export type AgentFindResult = AgentFindSuccess | AgentFailureEnvelope;
/** Build the locator_find tool. */
export declare function makeAgentFindTool(rt: LocatorRuntime, content?: ContentIndex, ensure?: () => void, options?: AgentFindOptions): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=agent-find.d.ts.map