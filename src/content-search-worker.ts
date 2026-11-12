/**
 * Search worker: content queries run here so a slow query can never stall the
 * DSH host's event loop. A read-only connection makes the build's writes in the
 * main thread safe to observe concurrently (WAL).
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

let db: DatabaseSync | null = null

function open(path: string): void {
  try { db?.close() } catch { /* ignore */ }
  db = null
  try { db = new DatabaseSync(path, { readOnly: true }) } catch { db = null }
}

const initial = (workerData as { dbPath?: string } | undefined)?.dbPath
if (initial !== undefined) open(initial)

parentPort?.on('message', (request: Request) => {
  if (request.open !== undefined) {
    open(request.open)
    parentPort?.postMessage({ id: request.id, ok: true })
    return
  }
  if (request.close === true) {
    try { db?.close() } catch { /* ignore */ }
    db = null
    parentPort?.postMessage({ id: request.id, ok: true })
    return
  }
  let result: ContentSearchResult = {
    hits: [],
    count: { value: 0, kind: 'unknown' },
    warnings: [],
    error: 'content-index-unavailable',
  }
  let error = ''
  if (db !== null) {
    try {
      result = searchContent(db, request.query ?? '', request.limit ?? 30, request.options ?? {})
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }
  parentPort?.postMessage({ id: request.id, result, error })
})
