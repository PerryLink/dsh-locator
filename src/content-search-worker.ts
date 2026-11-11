/**
 * Search worker: the FTS5 query runs here so a slow content query can never
 * stall the DSH host's event loop. A read-only connection makes the build's
 * writes in the main thread safe to observe concurrently (WAL).
 * @module dsh-locator/content-search-worker
 */

import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { searchContent } from './content-search.ts'
import type { ContentHit } from './content.ts'

interface Request {
  id: number
  open?: string
  close?: boolean
  query?: string
  limit?: number
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
  let hits: ContentHit[] = []
  let error = ''
  if (db !== null) {
    try { hits = searchContent(db, request.query ?? '', request.limit ?? 30) } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }
  parentPort?.postMessage({ id: request.id, hits, error })
})
