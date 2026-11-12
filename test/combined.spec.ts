import { describe, expect, it } from 'vitest'
import {
  dedupeNameHits,
  readCombinedRequest,
  readScopes,
  runCombinedSearch,
  type CombinedDeps,
} from '../src/combined.ts'
import type { ContentHit, ContentState } from '../src/content.ts'
import type { SearchArgs, SearchHit, SearchResult } from '../src/runtime.ts'

function fileHit(path: string): SearchHit {
  return { path, name: path.split('/').pop() ?? path, size: 10, mtime: 1, ext: 'md', dir: false }
}

function dirHit(path: string): SearchHit {
  return { path, name: path.split('/').pop() ?? path, size: 0, mtime: 1, ext: '', dir: true }
}

function contentHit(kind: 'file' | 'session', path: string): ContentHit {
  return {
    kind,
    path,
    title: path.split('/').pop() ?? path,
    snippet: 'snippet',
    score: 1,
    ...(kind === 'session' ? { sessionId: 's1', messageId: 'm1' } : {}),
  }
}

function result(hits: SearchHit[], tookNs = 1_000_000): SearchResult {
  return { total: hits.length, returned: hits.length, offset: 0, truncated: false, tookNs, hits }
}

function state(extra: Partial<ContentState> = {}): ContentState {
  return { building: false, files: 0, sessions: 0, messages: 0, truncated: false, error: '', updatedAt: 0, ...extra }
}

function deps(overrides: Partial<CombinedDeps> = {}): CombinedDeps {
  return {
    maxResults: 100,
    search: async () => result([]),
    contentSearch: async () => [],
    contentStatus: () => state(),
    ensure: () => {},
    ...overrides,
  }
}

describe('combined search', () => {
  it('enables every scope unless it is explicitly false', () => {
    expect(readScopes({})).toEqual({ content: true, files: true, dirs: true })
    expect(readScopes({ content: false })).toEqual({ content: false, files: true, dirs: true })
    expect(readScopes({ files: false, dirs: false })).toEqual({ content: true, files: false, dirs: false })
    expect(readScopes({ content: 'no' })).toEqual({ content: true, files: true, dirs: true })
  })

  it('clamps the two page limits independently', () => {
    const request = readCombinedRequest({ query: 'x', limit: 9999, contentLimit: 9999 }, 100)
    expect(request.limit).toBe(100)
    expect(request.contentLimit).toBe(100)
    const fallback = readCombinedRequest({}, 100)
    expect(fallback.query).toBe('')
    expect(fallback.limit).toBe(50)
    expect(fallback.contentLimit).toBe(30)
    expect(fallback.sort).toBe('mtime')
    expect(readCombinedRequest({ sort: 'path', desc: true }, 100)).toMatchObject({ sort: 'path', desc: true })
  })

  it('drops name hits whose path is already in the content group', () => {
    const content = [contentHit('file', '/tmp/notes.md'), contentHit('session', '/tmp/session.log')]
    const names = [fileHit('/tmp/notes.md'), fileHit('/tmp/other.md'), fileHit('/tmp/session.log'), dirHit('/tmp/notes.md')]
    const deduped = dedupeNameHits(content, names)
    expect(deduped.deduped).toBe(2)
    expect(deduped.hits.map(hit => hit.path)).toEqual(['/tmp/other.md', '/tmp/notes.md'])
    expect(dedupeNameHits([], names)).toEqual({ hits: names, deduped: 0 })
  })

  it('does not start the lazy content build for empty or one-character queries', async () => {
    let ensured = 0
    let searched = 0
    const response = await runCombinedSearch(deps({
      ensure: () => { ensured++ },
      contentSearch: async () => { searched++; return [] },
    }), readCombinedRequest({ query: '   ' }, 100))
    expect(ensured).toBe(0)
    expect(searched).toBe(0)
    expect(response.content).toMatchObject({ hits: [], building: false })
    const short = await runCombinedSearch(deps({
      ensure: () => { ensured++ },
      contentSearch: async () => { searched++; return [] },
    }), readCombinedRequest({ query: 'x' }, 100))
    expect(ensured).toBe(0)
    expect(searched).toBe(0)
    expect(short.content?.returned).toBe(0)
  })

  it('does not touch content when the scope or the store is disabled', async () => {
    let ensured = 0
    let searched = 0
    const withContent = deps({
      ensure: () => { ensured++ },
      contentSearch: async () => { searched++; return [] },
    })
    await runCombinedSearch(withContent, readCombinedRequest({ query: 'x', content: false }, 100))
    expect(ensured).toBe(0)
    expect(searched).toBe(0)

    const withoutStore = deps()
    delete (withoutStore as { contentSearch?: CombinedDeps['contentSearch'] }).contentSearch
    const response = await runCombinedSearch(withoutStore, readCombinedRequest({ query: 'x' }, 100))
    expect(response.contentEnabled).toBe(false)
    expect(response.content).toBeUndefined()
  })

  it('queries content, files and directories in the documented order', async () => {
    const calls: SearchArgs[] = []
    let ensured = 0
    let contentQuery = ''
    const response = await runCombinedSearch(deps({
      search: async args => { calls.push(args); return args.filesOnly ? result([fileHit('/tmp/a.md')]) : result([dirHit('/tmp/dir')]) },
      ensure: () => { ensured++ },
      contentSearch: async query => { contentQuery = query; return [contentHit('file', '/tmp/a.md')] },
      contentStatus: () => state({ building: true }),
    }), readCombinedRequest({ query: 'note', limit: 5 }, 100))
    expect(ensured).toBe(1)
    expect(contentQuery).toBe('note')
    expect(calls.map(call => call.filesOnly)).toEqual([true, false])
    expect(calls.every(call => call.limit === 5)).toBe(true)
    expect(response.content).toMatchObject({ returned: 1, building: true })
    expect(response.files).toMatchObject({ returned: 0, deduped: 1, truncated: true })
    expect(response.dirs?.hits.map(hit => hit.path)).toEqual(['/tmp/dir'])
    expect(Object.keys(response).filter(key => key === 'content' || key === 'files' || key === 'dirs')).toEqual(['content', 'files', 'dirs'])
  })

  it('contains a failing store to its own group', async () => {
    const response = await runCombinedSearch(deps({
      search: async args => {
        if (args.filesOnly) throw new Error('engine offline')
        return result([dirHit('/tmp/dir')])
      },
    }), readCombinedRequest({ query: 'x' }, 100))
    expect(response.files?.error).toBe('engine offline')
    expect(response.files?.hits).toEqual([])
    expect(response.dirs?.hits).toHaveLength(1)
  })
})
