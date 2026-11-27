/**
 * Behavioural tests for locator_find (0.22.0 agent API) against fake
 * runtime/content stores — never the live index or engine.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ContentIndex, ContentState, SymbolMatch } from '../src/content.ts'
import type { LocatorRuntime, SearchHit } from '../src/runtime.ts'
import { makeAgentFindTool } from '../src/agent-find.ts'
import { decodeCursor, encodeCursor } from '../src/agent-core.ts'

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------- */

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'locator-agent-find-'))
  tempDirs.push(dir)
  return dir
}

function nameHit(path: string, over: Partial<SearchHit> = {}): SearchHit {
  const name = path.split(sep).pop() ?? path
  const dot = name.lastIndexOf('.')
  const ext = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
  return { path, name, size: 10, mtime: 1_000, ext, dir: false, ...over }
}

function fakeRuntime(hits: SearchHit[], roots: string[], options: { maxResults?: number; generation?: number } = {}): LocatorRuntime {
  return {
    roots,
    config: { maxResults: options.maxResults ?? 100, contentExcludes: [], contentShortQueryFallback: true },
    status: { running: true, ...(options.generation === undefined ? {} : { engine: { version: 'test', platform: 'test', roots, entries: hits.length, files: hits.length, dirs: 0, nameBytes: 0, deleted: 0, watching: false, generation: options.generation } }) },
    stateDir: '/tmp/state',
    binary: '/tmp/indexd',
    start: () => {},
    engineStatus: async () => undefined,
    async search(args: { query: string; limit: number; offset: number }) {
      const page = hits.slice(args.offset, args.offset + args.limit)
      return { total: hits.length, returned: page.length, offset: args.offset, truncated: hits.length > args.offset + page.length, tookNs: 1_000_000, hits: page }
    },
  } as unknown as LocatorRuntime
}

interface FakeContentOptions {
  hits?: Array<Record<string, unknown>>
  symbols?: SymbolMatch[]
  state?: Partial<ContentState>
  total?: number
  respectPathPrefix?: boolean
}

function fakeContent(options: FakeContentOptions = {}): ContentIndex {
  const all = options.hits ?? []
  const state: ContentState = {
    building: false,
    files: 1,
    sessions: 1,
    messages: 1,
    truncated: false,
    error: '',
    updatedAt: 1_000,
    warnings: [],
    ...options.state,
  }
  return {
    status: () => state,
    search: async (_query: string, limit: number, searchOptions: { offset?: number; pathPrefix?: string } = {}) => {
      const offset = searchOptions.offset ?? 0
      let candidates = all
      if (options.respectPathPrefix === true && typeof searchOptions.pathPrefix === 'string') {
        candidates = all.filter(hit => String(hit.path).startsWith(searchOptions.pathPrefix as string))
      }
      const page = candidates.slice(offset, offset + limit)
      return { hits: page, count: { value: options.total ?? candidates.length, kind: 'exact' }, warnings: [] }
    },
    authorizedSessionIds: () => new Set(['caller-session', 'session-1']),
    indexedMtime: () => 1_000,
    sessionEventRefs: () => new Map(),
    findSymbols: (name: string) => (options.symbols ?? []).filter(symbol => symbol.name === name || symbol.name.startsWith(name)),
  } as unknown as ContentIndex
}

function exec(cwd: string, sessionId = 'caller-session'): never {
  return { agent: { session: { id: sessionId, header: { cwd } } } } as never
}

interface FindItem {
  kind: string
  path: string
  title?: string
  name?: string
  line?: number
  snippet?: string
  why?: string[]
  sources?: string[]
  ref?: string
  sessionId?: string
  messageId?: string
  freshness?: unknown
  permissions?: unknown
  provenance?: unknown
  size?: number
  mtime?: number
  ext?: string
  language?: string
  symbolScope?: string
}

interface FindValue {
  ok: boolean
  query?: string
  mode?: string
  resolvedMode?: string
  detail?: string
  scope?: { requested: string; effective: string; fallback: boolean; fallbackReason?: string }
  items?: FindItem[]
  page?: { limit: number; returned: number; more: boolean; nextCursor?: string }
  counts?: { total?: number; totalKind?: string; nameTotal?: number; bodyTotal?: number; bodyKind?: string; symbolTotal?: number }
  coverage?: { indexing: boolean; indexTruncated: boolean; notes: Array<{ code: string; severity: string; message: string }> }
  budget?: { limitChars: number; usedChars: number; truncated: boolean; dropped: number }
  timing?: { tookMs: number }
  error?: { code: string; message: string; retryable: boolean; remediation?: string; nextTools?: string[] }
}

type FindTool = ReturnType<typeof makeAgentFindTool>

async function run(tool: FindTool, args: Record<string, unknown>, cwd: string, sessionId?: string): Promise<FindValue> {
  return await tool.execute(args as never, exec(cwd, sessionId)) as unknown as FindValue
}

function expectValidOutput(tool: FindTool, value: FindValue): void {
  const schema = tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
  expect(validateJsonSchemaValue(schema, value)).toEqual([])
}

function noteCodes(result: FindValue): string[] {
  return (result.coverage?.notes ?? []).map(note => note.code)
}

/* ------------------------------------------------------------------------- */
/* auto mode resolution                                                      */
/* ------------------------------------------------------------------------- */

describe('locator_find auto mode', () => {
  it('resolves an exact identifier to symbol mode', async () => {
    const root = tempDir()
    const symbols: SymbolMatch[] = [{ path: join(root, 'src', 'config.ts'), line: 3, kind: 'function', name: 'parseConfig', language: 'ts' }]
    const tool = makeAgentFindTool(fakeRuntime([], [root]), fakeContent({ symbols }))
    const result = await run(tool, { query: 'parseConfig' }, root)
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('auto')
    expect(result.resolvedMode).toBe('symbol')
    expect(result.items).toHaveLength(1)
    expect(result.items?.[0]).toMatchObject({ kind: 'symbol', path: join(root, 'src', 'config.ts'), title: 'parseConfig', line: 3, why: ['symbol:exact'] })
    expect(result.counts?.symbolTotal).toBe(1)
    expectValidOutput(tool, result)
  })

  it('falls back to body mode when no exact symbol exists but the content has a match', async () => {
    const root = tempDir()
    const content = fakeContent({
      symbols: [],
      hits: [{ kind: 'file', path: join(root, 'notes.md'), title: 'notes.md', snippet: 'hello world', line: 2, score: 1 }],
    })
    const tool = makeAgentFindTool(fakeRuntime([], [root]), content)
    const result = await run(tool, { query: 'hello world' }, root)
    expect(result.resolvedMode).toBe('body')
    expect(result.items?.[0]).toMatchObject({ kind: 'file', path: join(root, 'notes.md'), snippet: 'hello world', why: ['body:terms'] })
    expect(result.counts?.bodyTotal).toBe(1)
    expectValidOutput(tool, result)
  })

  it('falls back to name mode when body search is empty and explains it', async () => {
    const root = tempDir()
    const content = fakeContent({ symbols: [], hits: [], total: 0 })
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'deep.md'))], [root]), content)
    const result = await run(tool, { query: 'deep search' }, root)
    expect(result.resolvedMode).toBe('name')
    expect(result.items?.[0]?.path).toBe(join(root, 'deep.md'))
    expect(result.items?.[0]?.sources).toEqual(['name'])
  })

  it('uses name mode when no content index is configured', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'readme.md'))], [root]))
    const result = await run(tool, { query: 'readme' }, root)
    expect(result.resolvedMode).toBe('name')
    expect(result.items?.[0]?.why).toEqual(['name:prefix'])
  })
})

/* ------------------------------------------------------------------------- */
/* name mode                                                                 */
/* ------------------------------------------------------------------------- */

describe('locator_find name mode', () => {
  it('maps file names to compact items with refs and counts', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'alpha.ts')), nameHit(join(root, 'beta.md'))], [root]))
    const result = await run(tool, { query: 'alpha', mode: 'name' }, root)
    expect(result.scope).toMatchObject({ requested: 'workspace', effective: 'workspace', fallback: false })
    expect(result.page).toMatchObject({ limit: 10, returned: 2, more: false })
    expect(result.counts?.nameTotal).toBe(2)
    expect(result.items?.[0]).toMatchObject({ kind: 'file', title: 'alpha.ts', why: ['name:prefix'] })
    expect(result.items?.[0]?.ref).toMatch(/^ref:\/\/file/)
    expect(result.items?.[0]?.freshness).toBeUndefined()
    expectValidOutput(tool, result)
  })

  it('filters by kinds', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([
      nameHit(join(root, 'dir.md'), { dir: true, ext: '' }),
      nameHit(join(root, 'file.md')),
    ], [root]))
    const result = await run(tool, { query: 'd', mode: 'name', kinds: ['dir'] }, root)
    expect(result.items).toHaveLength(1)
    expect(result.items?.[0]?.kind).toBe('dir')
  })

  it('applies where.ext, where.minSize and where.modifiedAfter before paging', async () => {
    const root = tempDir()
    const old = Date.parse('2025-01-01T00:00:00Z')
    const recent = Date.parse('2026-06-01T00:00:00Z')
    const tool = makeAgentFindTool(fakeRuntime([
      nameHit(join(root, 'keep.ts'), { size: 100, mtime: recent }),
      nameHit(join(root, 'small.ts'), { size: 1, mtime: recent }),
      nameHit(join(root, 'old.ts'), { size: 100, mtime: old }),
      nameHit(join(root, 'other.md'), { size: 100, mtime: recent }),
    ], [root]))
    const result = await run(tool, {
      query: 'x',
      mode: 'name',
      where: { ext: ['ts'], minSize: 10, modifiedAfter: '2026-01-01T00:00:00Z' },
    }, root)
    expect(result.items?.map(item => item.path)).toEqual([join(root, 'keep.ts')])
  })

  it('narrows to a where.pathPrefix subdirectory', async () => {
    const root = tempDir()
    const sub = join(root, 'src')
    mkdirSync(sub)
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'top.md')), nameHit(join(sub, 'deep.md'))], [root]))
    const result = await run(tool, { query: 'md', mode: 'name', where: { pathPrefix: sub } }, root)
    expect(result.items?.map(item => item.path)).toEqual([join(sub, 'deep.md')])
  })

  it('refuses a where.pathPrefix outside the configured roots', async () => {
    const root = tempDir()
    const outside = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'a.md'))], [root]))
    const result = await run(tool, { query: 'a', mode: 'name', where: { pathPrefix: outside } }, root)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('scope-denied')
    expectValidOutput(tool, result)
  })
})

/* ------------------------------------------------------------------------- */
/* scope and workspace fallback                                              */
/* ------------------------------------------------------------------------- */

describe('locator_find scope', () => {
  it('widens an empty workspace page to roots once and echoes the fallback', async () => {
    const root = tempDir()
    const cwd = join(root, 'proj')
    const outside = join(root, 'other')
    mkdirSync(cwd)
    mkdirSync(outside)
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(outside, 'a.md')), nameHit(join(outside, 'b.md'))], [root]))
    const result = await run(tool, { query: 'a', mode: 'name' }, cwd)
    expect(result.ok).toBe(true)
    expect(result.scope).toMatchObject({ requested: 'workspace', effective: 'roots', fallback: true })
    expect(result.scope?.fallbackReason).toContain('workspace-empty')
    expect(noteCodes(result)).toContain('scope-fallback')
    expect(result.items?.length).toBeGreaterThan(0)
  })

  it('does not fall back when the workspace page has matches', async () => {
    const root = tempDir()
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(cwd, 'mine.md'))], [root]))
    const result = await run(tool, { query: 'mine', mode: 'name' }, cwd)
    expect(result.scope).toMatchObject({ requested: 'workspace', effective: 'workspace', fallback: false })
  })

  it('widens immediately when the cwd is not indexed', async () => {
    const root = tempDir()
    const outside = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'a.md'))], [root]))
    const result = await run(tool, { query: 'a', mode: 'name' }, outside)
    expect(result.scope).toMatchObject({ requested: 'workspace', effective: 'roots', fallback: true })
    expect(result.scope?.fallbackReason).toContain('cwd-not-indexed')
  })

  it('scope all searches every root without a fallback marker', async () => {
    const root = tempDir()
    const outside = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(outside, 'free.md'))], [root, outside]))
    const result = await run(tool, { query: 'free', mode: 'name', scope: 'all' }, root)
    expect(result.scope).toMatchObject({ requested: 'all', effective: 'all', fallback: false })
    expect(result.items?.[0]?.path).toBe(join(outside, 'free.md'))
  })
})

/* ------------------------------------------------------------------------- */
/* body and symbol modes                                                     */
/* ------------------------------------------------------------------------- */

describe('locator_find body mode', () => {
  it('returns session rows with a citable ref and keeps compact ids hidden', async () => {
    const root = tempDir()
    const sessionPath = join(root, 'session.v4.jsonl.zstd')
    writeFileSync(sessionPath, 'session')
    const content = fakeContent({
      hits: [{ kind: 'session', path: sessionPath, title: 'plan', snippet: 'ship friday', sessionId: 'caller-session', messageId: 'm1', score: 0.25 }],
    })
    const tool = makeAgentFindTool(fakeRuntime([], [root]), content)
    const result = await run(tool, { query: 'ship friday', mode: 'body' }, root)
    expect(result.items?.[0]).toMatchObject({ kind: 'session', snippet: 'ship friday', why: ['body:terms'] })
    expect(result.items?.[0]?.ref).toMatch(/^dsh-session:/)
    expect(result.items?.[0]?.sessionId).toBeUndefined()
    expect(result.counts?.bodyTotal).toBe(1)
    expectValidOutput(tool, result)
  })

  it('detail full exposes session ids, permissions and provenance', async () => {
    const root = tempDir()
    const sessionPath = join(root, 'session.v4.jsonl.zstd')
    writeFileSync(sessionPath, 'session')
    const content = fakeContent({
      hits: [{ kind: 'session', path: sessionPath, title: 'plan', snippet: 'ship friday', sessionId: 'caller-session', messageId: 'm1', score: 0.25 }],
    })
    const tool = makeAgentFindTool(fakeRuntime([], [root]), content)
    const result = await run(tool, { query: 'ship friday', mode: 'body', detail: 'full' }, root)
    expect(result.items?.[0]).toMatchObject({ sessionId: 'caller-session', messageId: 'm1' })
    expect(result.items?.[0]?.permissions).toBeDefined()
    expect(result.items?.[0]?.provenance).toBeDefined()
    expect(result.detail).toBe('full')
    expectValidOutput(tool, result)
  })

  it('reports index-building coverage without failing a warm index', async () => {
    const root = tempDir()
    const content = fakeContent({
      hits: [{ kind: 'file', path: join(root, 'notes.md'), title: 'notes.md', snippet: 'hello world', line: 1, score: 1 }],
      state: { building: true, files: 3, sessions: 0, messages: 0 },
    })
    const tool = makeAgentFindTool(fakeRuntime([], [root]), content)
    const result = await run(tool, { query: 'hello world', mode: 'body' }, root)
    expect(result.ok).toBe(true)
    expect(result.coverage?.indexing).toBe(true)
    expect(noteCodes(result)).toContain('index-building')
  })

  it('fails with index-unavailable when no content index is configured', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([], [root]))
    const result = await run(tool, { query: 'hello world', mode: 'body' }, root)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('index-unavailable')
    expect(result.error?.nextTools).toContain('locator_status')
    expectValidOutput(tool, result)
  })

  it('maps content-query-too-short to query-too-short', async () => {
    const root = tempDir()
    const content = {
      status: () => ({ building: false, files: 0, sessions: 0, messages: 0, truncated: false, error: '', updatedAt: 0, warnings: [] }),
      search: async () => ({ hits: [], count: { value: 0, kind: 'unknown' }, warnings: [], error: 'content-query-too-short' }),
      authorizedSessionIds: () => new Set<string>(),
      indexedMtime: () => undefined,
      sessionEventRefs: () => new Map(),
      findSymbols: () => [],
    } as unknown as ContentIndex
    const tool = makeAgentFindTool(fakeRuntime([], [root]), content)
    const result = await run(tool, { query: 'ab cd', mode: 'body' }, root)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('query-too-short')
  })
})

describe('locator_find symbol mode', () => {
  it('returns exact then prefix symbol matches with why labels', async () => {
    const root = tempDir()
    const symbols: SymbolMatch[] = [
      { path: join(root, 'a.ts'), line: 3, kind: 'function', name: 'parseConfig', language: 'ts' },
      { path: join(root, 'b.ts'), line: 9, kind: 'function', name: 'parseArgs', language: 'ts', scope: 'cli' },
    ]
    const tool = makeAgentFindTool(fakeRuntime([], [root]), fakeContent({ symbols }))
    const result = await run(tool, { query: 'parse', mode: 'symbol' }, root)
    expect(result.items).toHaveLength(2)
    expect(result.items?.[0]).toMatchObject({ kind: 'symbol', title: 'parseConfig', line: 3, why: ['symbol:prefix'] })
    expect(result.items?.[1]?.title).toBe('parseArgs')
    expect(result.counts?.symbolTotal).toBe(2)
    expectValidOutput(tool, result)
    const standard = await run(tool, { query: 'parse', mode: 'symbol', detail: 'standard' }, root)
    expect(standard.items?.[1]?.symbolScope).toBe('cli')
    expect(standard.items?.[1]?.language).toBe('ts')
  })

  it('fails with index-unavailable without a content index', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([], [root]))
    const result = await run(tool, { query: 'parse', mode: 'symbol' }, root)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('index-unavailable')
  })
})

/* ------------------------------------------------------------------------- */
/* pagination, cursor and budget                                             */
/* ------------------------------------------------------------------------- */

describe('locator_find pagination', () => {
  function fiveHits(root: string): SearchHit[] {
    return Array.from({ length: 5 }, (_, index) => nameHit(join(root, 'file-' + String(index) + '.md')))
  }

  it('pages through a cursor union without duplicates or loss', async () => {
    const root = tempDir()
    const hits = fiveHits(root)
    const tool = makeAgentFindTool(fakeRuntime(hits, [root]))
    const first = await run(tool, { query: 'file', mode: 'name', limit: 2 }, root)
    expect(first.page).toMatchObject({ limit: 2, returned: 2, more: true })
    expect(first.page?.nextCursor).toBeTruthy()
    const decoded = decodeCursor(first.page?.nextCursor)
    expect(decoded).toMatchObject({ mode: 'name', offset: 2 })
    const second = await run(tool, { query: 'file', mode: 'name', limit: 2, cursor: first.page?.nextCursor }, root)
    const third = await run(tool, { query: 'file', mode: 'name', limit: 2, cursor: second.page?.nextCursor }, root)
    expect(third.page?.more).toBe(false)
    expect(third.page?.nextCursor).toBeUndefined()
    const paths = [...(first.items ?? []), ...(second.items ?? []), ...(third.items ?? [])].map(item => item.path)
    expect(new Set(paths).size).toBe(5)
    expect([...paths].sort()).toEqual(hits.map(hit => hit.path).sort())
  })

  it('pages through explicit offset', async () => {
    const root = tempDir()
    const hits = fiveHits(root)
    const tool = makeAgentFindTool(fakeRuntime(hits, [root]))
    const result = await run(tool, { query: 'file', mode: 'name', limit: 2, offset: 2 }, root)
    expect(result.items?.map(item => item.path)).toEqual([hits[2]!.path, hits[3]!.path])
  })

  it('clamps limit to the contract maximum of 50', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'a.md'))], [root]))
    const result = await run(tool, { query: 'a', mode: 'name', limit: 100 }, root)
    expect(result.page?.limit).toBe(50)
  })

  it('rejects cursor and offset together', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'a.md'))], [root]))
    const cursor = encodeCursor({ v: 1, mode: 'name', queryHash: 'deadbeefdeadbeef', offset: 1 })
    const result = await run(tool, { query: 'a', mode: 'name', cursor, offset: 1 }, root)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('invalid-argument')
  })

  it('rejects malformed and foreign cursors', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'a.md'))], [root]))
    const malformed = await run(tool, { query: 'a', mode: 'name', cursor: 'not-a-cursor' }, root)
    expect(malformed.error?.code).toBe('cursor-invalid')
    const foreign = await run(tool, { query: 'a', mode: 'name', cursor: encodeCursor({ v: 1, mode: 'name', queryHash: 'deadbeefdeadbeef', offset: 1 }) }, root)
    expect(foreign.error?.code).toBe('cursor-invalid')
  })
})

describe('locator_find budget', () => {
  function manyHits(root: string, count: number): SearchHit[] {
    return Array.from({ length: count }, (_, index) => nameHit(join(root, 'budget-item-' + String(index) + '.md')))
  }

  it('defers items over maxChars and keeps them reachable through nextCursor', async () => {
    const root = tempDir()
    const hits = manyHits(root, 6)
    const tool = makeAgentFindTool(fakeRuntime(hits, [root]))
    const first = await run(tool, { query: 'budget', mode: 'name', maxChars: 400 }, root)
    expect(first.budget?.limitChars).toBe(400)
    expect(first.budget?.truncated).toBe(true)
    expect(first.page?.more).toBe(true)
    expect(first.page?.nextCursor).toBeTruthy()
    expect(noteCodes(first)).toContain('budget-truncated')
    const collected = [...(first.items ?? []).map(item => item.path)]
    let cursor = first.page?.nextCursor
    let guard = 0
    while (cursor !== undefined && guard < 20) {
      const page = await run(tool, { query: 'budget', mode: 'name', maxChars: 400, cursor }, root)
      expect(page.ok).toBe(true)
      collected.push(...(page.items ?? []).map(item => item.path))
      cursor = page.page?.more === true ? page.page.nextCursor : undefined
      guard += 1
    }
    expect(new Set(collected).size).toBe(6)
    expect(collected).toHaveLength(6)
  })

  it('rejects a budget too small for one item', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'a.md'))], [root]))
    const result = await run(tool, { query: 'a', mode: 'name', maxChars: 50 }, root)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('budget-too-small')
  })

  it('keeps one item when a single item exceeds the budget', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'a.md'))], [root]))
    const result = await run(tool, { query: 'a', mode: 'name', maxChars: 120 }, root)
    expect(result.ok).toBe(true)
    expect(result.items).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------------- */
/* errors, render and schema                                                 */
/* ------------------------------------------------------------------------- */

describe('locator_find errors and rendering', () => {
  it('rejects an empty query with invalid-argument', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([], [root]))
    const result = await run(tool, { query: '   ' }, root)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('invalid-argument')
    expect(result.error?.retryable).toBe(false)
  })

  it('validates both success and failure against the output schema', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'a.md'))], [root]))
    const success = await run(tool, { query: 'a', mode: 'name' }, root)
    expectValidOutput(tool, success)
    const failure = await run(tool, { query: '' }, root)
    expectValidOutput(tool, failure)
  })

  it('renders rows and failures as model-facing text', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'rendered.md'))], [root]))
    const success = await run(tool, { query: 'rendered', mode: 'name' }, root)
    const successText = tool.output.render({ query: 'rendered' } as never, success as never).map(block => (block as { text?: string }).text ?? '').join('\n')
    expect(successText).toContain('locator_find')
    expect(successText).toContain(join(root, 'rendered.md'))
    const failure = await run(tool, { query: '' }, root)
    const failureText = tool.output.render({ query: '' } as never, failure as never).map(block => (block as { text?: string }).text ?? '').join('\n')
    expect(failureText).toContain('locator_find failed')
    expect(failureText).toContain('invalid-argument')
  })
})
