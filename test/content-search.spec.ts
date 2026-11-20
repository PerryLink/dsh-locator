/**
 * Query-layer tests for src/content-search.ts and src/content-search-worker.ts:
 * adaptive rank ordering (P0-6), filter SQL split between the page (rowid
 * subqueries) and count (docs columns, bounded) paths (P1-3), cooperative
 * cancellation and the worker protocol + degraded profile (P2).
 *
 * The FTS schema is created directly so these tests exercise the query layer
 * without paying for a ContentIndex build; content.spec.ts covers the store.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { RANK_ADAPTIVE_THRESHOLD, searchContent, type ContentSearchResult } from '../src/content-search.ts'
import { createSearchWorkerHandler, SEARCH_WORKER_PROTOCOL, type SearchWorkerReply } from '../src/content-search-worker.ts'

/** Platform-native test roots: the query layer keeps the OS separator in path filters. */
const ROOT = process.platform === 'win32' ? 'C:\\root' : '/root'
const SCOPE = process.platform === 'win32' ? 'C:\\scope' : '/scope'
const SESSIONS = process.platform === 'win32' ? 'C:\\sessions' : '/sessions'
const under = (base: string, rest: string): string => base + sep + rest

const cleanups: Array<() => void> = []
afterAll(() => { for (const cleanup of cleanups.reverse()) cleanup() })

interface DocSpec {
  body: string
  kind?: 'file' | 'session'
  path?: string
  title?: string
  sessionId?: string
  messageId?: string
}

interface TestIndex {
  db: DatabaseSync
  path: string
  /** Rowid of the first inserted document. */
  firstRowid: number
}

/** Build a content.db-shaped database with the FTS5 trigram schema. */
function createIndex(specs: readonly DocSpec[]): TestIndex {
  const dir = mkdtempSync(join(tmpdir(), 'locator-query-'))
  const path = join(dir, 'content.db')
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows */ } })
  const db = new DatabaseSync(path)
  cleanups.push(() => { try { db.close() } catch { /* already closed */ } })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = OFF')
  db.exec('CREATE VIRTUAL TABLE docs USING fts5(body, kind UNINDEXED, path UNINDEXED, title UNINDEXED, session_id UNINDEXED, message_id UNINDEXED, tokenize = \'trigram\')')
  db.exec('CREATE TABLE docs_meta (rowid INTEGER PRIMARY KEY, doc_key TEXT UNIQUE, path TEXT, mtime INTEGER, kind TEXT, node_key TEXT)')
  db.exec('CREATE INDEX docs_meta_path ON docs_meta(path)')
  const insertDoc = db.prepare('INSERT INTO docs (body, kind, path, title, session_id, message_id) VALUES (?, ?, ?, ?, ?, ?)')
  const insertMeta = db.prepare('INSERT INTO docs_meta (doc_key, path, mtime, kind, node_key) VALUES (?, ?, ?, ?, ?)')
  db.exec('BEGIN')
  for (const [index, spec] of specs.entries()) {
    const kind = spec.kind ?? 'file'
    const pathValue = spec.path ?? under(ROOT, 'doc' + String(index) + '.md')
    const title = spec.title ?? 'doc' + String(index) + '.md'
    const sessionId = spec.sessionId ?? null
    const messageId = spec.messageId ?? null
    const result = insertDoc.run(spec.body, kind, pathValue, title, sessionId, messageId)
    insertMeta.run('doc-' + String(index), pathValue, 0, kind, null)
    if (index !== 0) continue
    void result
  }
  db.exec('COMMIT')
  const first = db.prepare('SELECT min(rowid) AS rowid FROM docs').get() as { rowid?: number } | undefined
  return { db, path, firstRowid: Number(first?.rowid ?? 1) }
}

function hits(result: ContentSearchResult): Array<{ title: string; path: string }> {
  return result.hits.map(hit => ({ title: hit.title, path: hit.path }))
}

/** A corpus whose match set for `term` is wider than the adaptive threshold. */
function wideCorpus(term: string, count = RANK_ADAPTIVE_THRESHOLD + 105): DocSpec[] {
  const specs: DocSpec[] = []
  for (let index = 0; index < count; index++) {
    specs.push({ body: term + ' filler body ' + String(index), title: 'plain' + String(index) + '.md' })
  }
  return specs
}

describe('adaptive rank ordering (P0-6)', () => {
  it('keeps bm25 ordering for a narrow result set', () => {
    const index = createIndex([
      { body: 'alpha appears once here', title: 'sparse.md' },
      { body: 'alpha alpha alpha alpha alpha alpha', title: 'dense.md' },
    ])
    const result = searchContent(index.db, 'alpha', 5)
    expect(result.error).toBeUndefined()
    expect(hits(result).map(hit => hit.title)).toEqual(['dense.md', 'sparse.md'])
  })

  it('skips bm25 for a wide match set and restores it when adaptive rank is off', () => {
    const specs = wideCorpus('common')
    specs[0] = { body: 'common first document', title: 'first.md' }
    specs[1] = { body: 'common second document', title: 'second.md' }
    specs.push({ body: 'common '.repeat(40), title: 'dense.md' })
    const index = createIndex(specs)
    const adaptive = searchContent(index.db, 'common', 3)
    expect(adaptive.error).toBeUndefined()
    expect(hits(adaptive).map(hit => hit.title)).toEqual(['first.md', 'second.md', 'plain2.md'])
    const alwaysRank = searchContent(index.db, 'common', 3, { rankAdaptive: false })
    expect(hits(alwaysRank)[0]?.title).toBe('dense.md')
  })

  it('never ranks whole-word searches', () => {
    const index = createIndex([
      { body: 'test one plain row', title: 'plain.md' },
      { body: 'test test test test dense row', title: 'dense.md' },
    ])
    const wholeWord = searchContent(index.db, 'test', 5, { wholeWord: true })
    expect(hits(wholeWord).map(hit => hit.title)).toEqual(['plain.md', 'dense.md'])
    // The same corpus with wholeWord off and adaptive rank off proves the
    // ordering difference comes from bm25, not from the data.
    const ranked = searchContent(index.db, 'test', 5, { rankAdaptive: false })
    expect(hits(ranked)[0]?.title).toBe('dense.md')
  })

  it('sorts a wide unranked page with the light heuristic (title matches first)', () => {
    const specs = wideCorpus('needle')
    specs[2] = { body: 'needle titled document', title: 'needle-titled.md' }
    const index = createIndex(specs)
    const result = searchContent(index.db, 'needle', 5)
    expect(result.error).toBeUndefined()
    expect(result.hits.length).toBe(5)
    expect(result.hits[0]?.title).toBe('needle-titled.md')
  })
})

describe('filter SQL split and bounded counting (P1-3)', () => {
  it('counts a session-scoped wide match set exactly through the column path', () => {
    const specs = wideCorpus('common')
    for (let index = 0; index < 7; index++) {
      specs[index] = {
        body: 'common session message ' + String(index),
        kind: 'session',
        path: '/sessions/current.jsonl.zst',
        title: 'message' + String(index),
        sessionId: 'session-one',
      }
    }
    const index2 = createIndex(specs)
    const result = searchContent(index2.db, 'common', 10, { sessionPath: '/sessions/current.jsonl.zst' })
    expect(result.error).toBeUndefined()
    expect(result.hits).toHaveLength(7)
    expect(result.count).toEqual({ value: 7, kind: 'exact' })
  })

  it('bounds an exact count for a wide filtered set at countLimit', () => {
    const specs = wideCorpus('common')
    for (let index = 0; index < 5; index++) {
      specs[index] = { body: 'common scoped body ' + String(index), path: under(SCOPE, 'file' + String(index) + '.md') }
    }
    const index2 = createIndex(specs)
    const bounded = searchContent(index2.db, 'common', 5, { pathPrefix: SCOPE, count: 'exact', countLimit: 3 })
    expect(bounded.count).toEqual({ value: 3, kind: 'bounded', limit: 3 })
    expect(bounded.warnings).toContain('bounded-count')
    const exact = searchContent(index2.db, 'common', 5, { pathPrefix: SCOPE, count: 'exact', countLimit: 100 })
    expect(exact.count).toEqual({ value: 5, kind: 'exact' })
  })

  it('keeps narrow filtered counts exact and bounded counts capped', () => {
    const index = createIndex([
      { body: 'needle one', path: '/scope/a.md' },
      { body: 'needle two', path: '/scope/b.md' },
      { body: 'needle three', path: '/scope/c.md' },
      { body: 'needle four', path: '/scope/d.md' },
      { body: 'needle five', path: '/scope/e.md' },
    ])
    const exact = searchContent(index.db, 'needle', 5, { count: 'exact' })
    expect(exact.count).toEqual({ value: 5, kind: 'exact' })
    const bounded = searchContent(index.db, 'needle', 5, { count: 'bounded', countLimit: 3 })
    expect(bounded.count).toEqual({ value: 3, kind: 'bounded', limit: 3 })
    expect(bounded.warnings).toContain('bounded-count')
  })

  it('splits a workspace count by kind while keeping session authorization filters', () => {
    const specs = wideCorpus('common')
    for (let index = 0; index < 7; index++) {
      specs.push({ body: 'common session ' + String(index), kind: 'session', path: under(SESSIONS, 'current.jsonl.zst'), title: 's' + String(index), sessionId: 'session-one' })
    }
    for (let index = 0; index < 3; index++) {
      specs.push({ body: 'common archived ' + String(index), kind: 'session', path: under(SESSIONS, 'archived.jsonl.zst'), title: 'a' + String(index), sessionId: 'session-archived' })
    }
    const index2 = createIndex(specs)
    const result = searchContent(index2.db, 'common', 5, {
      sessionPath: under(SESSIONS, 'current.jsonl.zst'),
      pathPrefix: ROOT,
      allowedSessionIds: ['session-one', 'session-archived'],
      excludeArchivedSessions: ['session-archived'],
      count: 'exact',
      countLimit: 5000,
    })
    expect(result.error).toBeUndefined()
    expect(result.count).toEqual({ value: RANK_ADAPTIVE_THRESHOLD + 105 + 7, kind: 'exact' })
    expect(result.hits.every(hit => hit.kind === 'file' || hit.sessionId === 'session-one')).toBe(true)
  })

  it('counts only file documents when sessions are excluded on a wide set', () => {
    const specs = wideCorpus('common')
    specs.push({ body: 'common session only', kind: 'session', path: '/sessions/a.jsonl.zst' })
    const index2 = createIndex(specs)
    const result = searchContent(index2.db, 'common', 5, { excludeSessions: true })
    // A wide filtered set is counted to the cap instead of scanning every match.
    expect(result.count).toEqual({ value: 1000, kind: 'bounded', limit: 1000 })
    expect(result.warnings).toContain('bounded-count')
    const generous = searchContent(index2.db, 'common', 5, { excludeSessions: true, countLimit: 5000 })
    expect(generous.count).toEqual({ value: RANK_ADAPTIVE_THRESHOLD + 105, kind: 'exact' })
  })
})

describe('cancellation and degraded profile', () => {
  it('returns a cancelled result when the hook reports cancellation', () => {
    const index = createIndex([{ body: 'cancel marker body' }])
    const result = searchContent(index.db, 'cancel', 5, { isCancelled: () => true })
    expect(result.error).toBe('content-search-cancelled')
    expect(result.hits).toEqual([])
    expect(result.count).toEqual({ value: 0, kind: 'unknown' })
  })

  it('returns a cancelled result for an already-aborted signal', () => {
    const index = createIndex([{ body: 'cancel marker body' }])
    const controller = new AbortController()
    controller.abort()
    const result = searchContent(index.db, 'cancel', 5, { signal: controller.signal })
    expect(result.error).toBe('content-search-cancelled')
  })

  it('forces bounded counting and no rank in the degraded profile', () => {
    const index = createIndex(wideCorpus('common'))
    const result = searchContent(index.db, 'common', 3, { degrade: true, count: 'exact' })
    expect(result.warnings).toContain('query-degraded')
    expect(result.count.kind).toBe('bounded')
    expect(result.count.limit).toBe(500)
  })
})

describe('search worker protocol (protocol 2)', () => {
  function replies(): { list: SearchWorkerReply[]; post: (reply: SearchWorkerReply) => void } {
    const list: SearchWorkerReply[] = []
    return { list, post: reply => { list.push(reply) } }
  }

  it('answers both the method and the legacy flat request shapes', () => {
    const index = createIndex([{ body: 'worker protocol marker' }])
    const sink = replies()
    const handler = createSearchWorkerHandler({ dbPath: index.path, post: sink.post })
    handler.handle({ id: 1, method: 'search', params: { query: 'protocol', limit: 5 } })
    const first = sink.list[0]
    expect(first?.id).toBe(1)
    expect(first?.ok).toBe(true)
    expect(first?.result?.hits).toHaveLength(1)
    handler.handle({ id: 2, query: 'marker', limit: 5 })
    expect(sink.list[1]?.ok).toBe(true)
    expect(sink.list[1]?.result?.error).toBeUndefined()
    handler.close()
  })

  it('reports tuning pragmas and the degraded flag through info', () => {
    const index = createIndex([{ body: 'info marker body' }])
    const sink = replies()
    const handler = createSearchWorkerHandler({ dbPath: index.path, post: sink.post })
    handler.handle({ id: 1, method: 'info' })
    const info = sink.list[0]?.info
    expect(info?.protocol).toBe(SEARCH_WORKER_PROTOCOL)
    expect(info?.readOnly).toBe(true)
    expect(info?.degraded).toBe(false)
    expect(info?.pragmas.cacheSize).toBe(-16384)
    expect(info?.pragmas.queryOnly).toBe(1)
    handler.close()
  })

  it('cancels a queued request by id before it runs', () => {
    const index = createIndex([{ body: 'cancelled worker marker' }])
    const sink = replies()
    const handler = createSearchWorkerHandler({ dbPath: index.path, post: sink.post })
    handler.handle({ id: 9, method: 'cancel' })
    handler.handle({ id: 9, method: 'search', params: { query: 'cancelled', limit: 5 } })
    const reply = sink.list.find(entry => entry.id === 9)
    expect(reply?.ok).toBe(false)
    expect(reply?.error).toBe('content-search-cancelled')
    handler.close()
  })

  it('aborts through the shared cancel buffer and clears its own slot', () => {
    const index = createIndex([{ body: 'shared buffer marker' }])
    const buffer = new SharedArrayBuffer(4)
    const view = new Int32Array(buffer)
    Atomics.store(view, 0, 4)
    const sink = replies()
    const handler = createSearchWorkerHandler({ dbPath: index.path, post: sink.post, cancelBuffer: buffer })
    handler.handle({ id: 4, method: 'search', params: { query: 'shared', limit: 5 } })
    expect(sink.list[0]?.ok).toBe(false)
    expect(sink.list[0]?.error).toBe('content-search-cancelled')
    Atomics.store(view, 0, 0)
    handler.handle({ id: 5, method: 'search', params: { query: 'marker', limit: 5 } })
    expect(sink.list[1]?.ok).toBe(true)
    handler.close()
  })

  it('requires open for a connection and reports a closed worker cleanly', () => {
    const index = createIndex([{ body: 'reopen marker body' }])
    const sink = replies()
    const handler = createSearchWorkerHandler({ post: sink.post })
    handler.handle({ id: 1, method: 'search', params: { query: 'reopen', limit: 5 } })
    expect(sink.list[0]?.ok).toBe(false)
    expect(sink.list[0]?.error).toBe('content-index-unavailable')
    handler.handle({ id: 2, method: 'open', params: { path: index.path } })
    expect(sink.list[1]?.ok).toBe(true)
    handler.handle({ id: 3, method: 'search', params: { query: 'reopen', limit: 5 } })
    expect(sink.list[2]?.ok).toBe(true)
    handler.handle({ id: 4, method: 'close' })
    expect(sink.list[3]?.ok).toBe(true)
    handler.handle({ id: 5, method: 'search', params: { query: 'reopen', limit: 5 } })
    expect(sink.list[4]?.ok).toBe(false)
    expect(sink.list[4]?.error).toBe('content-index-unavailable')
  })

  it('degrades the next query after one exceeded the deadline', () => {
    const index = createIndex(wideCorpus('common'))
    const sink = replies()
    const handler = createSearchWorkerHandler({ dbPath: index.path, post: sink.post, degradeThresholdMs: 0 })
    handler.handle({ id: 1, method: 'search', params: { query: 'common', limit: 3 } })
    expect(sink.list[0]?.ok).toBe(true)
    expect(handler.info().degraded).toBe(true)
    handler.handle({ id: 2, method: 'search', params: { query: 'common', limit: 3, options: { count: 'exact' } } })
    const second = sink.list[1]
    expect(second?.ok).toBe(true)
    expect(second?.result?.warnings).toContain('query-degraded')
    expect(second?.result?.count.kind).toBe('bounded')
    handler.close()
  })

  it('keeps two independent worker connections usable at once', () => {
    const index = createIndex([{ body: 'two worker marker body' }])
    const firstSink = replies()
    const secondSink = replies()
    const first = createSearchWorkerHandler({ dbPath: index.path, post: firstSink.post })
    const second = createSearchWorkerHandler({ dbPath: index.path, post: secondSink.post })
    first.handle({ id: 1, method: 'cancel' })
    first.handle({ id: 1, method: 'search', params: { query: 'worker', limit: 5 } })
    second.handle({ id: 1, method: 'search', params: { query: 'worker', limit: 5 } })
    expect(firstSink.list[0]?.ok).toBe(false)
    expect(secondSink.list[0]?.ok).toBe(true)
    expect(secondSink.list[0]?.result?.hits).toHaveLength(1)
    first.close()
    second.close()
  })
})