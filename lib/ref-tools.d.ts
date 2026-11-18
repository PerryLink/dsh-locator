/**
 * locator_resolve and locator_cite: turn refs into metadata/excerpts and
 * human/agent-readable citations. These tools never return content the caller
 * is not authorized to read (session refs follow the same workspace rule as
 * locator_find; file refs must stay inside the configured roots).
 *
 * 0.19.0 adds the auditable evidence layer: locator_resolve reports an
 * additive status/checkedAt/anchor, URL refs can be revalidated with a
 * conditional HTTP request, and locator_cite gained a detail: "exact" mode
 * that quotes the verbatim evidence plus a fallback locator.
 * @module dsh-locator/ref-tools
 */
import type { ContentIndex } from './content.ts';
import type { LocatorRuntime } from './runtime.ts';
/** Extra tool-level knobs for locator_resolve (root wiring passes config here). */
export interface ResolveToolOptions {
    /**
     * Opt in to network revalidation of URL refs. Default false: URL refs stay
     * metadata-only and no request is made.
     */
    urlFreshness?: boolean;
    /** Per-request deadline for URL revalidation in ms (default 5000, at most 30000). */
    urlFreshnessTimeoutMs?: number;
    /** Body-prefix cap hashed for URL revalidation (default 65536, at most 1048576). */
    urlFreshnessMaxBytes?: number;
}
/** Dependencies used by locator_cite detail mode. */
export interface CiteToolOptions {
    /** Content index used for session/event excerpts and freshness metadata. */
    content?: ContentIndex;
    /** Configured index roots; file content is only read inside them. */
    roots?: readonly string[];
}
/** Build the locator_resolve tool. */
export declare function makeResolveTool(rt: LocatorRuntime, content?: ContentIndex, options?: ResolveToolOptions): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Build the locator_cite tool. */
export declare function makeCiteTool(options?: CiteToolOptions): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Build a URL ref from one raw URL (used by future indexing work and tests). */
export declare function buildUrlRef(raw: string): string;
/** Decode a session ref back to its id (exported for tests/other modules). */
export declare function sessionIdOf(ref: string): string | undefined;
//# sourceMappingURL=ref-tools.d.ts.map