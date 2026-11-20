import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { ContentIndex } from '../src/content.ts'
import { CONTENT_STATE_SCHEMA, contentPathExcluded, contentScopeOptionsOf, makeFindTool } from '../src/find.ts'
import type { ContentSearchOptions } from '../src/content-search.ts'
import { sessionEventRef } from '../src/refs.ts'
import type { LocatorRuntime } from '../src/runtime.ts'

/** Fake content store with the authorization/ref helpers locator_find now uses. */
function withAuth(fake: Record<string, unknown>): ContentIndex {
  return {
    authorizedSessionIds: () => new Set(['caller-session', 'session-1', 'other']),
    indexedMtime: () => undefined,
    sessionIndexedMtime: () => undefined,
    sessionBody: () => undefined,
    ...fake,
  } as unknown as ContentIndex
}

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
      authorizedSessionIds: () => new Set(['caller-session', 'session-1', 'other']),
      indexedMtime: () => undefined,
      sessionIndexedMtime: () => undefined,
      sessionBody: () => undefined,
    } as unknown as ContentIndex
    const tool = makeFindTool(fake, undefined, ['/tmp/workspace'])
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
    }, { agent: { session: { id: 'caller-session', header: { cwd: '/tmp/workspace' } } } } as never) as { ok: boolean; error?: string; warnings?: string[] }
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
      authorizedSessionIds: () => new Set(['caller-session', 'session-1', 'other']),
      indexedMtime: () => undefined,
      sessionIndexedMtime: () => undefined,
      sessionBody: () => undefined,
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
      authorizedSessionIds: () => new Set(['caller-session', 'session-1', 'other']),
      indexedMtime: () => undefined,
      sessionIndexedMtime: () => undefined,
      sessionBody: () => undefined,
    } as unknown as ContentIndex
    const tool = makeFindTool(fake, undefined, ['/tmp'])
    await tool.execute({ query: 'note', scope: 'all' }, exec())
    expect(calls[0]!.sessionId).toBeUndefined()
    expect(calls[0]!.pathPrefix).toBeUndefined()
    // `all` still limits session documents to the caller's authorized set.
    expect(calls[0]!.allowedSessionIds).toEqual(['caller-session', 'session-1', 'other'])
    // An explicit, authorized session id is honored (root-scoped path allowed).
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
      authorizedSessionIds: () => new Set(['caller-session', 'session-1', 'other']),
      indexedMtime: () => undefined,
      sessionIndexedMtime: () => undefined,
      sessionBody: () => undefined,
    } as unknown as ContentIndex
    const tool = makeFindTool(fake, undefined, ['/home/yy'])
    await tool.execute({ query: 'note' }, {
      agent: { session: { id: 'caller-session', header: { cwd: '/mnt/d/projects/elsewhere' } } },
    } as never)
    expect(calls[0]).toMatchObject({ sessionId: 'caller-session', fileHitsAllRoots: true })
    expect(calls[0]!.pathPrefix).toBeUndefined()
  })


  it('passes an offset through to the content search', async () => {
    const calls: ContentSearchOptions[] = []
    const fake = {
      search: async (_query: string, _limit: number, options: ContentSearchOptions) => {
        calls.push(options)
        return { hits: [], count: { value: 42, kind: 'exact' }, warnings: [] }
      },
      status: () => ({ ...state }),
      authorizedSessionIds: () => new Set(['caller-session', 'session-1', 'other']),
      indexedMtime: () => undefined,
      sessionIndexedMtime: () => undefined,
      sessionBody: () => undefined,
    } as unknown as ContentIndex
    const tool = makeFindTool(fake)
    const result = await tool.execute({ query: 'note', offset: 7, limit: 5 }, {} as never) as { offset?: number }
    expect(calls[0]!.offset).toBe(7)
    expect(result.offset).toBe(7)
  })


  it('declares every content-state field the host validates', () => {
    // Regression: 0.11.3 added fullIndex/reasoningIndex to ContentState but not
    // to the locator_find output schema, so every call failed host validation
    // with "invalid output" until the schema caught up.
    const schema = CONTENT_STATE_SCHEMA as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    const state = {
      building: true,
      files: 0,
      sessions: 0,
      messages: 0,
      truncated: false,
      error: '',
      warnings: [],
      updatedAt: 1,
      fullIndex: true,
      reasoningIndex: true,
      refs: { total: 3, byKind: { url: 2, spill: 1 } },
      progress: { phase: 'files', scanned: 3, indexed: 1, total: 9, path: '/tmp/a.md', startedAt: 2 },
    }
    expect(validateJsonSchemaValue(schema, state)).toEqual([])
  })


  it('marks a 2-code-point page as a short-query fallback', async () => {
    const fake = withAuth({
      search: async () => ({
        hits: [{ kind: 'file' as const, path: '/home/yy/ai.md', title: 'ai.md', snippet: 'ai body', score: 1 }],
        count: { value: 1, kind: 'exact' as const },
        warnings: ['content-query-short-fallback'],
        shortQueryFallback: true,
      }),
      status: () => ({ building: false, files: 1, sessions: 0, messages: 0, truncated: false, updatedAt: 1, error: '', warnings: [] }),
    })
    const tool = makeFindTool(fake, undefined, [])
    const result = await tool.execute({ query: 'ai' }, exec()) as {
      ok: boolean
      shortQueryFallback?: boolean
      warnings?: string[]
    }
    expect(result.ok).toBe(true)
    expect(result.shortQueryFallback).toBe(true)
    expect(result.warnings).toContain('content-query-short-fallback')
    const schema = tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, result)).toEqual([])
    const text = tool.output.render({ query: 'ai' }, result as never).map(block => (block as { text?: string }).text ?? '').join('\n')
    expect(text).toContain('short-query fallback')
  })

  it('denies an explicit session id outside the caller workspace', async () => {
    const calls: ContentSearchOptions[] = []
    const fake = withAuth({
      search: async (_query: string, _limit: number, options: ContentSearchOptions) => {
        calls.push(options)
        return { hits: [], count: { value: 0, kind: 'unknown' as const }, warnings: [] }
      },
      status: () => ({ building: false, files: 0, sessions: 0, messages: 0, truncated: false, updatedAt: 0, error: '', warnings: [] }),
      authorizedSessionIds: () => new Set(['caller-session']),
    })
    const tool = makeFindTool(fake, undefined, ['/tmp/workspace'])
    const result = await tool.execute({ query: 'note', sessionId: 'other-project-session' }, exec()) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe('content-scope-denied')
    expect(calls).toHaveLength(0)
  })

  it('denies a pathPrefix outside the indexed roots', async () => {
    const fake = withAuth({
      search: async () => ({ hits: [], count: { value: 0, kind: 'unknown' as const }, warnings: [] }),
      status: () => ({ building: false, files: 0, sessions: 0, messages: 0, truncated: false, updatedAt: 0, error: '', warnings: [] }),
    })
    const tool = makeFindTool(fake, undefined, ['/tmp/workspace'])
    const result = await tool.execute({ query: 'note', pathPrefix: '/etc' }, exec()) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe('content-path-denied')
  })

  it('attaches refs, provenance, freshness and permissions to hits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-find-ref-'))
    const file = join(dir, 'notes.md')
    writeFileSync(file, 'ref evidence body')
    try {
      const fake = withAuth({
        search: async () => ({
          hits: [
            { kind: 'file' as const, path: file, title: 'notes.md', snippet: 'ref evidence', line: 1, score: 1 },
            { kind: 'session' as const, path: '/home/u/.dsh/sessions/--w--/session-1/session.v4.jsonl.zstd', title: 'chat', snippet: 'ref evidence', sessionId: 'session-1', messageId: 'msg-1', score: 1 },
          ],
          count: { value: 2, kind: 'exact' as const },
          warnings: [],
        }),
        status: () => ({ building: false, files: 1, sessions: 1, messages: 1, truncated: false, updatedAt: 1, error: '', warnings: [] }),
      })
      const tool = makeFindTool(fake, undefined, ['/tmp/workspace'])
      const result = await tool.execute({ query: 'ref evidence' }, {
        agent: { session: { id: 'caller-session', header: { cwd: '/tmp/workspace' } } },
      } as never) as { ok: boolean; hits?: Array<{ ref?: string; freshness?: { state?: string }; permissions?: { visibility?: string }; hash?: string }> }
      expect(result.ok).toBe(true)
      const hits = result.hits ?? []
      expect(hits[0]?.ref).toMatch(/^ref:\/\/file\?/)
      expect(hits[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(hits[0]?.freshness?.state).toBe('fresh')
      expect(hits[0]?.permissions?.visibility).toBe('workspace')
      expect(hits[1]?.ref).toMatch(/^dsh-session:/)
      expect(hits[1]?.permissions?.visibility).toBe('session')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('attaches session-event seq and eventRef to session hits', async () => {
    const sessionPath = '/tmp/locator-find-events/session-1/session.v4.jsonl.zstd'
    const eventRef = sessionEventRef({ sessionId: 'session-1', seq: 4 })
    const fake = withAuth({
      search: async () => ({
        hits: [
          { kind: 'session' as const, path: sessionPath, title: 'chat', snippet: 'event body', sessionId: 'session-1', messageId: 'msg-1', score: 1 },
          { kind: 'session' as const, path: sessionPath, title: 'tool output', snippet: 'result body', sessionId: 'session-1', messageId: 'call-1', score: 1 },
        ],
        count: { value: 2, kind: 'exact' as const },
        warnings: [],
      }),
      status: () => ({ ...state }),
      sessionEventRefs: () => new Map([['msg-1', { seq: 4, ref: eventRef }]]),
    })
    const tool = makeFindTool(fake, undefined, [])
    const result = await tool.execute({ query: 'event body' }, exec()) as {
      ok: boolean
      hits?: Array<{ messageId?: string; seq?: number; eventRef?: string }>
    }
    expect(result.ok).toBe(true)
    expect(result.hits?.[0]).toMatchObject({ messageId: 'msg-1', seq: 4, eventRef })
    // Tool-result documents have no session-event ref: the fields stay absent.
    expect(result.hits?.[1]?.seq).toBeUndefined()
    expect(result.hits?.[1]?.eventRef).toBeUndefined()
    const schema = tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, result)).toEqual([])
  })

  it('reads real session-event refs from the content index', async () => {
    const sessions = mkdtempSync(join(tmpdir(), 'locator-find-events-sessions-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'locator-find-events-state-'))
    const dir = join(sessions, '--work-a--', 'session-events')
    mkdirSync(dir, { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session', version: 4, id: 'session-events', createdAt: 1, cwd: '/work/a' }),
      JSON.stringify({ type: 'user/message', data: { id: 'msg-events', seq: 1, content: [{ type: 'text', text: 'EVENTMARK evidence decision' }] } }),
    ].join('\n')
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines)))
    const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir, sessionDirs: [sessions], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 10 })
    try {
      content.start()
      for (let i = 0; i < 200 && content.status().building; i++) await new Promise(resolve => setTimeout(resolve, 25))
      const tool = makeFindTool(content, undefined, [])
      const result = await tool.execute({ query: 'EVENTMARK', sessionId: 'session-events' }, {
        agent: { session: { id: 'caller-session', header: { cwd: '/work/a' } } },
      } as never) as { ok: boolean; hits?: Array<{ kind: string; sessionId?: string; messageId?: string; seq?: number; eventRef?: string }> }
      const hit = (result.hits ?? []).find(candidate => candidate.kind === 'session')
      expect(hit).toMatchObject({
        sessionId: 'session-events',
        messageId: 'msg-events',
        seq: 0,
        eventRef: sessionEventRef({ sessionId: 'session-events', seq: 0 }),
      })
    } finally {
      content.close()
      rmSync(sessions, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('truncates fractional indexedAt so the output schema stays valid', async () => {
    const sessionPath = '/tmp/locator-find-events-fractional/session-1/session.v4.jsonl.zstd'
    const fake = withAuth({
      search: async () => ({
        hits: [{ kind: 'session' as const, path: sessionPath, title: 'chat', snippet: 'fractional', sessionId: 'session-1', messageId: 'msg-1', score: 1 }],
        count: { value: 1, kind: 'exact' as const },
        warnings: [],
      }),
      status: () => ({ ...state }),
      indexedMtime: () => 1794833230332.75,
    })
    const tool = makeFindTool(fake, undefined, [])
    const result = await tool.execute({ query: 'fractional' }, exec()) as {
      ok: boolean
      hits?: Array<{ provenance?: { indexedAt?: number } }>
    }
    expect(result.ok).toBe(true)
    expect(result.hits?.[0]?.provenance?.indexedAt).toBe(1794833230332)
    const schema = tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, result)).toEqual([])
  })

})

describe('workspace content scope fallback (0.20.2)', () => {
  const state = { building: false, files: 1, sessions: 1, messages: 1, truncated: false, updatedAt: 1, error: '', warnings: [] }
  function exec(cwd: string) {
    return { agent: { session: { id: 'caller-session', header: { cwd } } } } as never
  }
  /** A runtime view whose config carries the two 0.20.2 content-scope knobs. */
  function runtime(contentExcludes: string[], shortQueryFallback = true): LocatorRuntime {
    return { config: { contentExcludes, contentShortQueryFallback: shortQueryFallback }, roots: ['/mnt/d'] } as unknown as LocatorRuntime
  }
  const fileHit = { kind: 'file' as const, path: '/home/yy/global.md', title: 'global.md', snippet: 'global hit', score: 1 }

  it('reports a cwd under a contentExcludes rule as outside the content roots', () => {
    expect(contentPathExcluded('/mnt/d/Projects/dsh', ['/mnt/d/'])).toBe(true)
    expect(contentPathExcluded('/mnt/d/Projects/dsh', ['node_modules'])).toBe(false)
    expect(contentPathExcluded('/home/yy/pkg/node_modules/x', ['node_modules'])).toBe(true)
    expect(contentPathExcluded('/home/yy/.dsh/sessions', [])).toBe(true)
    expect(contentPathExcluded('/home/yy/work', [])).toBe(false)
  })

  it('reads the content-scope knobs off the runtime config defensively', () => {
    expect(contentScopeOptionsOf(undefined)).toEqual({})
    expect(contentScopeOptionsOf(runtime(['/mnt/d/']))).toEqual({ contentExcludes: ['/mnt/d/'], shortQueryFallback: true })
    expect(contentScopeOptionsOf(runtime([], false))).toEqual({ contentExcludes: [], shortQueryFallback: false })
    const bare = { config: {} } as unknown as LocatorRuntime
    expect(contentScopeOptionsOf(bare)).toEqual({ contentExcludes: [], shortQueryFallback: true })
  })

  it('retries an empty workspace page across all content roots and marks it global', async () => {
    const calls: ContentSearchOptions[] = []
    const fake = withAuth({
      search: async (_query: string, _limit: number, options: ContentSearchOptions) => {
        calls.push(options)
        if (calls.length === 1) return { hits: [], count: { value: 0, kind: 'exact' as const }, warnings: [] }
        return { hits: [fileHit], count: { value: 1, kind: 'exact' as const }, warnings: [] }
      },
      status: () => ({ ...state }),
    })
    const tool = makeFindTool(fake, undefined, ['/mnt/d'], false, { rt: runtime(['/mnt/d/']) })
    const result = await tool.execute({ query: 'note' }, exec('/mnt/d/Projects/dsh')) as { ok: boolean; hits?: Array<{ path?: string }>; scopeFallback?: string }
    expect(calls).toHaveLength(2)
    // The first query keeps the workspace narrowing; the retry drops it and
    // asks the content layer for file hits across every content root.
    expect(calls[0]).toMatchObject({ pathPrefix: '/mnt/d/Projects/dsh', sessionId: 'caller-session' })
    expect(calls[1]!.pathPrefix).toBeUndefined()
    expect(calls[1]!.fileHitsAllRoots).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.scopeFallback).toBe('global')
    expect(result.hits?.map(hit => hit.path)).toEqual(['/home/yy/global.md'])
  })

  it('keeps the workspace query alone when the cwd is inside the content index', async () => {
    const calls: ContentSearchOptions[] = []
    const fake = withAuth({
      search: async (_query: string, _limit: number, options: ContentSearchOptions) => {
        calls.push(options)
        return { hits: [], count: { value: 0, kind: 'exact' as const }, warnings: [] }
      },
      status: () => ({ ...state }),
    })
    const tool = makeFindTool(fake, undefined, ['/mnt/d'], false, { rt: runtime([]) })
    const result = await tool.execute({ query: 'note' }, exec('/mnt/d/Projects/dsh')) as { scopeFallback?: string }
    expect(calls).toHaveLength(1)
    expect(calls[0]!.pathPrefix).toBe('/mnt/d/Projects/dsh')
    expect(result.scopeFallback).toBeUndefined()
  })

  it('never widens an explicit pathPrefix and never retries a paged query', async () => {
    const calls: ContentSearchOptions[] = []
    const fake = withAuth({
      search: async (_query: string, _limit: number, options: ContentSearchOptions) => {
        calls.push(options)
        return { hits: [], count: { value: 0, kind: 'exact' as const }, warnings: [] }
      },
      status: () => ({ ...state }),
    })
    const tool = makeFindTool(fake, undefined, ['/mnt/d'], false, { rt: runtime(['/mnt/d/']) })
    await tool.execute({ query: 'note', pathPrefix: '/mnt/d/Projects' }, exec('/mnt/d/Projects/dsh'))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.pathPrefix).toBe('/mnt/d/Projects')
    calls.length = 0
    await tool.execute({ query: 'note', offset: 10 }, exec('/mnt/d/Projects/dsh'))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.offset).toBe(10)
  })

  it('marks the fallback even when the global page is also empty', async () => {
    const calls: ContentSearchOptions[] = []
    const fake = withAuth({
      search: async (_query: string, _limit: number, options: ContentSearchOptions) => {
        calls.push(options)
        return { hits: [], count: { value: 0, kind: 'exact' as const }, warnings: [] }
      },
      status: () => ({ ...state }),
    })
    const tool = makeFindTool(fake, undefined, ['/mnt/d'], false, { rt: runtime(['/mnt/d/']) })
    const result = await tool.execute({ query: 'note' }, exec('/mnt/d/Projects/dsh')) as { scopeFallback?: string }
    expect(calls).toHaveLength(2)
    expect(result.scopeFallback).toBe('global')
  })

  it('keeps the existing cwd-not-indexed marker for a cwd outside every root', async () => {
    const fake = withAuth({
      search: async () => ({ hits: [fileHit], count: { value: 1, kind: 'exact' as const }, warnings: [] }),
      status: () => ({ ...state }),
    })
    const tool = makeFindTool(fake, undefined, ['/home/yy'], false, { rt: runtime(['/mnt/d/']) })
    const result = await tool.execute({ query: 'note' }, exec('/mnt/d/elsewhere')) as { scopeFallback?: string }
    expect(result.scopeFallback).toBe('cwd-not-indexed; files searched across configured roots')
  })
})
