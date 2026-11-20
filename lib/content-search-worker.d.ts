/**
 * Search worker: content queries run here so a slow query can never stall the
 * DSH host's event loop. Each worker owns its own read-only connection, which
 * makes two parallel search workers safe alongside the build's writes in the
 * main thread (WAL).
 *
 * Protocol (0.20.0, `protocol: 2`):
 *
 * - search:  { id, method: 'search', params: { query, limit?, options? } }
 * - cancel:  { id, method: 'cancel' }
 * - open:    { id, method: 'open', params: { path } } (or the legacy { id, open })
 * - close:   { id, method: 'close' } (or the legacy { id, close: true })
 * - info:    { id, method: 'info' }
 * - reply:   { id, ok: true, result } | { id, ok: false, error, result? }
 *
 * The platform allows the host to build exactly two search workers; this module
 * is the worker side of that pool and keeps no cross-worker state. A cancel
 * message cannot interrupt a synchronous SQLite call (messages queue on the
 * blocked worker event loop), so the host aborts by posting cancel and then
 * terminating the worker. For a graceful in-scan abort the host may instead
 * pass a SharedArrayBuffer as `workerData.cancelBuffer`: the worker polls
 * `Atomics.load(new Int32Array(buffer), 0)` inside its JS scan loops and aborts
 * the request whose id is stored in slot 0 (the worker clears the slot with a
 * compare-exchange).
 *
 * The worker never throws into the channel: every failure becomes a reply, and
 * a malformed reply is a hard host error rather than an in-process re-run.
 * @module dsh-locator/content-search-worker
 */
import { type ContentSearchResult } from './content-search.ts';
/** Replies carry a protocol version so a future pool can negotiate. */
export declare const SEARCH_WORKER_PROTOCOL = 2;
/** Default wall-clock budget, per query, after which the worker degrades. */
export declare const WORKER_DEGRADE_THRESHOLD_MS = 1000;
/** How long the degraded profile stays on after a slow query. */
export declare const WORKER_DEGRADE_COOLDOWN_MS = 30000;
/** One reply posted back to the host. */
export interface SearchWorkerReply {
    id: number;
    ok: boolean;
    /** Search result for a successful (or search-level failed) query. */
    result?: ContentSearchResult;
    /** Failure code for ok === false. */
    error?: string;
    /** Diagnostic payload for method: 'info'. */
    info?: SearchWorkerInfo;
}
/** Diagnostic payload for method: 'info'. */
export interface SearchWorkerInfo {
    protocol: number;
    dbPath: string | null;
    readOnly: boolean;
    pragmas: Record<string, number>;
    degraded: boolean;
    degradedUntil: number;
    lastQueryMs: number;
    cancelledPending: number;
}
/** Construction options for a worker handler (production and tests). */
export interface SearchWorkerHandlerOptions {
    /** Send one reply to the host (or a test sink). */
    post: (reply: SearchWorkerReply) => void;
    /** Initial database path; absent means wait for an open request. */
    dbPath?: string | null;
    /** Optional shared cancellation slot; see the module docs. */
    cancelBuffer?: SharedArrayBuffer;
    /** Test seam: degrade threshold in ms (default 1000). */
    degradeThresholdMs?: number;
    /** Test seam: degraded-profile cooldown in ms (default 30000). */
    degradeCooldownMs?: number;
}
/** A worker handler that can be driven synchronously (tests) or by postMessage. */
export interface SearchWorkerHandler {
    /** Handle one request; never throws. */
    handle: (request: unknown) => void;
    /** Open (or replace) the read-only connection; true on success. */
    open: (path: string) => boolean;
    /** Close the connection (open() can revive it after a rebuild). */
    close: () => void;
    /** Current diagnostic payload. */
    info: () => SearchWorkerInfo;
}
/**
 * Create a search-worker handler.
 *
 * The handler owns one read-only DatabaseSync connection, an in-flight request
 * id, the shared cancel slot and the degraded-profile state. Nothing is global,
 * so several handlers (two-worker pool) can coexist in one process; production
 * still runs each in its own worker thread.
 */
export declare function createSearchWorkerHandler(options: SearchWorkerHandlerOptions): SearchWorkerHandler;
//# sourceMappingURL=content-search-worker.d.ts.map