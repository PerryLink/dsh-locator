/**
 * locator_find — search file bodies and DSH session messages.
 * @module dsh-locator/find
 */
import type { ContentHit, ContentIndex, ContentState } from './content.ts';
import type { ContentCount } from './content-search.ts';
import { type RefFreshness, type RefPermissions, type RefProvenance } from './refs.ts';
import type { LocatorRuntime } from './runtime.ts';
import { type Scope } from './scope.ts';
/** The additive locator_find hit schema, shared with locator_search mode content. */
export declare const CONTENT_HIT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly kind: {
            readonly type: "string";
            readonly enum: readonly ["file", "session", "dir"];
            readonly required: true;
        };
        readonly path: {
            readonly type: "string";
            readonly required: true;
        };
        readonly name: {
            readonly type: "string";
            readonly description: "Base name for name-index hits (mode names).";
        };
        readonly title: {
            readonly type: "string";
        };
        readonly snippet: {
            readonly type: "string";
        };
        readonly sessionId: {
            readonly type: "string";
        };
        readonly messageId: {
            readonly type: "string";
        };
        readonly nodeKey: {
            readonly type: "string";
        };
        readonly line: {
            readonly type: "integer";
            readonly description: "1-based line of the first match in the stored body (file hits).";
        };
        readonly score: {
            readonly type: "number";
        };
        readonly size: {
            readonly type: "integer";
            readonly description: "File size in bytes when known (name hits).";
        };
        readonly mtime: {
            readonly type: "integer";
            readonly description: "Modification time in Unix milliseconds when known (name hits).";
        };
        readonly dir: {
            readonly type: "boolean";
            readonly description: "True for a directory hit (name mode).";
        };
        readonly context: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "Lines around the hit line, when contextLines > 0.";
        };
        readonly contextStart: {
            readonly type: "integer";
            readonly description: "1-based line number of context[0].";
        };
        readonly format: {
            readonly type: "string";
            readonly description: "Extracted document format (pdf, docx, xlsx, pptx, epub) for file hits whose body came from a document.";
        };
        readonly ref: {
            readonly type: "string";
            readonly description: "Citable evidence reference: dsh-session: URI for session hits, ref://file for file hits.";
        };
        readonly seq: {
            readonly type: "integer";
            readonly description: "Session event sequence of this message when the content index stored a session-event ref for it.";
        };
        readonly eventRef: {
            readonly type: "string";
            readonly description: "Full ref://session-event?sid=...&seq=N evidence reference for the indexed event, when one was stored.";
        };
        readonly hash: {
            readonly type: "string";
            readonly description: "sha256 of the file bytes when cheap to compute (files up to 2 MiB).";
        };
        readonly refStatus: {
            readonly type: "string";
            readonly enum: readonly ["fresh", "stale", "missing", "unknown"];
            readonly description: "Short freshness label for the evidence ref (same value as freshness.state).";
        };
        readonly provenance: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly origin: {
                    readonly type: "string";
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
                };
            };
        };
        readonly freshness: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly state: {
                    readonly type: "string";
                    readonly enum: readonly ["fresh", "stale", "missing", "unknown"];
                };
                readonly observedAt: {
                    readonly type: "integer";
                };
                readonly mtime: {
                    readonly type: "integer";
                };
            };
        };
        readonly permissions: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly read: {
                    readonly type: "string";
                    readonly enum: readonly ["allowed", "denied"];
                };
                readonly visibility: {
                    readonly type: "string";
                    readonly enum: readonly ["workspace", "roots", "session", "external"];
                };
                readonly reason: {
                    readonly type: "string";
                };
            };
        };
    };
};
/** The additive per-result budget block (see scope.ts applyOutputBudget). */
export declare const BUDGET_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly limitChars: {
            readonly type: "integer";
            readonly description: "Configured soft cap in characters (0 = disabled).";
        };
        readonly usedChars: {
            readonly type: "integer";
            readonly description: "Characters of the JSON payload actually returned.";
        };
        readonly truncated: {
            readonly type: "boolean";
            readonly description: "True when at least one hit was dropped to satisfy the cap.";
        };
        readonly dropped: {
            readonly type: "integer";
            readonly description: "Hits dropped by the budget.";
        };
    };
};
/**
 * Content-index state shared by the locator_find and locator_status output
 * schemas. Keep it in sync with ContentState: the host validates every tool
 * result against the declared schema and rejects undeclared fields, so a state
 * field missing here makes the whole tool call fail as "invalid output".
 */
export declare const CONTENT_STATE_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly building: {
            readonly type: "boolean";
        };
        readonly files: {
            readonly type: "integer";
        };
        readonly sessions: {
            readonly type: "integer";
        };
        readonly messages: {
            readonly type: "integer";
        };
        readonly truncated: {
            readonly type: "boolean";
        };
        readonly updatedAt: {
            readonly type: "integer";
        };
        readonly error: {
            readonly type: "string";
        };
        readonly warnings: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "Non-fatal build problems, e.g. an unreadable session log.";
        };
        readonly fullIndex: {
            readonly type: "boolean";
        };
        readonly reasoningIndex: {
            readonly type: "boolean";
        };
        readonly toolResultsIndex: {
            readonly type: "boolean";
        };
        readonly refs: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly total: {
                    readonly type: "integer";
                    readonly description: "Distinct evidence ref identities stored in the content index.";
                };
                readonly byKind: {
                    readonly type: "object";
                    readonly additionalProperties: true;
                    readonly description: "Distinct ref identities per kind (url, session-event, spill, attachment).";
                };
            };
        };
        readonly progress: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly phase: {
                    readonly type: "string";
                };
                readonly scanned: {
                    readonly type: "integer";
                };
                readonly indexed: {
                    readonly type: "integer";
                };
                readonly total: {
                    readonly type: "integer";
                };
                readonly path: {
                    readonly type: "string";
                };
                readonly startedAt: {
                    readonly type: "integer";
                };
            };
        };
    };
};
/** One content hit after evidence metadata and freshness labeling. */
export type EnrichedContentHit = ContentHit & {
    ref: string;
    hash?: string;
    seq?: number;
    eventRef?: string;
    provenance: RefProvenance;
    freshness: RefFreshness;
    permissions: RefPermissions;
    refStatus: RefFreshness['state'];
};
/** Upper bound for the contextLines argument; keeps one hit a few KB at most. */
export declare const CONTEXT_MAX_LINES = 10;
/**
 * Attach citable evidence metadata to content hits. Hashing is capped per file
 * so a tool call cannot read a huge artifact just to label a hit.
 */
export declare function enrichContentHits(hits: readonly ContentHit[], content: ContentIndex, callerCwd: string | undefined): Promise<EnrichedContentHit[]>;
/** Caller identity used by the content workspace/session authorization. */
export interface CallerIdentity {
    sessionId?: string;
    cwd?: string;
}
/** One content query after argument parsing (shared by find and search content mode). */
export interface ContentRequest {
    query: string;
    limit: number;
    offset: number;
    scope: 'workspace' | 'all';
    sessionId?: string;
    matchMode?: 'normal' | 'extended';
    caseSensitive?: boolean;
    wholeWord?: boolean;
    count?: 'exact' | 'bounded' | 'none';
    countLimit?: number;
    pathPrefix?: string;
    /** File documents only: used by the public HTTP API, which has no caller session identity. */
    filesOnly?: boolean;
}
/**
 * Plugin-supplied content-scope context for {@link runContentSearchRequest}.
 * These values come from the validated plugin configuration, never from the
 * caller, so they are kept out of {@link ContentRequest} (and out of tool args).
 */
export interface ContentSearchRequestOptions {
    /** config.contentExcludes: path rules that keep a directory out of the content index. */
    contentExcludes?: readonly string[];
    /** config.contentShortQueryFallback: admit 2-code-point queries to the bounded fallback. */
    shortQueryFallback?: boolean;
}
/**
 * Whether a directory is outside the content index because of `contentExcludes`.
 * Mirrors the content layer's own skip rule (a rule containing `/` matches as a
 * path substring, a bare rule matches a path segment) so the workspace-scope
 * fallback agrees with what the index actually scanned. The plugin's `.dsh`
 * tree is always excluded.
 * @param path - absolute directory (usually the caller cwd).
 * @param excludes - configured content excludes.
 * @returns true when the directory itself cannot have indexed bodies.
 */
export declare function contentPathExcluded(path: string, excludes: readonly string[]): boolean;
/**
 * Read the content-scope knobs off the runtime configuration. The 0.20.2
 * fields are read defensively: an embedder runtime or an older profile keeps
 * the 0.20.1 behavior (no cwd fallback, no short-query fallback) instead of
 * throwing.
 * @param rt - the locator runtime, when the caller has one.
 * @returns options ready for {@link runContentSearchRequest}.
 */
export declare function contentScopeOptionsOf(rt: LocatorRuntime | undefined): ContentSearchRequestOptions;
/** Result of one authorized content query. */
export type ContentRequestResult = {
    ok: true;
    hits: EnrichedContentHit[];
    count: ContentCount;
    warnings: string[];
    state: ContentState;
    scope: 'workspace' | 'all';
    scopeFallback?: string;
    /** True when a 2-code-point query was answered by the bounded fallback. */
    shortQueryFallback?: boolean;
} | {
    ok: false;
    error: string;
    warnings: string[];
    hits: EnrichedContentHit[];
    state: ContentState;
    scope?: 'workspace' | 'all';
};
/**
 * Run one content query with the same workspace/session authorization
 * locator_find always applied. Extracted so locator_search mode "content" can
 * reuse the exact rules instead of duplicating them.
 */
export declare function runContentSearchRequest(content: ContentIndex, request: ContentRequest, roots: readonly string[], allowCrossWorkspaceSessions: boolean, caller?: CallerIdentity, requestOptions?: ContentSearchRequestOptions): Promise<ContentRequestResult>;
/**
 * Read a bounded window of lines around one hit line. Files that are missing,
 * non-text-sized or unreadable simply get no context; context is an additive
 * convenience, never a reason to fail the query.
 */
export declare function readContextLines(path: string, line: number, contextLines: number): Promise<{
    start: number;
    lines: string[];
} | undefined>;
/** Modes locator_find understands; the default keeps the historical behavior. */
export type FindMode = 'names' | 'content' | 'count';
/** Parse one mode argument, defaulting to "content". */
export declare function parseFindMode(value: unknown): FindMode;
/** Options the plugin passes to makeFindTool (all optional for embedders). */
export interface FindToolOptions {
    /** Name index backing mode "names" (the plugin always supplies it). */
    rt?: LocatorRuntime;
    /** Layered ignore rules; omitted means no filtering. */
    scope?: Scope;
    /** Soft result budget in characters; omitted uses the catalog default. */
    budgetChars?: number;
    /** Optional external rerank command (config.rerankCommand); empty disables. */
    rerankCommand?: string;
}
/** Build the locator_find tool. */
export declare function makeFindTool(content: ContentIndex, ensure?: () => void, roots?: readonly string[], allowCrossWorkspaceSessions?: boolean, options?: FindToolOptions): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=find.d.ts.map