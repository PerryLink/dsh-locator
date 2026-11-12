/**
 * Search worker: content queries run here so a slow query can never stall the
 * DSH host's event loop. A read-only connection makes the build's writes in the
 * main thread safe to observe concurrently (WAL).
 * @module dsh-locator/content-search-worker
 */
export {};
//# sourceMappingURL=content-search-worker.d.ts.map