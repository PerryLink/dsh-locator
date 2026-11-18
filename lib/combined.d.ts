/**
 * Combined search: one request for the three scopes the Web panel shows by
 * default — content (bodies and sessions), files and directories.
 *
 * The name index and the content index live in different stores, so this module
 * owns the orchestration and the merge rules as pure, injectable functions:
 * scope gating, the lazy-build guard for empty queries, per-group degradation,
 * match-option routing (content vs name engine), page counts and de-duplication
 * of a path that appears both as a body hit and a name hit.
 * @module dsh-locator/combined
 */
import type { ContentHit, ContentProgress, ContentState } from './content.ts';
import type { ContentCount, ContentCountMode, ContentMatchMode, ContentSearchOptions, ContentSearchResult } from './content-search.ts';
import type { RefFreshness, RefPermissions } from './refs.ts';
import type { SearchArgs, SearchHit, SearchResult } from './runtime.ts';
/** Additive evidence metadata attached to one combined hit for the panel. */
export interface CombinedHitEvidence {
    /** Freshness of the hit's snapshot against the current bytes. */
    freshness: RefFreshness;
    /** The caller may read this hit; visibility mirrors the hit's scope. */
    permissions: RefPermissions;
    /** sha256 of the file bytes when cheap to compute (small name hits). */
    hash?: string;
}
/** One content hit enriched with evidence metadata. */
export type CombinedContentHit = ContentHit & {
    ref?: string;
} & CombinedHitEvidence;
/** One name hit enriched with evidence metadata. */
export type CombinedNameHit = SearchHit & CombinedHitEvidence;
/** Only files up to this size get a hash on a name hit (panel evidence detail). */
export declare const COMBINED_HASH_MAX_BYTES: number;
/** At most this many name hits per page are hashed, keeping keystroke latency low. */
export declare const COMBINED_HASH_MAX_HITS = 20;
/**
 * Compare one hit snapshot (engine mtime/size) with the current stat. A page is
 * a preview, not a resolve, so the check is one stat per hit and never a read.
 * @param snapshot - engine-reported mtime, plus size for files.
 * @param current - current stat, or undefined when the path is gone.
 * @param observedAt - epoch ms of this observation.
 * @returns the additive freshness block.
 */
export declare function freshnessForHit(snapshot: {
    mtime: number;
    size?: number;
}, current: {
    mtimeMs: number;
    size: number;
} | undefined, observedAt: number): RefFreshness;
/**
 * Accept a requested root prefix only when it lives under a configured root;
 * the panel sends one of `status.roots`, but the route is still a trust
 * boundary, so an arbitrary path must not narrow (or fake) the search.
 * @param prefix - requested prefix from the request body.
 * @param roots - configured roots.
 * @returns the trimmed prefix, or null when it is not authorized.
 */
export declare function authorizedRootPrefix(prefix: string | null, roots: readonly string[]): string | null;
/** Which groups a combined request asked for; every scope is on by default. */
export interface CombinedScopes {
    content: boolean;
    files: boolean;
    dirs: boolean;
}
/** A validated combined request with per-group limits already clamped. */
export interface CombinedRequest {
    query: string;
    limit: number;
    contentLimit: number;
    /** Name-index offsets for load-more. */
    offset: number;
    filesOffset: number;
    dirsOffset: number;
    /** Content-index offset for load-more. */
    contentOffset: number;
    sort: string;
    desc: boolean;
    scopes: CombinedScopes;
    /** How the query text is interpreted (`normal` by default). */
    matchMode: ContentMatchMode;
    caseSensitive: boolean;
    wholeWord: boolean;
    /** Restrict the content group to one session (null means every document). */
    sessionId: string | null;
    /** Restrict name/content hits to one configured root (panel root picker). */
    rootPrefix: string | null;
    /** Include archived sessions in the content group (panel checkbox). */
    includeArchived: boolean;
    /** How much counting work the groups may spend. */
    count: ContentCountMode;
    countLimit: number;
}
/** One name-index group: files or directories. */
export interface NameGroup {
    /** Hits carry additive freshness/permissions/hash evidence fields. */
    hits: CombinedNameHit[];
    returned: number;
    total: number;
    truncated: boolean;
    /** Rows dropped because the same path already appears in the content group. */
    deduped: number;
    /** The name engine always returns an exact total. */
    count: ContentCount;
    tookMs: number;
    warnings?: string[];
    error?: string;
}
/** The content group: body/session hits plus the index state at query time. */
export interface ContentGroup {
    /** Hits carry additive freshness/permissions evidence fields. */
    hits: CombinedContentHit[];
    returned: number;
    /** True when the group was cut off by its page limit. */
    capped: boolean;
    /** Exact or bounded match count; `unknown` when counting was skipped. */
    count: ContentCount;
    warnings: string[];
    building: boolean;
    files: number;
    sessions: number;
    messages: number;
    truncated: boolean;
    /** Live build progress while `building`; the panel shows the counters. */
    progress?: ContentProgress;
    /** Wall-clock time of the content lookup; 0 when it was skipped. */
    tookMs: number;
    error?: string;
}
/** Everything the panel needs from one combined search. */
export interface CombinedResponse {
    scopes: CombinedScopes;
    /** False when the plugin runs with `contentIndex: false`. */
    contentEnabled: boolean;
    content?: ContentGroup;
    files?: NameGroup;
    dirs?: NameGroup;
    tookMs: number;
}
/** Dependencies required to run a combined search; the HTTP layer supplies them. */
export interface CombinedDeps {
    search(args: SearchArgs): Promise<SearchResult>;
    contentSearch?: (query: string, limit: number, options: ContentSearchOptions) => Promise<ContentSearchResult>;
    contentStatus?: () => ContentState;
    /**
     * Optional look-up of the content-index snapshot mtime for one hit. Supplying
     * it turns content-hit freshness from "unknown" into fresh/stale/missing; the
     * panel keeps working without it.
     */
    contentIndexedMtime?: (hit: ContentHit) => number | undefined;
    ensure?: () => void;
    maxResults: number;
    /** Configured roots; a requested root prefix must live under one of them. */
    roots?: string[];
}
/**
 * Read the three scope flags from a request body. Anything that is not an
 * explicit `false` counts as enabled, so a panel that only sends `{ content:
 * true }` still gets the name groups.
 * @param body - parsed request body.
 * @returns normalized scopes.
 */
export declare function readScopes(body: Record<string, unknown>): CombinedScopes;
/**
 * Validate and clamp a combined request body. The two pages have separate
 * limits: content hits are heavier (bodies/snippets) than name rows.
 * @param body - parsed request body.
 * @param maxResults - the plugin's hard per-page cap.
 * @returns a normalized request.
 */
export declare function readCombinedRequest(body: Record<string, unknown>, maxResults: number): CombinedRequest;
/**
 * Drop name hits whose path is already present in the content group. Content
 * rows carry the snippet and the jump target, so one row per path is enough;
 * directories are never dropped.
 * @param contentHits - body/session hits from the content index.
 * @param nameHits - hits from the name index.
 * @returns the kept hits and how many were dropped.
 */
export declare function dedupeNameHits<T extends SearchHit>(contentHits: readonly ContentHit[], nameHits: readonly T[]): {
    hits: T[];
    deduped: number;
};
/**
 * Run one combined search. Empty queries never touch the content index: the
 * panel opens with an empty box, and a lazy content build there would cost
 * minutes and gigabytes for no results. Failures are contained per group so a
 * broken content cache still shows name results.
 * @param deps - stores and the lazy-start hook.
 * @param request - normalized request.
 * @returns grouped result in content → files → dirs order.
 */
export declare function runCombinedSearch(deps: CombinedDeps, input: CombinedRequest): Promise<CombinedResponse>;
//# sourceMappingURL=combined.d.ts.map