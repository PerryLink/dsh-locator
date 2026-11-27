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
 * Mode `auto` merges every source its `kinds` allow instead of resolving to a
 * single first-non-empty source (0.23): symbol declarations (identifier-shaped
 * queries only, headings excluded), body hits from the content index, and
 * file/dir names. The streams are merged by a stable rank (symbol exact, then
 * body BM25/coverage, then symbol prefix, then name prefix/substring), rows
 * with the same identity are merged into one item with `why`/`sources` union,
 * and the page's continuation cursor (v2) pins the consumed position of every
 * source so pagination neither loses nor re-fetches a row. Single-source modes
 * keep emitting the v1 cursor, and a v1 cursor is only accepted there.
 * @module dsh-locator/agent-find
 */
import type { ContentIndex } from './content.ts';
import { type AgentBudget, type AgentCoverage, type AgentDetail, type AgentFailureEnvelope, type AgentFindMode, type AgentItem, type AgentItemSource, type AgentPage, type AgentScopeMode, type AgentSuccessBase } from './agent-core.ts';
import { type CallerIdentity } from './find.ts';
import type { LocatorRuntime } from './runtime.ts';
import { type Scope } from './scope.ts';
/** One row kind locator_find can return. */
export type AgentFindKind = AgentItem['kind'];
/** Confidence of a match count. */
export type AgentFindCountKind = 'exact' | 'bounded' | 'unknown';
/** One index source of the auto cross-source merge. */
export type AgentFindSource = AgentItemSource;
/** Mode auto reports after merging: a single source or "mixed" when several contributed. */
export type AgentFindResolvedMode = 'name' | 'body' | 'symbol' | 'mixed';
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
    /** Mode actually used: a single source, or "mixed" for a cross-source auto page. */
    resolvedMode: AgentFindResolvedMode;
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
/**
 * Run one fully-validated locator_find call.
 *
 * Resolves the mode, pins the cursor scope/mode, fetches one page from the
 * chosen source, applies the detail preset and the item budget, and assembles
 * the success/failure envelope. Empty page one in workspace scope is widened
 * to every configured root exactly once (never silently).
 * @param rt - locator runtime.
 * @param content - optional content index (body/symbol modes).
 * @param ensure - lazy content boot hook.
 * @param options - factory options.
 * @param caller - caller session/cwd identity.
 * @param rawArgs - raw argument object.
 * @param started - call start timestamp.
 * @returns the success or failure envelope.
 */
export declare function runAgentFind(rt: LocatorRuntime, content: ContentIndex | undefined, ensure: (() => void) | undefined, options: AgentFindOptions, caller: CallerIdentity, rawArgs: unknown, started: number): Promise<AgentFindResult>;
/** Build the locator_find tool. */
export declare function makeAgentFindTool(rt: LocatorRuntime, content?: ContentIndex, ensure?: () => void, options?: AgentFindOptions): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Host parameter DSL of locator_find (source of truth for generated MCP/CLI JSON Schema). */
export declare const AGENT_FIND_PARAMETERS: {
    readonly query: {
        readonly type: "string";
        readonly required: true;
        readonly description: "Words/phrase, name fragment or identifier. Empty is rejected.";
    };
    readonly mode: {
        readonly type: "string";
        readonly enum: readonly ["auto", "name", "body", "symbol"];
        readonly description: "auto (merge symbol/body/name by kinds), name, body or symbol.";
    };
    readonly kinds: {
        readonly type: "array";
        readonly items: {
            readonly type: "string";
            readonly enum: readonly ["file", "dir", "session", "symbol"];
        };
        readonly description: "Row kinds to return (default all).";
    };
    readonly where: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly properties: {
            readonly pathPrefix: {
                readonly type: "string";
                readonly description: "Only rows under this directory (inside the roots).";
            };
            readonly ext: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Only these lower-case extensions (no dot).";
            };
            readonly modifiedAfter: {
                readonly type: "string";
                readonly description: "ISO-8601 time or epoch-ms mtime lower bound.";
            };
            readonly minSize: {
                readonly type: "integer";
                readonly description: "Minimum file size in bytes.";
            };
        };
        readonly description: "Metadata filters applied before paging.";
    };
    readonly scope: {
        readonly type: "string";
        readonly enum: readonly ["workspace", "roots", "all"];
        readonly description: "workspace (cwd/session), roots (all roots) or all (+cross-workspace sessions).";
    };
    readonly limit: {
        readonly type: "integer";
        readonly description: "Items per page (default 10, max 50).";
    };
    readonly cursor: {
        readonly type: "string";
        readonly description: "Opaque page.nextCursor; mutually exclusive with offset.";
    };
    readonly offset: {
        readonly type: "integer";
        readonly description: "Legacy row offset (prefer cursor).";
    };
    readonly maxChars: {
        readonly type: "integer";
        readonly description: "Item budget in characters (default 6000; 0 = unlimited).";
    };
    readonly detail: {
        readonly type: "string";
        readonly enum: readonly ["compact", "standard", "full"];
        readonly description: "compact (default), standard (+freshness) or full (+ids/hash/permissions).";
    };
    readonly count: {
        readonly type: "string";
        readonly enum: readonly ["exact", "bounded", "none"];
        readonly description: "exact (default), bounded or none (none omits all counts).";
    };
    readonly includeArchived: {
        readonly type: "boolean";
        readonly description: "Search archived sessions in body results too (default false).";
    };
};
/** Host output DSL of locator_find (source of truth for generated MCP/CLI JSON Schema). */
export declare const AGENT_FIND_OUTPUT: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly query: {
            readonly type: "string";
        };
        readonly mode: {
            readonly type: "string";
            readonly enum: readonly ["auto", "name", "body", "symbol"];
        };
        readonly resolvedMode: {
            readonly type: "string";
            readonly enum: readonly ["name", "body", "symbol", "mixed"];
        };
        readonly detail: {
            readonly type: "string";
            readonly enum: readonly ["compact", "standard", "full"];
        };
        readonly scope: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly requested: {
                    readonly type: "string";
                    readonly required: true;
                    readonly enum: readonly ["workspace", "roots", "all"];
                    readonly description: "Scope the caller asked for.";
                };
                readonly effective: {
                    readonly type: "string";
                    readonly required: true;
                    readonly enum: readonly ["workspace", "roots", "all"];
                    readonly description: "Scope actually searched (after a workspace fallback).";
                };
                readonly fallback: {
                    readonly type: "boolean";
                    readonly description: "True when the effective scope was widened from the requested one.";
                };
                readonly fallbackReason: {
                    readonly type: "string";
                    readonly description: "Why the scope was widened.";
                };
            };
        };
        readonly items: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly properties: {
                    readonly kind: {
                        readonly type: "string";
                        readonly required: true;
                        readonly enum: readonly ["file", "dir", "session", "symbol"];
                    };
                    readonly path: {
                        readonly type: "string";
                        readonly required: true;
                    };
                    readonly title: {
                        readonly type: "string";
                    };
                    readonly name: {
                        readonly type: "string";
                        readonly description: "Symbol declaration name (full detail only).";
                    };
                    readonly line: {
                        readonly type: "integer";
                        readonly description: "1-based matched/declaration line, when known.";
                    };
                    readonly snippet: {
                        readonly type: "string";
                        readonly description: "Bounded matched text (compact: at most 160 code points).";
                    };
                    readonly why: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                        readonly description: "Why this row matched, e.g. \"symbol:exact\" or \"body:terms\".";
                    };
                    readonly sources: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                            readonly enum: readonly ["name", "body", "symbol"];
                        };
                        readonly description: "Index sources that produced this row (auto mode; merged rows list every source).";
                    };
                    readonly score: {
                        readonly type: "number";
                        readonly description: "Relevance score (content rank; lower is better for FTS5 bm25).";
                    };
                    readonly ref: {
                        readonly type: "string";
                        readonly description: "Citable evidence ref (ref://file or dsh-session:...).";
                    };
                    readonly refStatus: {
                        readonly type: "string";
                        readonly enum: readonly ["fresh", "stale", "missing", "tombstoned", "unknown"];
                        readonly description: "Evidence freshness label (standard/full).";
                    };
                    readonly freshness: {
                        readonly type: "object";
                        readonly additionalProperties: false;
                        readonly properties: {
                            readonly state: {
                                readonly type: "string";
                                readonly required: true;
                                readonly enum: readonly ["fresh", "stale", "missing", "unknown"];
                            };
                            readonly observedAt: {
                                readonly type: "integer";
                                readonly description: "Epoch ms of the observation behind this state.";
                            };
                            readonly mtime: {
                                readonly type: "integer";
                                readonly description: "Current on-disk mtime in epoch ms, when observed.";
                            };
                        };
                    };
                    readonly hash: {
                        readonly type: "string";
                        readonly description: "sha256 of the file bytes (full detail only).";
                    };
                    readonly permissions: {
                        readonly type: "object";
                        readonly additionalProperties: false;
                        readonly properties: {
                            readonly read: {
                                readonly type: "string";
                                readonly required: true;
                                readonly enum: readonly ["allowed", "denied"];
                            };
                            readonly visibility: {
                                readonly type: "string";
                                readonly required: true;
                                readonly enum: readonly ["workspace", "roots", "session", "external"];
                            };
                            readonly reason: {
                                readonly type: "string";
                            };
                        };
                    };
                    readonly provenance: {
                        readonly type: "object";
                        readonly additionalProperties: false;
                        readonly properties: {
                            readonly origin: {
                                readonly type: "string";
                                readonly required: true;
                                readonly enum: readonly ["index", "tool", "session", "web"];
                            };
                            readonly path: {
                                readonly type: "string";
                            };
                            readonly sessionId: {
                                readonly type: "string";
                            };
                            readonly messageId: {
                                readonly type: "string";
                            };
                            readonly indexedAt: {
                                readonly type: "integer";
                                readonly description: "Epoch ms when the index last stored this object.";
                            };
                            readonly url: {
                                readonly type: "string";
                            };
                            readonly callId: {
                                readonly type: "string";
                            };
                        };
                    };
                    readonly sessionId: {
                        readonly type: "string";
                        readonly description: "Session id for session rows (full detail only).";
                    };
                    readonly messageId: {
                        readonly type: "string";
                        readonly description: "Message id for session rows (full detail only).";
                    };
                    readonly seq: {
                        readonly type: "integer";
                        readonly description: "Indexed event sequence for session rows (compact/standard/full).";
                    };
                    readonly eventRef: {
                        readonly type: "string";
                        readonly description: "Full ref://session-event?sid=...&seq=N reference for session rows (compact/standard/full).";
                    };
                    readonly size: {
                        readonly type: "integer";
                        readonly description: "File size in bytes (full detail only).";
                    };
                    readonly mtime: {
                        readonly type: "integer";
                        readonly description: "Modification time in epoch ms (full detail only).";
                    };
                    readonly modified: {
                        readonly type: "string";
                        readonly description: "ISO-8601 modification time (full detail only).";
                    };
                    readonly ext: {
                        readonly type: "string";
                        readonly description: "Lower-case file extension without the dot (full detail only).";
                    };
                    readonly dir: {
                        readonly type: "boolean";
                        readonly description: "True for directory rows (full detail only).";
                    };
                    readonly format: {
                        readonly type: "string";
                        readonly description: "Extracted document format (full detail only).";
                    };
                    readonly language: {
                        readonly type: "string";
                        readonly description: "Symbol language (standard/full).";
                    };
                    readonly symbolScope: {
                        readonly type: "string";
                        readonly description: "Enclosing type/namespace of a symbol (standard/full).";
                    };
                    readonly context: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                        readonly description: "Surrounding source lines for a body hit (full detail only).";
                    };
                    readonly contextStart: {
                        readonly type: "integer";
                        readonly description: "1-based line number of context[0] (full detail only).";
                    };
                };
            };
        };
        readonly page: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly limit: {
                    readonly type: "integer";
                    readonly required: true;
                    readonly description: "Effective page-size cap for this call.";
                };
                readonly returned: {
                    readonly type: "integer";
                    readonly required: true;
                    readonly description: "Items on this page (after budget trimming).";
                };
                readonly more: {
                    readonly type: "boolean";
                    readonly required: true;
                    readonly description: "True when paging further can return more items.";
                };
                readonly nextCursor: {
                    readonly type: "string";
                    readonly description: "Opaque continuation token; present only when more is true.";
                };
            };
        };
        readonly counts: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly total: {
                    readonly type: "integer";
                    readonly description: "Primary match count when known.";
                };
                readonly totalKind: {
                    readonly type: "string";
                    readonly enum: readonly ["exact", "bounded", "unknown"];
                    readonly description: "Confidence of total.";
                };
                readonly nameTotal: {
                    readonly type: "integer";
                    readonly description: "Name-index match count (name mode).";
                };
                readonly bodyTotal: {
                    readonly type: "integer";
                    readonly description: "Content-index match count (body mode).";
                };
                readonly bodyKind: {
                    readonly type: "string";
                    readonly enum: readonly ["exact", "bounded", "unknown"];
                    readonly description: "Confidence of bodyTotal.";
                };
                readonly symbolTotal: {
                    readonly type: "integer";
                    readonly description: "Symbol match count (symbol mode).";
                };
            };
        };
        readonly coverage: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly indexing: {
                    readonly type: "boolean";
                    readonly required: true;
                    readonly description: "The index is still building; this page is partial.";
                };
                readonly indexTruncated: {
                    readonly type: "boolean";
                    readonly required: true;
                    readonly description: "The content build dropped documents because of its size budget.";
                };
                readonly notes: {
                    readonly type: "array";
                    readonly required: true;
                    readonly items: {
                        readonly type: "object";
                        readonly additionalProperties: false;
                        readonly properties: {
                            readonly code: {
                                readonly type: "string";
                                readonly required: true;
                            };
                            readonly severity: {
                                readonly type: "string";
                                readonly required: true;
                                readonly enum: readonly ["info", "warn", "error"];
                            };
                            readonly message: {
                                readonly type: "string";
                                readonly required: true;
                            };
                        };
                    };
                };
            };
        };
        readonly budget: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly limitChars: {
                    readonly type: "integer";
                    readonly required: true;
                    readonly description: "Effective soft cap in characters; 0 means unlimited.";
                };
                readonly usedChars: {
                    readonly type: "integer";
                    readonly required: true;
                    readonly description: "Characters the returned items serialize to.";
                };
                readonly truncated: {
                    readonly type: "boolean";
                    readonly required: true;
                    readonly description: "True when items were dropped or the first item exceeds the cap.";
                };
                readonly dropped: {
                    readonly type: "integer";
                    readonly required: true;
                    readonly description: "Items kept out of this page by the budget.";
                };
            };
        };
        readonly error: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly code: {
                    readonly type: "string";
                    readonly required: true;
                    readonly enum: readonly ["invalid-argument", "query-too-short", "query-invalid", "scope-denied", "scope-empty-workspace", "not-found", "index-unavailable", "index-building", "budget-too-small", "cursor-invalid", "cancelled", "internal"];
                    readonly description: "Stable machine-readable error code.";
                };
                readonly message: {
                    readonly type: "string";
                    readonly required: true;
                    readonly description: "Human-readable message.";
                };
                readonly retryable: {
                    readonly type: "boolean";
                    readonly required: true;
                    readonly description: "True when the same call may succeed on retry.";
                };
                readonly remediation: {
                    readonly type: "string";
                    readonly description: "One actionable sentence for the caller.";
                };
                readonly nextTools: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Follow-up tools that can unblock the caller.";
                };
                readonly details: {
                    readonly type: "json";
                    readonly description: "Extra machine-readable context (never contains file contents).";
                };
            };
        };
        readonly apiVersion: {
            readonly type: "string";
            readonly required: true;
            readonly description: "Agent wire contract version.";
        };
        readonly ok: {
            readonly type: "boolean";
            readonly required: true;
        };
        readonly tool: {
            readonly type: "string";
            readonly required: true;
            readonly description: "Tool that produced the result.";
        };
        readonly timing: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly tookMs: {
                    readonly type: "number";
                    readonly required: true;
                    readonly description: "Milliseconds spent inside the tool call (never negative).";
                };
            };
        };
    };
};
//# sourceMappingURL=agent-find.d.ts.map