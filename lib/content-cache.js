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
function countOption(value) {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
/**
 * Create a TTL + LRU search-result cache.
 *
 * size <= 0 disables storage (every get misses, every set is a no-op) but not
 * single-flight: concurrent same-key run() calls still share one query.
 * ttlMs <= 0 means "no TTL": entries live until LRU eviction.
 * @param options - maximum entries and entry lifetime in milliseconds.
 */
export function createSearchCache(options) {
    const sizeLimit = countOption(options.size);
    const ttlMs = countOption(options.ttlMs);
    const entries = new Map();
    const pending = new Map();
    let hits = 0;
    let misses = 0;
    let stores = 0;
    let evictions = 0;
    let expired = 0;
    let closed = false;
    const isFresh = (entry, now) => ttlMs <= 0 || now - entry.storedAt < ttlMs;
    function read(key) {
        const entry = entries.get(key);
        if (entry === undefined)
            return undefined;
        if (!isFresh(entry, Date.now())) {
            entries.delete(key);
            expired++;
            return undefined;
        }
        // Refresh LRU recency: a Map keeps insertion order.
        entries.delete(key);
        entries.set(key, entry);
        return entry;
    }
    function write(key, value) {
        if (closed || sizeLimit <= 0)
            return;
        entries.delete(key);
        entries.set(key, { value, storedAt: Date.now() });
        stores++;
        while (entries.size > sizeLimit) {
            const oldest = entries.keys().next();
            if (oldest.done === true)
                break;
            entries.delete(oldest.value);
            evictions++;
        }
    }
    const cache = {
        get(key) {
            if (closed)
                return undefined;
            const entry = read(key);
            if (entry === undefined) {
                misses++;
                return undefined;
            }
            hits++;
            return entry.value;
        },
        set(key, value) {
            if (closed)
                return;
            write(key, value);
        },
        run(key, fn) {
            if (closed)
                return fn();
            const entry = read(key);
            if (entry !== undefined) {
                hits++;
                return Promise.resolve(entry.value);
            }
            const inflight = pending.get(key);
            if (inflight !== undefined) {
                hits++;
                return inflight;
            }
            misses++;
            const promise = (async () => {
                try {
                    const value = await fn();
                    write(key, value);
                    return value;
                }
                finally {
                    pending.delete(key);
                }
            })();
            pending.set(key, promise);
            return promise;
        },
        close() {
            closed = true;
            entries.clear();
            pending.clear();
        },
        stats() {
            return {
                size: entries.size,
                pending: pending.size,
                sizeLimit,
                ttlMs,
                hits,
                misses,
                stores,
                evictions,
                expired,
                closed,
            };
        },
    };
    return cache;
}
//# sourceMappingURL=content-cache.js.map