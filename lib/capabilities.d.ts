/**
 * Capability index: which tool/skill/MCP action can do a job, what it costs and
 * what it may touch. This is a thin adapter over the DSH registries the host
 * already keeps (tool definitions, skill catalog): it does not re-implement
 * discovery, it adds intent matching, risk labels and a preflight check.
 * @module dsh-locator/capabilities
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { type ErrorInfo } from './scope.ts';
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
        basis: 'override' | 'mixed' | 'schema' | 'name';
    };
    permission: {
        approval: 'none' | 'ask';
        sandbox: 'none' | 'write' | 'any';
    };
    state: 'available' | 'unknown';
    source: 'tools' | 'skills';
    /**
     * 0.23.0: the host asked to defer this tool's schema (legacy surface). Deferred
     * cards rank below resident ones and their keyword matches weigh less, so the
     * 3+1 AI-first tools stay on top without hiding real maintenance tools.
     */
    deferred: boolean;
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
/**
 * Infer risk/permission from a tool name and parameter schema.
 *
 * 0.23.0 P0-9: the description no longer feeds the exec/write keyword match.
 * Descriptions legitimately NAME dangerous things as the thing a read-only tool
 * replaces ("use it instead of shell cat/head") or warns against ("do not
 * install image libraries"), which made locator_read look exec and read_image
 * look write. Only the name (and the declared schema) can declare side effects;
 * the description still feeds discovery keywords/tags. The parameter is kept
 * for API compatibility and future heuristics.
 * @param name - tool name; the only keyword source for exec/write inference.
 * @param _description - accepted for compatibility; not used for risk keywords.
 * @param parameters - declared parameter schema (JSON-Schema shape).
 * @returns risk level/actions/basis plus the approval/sandbox permission echo.
 */
export declare function inferRisk(name: string, _description: string, parameters?: Record<string, unknown>): CapabilityCard['risk'] & {
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
    /** 0.21.1: ok mirrors admitted (false when the call is not authorized/valid). */
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
    /** Legacy string code; mirrors errorInfo.code when ok is false. */
    error?: string;
    /** Structured failure detail (0.21.1, additive). */
    errorInfo?: ErrorInfo;
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
    /** Offset of the next page; absent when this page is the last one (0.21.1). */
    nextOffset?: number;
    /** True when more ranked cards exist beyond this page (0.21.1). */
    truncated?: boolean;
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