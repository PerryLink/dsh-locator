import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validateJsonSchemaValue, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentHit, ContentIndex, ContentState } from '../src/content.ts'
import { exploreQueries, makeExploreTool } from '../src/explore.ts'
import type { LocatorRuntime, SearchHit } from '../src/runtime.ts'

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function fakeExec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext
}

function searchHit(path: string, overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    path,
    name: basename(path),
    size: 12,
    mtime: 1_700_000_000_000,
    ext: path.split('.').pop() ?? '',
    dir: false,
    ...overrides,
  }
}

function contentHit(path: string, overrides: Partial<ContentHit> = {}): ContentHit {
  return {
    kind: 'file',
    path,
    title: basename(path),
    snippet: 'body text around the match',
    line: 2,
    score: 1,
    ...overrides,
  }
}

function contentState(): ContentState {
  return { building: false, files: 1, sessions: 0, messages: 0, truncated: false, updatedAt: 1, error: '', warnings: [] }
}

/** Minimal fake content index; the content type allows duck-typed test doubles. */
function fakeContent(hitsFor: (query: string) => ContentHit[]): ContentIndex {
  return {
    status: () => contentState(),
    authorizedSessionIds: () => new Set<string>(),
    indexedMtime: () => undefined,
    sessionEventRefs: () => new Map(),
    async search(query: string, limit: number) {
      const hits = hitsFor(query).slice(0, Math.max(0, limit))
      return { hits, count: { value: hitsFor(query).length, kind: 'exact' as const }, warnings: [] }
    },
  } as unknown as ContentIndex
}

/** Minimal fake name index that answers every probe with the same page. */
function fakeRuntime(hits: SearchHit[]): LocatorRuntime {
  return {
    roots: [],
    config: { maxResults: 100, excludes: [] },
    status: { running: true },
    start: () => {},
    async search() {
      return { total: hits.length, returned: hits.length, offset: 0, truncated: false, tookNs: 1_000_000, hits }
    },
  } as unknown as LocatorRuntime
}

interface ExploreValue {
  ok: boolean
  summary?: string
  refs?: Array<{
    path: string
    kind: string
    origin: string
    title?: string
    score?: number
    matchedQuery?: string
    why?: string[]
  }>
  counts?: { nameHits?: number; contentHits?: number; refs?: number; deduped?: number; merged?: number; maxRefs?: number }
  truncated?: boolean
  truncatedReason?: string
  budget?: { dropped?: number; truncated?: boolean }
  warnings?: string[]
}

async function explore(
  runtime: LocatorRuntime,
  content: ContentIndex,
  args: Record<string, unknown>,
): Promise<ExploreValue> {
  const tool = makeExploreTool(runtime, { content, roots: [] })
  return await tool.execute({ thoroughness: 'quick', ...args } as never, fakeExec()) as unknown as ExploreValue
}

describe('locator_explore ranking', () => {
  it('sorts content hits by ascending bm25 rank (lower is more relevant), names last', async () => {
    const dir = tempDir('locator-explore-rank-')
    const best = join(dir, 'best.md')
    const middle = join(dir, 'middle.md')
    const worst = join(dir, 'worst.md')
    const nameOnly = join(dir, 'zzz-name-only.md')
    const content = fakeContent(() => [
      // FTS5 rank: -11.5 is the most relevant, -0.25 the least.
      contentHit(worst, { score: -0.25 }),
      contentHit(best, { score: -11.5 }),
      contentHit(middle, { score: -2 }),
    ])
    const value = await explore(fakeRuntime([searchHit(nameOnly)]), content, {
      question: 'where did we decide the retry policy for checkout',
    })
    expect(value.ok).toBe(true)
    // The old code sorted descending, so worst.md came first and the Top line
    // showed the least relevant evidence. Ascending rank must put best.md first.
    expect(value.refs?.map(ref => ref.path)).toEqual([best, middle, worst, nameOnly])
    expect(value.refs?.slice(0, 3).map(ref => ref.score)).toEqual([-11.5, -2, -0.25])
    const top = value.summary ?? ''
    expect(top.indexOf('best.md')).toBeLessThan(top.indexOf('middle.md'))
    expect(top.indexOf('middle.md')).toBeLessThan(top.indexOf('worst.md'))
  })

  it('keeps the best rank and attributes every probe when content probes overlap', async () => {
    const dir = tempDir('locator-explore-merge-')
    const file = join(dir, 'shared.md')
    const content = fakeContent(query => [
      contentHit(file, { score: query.includes('retry') ? -7.5 : -1.25 }),
    ])
    const value = await explore(fakeRuntime([]), content, {
      question: 'retry policy alpha beta',
      thoroughness: 'medium',
    })
    expect(value.ok).toBe(true)
    expect(value.refs).toHaveLength(1)
    expect(value.refs?.[0]?.score).toBe(-7.5)
    expect(value.refs?.[0]?.matchedQuery).toBe('retry policy alpha')
    expect(value.refs?.[0]?.why).toEqual(expect.arrayContaining(['content:retry policy alpha', 'content:policy alpha beta']))
  })

  it('deduplicates name probes and drops a directory hit already covered by content', async () => {
    const dir = tempDir('locator-explore-dedupe-')
    const packageDir = join(dir, 'pkg')
    const file = join(packageDir, 'notes.md')
    const content = fakeContent(() => [contentHit(file, { score: -4 })])
    // Both name probes return the same directory + file page: the directory is
    // subsumed by the content hit, and the duplicate file must merge into one ref.
    const runtime = fakeRuntime([searchHit(packageDir, { dir: true }), searchHit(file)])
    const value = await explore(runtime, content, { question: 'notes package retry policy' })
    expect(value.ok).toBe(true)
    expect(value.refs?.map(ref => ref.path)).toEqual([file])
    expect(value.refs?.[0]?.origin).toBe('content')
    expect(value.refs?.[0]?.matchedQuery).toBeDefined()
    expect(value.refs?.[0]?.why?.some(label => label.startsWith('content:'))).toBe(true)
    expect(value.refs?.[0]?.why?.[0]).toMatch(/^name:/)
    expect(value.counts?.deduped ?? 0).toBeGreaterThanOrEqual(3)
    expect(value.counts?.nameHits).toBe(4)
  })

  it('reports the truncation reason and keeps the most relevant refs', async () => {
    const dir = tempDir('locator-explore-trunc-')
    const paths = ['a', 'b', 'c', 'd', 'e'].map(name => join(dir, `${name}.md`))
    const content = fakeContent(() => paths.map((path, index) => contentHit(path, { score: -10 + index })))
    const limited = await explore(fakeRuntime([]), content, { question: 'retry policy', limit: 2 })
    expect(limited.refs).toHaveLength(2)
    expect(limited.counts?.maxRefs).toBe(2)
    expect(limited.counts?.merged).toBe(5)
    expect(limited.counts?.refs).toBe(2)
    expect(limited.truncated).toBe(true)
    expect(limited.truncatedReason).toBe('maxRefs')
    expect(limited.budget?.dropped).toBe(0)
    expect(limited.refs?.map(ref => ref.path)).toEqual([paths[0], paths[1]])

    const budgeted = await explore(fakeRuntime([]), content, { question: 'retry policy', maxChars: 400 })
    expect(budgeted.truncated).toBe(true)
    expect(budgeted.truncatedReason).toBe('budget')
    expect(budgeted.budget?.dropped ?? 0).toBeGreaterThan(0)
    expect(budgeted.refs?.[0]?.path).toBe(paths[0])

    const both = await explore(fakeRuntime([]), content, { question: 'retry policy', limit: 2, maxChars: 400 })
    expect(both.truncatedReason).toBe('both')
    expect(both.refs?.[0]?.path).toBe(paths[0])
  })
})

describe('locator_explore contract', () => {
  it('advertises a valid additive schema and concurrency safety', async () => {
    const dir = tempDir('locator-explore-schema-')
    const file = join(dir, 'notes.md')
    const content = fakeContent(() => [contentHit(file, { score: -3 })])
    const tool = makeExploreTool(fakeRuntime([searchHit(join(dir, 'other.md'))]), { content, roots: [] })
    const value = await tool.execute({ question: 'retry policy' } as never, fakeExec()) as unknown as ExploreValue
    const schema = tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, value)).toEqual([])
    expect(tool.isConcurrencySafe?.({ question: 'retry policy' } as never)).toBe(true)
    expect(value.refs?.every(ref => ref.matchedQuery !== undefined && (ref.why?.length ?? 0) > 0)).toBe(true)
    expect(value.counts?.merged).toBeGreaterThanOrEqual(2)
  })

  it('removes question scaffolding words from the derived probes', () => {
    const plan = { nameQueries: 3, contentQueries: 2, limit: 20, perQuery: 8 }
    const probes = exploreQueries('Where did we decide the retry policy "exponential backoff" for checkout?', plan)
    expect(probes.names).toContain('exponential backoff')
    expect(probes.names).not.toContain('we')
    expect(probes.content.join(' ')).not.toContain('we')
    expect(probes.content.join(' ')).toContain('retry')
  })
})
