/**
 * Query-layer tests for src/content-search.ts and src/content-search-worker.ts:
 * adaptive rank ordering (P0-6), filter SQL split between the page (rowid
 * subqueries) and count (docs columns, bounded) paths (P1-3), cooperative
 * cancellation and the worker protocol + degraded profile (P2).
 *
 * 0.20.2 adds coverage for the two quality fixes: the wide unranked page is
 * now fetched per document kind (file page first, session share capped) and
 * re-sorted in page, while 2-codepoint queries are answered by the bounded
 * name+body fallback instead of being rejected. The worker profile test also
 * pins the raised page cache (P1).
 *
 * The FTS schema is created directly so these tests exercise the query layer
 * without paying for a ContentIndex build; content.spec.ts covers the store.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
// The persisted schema-v4 kind codes (0 = file, 1 = session) live in content.ts;
// importing them keeps the fixture honest if the codes are ever re-read.
import { DOC_KIND_FILE, DOC_KIND_SESSION } from '../src/content.ts'
import {
  RANK_ADAPTIVE_THRESHOLD,
  SEARCH_CACHE_KIB,
  WIDE_SESSION_MAX_SHARE,
  checkContentQuery,
  searchContent,
  type ContentSearchResult,
} from '../src/content-search.ts'
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

/**
 * Build a content.db-shaped database with the schema v4 FTS5 trigram schema:
 * normalized paths dictionary, integer document kinds, and the same derived
 * indexes content.ts creates. The query layer resolves every docs_meta filter
 * through the paths table, so a v3-shaped fixture would silently test SQL that
 * the production database can no longer run.
 */
function createIndex(specs: readonly DocSpec[]): TestIndex {
  const dir = mkdtempSync(join(tmpdir(), 'locator-query-'))
  const path = join(dir, 'content.db')
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows */ } })
  const db = new DatabaseSync(path)
  cleanups.push(() => { try { db.close() } catch { /* already closed */ } })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = OFF')
  db.exec('CREATE VIRTUAL TABLE docs USING fts5(body, kind UNINDEXED, path UNINDEXED, title UNINDEXED, session_id UNINDEXED, message_id UNINDEXED, tokenize = \'trigram\')')
  db.exec('CREATE TABLE paths (id INTEGER PRIMARY KEY, path TEXT NOT NULL)')
  db.exec('CREATE UNIQUE INDEX paths_path ON paths(path)')
  db.exec('CREATE TABLE docs_meta (rowid INTEGER PRIMARY KEY, path_id INTEGER NOT NULL, mtime INTEGER, kind_id INTEGER NOT NULL, node_key TEXT, format TEXT, session_key TEXT)')
  db.exec('CREATE INDEX docs_meta_path_id ON docs_meta(path_id)')
  db.exec('CREATE INDEX docs_meta_mtime ON docs_meta(mtime, rowid)')
  db.exec('CREATE UNIQUE INDEX docs_meta_file_path ON docs_meta(path_id) WHERE kind_id = 0')
  db.exec('CREATE UNIQUE INDEX docs_meta_session_key ON docs_meta(session_key) WHERE kind_id = 1')
  db.exec('CREATE TABLE symbols (path_id INTEGER NOT NULL, name TEXT NOT NULL, kind INTEGER NOT NULL, line INTEGER NOT NULL, language INTEGER, scope TEXT)')
  db.exec('PRAGMA user_version = 4')
  const insertDoc = db.prepare('INSERT INTO docs (rowid, body, kind, path, title, session_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const insertPath = db.prepare('INSERT INTO paths (path) VALUES (?) ON CONFLICT(path) DO UPDATE SET path = excluded.path RETURNING id')
  const insertMeta = db.prepare('INSERT INTO docs_meta (rowid, path_id, mtime, kind_id, node_key, format, session_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
  db.exec('BEGIN')
  for (const [index, spec] of specs.entries()) {
    const rowid = index + 1
    const kind = spec.kind ?? 'file'
    const pathValue = spec.path ?? under(ROOT, 'doc' + String(index) + '.md')
    const title = spec.title ?? 'doc' + String(index) + '.md'
    const sessionId = spec.sessionId ?? null
    const messageId = spec.messageId ?? null
    insertDoc.run(rowid, spec.body, kind, pathValue, title, sessionId, messageId)
    const pathId = Number((insertPath.get(pathValue) as { id?: number } | undefined)?.id ?? 0)
    const kindId = kind === 'session' ? DOC_KIND_SESSION : DOC_KIND_FILE
    // One document per session key: a test may index many messages of the same
    // session log, so a row without messageId still needs its own key.
    const sessionKey = kindId === DOC_KIND_SESSION
      ? 'session:' + (spec.sessionId ?? 'none') + ':' + (spec.messageId ?? 'row-' + String(index))
      : null
    // Latest document last, so name-hit mtime ordering is deterministic.
    insertMeta.run(rowid, pathId, index, kindId, null, null, sessionKey)
  }
  db.exec('COMMIT')
  return { db, path, firstRowid: 1 }
}

function titles(result: ContentSearchResult): string[] {
  return result.hits.map(hit => hit.title)
}

function fileShare(result: ContentSearchResult): number {
  if (result.hits.length === 0) return 0
  return result.hits.filter(hit => hit.kind === 'file').length / result.hits.length
}

function sessionShare(result: ContentSearchResult): number {
  if (result.hits.length === 0) return 0
  return result.hits.filter(hit => hit.kind === 'session').length / result.hits.length
}

/** A corpus whose match set for \`term\` is wider than the adaptive threshold. */
function wideCorpus(term: string, count = RANK_ADAPTIVE_THRESHOLD + 105): DocSpec[] {
  const specs: DocSpec[] = []
  for (let index = 0; index < count; index++) {
    specs.push({ body: term + ' filler body ' + String(index), title: 'plain' + String(index) + '.md' })
  }
  return specs
}

/** \`count\` session documents matching \`term\`, indexed before the file documents. */
function sessionDocs(term: string, count: number): DocSpec[] {
  const specs: DocSpec[] = []
  for (let index = 0; index < count; index++) {
    specs.push({
      body: term + ' session message ' + String(index),
      kind: 'session',
      path: under(SESSIONS, 'current.jsonl.zst'),
      title: 'message' + String(index),
      sessionId: 'session-one',
      messageId: 'm' + String(index),
    })
  }
  return specs
}

describe('schema v4 query fixture', () => {
  it('pins the normalized docs_meta/paths shape the query layer runs against', () => {
    const index = createIndex([{ body: 'schema marker', path: under(ROOT, 'schema.md') }])
    const columns = new Set(
      (index.db.prepare('PRAGMA table_info(docs_meta)').all() as Array<{ name?: string }>)
        .map(row => row.name)
        .filter((name): name is string => typeof name === 'string'),
    )
    expect([...columns].sort()).toEqual(['format', 'kind_id', 'mtime', 'node_key', 'path_id', 'rowid', 'session_key'])
    expect(columns.has('path')).toBe(false)
    expect(columns.has('kind')).toBe(false)
    expect(columns.has('doc_key')).toBe(false)
    const version = index.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    expect(Number(version?.user_version)).toBe(4)
    const pathRows = index.db.prepare('SELECT path FROM paths').all() as Array<{ path?: string }>
    expect(pathRows.map(row => row.path)).toEqual([under(ROOT, 'schema.md')])
  })
})

describe('adaptive rank ordering (P0-6)', () => {
  it('keeps bm25 ordering for a narrow result set', () => {
    const index = createIndex([
      { body: 'alpha appears once here', title: 'sparse.md' },
      { body: 'alpha alpha alpha alpha alpha alpha', title: 'dense.md' },
    ])
    const result = searchContent(index.db, 'alpha', 5)
    expect(result.error).toBeUndefined()
    expect(titles(result)).toEqual(['dense.md', 'sparse.md'])
  })

  it('leaves a narrow mixed-kind query identical to always-rank bm25', () => {
    const index = createIndex([
      { body: 'needle once', title: 'sparse.md' },
      { body: 'needle needle needle needle', title: 'dense.md' },
      { body: 'needle session text', kind: 'session', path: under(SESSIONS, 'a.jsonl.zst'), title: 'session.md', sessionId: 's1' },
      { body: 'needle in the middle', title: 'middle.md' },
    ])
    const adaptive = searchContent(index.db, 'needle', 10)
    const alwaysRank = searchContent(index.db, 'needle', 10, { rankAdaptive: false })
    expect(adaptive.error).toBeUndefined()
    expect(titles(adaptive)).toEqual(titles(alwaysRank))
    expect(adaptive.hits.map(hit => hit.score)).toEqual(alwaysRank.hits.map(hit => hit.score))
  })

  it('skips bm25 for a wide match set and restores it when adaptive rank is off', () => {
    const specs = wideCorpus('common')
    specs[0] = { body: 'common first document', title: 'first.md' }
    specs[1] = { body: 'common second document', title: 'second.md' }
    specs.push({ body: 'common '.repeat(40), title: 'dense.md' })
    const index = createIndex(specs)
    const adaptive = searchContent(index.db, 'common', 3)
    expect(adaptive.error).toBeUndefined()
    expect(titles(adaptive)).toEqual(['first.md', 'second.md', 'plain2.md'])
    const alwaysRank = searchContent(index.db, 'common', 3, { rankAdaptive: false })
    expect(titles(alwaysRank)[0]).toBe('dense.md')
  })

  it('never ranks whole-word searches', () => {
    const index = createIndex([
      { body: 'test one plain row', title: 'plain.md' },
      { body: 'test test test test dense row', title: 'dense.md' },
    ])
    const wholeWord = searchContent(index.db, 'test', 5, { wholeWord: true })
    expect(titles(wholeWord)).toEqual(['plain.md', 'dense.md'])
    // The same corpus with wholeWord off and adaptive rank off proves the
    // ordering difference comes from bm25, not from the data.
    const ranked = searchContent(index.db, 'test', 5, { rankAdaptive: false })
    expect(titles(ranked)[0]).toBe('dense.md')
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

  it('ranks a wide page by term frequency inside the file group', () => {
    const specs = wideCorpus('needle')
    // Low rowid, so this file is inside the first page of file rows; the term
    // frequency heuristic must lift it above its neighbours.
    specs[3] = { body: 'needle needle needle needle needle needle dense row', title: 'dense-page.md' }
    const index = createIndex(specs)
    const result = searchContent(index.db, 'needle', 10)
    expect(result.error).toBeUndefined()
    expect(result.hits[0]?.title).toBe('dense-page.md')
  })
})

describe('wide-page kind grouping (0.20.2 P0-1)', () => {
  it('fills a wide page from files even when sessions are indexed first', () => {
    // A full build indexes sessions before files; before the fix the lowest
    // rowids made a common-word page 100% session documents.
    const specs = [...sessionDocs('common', 60), ...wideCorpus('common')]
    const index = createIndex(specs)
    const result = searchContent(index.db, 'common', 20)
    expect(result.error).toBeUndefined()
    expect(result.hits).toHaveLength(20)
    expect(fileShare(result)).toBeGreaterThanOrEqual(0.8)
    expect(sessionShare(result)).toBeLessThanOrEqual(WIDE_SESSION_MAX_SHARE)
    expect(result.hits.every(hit => hit.kind === 'file')).toBe(true)
  })

  it('keeps the file share >= 80% and the session share <= 30% for the/function/error', () => {
    const terms = ['the', 'function', 'error']
    const specs: DocSpec[] = [...sessionDocs('the function error', 90)]
    for (let index = 0; index < RANK_ADAPTIVE_THRESHOLD + 105; index++) {
      specs.push({ body: 'the function error filler body ' + String(index), title: 'plain' + String(index) + '.md' })
    }
    const index = createIndex(specs)
    for (const term of terms) {
      const result = searchContent(index.db, term, 20)
      expect(result.error).toBeUndefined()
      expect(result.hits).toHaveLength(20)
      expect(fileShare(result)).toBeGreaterThanOrEqual(0.8)
      expect(sessionShare(result)).toBeLessThanOrEqual(WIDE_SESSION_MAX_SHARE)
      expect(result.hits.every(hit => hit.kind === 'file')).toBe(true)
    }
  })

  it('caps the session share when file matches are scarce', () => {
    const specs: DocSpec[] = [
      { body: 'common file one', title: 'file-one.md' },
      { body: 'common file two', title: 'file-two.md' },
      { body: 'common file three', title: 'file-three.md' },
      ...sessionDocs('common', RANK_ADAPTIVE_THRESHOLD + 5),
    ]
    const index = createIndex(specs)
    const result = searchContent(index.db, 'common', 20)
    expect(result.error).toBeUndefined()
    const files = result.hits.filter(hit => hit.kind === 'file')
    const sessions = result.hits.filter(hit => hit.kind === 'session')
    expect(files).toHaveLength(3)
    // Sessions only fill the slots the file page leaves empty, and never more
    // than ~30% of the requested page.
    expect(sessions.length).toBeLessThanOrEqual(Math.floor(20 * WIDE_SESSION_MAX_SHARE))
    expect(sessions.length).toBeGreaterThan(0)
    // File hits stay in front of session hits.
    expect(result.hits.slice(0, 3).every(hit => hit.kind === 'file')).toBe(true)
    expect(result.hits.slice(3).every(hit => hit.kind === 'session')).toBe(true)
  })

  it('keeps a session-scoped wide query uncapped and in one group', () => {
    const specs = sessionDocs('common', RANK_ADAPTIVE_THRESHOLD + 5)
    const index = createIndex(specs)
    const result = searchContent(index.db, 'common', 10, { sessionPath: under(SESSIONS, 'current.jsonl.zst') })
    expect(result.error).toBeUndefined()
    expect(result.hits).toHaveLength(10)
    expect(result.hits.every(hit => hit.kind === 'session')).toBe(true)
  })

  it('never mixes session documents into an excludeSessions file page', () => {
    const specs = [...sessionDocs('common', 30), ...wideCorpus('common')]
    const index = createIndex(specs)
    const result = searchContent(index.db, 'common', 10, { excludeSessions: true })
    expect(result.error).toBeUndefined()
    expect(result.hits.every(hit => hit.kind === 'file')).toBe(true)
  })

  it('pages a wide file page deterministically across load-more offsets', () => {
    const specs = wideCorpus('common', RANK_ADAPTIVE_THRESHOLD + 205)
    const index = createIndex(specs)
    const first = searchContent(index.db, 'common', 10, { offset: 0 })
    const second = searchContent(index.db, 'common', 10, { offset: 10 })
    expect(titles(first)).toHaveLength(10)
    expect(titles(second)).toHaveLength(10)
    expect(titles(first).filter(title => titles(second).includes(title))).toEqual([])
  })
})

describe('short-query fallback (0.20.2 P0-2)', () => {
  it('answers a 2-codepoint Chinese body match with file hits and the fallback flag', () => {
    const index = createIndex([
      { body: '这里讨论索引结构', path: under(ROOT, 'notes/a.md'), title: 'a.md' },
      { body: 'unrelated english body', path: under(ROOT, 'notes/b.md'), title: 'b.md' },
    ])
    const result = searchContent(index.db, '索引', 10, { shortQueryFallback: true })
    expect(result.error).toBeUndefined()
    expect(result.shortQueryFallback).toBe(true)
    expect(result.warnings).toContain('content-query-short-fallback')
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.path).toBe(under(ROOT, 'notes/a.md'))
  })

  it('answers a 2-character ASCII query', () => {
    const index = createIndex([
      { body: 'use ai here', path: under(ROOT, 'ai.md'), title: 'ai.md' },
      { body: 'nothing relevant', path: under(ROOT, 'other.md'), title: 'other.md' },
    ])
    const result = searchContent(index.db, 'ai', 10, { shortQueryFallback: true })
    expect(result.error).toBeUndefined()
    expect(result.shortQueryFallback).toBe(true)
    expect(result.hits.map(hit => hit.path)).toContain(under(ROOT, 'ai.md'))
  })

  it('returns name hits before body hits', () => {
    const nameHit = under(ROOT, '索引说明.md')
    const bodyHit = under(ROOT, 'body-only.md')
    const index = createIndex([
      { body: 'body match 索引 here', path: bodyHit, title: 'body-only.md' },
      { body: 'no body match at all', path: nameHit, title: '索引说明.md' },
    ])
    const result = searchContent(index.db, '索引', 10, { shortQueryFallback: true })
    expect(result.error).toBeUndefined()
    expect(result.hits.map(hit => hit.path)).toContain(nameHit)
    expect(result.hits.map(hit => hit.path)).toContain(bodyHit)
    expect(result.hits[0]?.path).toBe(nameHit)
  })

  it('rejects one-codepoint queries even with the fallback enabled', () => {
    const index = createIndex([{ body: 'a single letter body' }])
    const result = searchContent(index.db, 'a', 10, { shortQueryFallback: true })
    expect(result.error).toBe('content-query-too-short')
    expect(result.shortQueryFallback).toBeUndefined()
    const check = checkContentQuery('a', 'normal', { allowShort: true })
    expect(check.ok).toBe(false)
    expect(check.error).toBe('content-query-too-short')
  })

  it('keeps rejecting 2-codepoint queries when the caller did not opt in', () => {
    const index = createIndex([{ body: '索引 body' }])
    const result = searchContent(index.db, '索引', 10)
    expect(result.error).toBe('content-query-too-short')
    const legacy = checkContentQuery('索引', 'normal')
    expect(legacy.ok).toBe(false)
    expect(legacy.error).toBe('content-query-too-short')
  })

  it('keeps normal 3+ character queries on the trigram path', () => {
    const index = createIndex([{ body: 'needle in a body', path: under(ROOT, 'needle.md') }])
    const result = searchContent(index.db, 'needle', 10, { shortQueryFallback: true })
    expect(result.error).toBeUndefined()
    expect(result.shortQueryFallback).toBeUndefined()
    expect(result.warnings).not.toContain('content-query-short-fallback')
    expect(result.hits).toHaveLength(1)
  })

  it('respects the path prefix while scanning bodies', () => {
    const index = createIndex([
      { body: '共享 索引 内容', path: under(SCOPE, 'inside.md') },
      { body: '共享 索引 内容', path: under(ROOT, 'outside.md') },
    ])
    const result = searchContent(index.db, '索引', 10, { shortQueryFallback: true, pathPrefix: SCOPE })
    expect(result.error).toBeUndefined()
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.path).toBe(under(SCOPE, 'inside.md'))
  })

  it('applies the whole-word filter to fallback body hits', () => {
    const index = createIndex([
      { body: 'said again only words', path: under(ROOT, 'inside-word.md'), title: 'inside-word.md' },
      { body: 'ai alone here', path: under(ROOT, 'alone.md'), title: 'alone.md' },
    ])
    const result = searchContent(index.db, 'ai', 10, { shortQueryFallback: true, wholeWord: true })
    expect(result.error).toBeUndefined()
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.path).toBe(under(ROOT, 'alone.md'))
  })

  it('honours case sensitivity with GLOB matching', () => {
    const index = createIndex([
      { body: 'AI upper body', path: under(ROOT, 'upper.md') },
      { body: 'ai lower body', path: under(ROOT, 'lower.md') },
    ])
    const exact = searchContent(index.db, 'AI', 10, { shortQueryFallback: true, caseSensitive: true })
    expect(exact.error).toBeUndefined()
    expect(exact.hits).toHaveLength(1)
    expect(exact.hits[0]?.path).toBe(under(ROOT, 'upper.md'))
    const folded = searchContent(index.db, 'AI', 10, { shortQueryFallback: true })
    expect(folded.hits).toHaveLength(2)
  })

  it('matches every term of a mixed short/long query', () => {
    const index = createIndex([
      { body: 'ai and config together', path: under(ROOT, 'both.md') },
      { body: 'ai without the long term', path: under(ROOT, 'short-only.md') },
    ])
    const result = searchContent(index.db, 'ai config', 10, { shortQueryFallback: true })
    expect(result.error).toBeUndefined()
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.path).toBe(under(ROOT, 'both.md'))
  })

  it('supports extended mode target text for a short query', () => {
    const index = createIndex([{ body: '索引 内容', path: under(ROOT, 'extended.md') }])
    const result = searchContent(index.db, '索引', 10, { matchMode: 'extended', shortQueryFallback: true })
    expect(result.error).toBeUndefined()
    expect(result.shortQueryFallback).toBe(true)
    expect(result.hits).toHaveLength(1)
    const invalid = searchContent(index.db, '\\xZZ', 10, { matchMode: 'extended', shortQueryFallback: true })
    expect(invalid.error).toBe('invalid-escape')
  })

  it('reports an exact count when the scan finishes and a bounded count when the page fills', () => {
    const smallSpecs: DocSpec[] = []
    for (let index = 0; index < 3; index++) smallSpecs.push({ body: '索引 rare ' + String(index), path: under(ROOT, 'rare' + String(index) + '.md') })
    for (let index = 0; index < 20; index++) smallSpecs.push({ body: 'filler ' + String(index), path: under(ROOT, 'fill' + String(index) + '.md') })
    const small = createIndex(smallSpecs)
    const exact = searchContent(small.db, '索引', 10, { shortQueryFallback: true })
    expect(exact.count).toEqual({ value: 3, kind: 'exact' })
    const wideSpecs: DocSpec[] = []
    for (let index = 0; index < 300; index++) wideSpecs.push({ body: 'ai common ' + String(index), path: under(ROOT, 'wide' + String(index) + '.md') })
    const wide = createIndex(wideSpecs)
    const bounded = searchContent(wide.db, 'ai', 10, { shortQueryFallback: true })
    expect(bounded.hits).toHaveLength(10)
    expect(bounded.count.kind).toBe('bounded')
    expect(bounded.warnings).toContain('bounded-count')
  })

  it('scans a pure session scope for a short query', () => {
    const sessionPath = under(SESSIONS, 'current.jsonl.zst')
    const index = createIndex([
      { body: '索引 session content', kind: 'session', path: sessionPath, sessionId: 'session-one' },
      { body: '索引 file content', path: under(ROOT, 'file.md') },
    ])
    const result = searchContent(index.db, '索引', 10, { shortQueryFallback: true, sessionPath })
    expect(result.error).toBeUndefined()
    expect(result.shortQueryFallback).toBe(true)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.kind).toBe('session')
    expect(result.hits[0]?.sessionId).toBe('session-one')
  })

  it('bounds the count when name hits fill the page and bodies stay unscanned', () => {
    const specs: DocSpec[] = []
    for (let index = 0; index < 30; index++) {
      specs.push({ body: 'no match at all ' + String(index), path: under(ROOT, '索引' + String(index) + '.md'), title: '索引' + String(index) + '.md' })
    }
    specs.push({ body: 'body match 索引 here', path: under(ROOT, 'body-only.md') })
    const index = createIndex(specs)
    const result = searchContent(index.db, '索引', 10, { shortQueryFallback: true })
    expect(result.error).toBeUndefined()
    expect(result.hits).toHaveLength(10)
    expect(result.hits.every(hit => hit.title.includes('索引'))).toBe(true)
    // The body scan never ran, so the count cannot claim to be exact.
    expect(result.count.kind).toBe('bounded')
    expect(result.warnings).toContain('bounded-count')
  })

  it('returns nothing for a session-only scope with sessions excluded', () => {
    const sessionPath = under(SESSIONS, 'current.jsonl.zst')
    const index = createIndex([
      { body: '索引 session content', kind: 'session', path: sessionPath, sessionId: 'session-one' },
      { body: '索引 file content', path: under(ROOT, 'file.md') },
    ])
    const result = searchContent(index.db, '索引', 10, { shortQueryFallback: true, sessionPath, excludeSessions: true })
    expect(result.error).toBeUndefined()
    expect(result.shortQueryFallback).toBe(true)
    expect(result.hits).toEqual([])
    expect(result.count).toEqual({ value: 0, kind: 'exact' })
  })

  it('keeps a short-query session window on the caller log', () => {
    const sessionPath = under(SESSIONS, 'current.jsonl.zst')
    const index = createIndex([
      { body: '索引 current message', kind: 'session', path: sessionPath, title: 'current', sessionId: 'session-one', messageId: 'm1' },
      { body: '索引 other message', kind: 'session', path: under(SESSIONS, 'other.jsonl.zst'), title: 'other', sessionId: 'session-two', messageId: 'm1' },
      { body: '索引 file body', path: under(ROOT, 'file.md') },
    ])
    const result = searchContent(index.db, '索引', 10, { shortQueryFallback: true, sessionPath })
    expect(result.error).toBeUndefined()
    expect(result.shortQueryFallback).toBe(true)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.title).toBe('current')
    expect(result.hits[0]?.sessionId).toBe('session-one')
    expect(result.count).toEqual({ value: 1, kind: 'exact' })
  })

  it('filters short-query name hits by path prefix through the paths dictionary', () => {
    const index = createIndex([
      { body: 'no body match at all', path: under(SCOPE, '索引-inside.md'), title: 'inside' },
      { body: 'no body match at all', path: under(ROOT, '索引-outside.md'), title: 'outside' },
    ])
    const result = searchContent(index.db, '索引', 10, { shortQueryFallback: true, pathPrefix: SCOPE })
    expect(result.error).toBeUndefined()
    expect(result.hits.map(hit => hit.title)).toEqual(['inside'])
    expect(result.count).toEqual({ value: 1, kind: 'exact' })
  })

  it('stops the fallback when the cancellation hook fires', () => {
    const index = createIndex([{ body: '索引 body' }])
    const result = searchContent(index.db, '索引', 10, { shortQueryFallback: true, isCancelled: () => true })
    expect(result.error).toBe('content-search-cancelled')
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
    expect(result.count).toEqual({ value: 1000, kind: 'bounded', limit: 1000 })
    expect(result.warnings).toContain('bounded-count')
    const generous = searchContent(index2.db, 'common', 5, { excludeSessions: true, countLimit: 5000 })
    expect(generous.count).toEqual({ value: RANK_ADAPTIVE_THRESHOLD + 105, kind: 'exact' })
  })

  it('composes a workspace page filter by kind through the paths dictionary', () => {
    const sessionPath = under(SESSIONS, 'current.jsonl.zst')
    const index = createIndex([
      { body: 'anchor session body', kind: 'session', path: sessionPath, title: 'session', sessionId: 'session-one', messageId: 'm1' },
      { body: 'anchor current file', path: under(ROOT, 'current.md'), title: 'current.md' },
      { body: 'anchor other file', path: under(SCOPE, 'other.md'), title: 'other.md' },
      { body: 'anchor stale session', kind: 'session', path: under(SESSIONS, 'other.jsonl.zst'), title: 'other-session', sessionId: 'session-two', messageId: 'm2' },
    ])
    // Workspace scope = session rows from this log OR file rows under this
    // prefix; the v4 page filter resolves both through the paths dictionary.
    const result = searchContent(index.db, 'anchor', 10, { sessionPath, pathPrefix: ROOT })
    expect(result.error).toBeUndefined()
    expect(result.hits.map(hit => hit.path).sort()).toEqual([under(ROOT, 'current.md'), sessionPath].sort())
    expect(result.count).toEqual({ value: 2, kind: 'exact' })
  })

  it('restricts a pure session window through the paths dictionary', () => {
    const sessionPath = under(SESSIONS, 'current.jsonl.zst')
    const index = createIndex([
      { body: 'window marker one', kind: 'session', path: sessionPath, title: 'm1', sessionId: 'session-one', messageId: 'm1' },
      { body: 'window marker two', kind: 'session', path: sessionPath, title: 'm2', sessionId: 'session-one', messageId: 'm2' },
      { body: 'window marker other', kind: 'session', path: under(SESSIONS, 'other.jsonl.zst'), title: 'other', sessionId: 'session-two', messageId: 'm1' },
    ])
    const result = searchContent(index.db, 'window', 10, { sessionPath })
    expect(result.error).toBeUndefined()
    expect(result.hits.map(hit => hit.title).sort()).toEqual(['m1', 'm2'])
    expect(result.hits.every(hit => hit.sessionId === 'session-one')).toBe(true)
    expect(result.count).toEqual({ value: 2, kind: 'exact' })
  })

  it('keeps sessions scoped to the caller log but all file roots with fileHitsAllRoots', () => {
    const sessionPath = under(SESSIONS, 'current.jsonl.zst')
    const index = createIndex([
      { body: 'wings session marker', kind: 'session', path: sessionPath, title: 'session', sessionId: 'session-one', messageId: 'm1' },
      { body: 'wings root file', path: under(ROOT, 'root.md'), title: 'root.md' },
      { body: 'wings scope file', path: under(SCOPE, 'scope.md'), title: 'scope.md' },
      { body: 'wings other session', kind: 'session', path: under(SESSIONS, 'other.jsonl.zst'), title: 'other-session', sessionId: 'session-two', messageId: 'm2' },
    ])
    const result = searchContent(index.db, 'wings', 10, { sessionPath, fileHitsAllRoots: true })
    expect(result.error).toBeUndefined()
    expect(result.hits.map(hit => hit.kind === 'file' ? hit.path : hit.sessionId).sort())
      .toEqual([under(ROOT, 'root.md'), under(SCOPE, 'scope.md'), 'session-one'].sort())
    expect(result.count).toEqual({ value: 3, kind: 'exact' })
  })

  it('pages a filtered wide set across offsets through the paths dictionary', () => {
    const specs = wideCorpus('common', RANK_ADAPTIVE_THRESHOLD + 205)
    const index = createIndex(specs)
    const first = searchContent(index.db, 'common', 10, { pathPrefix: ROOT, offset: 0 })
    const second = searchContent(index.db, 'common', 10, { pathPrefix: ROOT, offset: 10 })
    expect(titles(first)).toHaveLength(10)
    expect(titles(second)).toHaveLength(10)
    expect(titles(first).filter(title => titles(second).includes(title))).toEqual([])
    // Every fixture path lives under ROOT, but the filtered count is bounded by
    // the wide filtered path (never an unbounded exact count).
    expect(first.count).toEqual({ value: 1000, kind: 'bounded', limit: 1000 })
    expect(first.warnings).toContain('bounded-count')
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

  it('reports the raised page cache and in-memory temp store through info', () => {
    const index = createIndex([{ body: 'info marker body' }])
    const sink = replies()
    const handler = createSearchWorkerHandler({ dbPath: index.path, post: sink.post })
    handler.handle({ id: 1, method: 'info' })
    const info = sink.list[0]?.info
    expect(info?.protocol).toBe(SEARCH_WORKER_PROTOCOL)
    expect(info?.readOnly).toBe(true)
    expect(info?.degraded).toBe(false)
    expect(info?.pragmas.cacheSize).toBe(-SEARCH_CACHE_KIB)
    expect(info?.pragmas.queryOnly).toBe(1)
    expect(info?.pragmas.tempStore).toBe(2)
    expect(info?.pragmas.mmapSize).toBe(268435456)
    handler.close()
  })

  it('forwards the short-query fallback option and result flag', () => {
    const index = createIndex([{ body: '索引 worker body' }])
    const sink = replies()
    const handler = createSearchWorkerHandler({ dbPath: index.path, post: sink.post })
    handler.handle({ id: 1, method: 'search', params: { query: '索引', limit: 5, options: { shortQueryFallback: true } } })
    const reply = sink.list[0]
    expect(reply?.ok).toBe(true)
    expect(reply?.result?.shortQueryFallback).toBe(true)
    expect(reply?.result?.hits).toHaveLength(1)
    expect(reply?.result?.warnings).toContain('content-query-short-fallback')
    handler.close()
  })

  it('does not degrade the worker after an intentionally slow short-query fallback', () => {
    const index = createIndex([{ body: '索引 worker body' }])
    const sink = replies()
    const handler = createSearchWorkerHandler({ dbPath: index.path, post: sink.post, degradeThresholdMs: 0 })
    handler.handle({ id: 1, method: 'search', params: { query: '索引', limit: 5, options: { shortQueryFallback: true } } })
    expect(sink.list[0]?.result?.shortQueryFallback).toBe(true)
    expect(handler.info().degraded).toBe(false)
    handler.handle({ id: 2, method: 'search', params: { query: 'worker', limit: 5 } })
    expect(sink.list[1]?.ok).toBe(true)
    expect(sink.list[1]?.result?.warnings ?? []).not.toContain('query-degraded')
    // A normal query that exceeds the (zero) deadline still degrades the next one.
    expect(handler.info().degraded).toBe(true)
    handler.handle({ id: 3, method: 'search', params: { query: 'worker', limit: 5 } })
    expect(sink.list[2]?.result?.warnings).toContain('query-degraded')
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
