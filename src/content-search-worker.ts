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

import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { configureSearchConnection, searchContent, type ContentSearchOptions, type ContentSearchResult } from './content-search.ts'

/** Replies carry a protocol version so a future pool can negotiate. */
export const SEARCH_WORKER_PROTOCOL = 2

/** Default wall-clock budget, per query, after which the worker degrades. */
export const WORKER_DEGRADE_THRESHOLD_MS = 1_000

/** How long the degraded profile stays on after a slow query. */
export const WORKER_DEGRADE_COOLDOWN_MS = 30_000

/** One reply posted back to the host. */
export interface SearchWorkerReply {
  id: number
  ok: boolean
  /** Search result for a successful (or search-level failed) query. */
  result?: ContentSearchResult
  /** Failure code for ok === false. */
  error?: string
  /** Diagnostic payload for method: 'info'. */
  info?: SearchWorkerInfo
}

/** Diagnostic payload for method: 'info'. */
export interface SearchWorkerInfo {
  protocol: number
  dbPath: string | null
  readOnly: boolean
  pragmas: Record<string, number>
  degraded: boolean
  degradedUntil: number
  lastQueryMs: number
  cancelledPending: number
}

/** Construction options for a worker handler (production and tests). */
export interface SearchWorkerHandlerOptions {
  /** Send one reply to the host (or a test sink). */
  post: (reply: SearchWorkerReply) => void
  /** Initial database path; absent means wait for an open request. */
  dbPath?: string | null
  /** Optional shared cancellation slot; see the module docs. */
  cancelBuffer?: SharedArrayBuffer
  /** Test seam: degrade threshold in ms (default 1000). */
  degradeThresholdMs?: number
  /** Test seam: degraded-profile cooldown in ms (default 30000). */
  degradeCooldownMs?: number
}

/** A worker handler that can be driven synchronously (tests) or by postMessage. */
export interface SearchWorkerHandler {
  /** Handle one request; never throws. */
  handle: (request: unknown) => void
  /** Open (or replace) the read-only connection; true on success. */
  open: (path: string) => boolean
  /** Close the connection (open() can revive it after a rebuild). */
  close: () => void
  /** Current diagnostic payload. */
  info: () => SearchWorkerInfo
}

/** A result shape every failure path can share. */
function failure(error: string, warnings: string[] = [error]): ContentSearchResult {
  return { hits: [], count: { value: 0, kind: 'unknown' }, warnings, error }
}

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback
}

/**
 * Drop fields the worker must own: hooks and an AbortSignal cannot cross a
 * postMessage boundary, so whatever shape arrived is untrusted input here.
 */
function sanitizeOptions(raw: unknown): ContentSearchOptions {
  if (typeof raw !== 'object' || raw === null) return {}
  const options: ContentSearchOptions = { ...(raw as ContentSearchOptions) }
  delete (options as { isCancelled?: unknown }).isCancelled
  delete (options as { signal?: unknown }).signal
  delete (options as { degrade?: unknown }).degrade
  return options
}

/** Read the tuning pragmas back for the info reply. */
function readPragmas(connection: DatabaseSync | null): Record<string, number> {
  const values: Record<string, number> = {}
  if (connection === null) return values
  const queries: Array<[string, string]> = [
    ['busyTimeout', 'PRAGMA busy_timeout'],
    ['cacheSize', 'PRAGMA cache_size'],
    ['mmapSize', 'PRAGMA mmap_size'],
    ['queryOnly', 'PRAGMA query_only'],
    ['tempStore', 'PRAGMA temp_store'],
  ]
  for (const [name, sql] of queries) {
    try {
      const row = connection.prepare(sql).get() as Record<string, unknown> | undefined
      const value = row === undefined ? undefined : Object.values(row)[0]
      if (typeof value === 'number') values[name] = value
    } catch { /* pragma unavailable on this platform */ }
  }
  return values
}

/**
 * Create a search-worker handler.
 *
 * The handler owns one read-only DatabaseSync connection, an in-flight request
 * id, the shared cancel slot and the degraded-profile state. Nothing is global,
 * so several handlers (two-worker pool) can coexist in one process; production
 * still runs each in its own worker thread.
 */
export function createSearchWorkerHandler(options: SearchWorkerHandlerOptions): SearchWorkerHandler {
  const degradeThresholdMs = positiveMs(options.degradeThresholdMs, WORKER_DEGRADE_THRESHOLD_MS)
  const degradeCooldownMs = positiveMs(options.degradeCooldownMs, WORKER_DEGRADE_COOLDOWN_MS)
  const cancelView = options.cancelBuffer === undefined ? null : new Int32Array(options.cancelBuffer)
  let db: DatabaseSync | null = null
  let dbPath: string | null = null
  let degradedUntil = 0
  let lastQueryMs = 0
  const cancelledIds = new Set<number>()

  function post(reply: SearchWorkerReply): void {
    try { options.post(reply) } catch { /* the host is gone; nothing to do */ }
  }

  function cancelRequested(id: number): boolean {
    if (cancelledIds.has(id)) return true
    if (cancelView !== null && Atomics.load(cancelView, 0) === id) return true
    return false
  }

  function rememberCancel(id: number): void {
    // Hosts cancel at most a handful of in-flight ids; bound the set anyway.
    if (cancelledIds.size >= 128) {
      const oldest = cancelledIds.values().next()
      if (oldest.done !== true) cancelledIds.delete(oldest.value)
    }
    cancelledIds.add(id)
  }

  function open(path: string): boolean {
    try { db?.close() } catch { /* a dying connection must not stop the swap */ }
    db = null
    dbPath = null
    // Opening after a close is allowed: the pre-0.20 protocol reused a worker
    // through { close } then { open } after a database rebuild.
    try {
      const connection = new DatabaseSync(path, { readOnly: true })
      configureSearchConnection(connection)
      db = connection
      dbPath = path
      return true
    } catch {
      return false
    }
  }

  function close(): void {
    cancelledIds.clear()
    try { db?.close() } catch { /* ignore */ }
    db = null
    dbPath = null
  }

  function info(): SearchWorkerInfo {
    return {
      protocol: SEARCH_WORKER_PROTOCOL,
      dbPath,
      readOnly: db !== null,
      pragmas: readPragmas(db),
      degraded: Date.now() < degradedUntil,
      degradedUntil,
      lastQueryMs,
      cancelledPending: cancelledIds.size,
    }
  }

  /** Run one query synchronously and post exactly one reply. */
  function runSearch(id: number, query: unknown, limit: unknown, rawOptions: unknown): void {
    if (typeof query !== 'string') {
      post({ id, ok: false, error: 'content-search-worker-protocol-error', result: failure('content-search-worker-protocol-error') })
      return
    }
    if (db === null) {
      post({ id, ok: false, error: 'content-index-unavailable', result: failure('content-index-unavailable') })
      return
    }
    if (cancelledIds.delete(id)) {
      post({ id, ok: false, error: 'content-search-cancelled', result: failure('content-search-cancelled') })
      return
    }
    const searchOptions = sanitizeOptions(rawOptions)
    const degraded = Date.now() < degradedUntil
    const effective: ContentSearchOptions = degraded ? { ...searchOptions, degrade: true } : searchOptions
    const started = performance.now()
    let result: ContentSearchResult
    try {
      result = searchContent(db, query, typeof limit === 'number' ? limit : 30, { ...effective, isCancelled: () => cancelRequested(id) })
      lastQueryMs = performance.now() - started
      // A query that blew its deadline switches the worker to the degraded
      // profile for a cooldown: bounded counts, no bm25 sort.
      if (lastQueryMs >= degradeThresholdMs) degradedUntil = Date.now() + degradeCooldownMs
    } catch {
      post({ id, ok: false, error: 'content-search-worker-error', result: failure('content-search-worker-error') })
      return
    } finally {
      if (cancelView !== null) Atomics.compareExchange(cancelView, 0, id, 0)
    }
    if (result.error === 'content-search-cancelled') {
      post({ id, ok: false, error: 'content-search-cancelled', result })
      return
    }
    post({ id, ok: true, result })
  }

  function handle(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return
    const request = raw as Record<string, unknown>
    if (typeof request.id !== 'number') return
    const id = request.id
    const method = typeof request.method === 'string' ? request.method : null
    const params = typeof request.params === 'object' && request.params !== null ? request.params as Record<string, unknown> : null

    if (method === 'cancel') {
      rememberCancel(id)
      return
    }
    if (method === 'open' || (method === null && typeof request.open === 'string')) {
      const path = params !== null && typeof params.path === 'string' ? params.path : request.open
      if (typeof path !== 'string' || path === '') {
        post({ id, ok: false, error: 'content-index-unavailable' })
        return
      }
      post(open(path) ? { id, ok: true } : { id, ok: false, error: 'content-index-unavailable' })
      return
    }
    if (method === 'close' || (method === null && request.close === true)) {
      close()
      // Stay alive to answer a late request with content-index-unavailable.
      post({ id, ok: true })
      return
    }
    if (method === 'info') {
      post({ id, ok: true, info: info() })
      return
    }
    if (method === 'search') {
      runSearch(id, params?.query, params?.limit, params?.options)
      return
    }
    if (method === null) {
      // Legacy flat request shape used before protocol 2.
      runSearch(id, request.query, request.limit, request.options)
      return
    }
    post({ id, ok: false, error: 'content-search-worker-protocol-error', result: failure('content-search-worker-protocol-error') })
  }

  if (typeof options.dbPath === 'string' && options.dbPath !== '') open(options.dbPath)

  return { handle, open, close, info }
}

const workerState = workerData as { dbPath?: unknown; cancelBuffer?: unknown } | null | undefined
if (parentPort !== null) {
  const port = parentPort
  const handler = createSearchWorkerHandler({
    post: (reply: SearchWorkerReply) => { try { port.postMessage(reply) } catch { /* host gone */ } },
    ...(typeof workerState?.dbPath === 'string' ? { dbPath: workerState.dbPath } : {}),
    ...(workerState?.cancelBuffer instanceof SharedArrayBuffer ? { cancelBuffer: workerState.cancelBuffer } : {}),
  })
  port.on('message', (message: unknown) => { handler.handle(message) })
}