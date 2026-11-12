import { describe, expect, it } from 'vitest'
import { makeFindTool } from '../src/find.ts'
import type { ContentIndex } from '../src/content.ts'
import type { ContentSearchOptions } from '../src/content-search.ts'

const tool = makeFindTool({} as unknown as ContentIndex)

function render(value: unknown): string {
  const blocks = tool.output.render({ query: 'x' }, value as never)
  return blocks.map(block => (block as { text?: string }).text ?? '').join('\n')
}

describe('locator_find render', () => {
  it('lists hits with kind, title, snippet and path', () => {
    const text = render({
      ok: true,
      query: 'x',
      hits: [{ kind: 'session', path: '/tmp/s/session.v4.jsonl.zstd', title: 'plan', snippet: 'ship friday', sessionId: 's', messageId: 'm', score: 0 }],
      state: { building: false, files: 1, sessions: 1, messages: 1, truncated: false, updatedAt: 1, error: '' },
    })
    expect(text).toContain('[session] plan — ship friday')
    expect(text).toContain('/tmp/s/session.v4.jsonl.zstd')
    expect(text).not.toContain('budget reached')
    expect(text).not.toContain('still building')
  })

  it('warns while the index is building and when the body budget truncated the build', () => {
    const building = render({ ok: true, hits: [], state: { building: true, files: 0, sessions: 0, messages: 0, truncated: false, updatedAt: 0, error: '' } })
    expect(building).toContain('index still building')
    const truncated = render({ ok: true, hits: [], state: { building: false, files: 1, sessions: 1, messages: 1, truncated: true, updatedAt: 1, error: '' } })
    expect(truncated).toContain('content budget reached')
    expect(truncated).toContain('contentMaxTotalBytes')
  })

  it('renders tool errors', () => {
    expect(render({ ok: false, error: 'query is empty' })).toContain('locator_find failed: query is empty')
  })
})

describe('locator_find advanced result', () => {
  const state = { building: false, files: 1, sessions: 1, messages: 1, truncated: false, updatedAt: 1, error: '', warnings: [] }

  it('renders bounded counts and build warnings', () => {
    const bounded = render({
      ok: true,
      hits: [{ kind: 'file', path: '/tmp/a.md', title: 'a.md', snippet: 'note', score: 1 }],
      count: { value: 42, kind: 'bounded' },
      warnings: ['scan-capped'],
      state,
    })
    expect(bounded).toContain('count ≥ 42')
    expect(bounded).toContain('warnings: scan-capped')
  })

  it('shows non-fatal build warnings from the content state', () => {
    const text = render({
      ok: true,
      hits: [],
      state: { ...state, warnings: ['content-session-log-unreadable'] },
    })
    expect(text).toContain('warnings: content-session-log-unreadable')
  })

  it('renders a rejected query and its warning codes', () => {
    const text = render({ ok: false, error: 'content-query-too-short', warnings: ['content-query-too-short'] })
    expect(text).toContain('locator_find failed: content-query-too-short')
    expect(text).toContain('content-query-too-short')
  })

  it('passes the advanced options and query errors through execute', async () => {
    const calls: Array<{ query: string; limit: number; options: ContentSearchOptions }> = []
    const fake = {
      search: async (query: string, limit: number, options: ContentSearchOptions) => {
        calls.push({ query, limit, options })
        return { hits: [], count: { value: 0, kind: 'unknown' }, warnings: ['content-query-too-short'], error: 'content-query-too-short' }
      },
      status: () => ({ ...state }),
    } as unknown as ContentIndex
    const tool = makeFindTool(fake)
    const result = await tool.execute({
      query: 'note',
      limit: 5,
      matchMode: 'extended',
      caseSensitive: true,
      wholeWord: true,
      sessionId: 'session-1',
      count: 'bounded',
      countLimit: 7,
      pathPrefix: '/tmp/workspace',
    }, {} as never) as { ok: boolean; error?: string; warnings?: string[] }
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      query: 'note',
      limit: 5,
      options: {
        matchMode: 'extended',
        caseSensitive: true,
        wholeWord: true,
        sessionId: 'session-1',
        count: 'bounded',
        countLimit: 7,
        pathPrefix: '/tmp/workspace',
      },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('content-query-too-short')
    expect(result.warnings).toContain('content-query-too-short')
  })
})


describe('locator_find workspace scope', () => {
  const state = { building: false, files: 1, sessions: 1, messages: 1, truncated: false, updatedAt: 1, error: '', warnings: [] }
  function exec() {
    return { agent: { session: { id: 'caller-session', header: { cwd: '/tmp/caller-workspace' } } } } as never
  }
  it('defaults session and path filters to the caller workspace', async () => {
    const calls: ContentSearchOptions[] = []
    const fake = {
      search: async (_query: string, _limit: number, options: ContentSearchOptions) => {
        calls.push(options)
        return { hits: [], count: { value: 0, kind: 'unknown' }, warnings: [] }
      },
      status: () => ({ ...state }),
    } as unknown as ContentIndex
    const tool = makeFindTool(fake, undefined, ['/tmp/caller-workspace'])
    await tool.execute({ query: 'note' }, exec())
    expect(calls[0]).toMatchObject({ sessionId: 'caller-session', pathPrefix: '/tmp/caller-workspace' })
  })
  it('scope all drops implicit filters but still honors explicit ones', async () => {
    const calls: ContentSearchOptions[] = []
    const fake = {
      search: async (_query: string, _limit: number, options: ContentSearchOptions) => {
        calls.push(options)
        return { hits: [], count: { value: 0, kind: 'unknown' }, warnings: [] }
      },
      status: () => ({ ...state }),
    } as unknown as ContentIndex
    const tool = makeFindTool(fake, undefined, ['/tmp/caller-workspace'])
    await tool.execute({ query: 'note', scope: 'all' }, exec())
    expect(calls[0]!.sessionId).toBeUndefined()
    expect(calls[0]!.pathPrefix).toBeUndefined()
    await tool.execute({ query: 'note', scope: 'all', sessionId: 'other', pathPrefix: '/tmp/other' }, exec())
    expect(calls[1]!).toMatchObject({ sessionId: 'other', pathPrefix: '/tmp/other' })
  })

  it('does not restrict file hits to a cwd outside every indexed root', async () => {
    const calls: ContentSearchOptions[] = []
    const fake = {
      search: async (_query: string, _limit: number, options: ContentSearchOptions) => {
        calls.push(options)
        return { hits: [], count: { value: 0, kind: 'unknown' }, warnings: [] }
      },
      status: () => ({ ...state }),
    } as unknown as ContentIndex
    const tool = makeFindTool(fake, undefined, ['/home/yy'])
    await tool.execute({ query: 'note' }, {
      agent: { session: { id: 'caller-session', header: { cwd: '/mnt/d/projects/elsewhere' } } },
    } as never)
    expect(calls[0]).toMatchObject({ sessionId: 'caller-session' })
    expect(calls[0]!.pathPrefix).toBeUndefined()
  })

})