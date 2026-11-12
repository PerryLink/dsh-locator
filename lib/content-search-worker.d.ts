/**
 * Search worker: content queries run here so a slow query can never stall the
 * DSH host's event loop. A read-only connection makes the build's writes in the
 * main thread safe to observe concurrently (WAL).
 *
 * Every request is answered with a complete {@link ContentSearchResult}; the
 * worker never throws into the channel, because the host treats a timeout or a
 * malformed reply as a hard error rather than re-running the query on the main
 * thread.
 * @module dsh-locator/content-search-worker
 */
export {};
//# sourceMappingURL=content-search-worker.d.ts.map