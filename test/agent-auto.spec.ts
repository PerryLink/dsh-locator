/**
 * Behavioural tests for the 0.23 cross-source auto merge, the v2 cursor and
 * the find contract fixes (session event refs, count none, where notes,
 * includeArchived, empty-page explanation). Fake stores only — never live.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ContentIndex, ContentState, SymbolMatch } from '../src/content.ts'
import type { LocatorRuntime, SearchHit } from '../src/runtime.ts'
import { makeAgentFindTool } from '../src/agent-find.ts'
import { decodeCursor, encodeCursor, encodeCursorV2, queryHashOf } from '../src/agent-core.ts'

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------- */

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'locator-agent-auto-'))
  tempDirs.push(dir)
  return dir
}

function nameHit(path: string, over: Partial<SearchHit> = {}): SearchHit {
  const name = path.split(sep).pop() ?? path
  const dot = name.lastIndexOf('.')
  const ext = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
  return { path, name, size: 10, mtime: 1_000, ext, dir: false, ...over }
}

interface RuntimeCalls {
  calls: Array<{ limit: number; offset: number }>
}

/** Realistic fake name index: filters by the query text, sorts by name and pages. */
function fakeRuntime(hits: SearchHit[], roots: string[], options: { generation?: number; maxResults?: number } = {}): LocatorRuntime & RuntimeCalls {
  const calls: Array<{ limit: number; offset: number }> = []
  const runtime = {
    roots,
    config: { maxResults: options.maxResults ?? 100, contentExcludes: [], contentShortQueryFallback: true },
    status: { running: true, ...(options.generation === undefined ? {} : { engine: { version: 'test', platform: 'test', roots, entries: hits.length, files: hits.length, dirs: 0, nameBytes: 0, deleted: 0, watching: false, generation: options.generation } }) },
    stateDir: '/tmp/state',
    binary: '/tmp/indexd',
    start: () => {},
    engineStatus: async () => undefined,
    calls,
    async search(args: { query: string; limit: number; offset: number; filesOnly?: boolean; dirsOnly?: boolean }) {
      calls.push({ limit: args.limit, offset: args.offset })
      const needle = args.query.trim().toLowerCase()
      let candidates = hits
      if (args.filesOnly === true) candidates = candidates.filter(hit => hit.dir !== true)
      if (args.dirsOnly === true) candidates = candidates.filter(hit => hit.dir === true)
      if (needle !== '') candidates = candidates.filter(hit => hit.name.toLowerCase().includes(needle) || hit.path.toLowerCase().includes(needle))
      const sorted = [...candidates].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      const page = sorted.slice(args.offset, args.offset + args.limit)
      return { total: sorted.length, returned: page.length, offset: args.offset, truncated: sorted.length > args.offset + page.length, indexing: false, tookNs: 1_000_000, hits: page }
    },
  }
  return runtime as unknown as LocatorRuntime & RuntimeCalls
}

interface FakeContentCalls {
  calls: Array<{ query: string; options: Record<string, unknown> }>
}

interface FakeContentOptions {
  hits?: Array<Record<string, unknown>>
  symbols?: SymbolMatch[]
  state?: Partial<ContentState>
  sessionRefs?: Map<string, Map<string, { seq: number; ref: string }>>
  respectPathPrefix?: boolean
  ignoreQuery?: boolean
}

/** Realistic fake content index: query/term filter, pathPrefix, session scope, count modes. */
function fakeContent(options: FakeContentOptions = {}): ContentIndex & FakeContentCalls {
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
  const calls: Array<{ query: string; options: Record<string, unknown> }> = []
  const content = {
    calls,
    status: () => state,
    async search(query: string, limit: number, searchOptions: Record<string, unknown> = {}) {
      calls.push({ query, options: { ...searchOptions } })
      const terms = query.toLowerCase().split(/\s+/).filter(term => term.length >= 2)
      let candidates = options.ignoreQuery === true
        ? [...all]
        : all.filter(hit => {
          const text = (String(hit.snippet ?? '') + ' ' + String(hit.title ?? '')).toLowerCase()
          return terms.length === 0 || terms.some(term => text.includes(term))
        })
      const pathPrefix = typeof searchOptions.pathPrefix === 'string' ? searchOptions.pathPrefix : undefined
      if (options.respectPathPrefix !== false && pathPrefix !== undefined) candidates = candidates.filter(hit => String(hit.path).startsWith(pathPrefix))
      if (searchOptions.excludeSessions === true) candidates = candidates.filter(hit => hit.kind !== 'session')
      const requestedSession = typeof searchOptions.sessionId === 'string' ? searchOptions.sessionId : undefined
      if (requestedSession !== undefined) candidates = candidates.filter(hit => hit.kind !== 'session' || hit.sessionId === requestedSession)
      const offset = typeof searchOptions.offset === 'number' ? searchOptions.offset : 0
      const page = candidates.slice(offset, offset + limit)
      const count = searchOptions.count === 'none'
        ? { value: 0, kind: 'unknown' as const }
        : { value: candidates.length, kind: 'exact' as const }
      return { hits: page, count, warnings: [] }
    },
    authorizedSessionIds: () => new Set(['caller-session', 'session-1']),
    indexedMtime: () => 1_000,
    sessionEventRefs: (sessionId: string, messageIds: readonly string[]) => {
      const out = new Map<string, { seq: number; ref: string }>()
      const byMessage = options.sessionRefs?.get(sessionId)
      if (byMessage === undefined) return out
      for (const messageId of messageIds) {
        const found = byMessage.get(messageId)
        if (found !== undefined) out.set(messageId, found)
      }
      return out
    },
    findSymbols: (name: string) => (options.symbols ?? []).filter(symbol => symbol.name === name || symbol.name.startsWith(name) || symbol.name.includes(name)),
  }
  return content as unknown as ContentIndex & FakeContentCalls
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
  eventRef?: string
  seq?: number
  sessionId?: string
  messageId?: string
  size?: number
  mtime?: number
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

function itemKey(item: FindItem): string {
  return item.kind + '\u0000' + item.path + '\u0000' + String(item.line ?? '')
}

async function collectPages(tool: FindTool, args: Record<string, unknown>, cwd: string, maxPages = 30): Promise<{ items: FindItem[]; pages: FindValue[] }> {
  const items: FindItem[] = []
  const pages: FindValue[] = []
  let cursor: string | undefined
  for (let index = 0; index < maxPages; index++) {
    const pageArgs: Record<string, unknown> = { ...args }
    if (cursor !== undefined) pageArgs.cursor = cursor
    const page = await run(tool, pageArgs, cwd)
    expect(page.ok).toBe(true)
    expectValidOutput(tool, page)
    pages.push(page)
    items.push(...(page.items ?? []))
    if (page.page?.more !== true) return { items, pages }
    expect(page.page.nextCursor).toBeTruthy()
    cursor = page.page.nextCursor
  }
  throw new Error('pagination did not terminate')
}

/* ------------------------------------------------------------------------- */
/* Cross-source merge                                                        */
/* ------------------------------------------------------------------------- */

describe('locator_find auto cross-source merge', () => {
  it('merges symbol, body and name rows in one page by rank tier', async () => {
    const root = tempDir()
    const symbols: SymbolMatch[] = [{ path: join(root, 'src', 'config.ts'), line: 3, kind: 'function', name: 'parseConfig', language: 'ts' }]
    const content = fakeContent({
      symbols,
      hits: [{ kind: 'file', path: join(root, 'docs', 'notes.md'), title: 'notes.md', snippet: 'parseConfig is used here', line: 2, score: 1 }],
    })
    const runtime = fakeRuntime([nameHit(join(root, 'src', 'parseConfig-helper.ts'))], [root])
    const tool = makeAgentFindTool(runtime, content)
    const result = await run(tool, { query: 'parseConfig' }, root)
    expect(result.ok).toBe(true)
    expect(result.resolvedMode).toBe('mixed')
    expect((result.items ?? []).map(item => item.kind)).toEqual(['symbol', 'file', 'file'])
    expect(result.items?.[0]).toMatchObject({ kind: 'symbol', path: join(root, 'src', 'config.ts'), why: ['symbol:exact'], sources: ['symbol'] })
    expect(result.items?.[1]).toMatchObject({ kind: 'file', path: join(root, 'docs', 'notes.md'), why: ['body:terms'], sources: ['body'] })
    expect(result.items?.[2]).toMatchObject({ kind: 'file', path: join(root, 'src', 'parseConfig-helper.ts'), why: ['name:prefix'], sources: ['name'] })
    expect(result.counts).toMatchObject({ nameTotal: 1, bodyTotal: 1, symbolTotal: 1, total: 3, totalKind: 'bounded' })
    expect(noteCodes(result)).toContain('counts-approximate')
    expectValidOutput(tool, result)
  })

  it('dedupes the same file across body and name sources, merging why and sources', async () => {
    const root = tempDir()
    const path = join(root, 'report.md')
    const content = fakeContent({ hits: [{ kind: 'file', path, title: 'report.md', snippet: 'report body text', line: 5, score: 0.5 }] })
    const runtime = fakeRuntime([nameHit(path)], [root])
    const tool = makeAgentFindTool(runtime, content)
    const result = await run(tool, { query: 'report' }, root)
    expect(result.ok).toBe(true)
    const matches = (result.items ?? []).filter(item => item.path === path)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ kind: 'file', why: ['body:terms', 'name:prefix'], sources: ['body', 'name'] })
    expect(matches[0]).toMatchObject({ snippet: 'report body text', line: 5 })
    expect(result.resolvedMode).toBe('mixed')
    expectValidOutput(tool, result)
  })

  it('pages the merged union without duplicates or losses', async () => {
    const root = tempDir()
    const symbols: SymbolMatch[] = Array.from({ length: 4 }, (_, index) => ({ path: join(root, 'src', 'widget-' + String(index) + '.ts'), line: index + 1, kind: 'function', name: 'Widget' + String(index), language: 'ts' }))
    const content = fakeContent({
      symbols,
      hits: Array.from({ length: 3 }, (_, index) => ({ kind: 'file', path: join(root, 'body', 'e' + String(index) + '.md'), title: 'e' + String(index) + '.md', snippet: 'Widget appears here ' + String(index), line: 1, score: index + 1 })),
    })
    const runtime = fakeRuntime([nameHit(join(root, 'widget-one.ts')), nameHit(join(root, 'widget-two.ts')), nameHit(join(root, 'widget-three.ts'))], [root])
    const tool = makeAgentFindTool(runtime, content)
    const { items, pages } = await collectPages(tool, { query: 'Widget', limit: 2 }, root)
    expect(pages.length).toBeGreaterThan(1)
    expect(items).toHaveLength(10)
    expect(new Set(items.map(itemKey)).size).toBe(10)
    for (const page of pages.slice(0, -1)) {
      const decoded = decodeCursor(page.page?.nextCursor)
      expect(decoded?.v).toBe(2)
      if (decoded !== undefined && decoded.v === 2) expect(decoded.mode).toBe('auto')
    }
  })

  it('keeps budget-deferred rows reachable through the v2 cursor', async () => {
    const root = tempDir()
    const content = fakeContent({
      hits: Array.from({ length: 4 }, (_, index) => ({ kind: 'file', path: join(root, 'body', 'b' + String(index) + '.md'), title: 'b' + String(index) + '.md', snippet: 'Widget body ' + String(index), line: 1, score: index + 1 })),
    })
    const runtime = fakeRuntime([nameHit(join(root, 'widget-a.ts')), nameHit(join(root, 'widget-b.ts'))], [root])
    const tool = makeAgentFindTool(runtime, content)
    const first = await run(tool, { query: 'Widget', limit: 5, maxChars: 400 }, root)
    expect(first.ok).toBe(true)
    expect(first.budget?.truncated).toBe(true)
    expect(first.page?.more).toBe(true)
    expect(noteCodes(first)).toContain('budget-truncated')
    const { items } = await collectPages(tool, { query: 'Widget', limit: 5, maxChars: 400 }, root)
    expect(items).toHaveLength(6)
    expect(new Set(items.map(itemKey)).size).toBe(6)
  })
})

/* ------------------------------------------------------------------------- */
/* Auto source selection (P0-3)                                              */
/* ------------------------------------------------------------------------- */

describe('locator_find auto source selection', () => {
  it('does not enable the symbol source for a bare common lowercase word', async () => {
    const root = tempDir()
    const symbols: SymbolMatch[] = [
      { path: join(root, 'a.ts'), line: 1, kind: 'variable', name: 'config', language: 'ts' },
      { path: join(root, 'b.ts'), line: 2, kind: 'variable', name: 'configManager', language: 'ts' },
    ]
    const content = fakeContent({ symbols, hits: [{ kind: 'file', path: join(root, 'README.md'), title: 'README.md', snippet: 'config file', line: 3, score: 1 }] })
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'config.ts'))], [root]), content)
    const result = await run(tool, { query: 'config' }, root)
    expect(result.ok).toBe(true)
    expect((result.items ?? []).some(item => item.kind === 'symbol')).toBe(false)
    expect(result.counts?.symbolTotal).toBeUndefined()
    expect(result.resolvedMode).toBe('mixed')
    const explicit = await run(tool, { query: 'config', mode: 'symbol' }, root)
    expect(explicit.items?.map(item => item.title)).toEqual(['config', 'configManager'])
  })

  it('never lets a markdown heading hijack the auto merge', async () => {
    const root = tempDir()
    const symbols: SymbolMatch[] = [{ path: join(root, 'docs', 'guide.md'), line: 7, kind: 'heading', name: 'ConfigName', language: 'markdown' }]
    const content = fakeContent({ symbols, hits: [{ kind: 'file', path: join(root, 'docs', 'body.md'), title: 'body.md', snippet: 'ConfigName used in prose', line: 2, score: 1 }] })
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'ConfigName.ts'))], [root]), content)
    const result = await run(tool, { query: 'ConfigName' }, root)
    expect(result.ok).toBe(true)
    expect((result.items ?? []).some(item => item.kind === 'symbol')).toBe(false)
    const explicit = await run(tool, { query: 'ConfigName', mode: 'symbol' }, root)
    expect(explicit.items).toHaveLength(1)
    expect(explicit.items?.[0]).toMatchObject({ kind: 'symbol', title: 'ConfigName' })
  })

  it('uses the symbol source directly when kinds is symbol-only', async () => {
    const root = tempDir()
    // The symbol is lowercase so only the explicit symbol-only kinds let it in.
    const symbols: SymbolMatch[] = [{ path: join(root, 'src', 'agent.ts'), line: 4, kind: 'function', name: 'makeagentf', language: 'ts' }]
    const content = fakeContent({ symbols })
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'makeagentf.ts'))], [root]), content)
    const result = await run(tool, { query: 'makeagentf', kinds: ['symbol'] }, root)
    expect(result.ok).toBe(true)
    expect(result.resolvedMode).toBe('symbol')
    expect(result.items).toHaveLength(1)
    expect(result.items?.[0]).toMatchObject({ kind: 'symbol', title: 'makeagentf' })
    expect(result.counts?.symbolTotal).toBe(1)
    const fallback = await run(tool, { query: 'makeagentf' }, root)
    expect(fallback.resolvedMode).toBe('name')
    expect(fallback.items?.[0]?.kind).toBe('file')
  })

  it('widens an empty workspace body source to every root once, with a note', async () => {
    const root = tempDir()
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const outside = join(root, 'other', 'notes.md')
    const content = fakeContent({ hits: [{ kind: 'file', path: outside, title: 'notes.md', snippet: 'ship friday now', line: 1, score: 1 }] })
    const tool = makeAgentFindTool(fakeRuntime([], [root]), content)
    const result = await run(tool, { query: 'ship friday' }, cwd)
    expect(result.ok).toBe(true)
    expect(result.items?.map(item => item.path)).toEqual([outside])
    expect(result.scope?.effective).toBe('workspace')
    expect(noteCodes(result)).toContain('auto-body-scope-fallback')
    // The first query was narrowed to the workspace, the retry was not.
    expect(content.calls[0]?.options.pathPrefix).toBe(cwd)
    expect(content.calls.slice(1).some(call => call.options.pathPrefix === undefined)).toBe(true)
  })
})

/* ------------------------------------------------------------------------- */
/* Contract fixes                                                            */
/* ------------------------------------------------------------------------- */

describe('locator_find session event refs', () => {
  const sessionRefs = new Map([['caller-session', new Map([['m1', { seq: 7, ref: 'ref://session-event?sid=abc&seq=7' }]])]])

  function sessionContent(root: string): ContentIndex & FakeContentCalls {
    return fakeContent({
      sessionRefs,
      hits: [{ kind: 'session', path: join(root, 'sessions', 'abc.v4.jsonl.zstd'), title: 'plan', snippet: 'ship friday', sessionId: 'caller-session', messageId: 'm1', score: 0.25 }],
    })
  }

  it('keeps eventRef and seq on compact and standard session rows', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([], [root]), sessionContent(root))
    const compact = await run(tool, { query: 'ship friday', mode: 'body' }, root)
    expect(compact.items?.[0]).toMatchObject({ kind: 'session', seq: 7, eventRef: 'ref://session-event?sid=abc&seq=7' })
    expect(compact.items?.[0]?.sessionId).toBeUndefined()
    expect(compact.items?.[0]?.messageId).toBeUndefined()
    expect(compact.items?.[0]?.ref).toMatch(/^dsh-session:/)
    expectValidOutput(tool, compact)
    const standard = await run(tool, { query: 'ship friday', mode: 'body', detail: 'standard' }, root)
    expect(standard.items?.[0]).toMatchObject({ seq: 7, eventRef: 'ref://session-event?sid=abc&seq=7' })
    expect(standard.items?.[0]?.messageId).toBeUndefined()
  })

  it('attaches the event ref on compact auto rows too', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([], [root]), sessionContent(root))
    const result = await run(tool, { query: 'ship friday' }, root)
    expect(result.resolvedMode).toBe('body')
    expect(result.items?.[0]?.eventRef).toBe('ref://session-event?sid=abc&seq=7')
    expectValidOutput(tool, result)
  })
})

describe('locator_find count semantics', () => {
  function bodyTool(root: string): { tool: FindTool; content: ContentIndex & FakeContentCalls } {
    const content = fakeContent({ hits: [{ kind: 'file', path: join(root, 'a.md'), title: 'a.md', snippet: 'hello world', line: 1, score: 1 }] })
    return { tool: makeAgentFindTool(fakeRuntime([], [root]), content), content }
  }

  it('count:none is forwarded to the content query and omits every count', async () => {
    const root = tempDir()
    const { tool, content } = bodyTool(root)
    const result = await run(tool, { query: 'hello world', mode: 'body', count: 'none' }, root)
    expect(result.ok).toBe(true)
    expect(content.calls[0]?.options.count).toBe('none')
    expect(result.counts).toEqual({})
    expect(result.counts?.bodyTotal).toBeUndefined()
    expect(result.counts?.total).toBeUndefined()
  })

  it('count:none omits counts in name mode too', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'alpha.ts'))], [root]))
    const result = await run(tool, { query: 'alpha', mode: 'name', count: 'none' }, root)
    expect(result.ok).toBe(true)
    expect(result.counts).toEqual({})
  })

  it('count:none omits counts in auto mode', async () => {
    const root = tempDir()
    const { tool } = bodyTool(root)
    const result = await run(tool, { query: 'hello world', count: 'none' }, root)
    expect(result.ok).toBe(true)
    expect(result.counts).toEqual({})
  })

  it('count:exact still reports the body total', async () => {
    const root = tempDir()
    const { tool } = bodyTool(root)
    const result = await run(tool, { query: 'hello world', mode: 'body' }, root)
    expect(result.counts).toMatchObject({ bodyTotal: 1, bodyKind: 'exact', total: 1 })
  })
})

describe('locator_find empty pages and where notes', () => {
  it('explains an empty page that still has more rows instead of claiming no matches', async () => {
    const root = tempDir()
    const hits = Array.from({ length: 300 }, (_, index) => nameHit(join(root, 'x-' + String(index).padStart(3, '0') + '.md')))
    const tool = makeAgentFindTool(fakeRuntime(hits, [root]))
    const result = await run(tool, { query: 'x', mode: 'name', scope: 'roots', where: { ext: ['ts'] } }, root)
    expect(result.ok).toBe(true)
    expect(result.items).toEqual([])
    expect(result.page).toMatchObject({ returned: 0, more: true })
    expect(result.page?.nextCursor).toBeTruthy()
    expect(noteCodes(result)).toContain('empty-page-more')
    expect(noteCodes(result)).not.toContain('no-matches')
    expect(noteCodes(result)).toContain('counts-ignore-where')
  })

  it('reports no-matches only when the set is exhausted', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'a.md'))], [root]))
    const result = await run(tool, { query: 'zzz', mode: 'name' }, root)
    expect(result.ok).toBe(true)
    expect(result.page?.more).toBe(false)
    expect(noteCodes(result)).toContain('no-matches')
  })

  it('adds counts-ignore-where when body where filters are active', async () => {
    const root = tempDir()
    const path = join(root, 'notes.md')
    writeFileSync(path, 'hello world body')
    const content = fakeContent({ hits: [{ kind: 'file', path, title: 'notes.md', snippet: 'hello world', line: 1, score: 1 }] })
    const tool = makeAgentFindTool(fakeRuntime([], [root]), content)
    const result = await run(tool, { query: 'hello world', mode: 'body', where: { minSize: 10_000_000 } }, root)
    expect(result.ok).toBe(true)
    expect(result.items).toEqual([])
    expect(result.counts?.bodyTotal).toBe(1)
    expect(noteCodes(result)).toContain('counts-ignore-where')
    expect(noteCodes(result)).toContain('no-matches')
  })
})

describe('locator_find includeArchived and full body evidence', () => {
  it('forwards includeArchived to the content query', async () => {
    const root = tempDir()
    const path = join(root, 'a.md')
    const content = fakeContent({ hits: [{ kind: 'file', path, title: 'a.md', snippet: 'hello world', line: 1, score: 1 }] })
    const tool = makeAgentFindTool(fakeRuntime([], [root]), content)
    const plain = await run(tool, { query: 'hello world', mode: 'body' }, root)
    expect(plain.ok).toBe(true)
    expect(content.calls[0]?.options.includeArchived).toBeUndefined()
    const archived = await run(tool, { query: 'hello world', mode: 'body', includeArchived: true }, root)
    expect(archived.ok).toBe(true)
    expect(content.calls[content.calls.length - 1]?.options.includeArchived).toBe(true)
  })

  it('rejects a non-boolean includeArchived', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([], [root]))
    await expect(run(tool, { query: 'x', mode: 'name', includeArchived: 'yes' }, root)).rejects.toThrow(/includeArchived/)
  })

  it('fills size and mtime on full-detail body file rows', async () => {
    const root = tempDir()
    const path = join(root, 'notes.md')
    const text = 'hello world body'
    writeFileSync(path, text)
    const content = fakeContent({ hits: [{ kind: 'file', path, title: 'notes.md', snippet: 'hello world', line: 1, score: 1 }] })
    const tool = makeAgentFindTool(fakeRuntime([], [root]), content)
    const result = await run(tool, { query: 'hello world', mode: 'body', detail: 'full' }, root)
    expect(result.ok).toBe(true)
    expect(result.items?.[0]?.size).toBe(Buffer.byteLength(text))
    expect(typeof result.items?.[0]?.mtime).toBe('number')
    expectValidOutput(tool, result)
  })
})

describe('locator_find symbol count accuracy', () => {
  it('does not claim counts.total is global after workspace narrowing', async () => {
    const root = tempDir()
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const symbols: SymbolMatch[] = [
      { path: join(cwd, 'in.ts'), line: 1, kind: 'function', name: 'parseIn', language: 'ts' },
      { path: join(root, 'out.ts'), line: 2, kind: 'function', name: 'parseOut', language: 'ts' },
    ]
    const tool = makeAgentFindTool(fakeRuntime([], [root]), fakeContent({ symbols }))
    const result = await run(tool, { query: 'parse', mode: 'symbol' }, cwd)
    expect(result.ok).toBe(true)
    expect(result.items?.map(item => item.path)).toEqual([join(cwd, 'in.ts')])
    expect(result.counts?.symbolTotal).toBe(1)
    expect(noteCodes(result)).not.toContain('total-is-global')
  })
})

/* ------------------------------------------------------------------------- */
/* Cursor contract                                                           */
/* ------------------------------------------------------------------------- */

describe('locator_find cursor contract', () => {
  function autoHash(query: string, scope = 'workspace'): string {
    return queryHashOf({ query, mode: 'auto', scope, kinds: ['dir', 'file', 'session', 'symbol'], where: {} })
  }

  it('keeps issuing v1 cursors for single-source modes', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime(Array.from({ length: 5 }, (_, index) => nameHit(join(root, 'file-' + String(index) + '.md'))), [root]))
    const first = await run(tool, { query: 'file', mode: 'name', limit: 2 }, root)
    const decoded = decodeCursor(first.page?.nextCursor)
    expect(decoded?.v).toBe(1)
    const second = await run(tool, { query: 'file', mode: 'name', limit: 2, cursor: first.page?.nextCursor }, root)
    expect(second.ok).toBe(true)
    expect(second.items).toHaveLength(2)
  })

  it('rejects a v1 cursor in auto mode (cross-source needs v2)', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'widget.ts'))], [root]))
    const cursor = encodeCursor({ v: 1, mode: 'name', queryHash: autoHash('widget'), offset: 0 })
    const result = await run(tool, { query: 'widget', cursor }, root)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('cursor-invalid')
    expect(result.error?.message).toContain('v2')
  })

  it('accepts a v2 cursor issued for a single-source mode', async () => {
    const root = tempDir()
    const hits = Array.from({ length: 5 }, (_, index) => nameHit(join(root, 'file-' + String(index) + '.md')))
    const tool = makeAgentFindTool(fakeRuntime(hits, [root]))
    const hash = queryHashOf({ query: 'file', mode: 'name', scope: 'workspace', kinds: ['dir', 'file', 'session', 'symbol'], where: {} })
    const cursor = encodeCursorV2({ v: 2, mode: 'name', queryHash: hash, offsets: { name: 2 } })
    const result = await run(tool, { query: 'file', mode: 'name', cursor }, root)
    expect(result.ok).toBe(true)
    expect(result.items?.[0]?.path).toBe(hits[2]?.path)
  })

  it('rejects a cursor from another query', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime(['widget-a', 'widget-b', 'widget-c'].map(name => nameHit(join(root, name + '.ts'))), [root]))
    const first = await run(tool, { query: 'Widget', limit: 1 }, root)
    expect(first.page?.nextCursor).toBeTruthy()
    const foreign = await run(tool, { query: 'Gadget', cursor: first.page?.nextCursor }, root)
    expect(foreign.ok).toBe(false)
    expect(foreign.error?.code).toBe('cursor-invalid')
  })

  it('rejects a v2 cursor whose kinds do not match the request', async () => {
    const root = tempDir()
    const tool = makeAgentFindTool(fakeRuntime([nameHit(join(root, 'widget.ts'))], [root]))
    const cursor = encodeCursorV2({ v: 2, mode: 'auto', queryHash: autoHash('widget'), offsets: { name: 0 }, kinds: ['file'] })
    const result = await run(tool, { query: 'widget', cursor }, root)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('cursor-invalid')
    expect(result.error?.message).toContain('kinds')
  })
})

/* ------------------------------------------------------------------------- */
/* Auto scope fallback + includeArchived forwarding                          */
/* ------------------------------------------------------------------------- */

describe('locator_find auto scope fallback and cursor', () => {
  it('widens an empty workspace page to roots and keeps the v2 cursor resumable', async () => {
    const root = tempDir()
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const alpha = join(root, 'other', 'alpha.ts')
    const beta = join(root, 'other', 'beta.ts')
    const tool = makeAgentFindTool(fakeRuntime([nameHit(alpha), nameHit(beta)], [root]))
    const first = await run(tool, { query: 'a', limit: 1 }, cwd)
    expect(first.ok).toBe(true)
    expect(first.items?.map(item => item.path)).toEqual([alpha])
    expect(first.scope).toMatchObject({ requested: 'workspace', effective: 'roots', fallback: true })
    const decoded = decodeCursor(first.page?.nextCursor)
    expect(decoded?.v).toBe(2)
    if (decoded !== undefined && decoded.v === 2) expect(decoded.scope).toBe('roots')
    const second = await run(tool, { query: 'a', limit: 1, cursor: first.page?.nextCursor }, cwd)
    expect(second.ok).toBe(true)
    expect(second.items?.map(item => item.path)).toEqual([beta])
    expect(second.page?.more).toBe(false)
  })

  it('forwards includeArchived from auto mode to the content query', async () => {
    const root = tempDir()
    const content = fakeContent({ hits: [{ kind: 'file', path: join(root, 'a.md'), title: 'a.md', snippet: 'hello world', line: 1, score: 1 }] })
    const tool = makeAgentFindTool(fakeRuntime([], [root]), content)
    const result = await run(tool, { query: 'hello world', includeArchived: true }, root)
    expect(result.ok).toBe(true)
    expect(content.calls.some(call => call.options.includeArchived === true)).toBe(true)
  })

  it('fills size and mtime on full-detail auto file rows', async () => {
    const root = tempDir()
    const path = join(root, 'notes.md')
    const text = 'hello world body'
    writeFileSync(path, text)
    const content = fakeContent({ hits: [{ kind: 'file', path, title: 'notes.md', snippet: 'hello world', line: 1, score: 1 }] })
    const tool = makeAgentFindTool(fakeRuntime([], [root]), content)
    const result = await run(tool, { query: 'hello world', detail: 'full' }, root)
    expect(result.ok).toBe(true)
    expect(result.items?.[0]?.size).toBe(Buffer.byteLength(text))
    expect(typeof result.items?.[0]?.mtime).toBe('number')
  })
})


describe('locator_find auto cross-page dedupe', () => {
  it('does not repeat a file that another source reaches on a later page', async () => {
    const root = tempDir()
    const shared = join(root, 'report.md')
    const nameOnly = join(root, 'report-extra.md')
    const content = fakeContent({ hits: [{ kind: 'file', path: shared, title: 'report.md', snippet: 'report body', line: 1, score: 1 }] })
    const tool = makeAgentFindTool(fakeRuntime([nameHit(shared), nameHit(nameOnly)], [root]), content)
    const first = await run(tool, { query: 'report', limit: 1 }, root)
    expect(first.items?.map(item => item.path)).toEqual([shared])
    expect(first.page?.more).toBe(true)
    const decoded = decodeCursor(first.page?.nextCursor)
    expect(decoded?.v).toBe(2)
    if (decoded !== undefined && decoded.v === 2) expect(decoded.seen?.length).toBe(1)
    const second = await run(tool, { query: 'report', limit: 1, cursor: first.page?.nextCursor }, root)
    expect(second.ok).toBe(true)
    expect(second.items?.map(item => item.path)).toEqual([nameOnly])
    expect(second.page?.more).toBe(true)
    // The name stream reaches the shared path only now: it must not come back.
    const third = await run(tool, { query: 'report', limit: 1, cursor: second.page?.nextCursor }, root)
    expect(third.ok).toBe(true)
    expect(third.items).toEqual([])
    expect(noteCodes(third)).toContain('duplicate-filtered')
    expect(third.page?.more).toBe(false)
    expectValidOutput(tool, third)
  })
})

describe('locator_find auto scan cap', () => {
  it('keeps paging when a filtered source burns the per-page scan cap', async () => {
    const root = tempDir()
    const hits = Array.from({ length: 1_200 }, (_, index) => nameHit(join(root, 'x-' + String(index).padStart(4, '0') + '.md')))
    const tool = makeAgentFindTool(fakeRuntime(hits, [root]))
    const result = await run(tool, { query: 'x', where: { ext: ['ts'] } }, root)
    expect(result.ok).toBe(true)
    expect(result.items).toEqual([])
    expect(result.page?.more).toBe(true)
    expect(result.page?.nextCursor).toBeTruthy()
    expect(noteCodes(result)).toContain('auto-scan-capped')
    expect(noteCodes(result)).toContain('empty-page-more')
    // The cursor resumes past the scanned raw rows instead of refetching them.
    const decoded = decodeCursor(result.page?.nextCursor)
    expect(decoded?.v).toBe(2)
    if (decoded !== undefined && decoded.v === 2) expect((decoded.offsets.name ?? 0) >= 1_000).toBe(true)
  })
})
describe('locator_find where note scope', () => {
  it('does not add counts-ignore-where for a pathPrefix-only body where', async () => {
    const root = tempDir()
    const sub = join(root, 'src')
    mkdirSync(sub)
    const path = join(sub, 'a.md')
    const content = fakeContent({ hits: [{ kind: 'file', path, title: 'a.md', snippet: 'hello world', line: 1, score: 1 }] })
    const tool = makeAgentFindTool(fakeRuntime([], [root]), content)
    const result = await run(tool, { query: 'hello world', mode: 'body', where: { pathPrefix: sub } }, root)
    expect(result.ok).toBe(true)
    expect(result.counts?.bodyTotal).toBe(1)
    expect(noteCodes(result)).not.toContain('counts-ignore-where')
  })
})
