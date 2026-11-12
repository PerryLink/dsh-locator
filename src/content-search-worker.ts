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

import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { searchContent, type ContentSearchOptions, type ContentSearchResult } from './content-search.ts'

interface Request {
  id: number
  open?: string
  close?: boolean
  query?: string
  limit?: number
  options?: ContentSearchOptions
}

/** A result shape every failure path can share. */
function failure(error: string, warnings: string[] = [error]): ContentSearchResult {
  return { hits: [], count: { value: 0, kind: 'unknown' }, warnings, error }
}

let db: DatabaseSync | null = null

function open(path: string): void {
  try { db?.close() } catch { /* ignore */ }
  db = null
  try { db = new DatabaseSync(path, { readOnly: true }) } catch { db = null }
}

function post(message: Record<string, unknown>): void {
  try { parentPort?.postMessage(message) } catch { /* the host is gone; nothing to do */ }
}

/** Handle one request; never throws. */
function handle(request: Request): void {
  try {
    if (request.open !== undefined) {
      open(request.open)
      post({ id: request.id, ok: true })
      return
    }
    if (request.close === true) {
      try { db?.close() } catch { /* ignore */ }
      db = null
      post({ id: request.id, ok: true })
      return
    }
    if (typeof request.query !== 'string') {
      post({ id: request.id, result: failure('content-search-worker-protocol-error') })
      return
    }
    if (db === null) {
      post({ id: request.id, result: failure('content-index-unavailable') })
      return
    }
    const result = searchContent(db, request.query, request.limit ?? 30, request.options ?? {})
    post({ id: request.id, result })
  } catch {
    // A thrown SQLite/JS error is reported as a result so the host can show a
    // clear error code instead of silently re-running the query in-process.
    post({ id: request.id, result: failure('content-search-worker-error') })
  }
}

const initial = (workerData as { dbPath?: string } | undefined)?.dbPath
if (initial !== undefined) open(initial)

parentPort?.on('message', (request: Request) => {
  if (typeof request !== 'object' || request === null || typeof request.id !== 'number') return
  handle(request)
})
