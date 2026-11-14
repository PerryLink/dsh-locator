/**
 * Capability index: which tool/skill/MCP action can do a job, what it costs and
 * what it may touch. This is a thin adapter over the DSH registries the host
 * already keeps (tool definitions, skill catalog): it does not re-implement
 * discovery, it adds intent matching, risk labels and a preflight check.
 * @module dsh-locator/capabilities
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
/** One capability card. */
export interface CapabilityCard {
    id: string;
    kind: 'tool' | 'mcp' | 'skill';
    name: string;
    summary: string;
    input?: Record<string, unknown>;
    tags: string[];
    risk: {
        level: 'read' | 'write' | 'exec';
        actions: string[];
        basis: 'schema' | 'name';
    };
    permission: {
        approval: 'none' | 'ask';
        sandbox: 'none' | 'write' | 'any';
    };
    state: 'available' | 'unknown';
    source: 'tools' | 'skills';
}
/** One snapshot of the live capability surface. */
export interface CapabilitySnapshot {
    builtAt: number;
    cards: CapabilityCard[];
    warnings: string[];
}
/** Minimal shape of the host services this module reads. */
export interface CapabilitySources {
    tools?: {
        definitions?: (scope?: unknown, toolSet?: unknown) => readonly unknown[];
        get?: (name: string, scope?: unknown) => unknown;
    } | undefined;
    skills?: {
        list?: (options?: Record<string, unknown>) => Promise<readonly unknown[]>;
    } | undefined;
}
/** Tokenize one intent/name for the lexical scorer (letters, digits, CJK). */
export declare function tokenize(text: string): string[];
/** Infer risk/permission from a tool name, description and parameter schema. */
export declare function inferRisk(name: string, description: string, parameters?: Record<string, unknown>): CapabilityCard['risk'] & {
    permission: CapabilityCard['permission'];
};
/** Build one capability snapshot from the live host services. */
export declare function buildCapabilitySnapshot(sources: CapabilitySources, scope?: unknown): Promise<CapabilitySnapshot>;
/** Card projection returned by tools: drop the full input schema payload. */
export declare function publicCard(card: CapabilityCard): Omit<CapabilityCard, 'input'>;
/** One ranked capability hit. */
export interface CapabilityHit {
    card: CapabilityCard;
    score: number;
    why: string[];
}
/**
 * Rank capability cards against an intent and optional filters.
 * @param cards - snapshot cards.
 * @param intent - what the caller wants to do.
 * @param options - kind/risk filters and pagination.
 * @returns ranked hits and the total before paging.
 */
export declare function searchCapabilities(cards: readonly CapabilityCard[], intent: string, options?: {
    kinds?: readonly CapabilityCard['kind'][];
    riskMax?: 'read' | 'write' | 'exec';
    limit?: number;
    offset?: number;
    availableOnly?: boolean;
}): {
    hits: CapabilityHit[];
    total: number;
};
/** One preflight result. */
export interface PreflightResult {
    ok: boolean;
    card?: CapabilityCard;
    admitted: boolean;
    schema?: {
        valid: boolean;
        violations: string[];
    };
    requires: {
        approval: 'none' | 'ask';
        sandbox: 'none' | 'write' | 'any';
    };
    sideEffects: string[];
    next: {
        callable: boolean;
        suggestion?: string;
    };
    error?: string;
    warnings: string[];
}
/**
 * Check whether one capability can be called with the given arguments right
 * now: existence/visibility, argument schema, predicted approval/sandbox and
 * side effects. It never executes the target.
 */
export declare function preflightCapability(snapshot: CapabilitySnapshot, target: string, args?: Record<string, unknown>, sources?: CapabilitySources, scope?: unknown): PreflightResult;
/** JSON payload for the Web panel's capability search. */
export interface CapabilitySearchPayload {
    ok: boolean;
    intent: string;
    total: number;
    returned: number;
    hits: Array<{
        card: Omit<CapabilityCard, 'input'>;
        score: number;
        why: string[];
    }>;
    warnings: string[];
}
/** Build one capability snapshot and rank cards for the Web panel. */
export declare function searchCapabilityCards(sources: CapabilitySources, intent: string, options?: {
    kinds?: readonly CapabilityCard['kind'][];
    riskMax?: 'read' | 'write' | 'exec';
    limit?: number;
    offset?: number;
}): Promise<CapabilitySearchPayload>;
/** Preflight one capability for the Web panel (no execution). */
export declare function preflightCapabilityCard(sources: CapabilitySources, capability: string, args?: Record<string, unknown>): Promise<unknown>;
/** Build `capability_search` and `capability_preflight` bound to the host registries. */
export declare function makeCapabilityTools(sources: CapabilitySources): readonly [import("@deepseek-ai/dsh-tools").ToolDefinition, import("@deepseek-ai/dsh-tools").ToolDefinition];
/** ToolRunContext re-export keeps the module self-describing for tests. */
export type { ToolRunContext };
//# sourceMappingURL=capabilities.d.ts.map