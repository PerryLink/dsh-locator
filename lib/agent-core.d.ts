/**
 * Shared AI-first contract for the dsh-locator 0.22.0 tools
 * (locator_find / locator_read / locator_status / locator_admin).
 *
 * One envelope shape, one closed error-code set, one cursor format and one
 * detail/budget model, so every new tool answers in the same machine-readable
 * shape while the legacy tools keep their historical output. This module is a
 * dependency-light leaf: it imports only node:crypto and must stay importable
 * from every agent-facing tool (and from tests) without touching the runtime,
 * the content store or the engine.
 * @module dsh-locator/agent-core
 */
/** Version of the agent-facing wire contract; bumps only on a breaking change. */
export declare const AGENT_API_VERSION: "2026-11";
/** Default item budget in characters (the budget counts items only). */
export declare const AGENT_DEFAULT_MAX_CHARS = 6000;
/** Smallest useful maxChars: below this one compact item cannot fit. */
export declare const AGENT_MIN_BUDGET_CHARS = 120;
/** Default page size. */
export declare const AGENT_DEFAULT_LIMIT = 10;
/** Hard cap on one page of items. */
export declare const AGENT_MAX_LIMIT = 50;
/** Compact snippets are cut at this many code points (the default detail). */
export declare const COMPACT_SNIPPET_CHARS = 160;
/** Standard snippets are cut at this many code points. */
export declare const STANDARD_SNIPPET_CHARS = 240;
/** Full snippets are cut at this many code points. */
export declare const FULL_SNIPPET_CHARS = 320;
/** Cursor payload version of the single-source contract (0.22; still accepted). */
export declare const CURSOR_VERSION: 1;
/** Cursor payload version of the cross-source auto contract (0.23). */
export declare const CURSOR_VERSION_V2: 2;
/** Most file-identity hashes one v2 cursor remembers (bounded cursor size). */
export declare const CURSOR_SEEN_MAX = 96;
/** Tool names that speak the agent envelope. */
export type AgentToolName = 'locator_find' | 'locator_read' | 'locator_status' | 'locator_admin';
/** Search modes understood by locator_find (auto resolves symbol -> body -> name). */
export declare const AGENT_FIND_MODES: readonly ["auto", "name", "body", "symbol"];
/** One locator_find mode. */
export type AgentFindMode = (typeof AGENT_FIND_MODES)[number];
/** Scope modes shared by the agent tools. */
export declare const AGENT_SCOPE_MODES: readonly ["workspace", "roots", "all"];
/** One scope mode: caller workspace, every configured root, or cross-workspace. */
export type AgentScopeMode = (typeof AGENT_SCOPE_MODES)[number];
/** Detail presets: compact (default) trims items hardest, full keeps evidence. */
export declare const AGENT_DETAILS: readonly ["compact", "standard", "full"];
/** One detail preset. */
export type AgentDetail = (typeof AGENT_DETAILS)[number];
/** Closed machine-readable error codes of the agent envelope. */
export declare const AGENT_ERROR_CODES: {
    readonly invalidArgument: "invalid-argument";
    readonly queryTooShort: "query-too-short";
    readonly queryInvalid: "query-invalid";
    readonly scopeDenied: "scope-denied";
    readonly scopeEmptyWorkspace: "scope-empty-workspace";
    readonly notFound: "not-found";
    readonly indexUnavailable: "index-unavailable";
    readonly indexBuilding: "index-building";
    readonly budgetTooSmall: "budget-too-small";
    readonly cursorInvalid: "cursor-invalid";
    readonly cancelled: "cancelled";
    readonly internal: "internal";
};
/** Union of the closed agent error codes. */
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[keyof typeof AGENT_ERROR_CODES];
/** Default retryability of each code (an explicit option can override it). */
export declare const AGENT_ERROR_RETRYABLE: Readonly<Record<AgentErrorCode, boolean>>;
/** Default human message of each code (used when no message is supplied). */
export declare const AGENT_ERROR_MESSAGES: Readonly<Record<AgentErrorCode, string>>;
/** Default actionable remediation of each code. */
export declare const AGENT_ERROR_REMEDIATION: Readonly<Record<AgentErrorCode, string>>;
/** Default follow-up tools advertised next to each code. */
export declare const AGENT_ERROR_NEXT_TOOLS: Readonly<Partial<Record<AgentErrorCode, readonly string[]>>>;
/** Wall-clock cost of one tool call. */
export interface AgentTiming {
    /** Milliseconds spent inside the tool call (never negative). */
    tookMs: number;
}
/** One machine-readable coverage note (fallbacks, partial indexes, filters). */
export interface AgentCoverageNote {
    /** Stable note code, e.g. "scope-fallback" or "index-building". */
    code: string;
    /** How much the note matters for trusting this page. */
    severity: 'info' | 'warn' | 'error';
    /** One sentence the model can act on. */
    message: string;
}
/** How complete the result is relative to the indexes. */
export interface AgentCoverage {
    /** The name/content index is still building; this page is partial. */
    indexing: boolean;
    /** The content build dropped documents because of its size budget. */
    indexTruncated: boolean;
    /** Actionable notes, in the order they were discovered. */
    notes: AgentCoverageNote[];
}
/** Per-call character budget report (items only, never the envelope). */
export interface AgentBudget {
    /** Effective soft cap in characters; 0 means unlimited. */
    limitChars: number;
    /** Characters the returned items serialize to. */
    usedChars: number;
    /** True when items were dropped or the single first item exceeds the cap. */
    truncated: boolean;
    /** Items kept out of this page by the budget. */
    dropped: number;
}
/** One page of items with a continuation cursor only when more items exist. */
export interface AgentPage {
    /** Effective page-size cap for this call. */
    limit: number;
    /** Items on this page (after budget trimming). */
    returned: number;
    /** True when paging further can return more items. */
    more: boolean;
    /** Opaque continuation token; present only when more is true. */
    nextCursor?: string;
}
/** One evidence-friendly freshness block (standard/full detail). */
export interface AgentFreshness {
    state: 'fresh' | 'stale' | 'missing' | 'unknown';
    /** Epoch ms when the observation behind this state was made. */
    observedAt?: number;
    /** Current on-disk mtime in epoch ms, when observed. */
    mtime?: number;
}
/** Read permission as computed at query time (full detail only). */
export interface AgentPermissions {
    read: 'allowed' | 'denied';
    visibility: 'workspace' | 'roots' | 'session' | 'external';
    reason?: string;
}
/** Where the row came from (full detail only). */
export interface AgentProvenance {
    origin: 'index' | 'tool' | 'session' | 'web';
    path?: string;
    sessionId?: string;
    messageId?: string;
    /** Epoch ms when the index last stored this object. */
    indexedAt?: number;
    url?: string;
    callId?: string;
}
/** Kinds of rows the agent find/read tools can return. */
export type AgentItemKind = 'file' | 'dir' | 'session' | 'symbol';
/** Search source of one auto-mode row: the indexes it was merged from. */
export type AgentItemSource = 'name' | 'body' | 'symbol';
/**
 * One result row, in the superset shape. Tools build the superset and project
 * it with {@link trimItem} so detail presets never leak extra fields.
 */
export interface AgentItem {
    /** Row kind. */
    kind: AgentItemKind;
    /** Absolute file path (or session log path for session rows). */
    path: string;
    /** Human label (file name, session title, symbol name). */
    title?: string;
    /** Symbol declaration name (full detail only). */
    name?: string;
    /** 1-based matched/declaration line, when known. */
    line?: number;
    /** Bounded matched text (compact: at most 160 code points). */
    snippet?: string;
    /** Why this row matched, e.g. "symbol:exact", "body:terms", "name:prefix". */
    why?: string[];
    /** Index sources that produced this row (auto mode; merged rows list every source). */
    sources?: AgentItemSource[];
    /** Relevance score (content rank; lower is better for FTS5 bm25). */
    score?: number;
    /** Citable evidence ref (ref://file or dsh-session:...). */
    ref?: string;
    /** Evidence freshness label (standard/full). */
    refStatus?: 'fresh' | 'stale' | 'missing' | 'tombstoned' | 'unknown';
    /** Evidence freshness block (standard/full). */
    freshness?: AgentFreshness;
    /** sha256 of the file bytes (full detail only, opt-in upstream). */
    hash?: string;
    /** Read permission (full detail only). */
    permissions?: AgentPermissions;
    /** Evidence provenance (full detail only). */
    provenance?: AgentProvenance;
    /** Session id for session rows (full detail only). */
    sessionId?: string;
    /** Message id for session rows (full detail only). */
    messageId?: string;
    /** Indexed event sequence for session rows (compact/standard/full). */
    seq?: number;
    /** Full ref://session-event reference for session rows (compact/standard/full). */
    eventRef?: string;
    /** File size in bytes (full detail only). */
    size?: number;
    /** Modification time in epoch ms (full detail only). */
    mtime?: number;
    /** ISO-8601 modification time (full detail only). */
    modified?: string;
    /** Lower-case file extension without the dot (full detail only). */
    ext?: string;
    /** True for directory rows (full detail only). */
    dir?: boolean;
    /** Extracted document format: pdf/docx/xlsx/pptx/epub (full detail only). */
    format?: string;
    /** Symbol language (standard/full). */
    language?: string;
    /** Enclosing type/namespace of a symbol (standard/full). */
    symbolScope?: string;
    /** Surrounding source lines for a body hit (full detail only). */
    context?: string[];
    /** 1-based line number of context[0] (full detail only). */
    contextStart?: number;
}
/** Structured error detail carried by the failure envelope. */
export interface AgentErrorInfo {
    /** Stable machine-readable code. */
    code: AgentErrorCode;
    /** Human-readable message. */
    message: string;
    /** True when the same call may succeed on retry. */
    retryable: boolean;
    /** One actionable sentence for the caller. */
    remediation?: string;
    /** Follow-up tools that can unblock the caller. */
    nextTools?: string[];
    /** Extra machine-readable context (never contains file contents). */
    details?: Record<string, unknown>;
}
/** Uniform failure envelope. */
export interface AgentFailureEnvelope {
    /** Wire contract version. */
    apiVersion: typeof AGENT_API_VERSION;
    /** Always false. */
    ok: false;
    /** Tool that produced the failure. */
    tool: string;
    /** The closed error block. */
    error: AgentErrorInfo;
    /** Wall-clock cost, when known. */
    timing?: AgentTiming;
}
/** Shared success fields of every agent envelope. */
export interface AgentSuccessBase {
    /** Wire contract version. */
    apiVersion: typeof AGENT_API_VERSION;
    /** Always true. */
    ok: true;
    /** Tool that produced the result. */
    tool: string;
    /** Wall-clock cost. */
    timing?: AgentTiming;
}
/** One success envelope: the shared base plus tool-specific fields. */
export type AgentSuccessResult<TFields extends Record<string, unknown> = Record<string, never>> = AgentSuccessBase & TFields;
/** Optional overrides for {@link makeError}. */
export interface AgentErrorOptions {
    /** Tool that produced the failure (defaults to locator_find). */
    tool?: string;
    /** Override the default retryability of the code. */
    retryable?: boolean;
    /** Override the default remediation sentence. */
    remediation?: string;
    /** Override the default follow-up tool list (empty array omits it). */
    nextTools?: readonly string[];
    /** Extra machine-readable detail merged into error.details. */
    details?: Record<string, unknown>;
    /** Wall-clock cost, when the caller measured it. */
    timing?: AgentTiming;
}
/**
 * Build the uniform failure envelope for one error code.
 *
 * The message falls back to {@link AGENT_ERROR_MESSAGES}, retryability and
 * remediation to their per-code tables; explicit options win. This is the only
 * constructor the agent tools use, so every failure path shares one shape.
 * @param code - closed agent error code.
 * @param message - human message (defaults to the code message).
 * @param options - retryability/remediation/nextTools/details/tool/timing overrides.
 * @returns the failure envelope.
 */
export declare function makeError(code: AgentErrorCode, message?: string, options?: AgentErrorOptions): AgentFailureEnvelope;
/** Wrap an already-built error block in the failure envelope. */
export declare function agentFailure(tool: string, error: AgentErrorInfo, timing?: AgentTiming): AgentFailureEnvelope;
/** Wrap one tool result in the uniform success envelope. */
export declare function agentSuccess<TFields extends Record<string, unknown>>(tool: string, fields: TFields, timing?: AgentTiming): AgentSuccessResult<TFields>;
/** Measure one tool call from a start timestamp. */
export declare function makeTiming(startedAt: number): AgentTiming;
/** Build one coverage note. */
export declare function coverageNote(code: string, message: string, severity?: AgentCoverageNote['severity']): AgentCoverageNote;
/** Build the coverage block (empty notes by default). */
export declare function makeCoverage(options?: {
    indexing?: boolean;
    indexTruncated?: boolean;
    notes?: readonly AgentCoverageNote[];
}): AgentCoverage;
/** Message of an unknown thrown value, safe for envelopes. */
export declare function errorMessage(error: unknown): string;
/** Cut a snippet to the detail preset cap (code-point safe, appends an ellipsis). */
export declare function trimSnippet(text: string, detail?: AgentDetail): string;
/** Project one item onto the detail preset's field set (never mutates the input). */
export declare function trimItem(item: AgentItem, detail?: AgentDetail): AgentItem;
/** Serialized cost estimate of one trimmed item, in characters. */
export declare function estimateItemChars(item: AgentItem): number;
/** Serialized cost estimate of an item list, in characters. */
export declare function estimateItemsChars(items: readonly AgentItem[]): number;
/** Result of one budget trim. */
export interface AgentItemBudgetResult {
    /** Items that fit the budget (at least one is always kept). */
    items: AgentItem[];
    /** Budget report for the kept items. */
    budget: AgentBudget;
    /** Items dropped by the budget. */
    dropped: number;
}
/**
 * Trim an item list so its serialized items stay inside maxChars.
 *
 * Only the variable item payload is measured (envelope/timing/coverage are
 * fixed cost); the first item is always kept so a single long snippet cannot
 * turn a valid hit into an empty page. maxChars <= 0 disables the trim.
 * @param items - already detail-trimmed items in result order.
 * @param maxChars - soft cap in characters; 0 or negative means unlimited.
 * @returns kept items, their budget report and the dropped count.
 */
export declare function applyItemBudget(items: readonly AgentItem[], maxChars: number): AgentItemBudgetResult;
/** Opaque continuation cursor of a single-source locator_find page (v1). */
export interface AgentCursorPayload {
    /** Payload version; only CURSOR_VERSION is decoded for this shape. */
    v: 1;
    /** Effective search mode this page belongs to. */
    mode: AgentFindMode;
    /** Hash binding the cursor to the query, mode, scope, kinds and where filters. */
    queryHash: string;
    /** Absolute store offset of the first not-yet-returned row. */
    offset: number;
    /** Effective scope of the paginated search (set after a workspace fallback). */
    scope?: AgentScopeMode;
    /** Index generation observed when the cursor was issued (informational). */
    generation?: number;
}
/**
 * Per-source continuation positions of a cross-source auto page (v2).
 *
 * Each value is the raw position one past the last row already consumed from
 * that source stream; the next page resumes there, so a source row is never
 * fetched twice. A source absent from the object is consumed from position 0
 * (and is not part of the page's source set).
 */
export interface AgentCursorOffsetsV2 {
    /** Raw name-index rows consumed by earlier pages. */
    name?: number;
    /** Raw content-search rows consumed by earlier pages. */
    body?: number;
    /** Visible symbol rows consumed by earlier pages. */
    symbol?: number;
}
/** Opaque continuation cursor of a cross-source auto page (v2). */
export interface AgentCursorV2Payload {
    /** Payload version; only CURSOR_VERSION_V2 is decoded for this shape. */
    v: 2;
    /** Mode the page belongs to; "auto" for a cross-source page. */
    mode: AgentFindMode;
    /** Hash binding the cursor to the query, mode, scope, kinds and where filters. */
    queryHash: string;
    /** Per-source continuation positions (raw rows consumed by earlier pages). */
    offsets: AgentCursorOffsetsV2;
    /** Effective scope of the paginated search (set after a workspace fallback). */
    scope?: AgentScopeMode;
    /** Index generation observed when the cursor was issued (informational). */
    generation?: number;
    /** Row kinds selected on the first page (auto page binding). */
    kinds?: AgentItemKind[];
    /** Whether archived sessions were searched on the first page. */
    includeArchived?: boolean;
    /**
     * Bounded hashes of file identities already returned on earlier pages.
     * A later page can meet the same path again from another source (body vs
     * name); the hash keeps the page union duplicate-free without carrying the
     * whole path list. Oldest hashes are dropped past {@link CURSOR_SEEN_MAX}.
     */
    seen?: string[];
}
/** One decoded continuation cursor, from either contract version. */
export type AgentCursor = AgentCursorPayload | AgentCursorV2Payload;
/** Deterministic short hash used to bind a cursor to one query request. */
export declare function queryHashOf(parts: unknown): string;
/** Encode one single-source (v1) cursor payload as an opaque base64url token. */
export declare function encodeCursor(payload: AgentCursorPayload): string;
/**
 * Encode one cross-source (v2) cursor payload as an opaque base64url token.
 *
 * Mirrors the parity surface implemented by scripts/locator-cli.mjs
 * (AGENT_CURSOR_VERSION = 2): v, mode, queryHash, offsets, scope, generation,
 * kinds and includeArchived, with the boolean omitted when false.
 * @param payload - v2 payload built from the page's per-source positions.
 * @returns the opaque token.
 */
export declare function encodeCursorV2(payload: AgentCursorV2Payload): string;
/** Short deterministic hash of one returned file identity (cursor dedupe memory). */
export declare function identityTokenHash(value: string): string;
/** Decode one opaque cursor (v1 or v2), returning undefined for anything malformed. */
export declare function decodeCursor(cursor: unknown): AgentCursor | undefined;
/** Whether a decoded cursor belongs to the current request (query/mode binding). */
export declare function cursorMatches(payload: AgentCursor, expected: {
    queryHash: string;
    mode?: AgentFindMode;
}): boolean;
/** Coerce one caller limit into 1..max (fallback when absent/invalid). */
export declare function clampLimit(requested: unknown, max?: number, fallback?: number): number;
/** Resolve one caller maxChars: absent uses the fallback, 0 disables, negatives clamp to 0. */
export declare function resolveMaxChars(requested: unknown, fallback?: number): number;
/** Declared timing block for output schemas. */
export declare const AGENT_TIMING_SCHEMA: {
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
/** Declared error block for output schemas. */
export declare const AGENT_ERROR_INFO_SCHEMA: {
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
/** Declared freshness block for output schemas. */
export declare const AGENT_FRESHNESS_SCHEMA: {
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
/** Declared permissions block for output schemas. */
export declare const AGENT_PERMISSIONS_SCHEMA: {
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
/** Declared provenance block for output schemas. */
export declare const AGENT_PROVENANCE_SCHEMA: {
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
/** Declared item block shared by the agent tools. */
export declare const AGENT_ITEM_SCHEMA: {
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
/** Declared page block for output schemas. */
export declare const AGENT_PAGE_SCHEMA: {
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
/** Declared coverage block for output schemas. */
export declare const AGENT_COVERAGE_SCHEMA: {
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
/** Declared budget block for output schemas. */
export declare const AGENT_BUDGET_SCHEMA: {
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
/** Declared scope echo for output schemas. */
export declare const AGENT_SCOPE_SCHEMA: {
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
/** Declared base success block for output schemas (spread into tool schemas). */
export declare const AGENT_SUCCESS_BASE_SCHEMA: {
    readonly properties: {
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
/** Declared failure envelope for output schemas. */
export declare const AGENT_FAILURE_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
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
            readonly description: "Tool that produced the failure.";
        };
        readonly error: {
            readonly required: true;
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
/** Declared success envelope marker: spread AGENT_SUCCESS_BASE_SCHEMA.properties into a tool schema. */
export declare const AGENT_SUCCESS_SCHEMA: {
    readonly properties: {
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
//# sourceMappingURL=agent-core.d.ts.map