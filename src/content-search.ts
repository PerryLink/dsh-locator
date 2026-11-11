/**
 * Content FTS5 query shared by the host thread and the search worker.
 * @module dsh-locator/content-search
 */

import type { DatabaseSync } from 'node:sqlite'
import type { ContentHit } from './content.ts'

/**
 * Run one content query against an open SQLite handle.
 * @param db - open database (read-only in the worker).
 * @param query - user query; shorter than three characters falls back to LIKE.
 * @param limit - maximum hits.
 * @returns hits, ordered by relevance.
 */
export function searchContent(db: DatabaseSync, query: string, limit: number): ContentHit[] {
  const text = query.trim()
  if (text === '') return []
  const capped = Math.max(1, Math.min(100, limit))
  let rows: Array<Record<string, unknown>>
  if ([...text].length < 3) {
    rows = db.prepare(`SELECT kind, path, title, session_id, message_id, body, 0 AS score
      FROM docs WHERE body LIKE '%' || ? || '%' LIMIT ?`).all(text, capped) as Array<Record<string, unknown>>
  } else {
    const match = text.split(/\s+/).filter(Boolean).map(term => '"' + term.replace(/"/g, '') + '"').join(' AND ')
    rows = db.prepare(`SELECT kind, path, title, session_id, message_id,
      snippet(docs, 0, char(1), char(2), '…', 16) AS snippet, bm25(docs) AS score
      FROM docs WHERE docs MATCH ? ORDER BY score LIMIT ?`).all(match, capped) as Array<Record<string, unknown>>
  }
  return rows.map(row => ({
    kind: row.kind === 'session' ? 'session' : 'file',
    path: String(row.path ?? ''),
    title: String(row.title ?? ''),
    snippet: String(row.snippet ?? row.body ?? '').replace(/[\u0001\u0002]/g, ''),
    ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
    ...(row.message_id ? { messageId: String(row.message_id) } : {}),
    score: Number(row.score ?? 0),
  }))
}
