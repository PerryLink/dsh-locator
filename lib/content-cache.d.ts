/**
 * Small TTL + LRU cache for content search results, with single-flight
 * de-duplication of identical in-flight queries.
 *
 * Content queries are expensive (bm25 ranking, whole-word body scans) and the
 * panel/HTTP layer issues the same query repeatedly: a keystroke re-query, a
 * status refresh, a panel retry. Two independent wins live here:
 *
 * - a TTL/LRU cache returns the last result while the index generation is
 *   still the same (the owner drops the cache on every rebuild/refresh);
 * - single-flight collapses concurrent calls for the same key into one
 *   underlying query, so two clients asking at once cost one search.
 *
 * The cache stores values by reference: callers must treat cached results as
 * immutable (clone before mutating) or the cached copy changes under everyone.
 * Rejected runs are never cached: a failing query is retried by the next call.
 * TTL is measured from store time, so a slow first query does not shorten the
 * freshness window of the value it produced.
 * @module dsh-locator/content-cache
 */
/** The query-cache seam used by createSearchCache. */
export interface SearchCache {
    /** Cached, unexpired value for key. */
    get<T>(key: string): T | undefined;
    /** Store a value under key, refreshing its TTL and LRU position. */
    set<T>(key: string, value: T): void;
    /**
     * Cached value, or one shared in-flight fn() for this key. Concurrent
     * callers for the same key share a single promise; a rejection reaches every
     * current waiter and is not cached.
     */
    run<T>(key: string, fn: () => Promise<T>): Promise<T>;
    /** Forget every cached value and in-flight entry. */
    close(): void;
}
/** Optional observability counters; safe to read while the cache is in use. */
export interface SearchCacheStats {
    size: number;
    pending: number;
    sizeLimit: number;
    ttlMs: number;
    hits: number;
    misses: number;
    stores: number;
    evictions: number;
    expired: number;
    closed: boolean;
}
/** A cache with its optional observability view attached. */
export type SearchCacheWithStats = SearchCache & {
    stats(): SearchCacheStats;
};
/**
 * Create a TTL + LRU search-result cache.
 *
 * size <= 0 disables storage (every get misses, every set is a no-op) but not
 * single-flight: concurrent same-key run() calls still share one query.
 * ttlMs <= 0 means "no TTL": entries live until LRU eviction.
 * @param options - maximum entries and entry lifetime in milliseconds.
 */
export declare function createSearchCache(options: {
    size: number;
    ttlMs: number;
}): SearchCacheWithStats;
//# sourceMappingURL=content-cache.d.ts.map