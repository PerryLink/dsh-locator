import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  COMBINED_ENRICH_CACHE_TTL_MS,
  COMBINED_HASH_MAX_BYTES,
  COMBINED_HASH_MAX_HITS,
  dedupeNameHits,
  isAbortError,
  isSlowFilesystemPath,
  mapLimit,
  readCombinedRequest,
  readScopes,
  resetCombinedEnrichCache,
  runCombinedSearch,
  type CombinedDeps,
} from '../src/combined.ts'
import { sha256File } from '../src/refs.ts'
import type { ContentHit, ContentState } from '../src/content.ts'
import type { SearchArgs, SearchHit, SearchResult } from '../src/runtime.ts'
import type { ContentCount, ContentSearchOptions, ContentSearchResult } from '../src/content-search.ts'

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

function contentResult(
  hits: ContentHit[],
  count: ContentCount = { value: hits.length, kind: 'exact' },
  warnings: string[] = [],
): ContentSearchResult {
  return { hits, count, warnings }
}

function state(extra: Partial<ContentState> = {}): ContentState {
  return { building: false, files: 0, sessions: 0, messages: 0, truncated: false, error: '', warnings: [], updatedAt: 0, ...extra }
}

/** The enrichment TTL cache is process-wide; isolate every test. */
beforeEach(() => {
  resetCombinedEnrichCache()
})

function deps(overrides: Partial<CombinedDeps> = {}): CombinedDeps {
  return {
    maxResults: 100,
    search: async () => result([]),
    contentSearch: async () => contentResult([]),
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

  it('defaults the evidence limit to 10, clamps it to 0..50 and accepts 0', () => {
    expect(readCombinedRequest({ query: 'x' }, 100).evidenceLimit).toBe(10)
    expect(readCombinedRequest({ query: 'x', evidenceLimit: 5 }, 100).evidenceLimit).toBe(5)
    expect(readCombinedRequest({ query: 'x', evidenceLimit: 999 }, 100).evidenceLimit).toBe(50)
    expect(readCombinedRequest({ query: 'x', evidenceLimit: -3 }, 100).evidenceLimit).toBe(0)
    expect(readCombinedRequest({ query: 'x', evidenceLimit: 0 }, 100).evidenceLimit).toBe(0)
    expect(readCombinedRequest({ query: 'x', evidenceLimit: 'many' }, 100).evidenceLimit).toBe(10)
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
      contentSearch: async () => { searched++; return contentResult([]) },
    }), readCombinedRequest({ query: '   ' }, 100))
    expect(ensured).toBe(0)
    expect(searched).toBe(0)
    expect(response.content).toMatchObject({ hits: [], building: false })
    const short = await runCombinedSearch(deps({
      ensure: () => { ensured++ },
      contentSearch: async () => { searched++; return contentResult([]) },
    }), readCombinedRequest({ query: 'x' }, 100))
    expect(ensured).toBe(0)
    expect(searched).toBe(0)
    expect(short.content?.returned).toBe(0)
  })

  it('surfaces an invalid content query without starting a build', async () => {
    let ensured = 0
    let searched = 0
    const run = (query: string, options: { shortQueryFallback?: boolean } = {}) => runCombinedSearch(deps({
      ensure: () => { ensured++ },
      contentSearch: async () => { searched++; return contentResult([]) },
    }), readCombinedRequest({ query }, 100), options)
    // A 2-code-point query is only pre-rejected when the bounded fallback is off.
    const twoOff = await run('ab', { shortQueryFallback: false })
    expect(twoOff.content).toMatchObject({
      hits: [],
      returned: 0,
      error: 'content-query-too-short',
      count: { value: 0, kind: 'unknown' },
    })
    expect(ensured).toBe(0)
    expect(searched).toBe(0)
    // With the fallback enabled the store decides and the marker is passed through.
    const twoOn = await runCombinedSearch(deps({
      ensure: () => { ensured++ },
      contentSearch: async () => {
        searched++
        return { ...contentResult([]), shortQueryFallback: true } as unknown as ContentSearchResult
      },
    }), readCombinedRequest({ query: 'ab' }, 100))
    expect(twoOn.content?.error).toBeUndefined()
    expect(twoOn.content?.shortQueryFallback).toBe(true)
    expect(ensured).toBe(1)
    expect(searched).toBe(1)
    // A longer query containing a short term follows the same fallback policy:
    // rejected while the fallback is off, admitted by the store when it is on.
    const mixedOff = await run('sql ab', { shortQueryFallback: false })
    expect(mixedOff.content?.error).toBe('content-query-too-short')
    expect(ensured).toBe(1)
    expect(searched).toBe(1)
    const mixedOn = await run('sql ab')
    expect(mixedOn.content?.error).toBeUndefined()
    expect(ensured).toBe(2)
    expect(searched).toBe(2)
    // A control character is never admitted, fallback or not.
    const nul = await run('alpha\u0000beta')
    expect(nul.content?.error).toBe('invalid-control-char')
    expect(ensured).toBe(2)
    expect(searched).toBe(2)
  })

  it('passes content timeout, scan-capped and bounded-count results through', async () => {
    const timeout = await runCombinedSearch(deps({
      contentSearch: async () => ({
        hits: [],
        count: { value: 0, kind: 'unknown' },
        warnings: ['content-search-timeout'],
        error: 'content-search-timeout',
      }),
    }), readCombinedRequest({ query: 'note' }, 100))
    expect(timeout.content).toMatchObject({
      error: 'content-search-timeout',
      warnings: ['content-search-timeout'],
      count: { value: 0, kind: 'unknown' },
      capped: false,
    })

    const capped = await runCombinedSearch(deps({
      contentSearch: async () => ({
        hits: [contentHit('file', '/tmp/a.md')],
        count: { value: 1, kind: 'bounded', limit: 1000 },
        warnings: ['scan-capped', 'bounded-count'],
      }),
    }), readCombinedRequest({ query: 'note' }, 100))
    expect(capped.content).toMatchObject({
      returned: 1,
      count: { value: 1, kind: 'bounded', limit: 1000 },
      warnings: ['scan-capped', 'bounded-count'],
    })
    expect(capped.content?.error).toBeUndefined()
  })

  it('does not touch content when the scope or the store is disabled', async () => {
    let ensured = 0
    let searched = 0
    const withContent = deps({
      ensure: () => { ensured++ },
      contentSearch: async () => { searched++; return contentResult([]) },
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
      contentSearch: async query => { contentQuery = query; return contentResult([contentHit('file', '/tmp/a.md')]) },
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

  it('keeps the response alive when the content status throws', async () => {
    const broken = deps({ contentStatus: () => { throw new Error('db gone') } })
    const empty = await runCombinedSearch(broken, readCombinedRequest({ query: '  ' }, 100))
    expect(empty.content).toMatchObject({ hits: [], returned: 0, building: false })
    expect(empty.files?.hits).toEqual([])
    expect(empty.dirs?.hits).toEqual([])

    const nonEmpty = await runCombinedSearch(deps({
      contentStatus: () => { throw new Error('db gone') },
      contentSearch: async () => contentResult([contentHit('file', '/tmp/a.md')]),
    }), readCombinedRequest({ query: 'note' }, 100))
    expect(nonEmpty.content?.error).toBe('db gone')
    expect(nonEmpty.files).toBeDefined()
    expect(nonEmpty.dirs).toBeDefined()
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

  it('parses the advanced match options with safe fallbacks', () => {
    const request = readCombinedRequest({
      query: 'note',
      matchMode: 'extended',
      caseSensitive: true,
      wholeWord: true,
      sessionId: 'session-1',
      count: 'bounded',
      countLimit: 99_999,
    }, 100)
    expect(request).toMatchObject({
      matchMode: 'extended',
      caseSensitive: true,
      wholeWord: true,
      sessionId: 'session-1',
      count: 'bounded',
      countLimit: 5000,
    })

    const fallback = readCombinedRequest({ matchMode: 'nope', count: 'nope', countLimit: 0, sessionId: '   ' }, 100)
    expect(fallback).toMatchObject({ matchMode: 'normal', caseSensitive: false, wholeWord: false, sessionId: null, count: 'exact', countLimit: 1 })
  })

  it('pauses the content group in regex mode instead of scanning the corpus', async () => {
    let ensured = 0
    let searched = 0
    const nameArgs: SearchArgs[] = []
    const response = await runCombinedSearch(deps({
      ensure: () => { ensured++ },
      contentSearch: async () => { searched++; return contentResult([]) },
      search: async args => { nameArgs.push(args); return result([fileHit('/tmp/a.md')]) },
    }), readCombinedRequest({ query: 'note', matchMode: 'regex' }, 100))
    expect(response.content).toMatchObject({ hits: [], returned: 0, error: 'content-regex-not-supported', warnings: ['content-regex-paused'] })
    expect(ensured).toBe(0)
    expect(searched).toBe(0)
    expect(nameArgs[0]?.regex).toBe(true)
    expect(response.files?.hits).toHaveLength(1)
  })

  it('passes match options and count to the content store and returns per-group counts', async () => {
    const calls: Array<{ query: string; limit: number; options: ContentSearchOptions }> = []
    const response = await runCombinedSearch(deps({
      contentSearch: async (query, limit, options) => {
        calls.push({ query, limit, options })
        return contentResult([contentHit('session', '/tmp/session.log')], { value: 42, kind: 'exact' })
      },
      search: async args => result(args.filesOnly ? [fileHit('/tmp/a.md')] : [dirHit('/tmp/dir')]),
    }), readCombinedRequest({
      query: 'note',
      matchMode: 'extended',
      caseSensitive: true,
      wholeWord: true,
      sessionId: 'session-1',
      count: 'bounded',
      countLimit: 7,
    }, 100))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      query: 'note',
      limit: 30,
      options: { matchMode: 'extended', caseSensitive: true, wholeWord: true, sessionId: 'session-1', count: 'bounded', countLimit: 7 },
    })
    expect(response.content?.count).toEqual({ value: 42, kind: 'exact' })
    expect(response.content?.warnings).toEqual([])
    expect(response.files?.count).toEqual({ value: 1, kind: 'exact' })
    expect(response.dirs?.count).toEqual({ value: 1, kind: 'exact' })
  })

  it('decodes extended escapes for the name engine and drops control characters', async () => {
    const nameArgs: SearchArgs[] = []
    const response = await runCombinedSearch(deps({
      search: async args => { nameArgs.push(args); return result([fileHit('/tmp/a.md')]) },
    }), readCombinedRequest({ query: 'foo\\tbar', matchMode: 'extended', content: false }, 100))
    expect(nameArgs[0]?.query).toBe('foobar')
    expect(response.files?.warnings).toContain('name-extended-control-char')

    const invalid = await runCombinedSearch(deps({
      search: async args => { nameArgs.push(args); return result([]) },
    }), readCombinedRequest({ query: 'bad\\xZZ', matchMode: 'extended', content: false }, 100))
    expect(invalid.files?.error).toBe('invalid-escape')
    expect(invalid.files?.hits).toEqual([])
  })

  it('passes case and whole-word flags to the name engine in normal mode', async () => {
    const nameArgs: SearchArgs[] = []
    await runCombinedSearch(deps({
      search: async args => { nameArgs.push(args); return result([]) },
      contentSearch: async () => contentResult([]),
    }), readCombinedRequest({ query: 'note', caseSensitive: true, wholeWord: true }, 100))
    expect(nameArgs).toHaveLength(2)
    for (const args of nameArgs) {
      expect(args.regex).toBe(false)
      expect(args.caseSensitive).toBe(true)
      expect(args.wholeWord).toBe(true)
    }
  })

  it('passes per-group offsets for load-more', async () => {
    const names: SearchArgs[] = []
    const options: ContentSearchOptions[] = []
    const request = readCombinedRequest({ query: 'note', filesOffset: 50, dirsOffset: 20, contentOffset: 30 }, 100)
    expect(request).toMatchObject({ filesOffset: 50, dirsOffset: 20, contentOffset: 30 })
    await runCombinedSearch(deps({
      search: async args => { names.push(args); return result([]) },
      contentSearch: async (_query, _limit, next) => { options.push(next); return contentResult([]) },
    }), request)
    expect(names.find(args => args.filesOnly)?.offset).toBe(50)
    expect(names.find(args => args.dirsOnly)?.offset).toBe(20)
    expect(options[0]?.offset).toBe(30)
  })

  it('passes content build progress through to the panel', async () => {
    const progress = { phase: 'files' as const, scanned: 12, indexed: 7, total: 100, path: '/tmp/page-1.md', startedAt: 1 }
    const withProgress = deps({
      contentStatus: () => state({ building: true, progress }),
      contentSearch: async () => contentResult([]),
    })
    const queried = await runCombinedSearch(withProgress, readCombinedRequest({ query: 'note', limit: 5 }, 100))
    expect(queried.content).toMatchObject({ building: true, progress })
    const idle = await runCombinedSearch(withProgress, readCombinedRequest({ query: '  ' }, 100))
    expect(idle.content).toMatchObject({ building: true, progress })
  })


  it('restricts hits to an authorized root prefix', async () => {
    const roots = ['/home/user', '/data']
    const contentOptions: ContentSearchOptions[] = []
    const response = await runCombinedSearch(deps({
      roots,
      search: async args => result(args.filesOnly
        ? [fileHit('/home/user/a.md'), fileHit('/data/b.md')]
        : [dirHit('/data/sub'), dirHit('/home/user/docs')]),
      contentSearch: async (_query, _limit, options) => {
        contentOptions.push(options)
        return contentResult([contentHit('file', '/data/c.md')])
      },
      contentStatus: () => state(),
    }), readCombinedRequest({ query: 'note', root: '/data' }, 100))
    expect(response.files?.hits.map(hit => hit.path)).toEqual(['/data/b.md'])
    expect(response.dirs?.hits.map(hit => hit.path)).toEqual(['/data/sub'])
    expect(contentOptions[0]?.pathPrefix).toBe('/data')
    const archived = await runCombinedSearch(deps({
      contentSearch: async (_query, _limit, options) => { contentOptions.push(options); return contentResult([]) },
      contentStatus: () => state(),
    }), readCombinedRequest({ query: 'note', includeArchived: true }, 100))
    expect(archived.content).toBeDefined()
    expect(contentOptions[contentOptions.length - 1]?.includeArchived).toBe(true)
    // A prefix outside every configured root is ignored instead of narrowing.
    const outside = await runCombinedSearch(deps({
      roots,
      search: async () => result([fileHit('/home/user/a.md')]),
    }), readCombinedRequest({ query: 'note', root: '/etc' }, 100))
    expect(outside.files?.hits.map(hit => hit.path)).toEqual(['/home/user/a.md'])
  })


  it('attaches citable evidence refs to content and name hits', async () => {
    const response = await runCombinedSearch(deps({
      contentSearch: async () => contentResult([
        contentHit('file', '/tmp/a.md'),
        contentHit('session', '/tmp/sessions/s1/session.v4.jsonl.zstd'),
      ]),
      search: async args => args.dirsOnly === true ? result([dirHit('/tmp/d')]) : result([fileHit('/tmp/b.md')]),
    }), readCombinedRequest({ query: 'note' }, 100))
    const contentHits = response.content?.hits ?? []
    expect(contentHits[0]?.ref).toMatch(/^ref:\/\/file\?path=%2Ftmp%2Fa\.md/)
    expect(contentHits[1]?.ref).toMatch(/^dsh-session:/)
    const fileHits = response.files?.hits ?? []
    expect(fileHits[0]?.ref).toMatch(/^ref:\/\/file\?path=%2Ftmp%2Fb\.md/)
    expect(fileHits[0]?.ref).toContain('size=10')
    const dirHits = response.dirs?.hits ?? []
    expect(dirHits[0]?.ref).toBeUndefined()
  })

})


/** One name hit built from the current stat of one real file. */
function liveFileHit(path: string): SearchHit {
  const info = statSync(path)
  return { path, name: basename(path), size: info.size, mtime: info.mtimeMs, ext: 'md', dir: false }
}

/** One name hit whose snapshot predates the current bytes. */
function staleFileHit(path: string): SearchHit {
  const info = statSync(path)
  return { path, name: basename(path), size: info.size, mtime: info.mtimeMs - 60_000, ext: 'md', dir: false }
}

describe('combined evidence enrichment', () => {
  it('labels fresh name hits with permissions, ref and a cheap hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-combined-fresh-'))
    const file = join(dir, 'notes.md')
    writeFileSync(file, 'combined evidence body')
    try {
      const response = await runCombinedSearch(deps({
        search: async args => args.filesOnly ? result([liveFileHit(file)]) : result([]),
      }), readCombinedRequest({ query: 'notes' }, 100))
      const hit = response.files?.hits[0]
      expect(hit?.freshness).toMatchObject({ state: 'fresh' })
      expect(typeof hit?.freshness?.observedAt).toBe('number')
      expect(hit?.permissions).toEqual({ read: 'allowed', visibility: 'roots', reason: 'name hit from the configured index roots' })
      expect(hit?.ref).toMatch(/^ref:\/\/file\?path=/)
      expect(hit?.hash).toBe(await sha256File(file))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports stale and missing name hits from the snapshot comparison', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-combined-stale-'))
    const file = join(dir, 'notes.md')
    writeFileSync(file, 'old body')
    try {
      const staleHit = staleFileHit(file)
      const stale = await runCombinedSearch(deps({
        search: async args => args.filesOnly ? result([staleHit]) : result([]),
      }), readCombinedRequest({ query: 'notes' }, 100))
      expect(stale.files?.hits[0]?.freshness).toMatchObject({ state: 'stale' })
      rmSync(file)
      // The fresh-state TTL cache is shared; reset it so the missing stat is real.
      resetCombinedEnrichCache()
      const missing = await runCombinedSearch(deps({
        search: async args => args.filesOnly ? result([staleHit]) : result([]),
      }), readCombinedRequest({ query: 'notes' }, 100))
      expect(missing.files?.hits[0]?.freshness).toMatchObject({ state: 'missing' })
      expect(missing.files?.hits[0]?.permissions?.read).toBe('allowed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('labels directory hits without hashing them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-combined-dir-'))
    const sub = join(dir, 'sub')
    mkdirSync(sub)
    writeFileSync(join(dir, 'placeholder.md'), 'x')
    try {
      const info = statSync(sub)
      const hit: SearchHit = { path: sub, name: basename(sub), size: 0, mtime: info.mtimeMs, ext: '', dir: true }
      const response = await runCombinedSearch(deps({
        search: async args => args.dirsOnly ? result([hit]) : result([]),
      }), readCombinedRequest({ query: 'sub' }, 100))
      const enriched = response.dirs?.hits[0]
      expect(enriched?.freshness).toMatchObject({ state: 'fresh' })
      expect(enriched?.permissions).toEqual({ read: 'allowed', visibility: 'roots', reason: 'directory hit from the configured index roots' })
      expect(enriched?.hash).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives content hits permissions by scope and passes an existing hash through', async () => {
    const hash = 'a'.repeat(64)
    const withHash = { ...contentHit('file', '/tmp/with-hash.md'), hash } as unknown as ContentHit
    const response = await runCombinedSearch(deps({
      contentSearch: async () => contentResult([
        withHash,
        contentHit('session', '/tmp/sessions/s1/session.v4.jsonl.zstd'),
      ]),
      search: async () => result([]),
    }), readCombinedRequest({ query: 'note' }, 100))
    const hits = response.content?.hits ?? []
    expect(hits[0]?.permissions).toEqual({ read: 'allowed', visibility: 'roots', reason: 'content hit from the configured index roots' })
    expect(hits[0]?.hash).toBe(hash)
    expect(hits[0]?.freshness).toMatchObject({ state: 'unknown' })
    expect(hits[1]?.permissions).toEqual({ read: 'allowed', visibility: 'session', reason: 'session messages are scoped to the caller workspace' })
    expect(hits[1]?.ref).toMatch(/^dsh-session:/)
  })

  it('derives content-hit freshness from the optional index snapshot lookup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-combined-content-'))
    const file = join(dir, 'body.md')
    writeFileSync(file, 'content evidence')
    try {
      const info = statSync(file)
      const stale = await runCombinedSearch(deps({
        contentSearch: async () => contentResult([contentHit('file', file)]),
        contentIndexedMtime: () => info.mtimeMs - 5_000,
        search: async () => result([]),
      }), readCombinedRequest({ query: 'content' }, 100))
      expect(stale.content?.hits[0]?.freshness).toMatchObject({ state: 'stale' })
      const fresh = await runCombinedSearch(deps({
        contentSearch: async () => contentResult([contentHit('file', file)]),
        contentIndexedMtime: () => info.mtimeMs,
        search: async () => result([]),
      }), readCombinedRequest({ query: 'content' }, 100))
      expect(fresh.content?.hits[0]?.freshness).toMatchObject({ state: 'fresh' })
      const gone = await runCombinedSearch(deps({
        contentSearch: async () => contentResult([contentHit('file', join(dir, 'gone.md'))]),
        contentIndexedMtime: () => 1,
        search: async () => result([]),
      }), readCombinedRequest({ query: 'content' }, 100))
      expect(gone.content?.hits[0]?.freshness).toMatchObject({ state: 'missing' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caps hashes by file size and per-page count', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-combined-cap-'))
    try {
      const big = join(dir, 'big.md')
      writeFileSync(big, 'x'.repeat(COMBINED_HASH_MAX_BYTES + 1))
      const bigResponse = await runCombinedSearch(deps({
        search: async args => args.filesOnly ? result([liveFileHit(big)]) : result([]),
      }), readCombinedRequest({ query: 'big' }, 100))
      expect(bigResponse.files?.hits[0]?.hash).toBeUndefined()
      expect(bigResponse.files?.hits[0]?.ref).toMatch(/^ref:\/\/file\?path=/)

      const hits: SearchHit[] = []
      for (let index = 0; index < COMBINED_HASH_MAX_HITS + 2; index++) {
        const file = join(dir, 'small-' + String(index) + '.md')
        writeFileSync(file, 'small body ' + String(index))
        hits.push(liveFileHit(file))
      }
      const capped = await runCombinedSearch(deps({
        search: async args => args.filesOnly ? result(hits) : result([]),
      }), readCombinedRequest({ query: 'small', limit: 50 }, 100))
      const hashed = (capped.files?.hits ?? []).filter(hit => hit.hash !== undefined)
      expect(hashed).toHaveLength(COMBINED_HASH_MAX_HITS)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})


describe('evidence limit (0.20.2)', () => {
  function manyHits(): { content: ContentHit[]; files: SearchHit[]; dirs: SearchHit[] } {
    return {
      content: Array.from({ length: 3 }, (_, index) => contentHit('file', '/tmp/content-' + String(index) + '.md')),
      files: Array.from({ length: 12 }, (_, index) => fileHit('/tmp/file-' + String(index) + '.md')),
      dirs: Array.from({ length: 2 }, (_, index) => dirHit('/tmp/dir-' + String(index))),
    }
  }

  function manyDeps(): CombinedDeps {
    const data = manyHits()
    return deps({
      contentSearch: async () => contentResult(data.content),
      search: async args => args.filesOnly ? result(data.files) : result(data.dirs),
    })
  }

  it('keeps evidence on the first N rows in content → files → dirs order', async () => {
    const response = await runCombinedSearch(manyDeps(), readCombinedRequest({ query: 'note', evidenceLimit: 5 }, 100))
    // Three content hits fill 3 of the 5 rows; the next two go to files.
    expect(response.content?.hits.every(hit => hit.freshness !== undefined && hit.permissions !== undefined)).toBe(true)
    expect(response.files?.hits.slice(0, 2).every(hit => hit.freshness !== undefined)).toBe(true)
    const strippedFiles = response.files?.hits.slice(2) ?? []
    expect(strippedFiles.length).toBe(10)
    for (const hit of strippedFiles) {
      expect(hit.freshness).toBeUndefined()
      expect(hit.permissions).toBeUndefined()
      expect(hit.ref).toBeUndefined()
    }
    for (const hit of response.dirs?.hits ?? []) {
      expect(hit.freshness).toBeUndefined()
      expect(hit.ref).toBeUndefined()
    }
    // Counts, totals and truncation are untouched by the evidence policy.
    expect(response.files?.count).toEqual({ value: 12, kind: 'exact' })
    expect(response.files?.returned).toBe(12)
    expect(response.files?.truncated).toBe(false)
    expect(response.dirs?.returned).toBe(2)
    expect(response.content?.returned).toBe(3)
  })

  it('keeps the documented default of 10 rows when the body omits the limit', async () => {
    const response = await runCombinedSearch(manyDeps(), readCombinedRequest({ query: 'note' }, 100))
    expect(response.content?.hits.every(hit => hit.freshness !== undefined)).toBe(true)
    expect(response.files?.hits.slice(0, 7).every(hit => hit.freshness !== undefined)).toBe(true)
    expect(response.files?.hits.slice(7).every(hit => hit.freshness === undefined)).toBe(true)
    expect(response.dirs?.hits.every(hit => hit.freshness === undefined)).toBe(true)
  })

  it('strips every evidence field when the limit is 0, without setting compact', async () => {
    const response = await runCombinedSearch(manyDeps(), readCombinedRequest({ query: 'note', evidenceLimit: 0 }, 100))
    expect(response.compact).toBeUndefined()
    for (const hit of [...(response.content?.hits ?? []), ...(response.files?.hits ?? []), ...(response.dirs?.hits ?? [])]) {
      expect(hit.freshness).toBeUndefined()
      expect(hit.permissions).toBeUndefined()
      expect(hit.hash).toBeUndefined()
      expect(hit.ref).toBeUndefined()
    }
    // The wire shape of a hit (path/title/snippet) stays.
    expect(response.content?.hits[0]?.snippet).toBe('snippet')
    expect(response.files?.hits[0]?.path).toBe('/tmp/file-0.md')
  })

  it('skips evidence enrichment for an empty-query browse page', async () => {
    const response = await runCombinedSearch(deps({
      search: async args => args.filesOnly ? result([fileHit('/tmp/browse.md')]) : result([dirHit('/tmp/browse-dir')]),
    }), readCombinedRequest({ query: '' }, 100))
    const file = response.files?.hits[0]
    // Refs are cheap and stay; stat-derived evidence is never computed.
    expect(file?.ref).toMatch(/^ref:\/\/file\?path=/)
    expect(file?.freshness).toBeUndefined()
    expect(file?.permissions).toBeUndefined()
    expect(response.dirs?.hits[0]?.freshness).toBeUndefined()
  })

  it('enriches only the top rows, so a large page pays a bounded number of stats', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-combined-limit-'))
    try {
      const hits: SearchHit[] = []
      for (let index = 0; index < 20; index++) {
        const file = join(dir, 'limit-' + String(index) + '.md')
        writeFileSync(file, 'body ' + String(index))
        hits.push(liveFileHit(file))
      }
      const response = await runCombinedSearch(deps({
        search: async args => args.filesOnly ? result(hits) : result([]),
      }), readCombinedRequest({ query: 'limit', evidenceLimit: 3 }, 100))
      // The request-level limit bounds the stats: only the first three rows are live.
      expect(response.files?.hits.slice(0, 3).every(hit => hit.freshness?.state === 'fresh')).toBe(true)
      expect(response.files?.hits.slice(3).every(hit => hit.freshness === undefined)).toBe(true)
      expect(response.files?.hits.filter(hit => hit.hash !== undefined)).toHaveLength(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('batched content freshness (0.20.2)', () => {
  it('resolves every file hit with one mtime lookup and sessions per hit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-combined-batch-'))
    const first = join(dir, 'first.md')
    const second = join(dir, 'second.md')
    writeFileSync(first, 'first body')
    writeFileSync(second, 'second body')
    try {
      const firstMtime = statSync(first).mtimeMs
      const secondMtime = statSync(second).mtimeMs
      let batchCalls = 0
      let batchPaths: readonly string[] = []
      let perHitCalls = 0
      const response = await runCombinedSearch(deps({
        contentSearch: async () => contentResult([
          contentHit('file', first),
          contentHit('file', second),
          contentHit('session', '/tmp/sessions/s1/session.v4.jsonl.zstd'),
        ]),
        contentIndexedMtimes: paths => {
          batchCalls++
          batchPaths = paths
          return new Map([[first, firstMtime], [second, secondMtime]])
        },
        contentIndexedMtime: () => {
          perHitCalls++
          return undefined
        },
        search: async () => result([]),
      }), readCombinedRequest({ query: 'body' }, 100))
      expect(batchCalls).toBe(1)
      expect([...batchPaths].sort()).toEqual([first, second].sort())
      // Only the session hit falls back to the per-hit lookup.
      expect(perHitCalls).toBe(1)
      expect(response.content?.hits[0]?.freshness).toMatchObject({ state: 'fresh' })
      expect(response.content?.hits[1]?.freshness).toMatchObject({ state: 'fresh' })
      // The sessions path has no stored row: the fallback keeps it "unknown".
      expect(response.content?.hits[2]?.freshness).toMatchObject({ state: 'unknown' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the per-hit lookup when the store has no batch method', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-combined-batch-fallback-'))
    const file = join(dir, 'one.md')
    writeFileSync(file, 'one body')
    try {
      let perHitCalls = 0
      const response = await runCombinedSearch(deps({
        contentSearch: async () => contentResult([contentHit('file', file)]),
        contentIndexedMtime: () => {
          perHitCalls++
          return statSync(file).mtimeMs
        },
        search: async () => result([]),
      }), readCombinedRequest({ query: 'body' }, 100))
      expect(perHitCalls).toBe(1)
      expect(response.content?.hits[0]?.freshness).toMatchObject({ state: 'fresh' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('async enrichment (0.20.0 P0-9)', () => {
  it('bounds the async mapper and preserves input order', async () => {
    let active = 0
    let peak = 0
    const mapped = await mapLimit([1, 2, 3, 4, 5, 6], 2, async value => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return value * 2
    })
    expect(mapped).toEqual([2, 4, 6, 8, 10, 12])
    expect(peak).toBeLessThanOrEqual(2)
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })

  it('serves repeated enrichment observations from the short TTL cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-combined-ttl-'))
    const file = join(dir, 'cached.md')
    writeFileSync(file, 'cached body')
    try {
      const hit = liveFileHit(file)
      const first = await runCombinedSearch(deps({
        search: async args => args.filesOnly ? result([hit]) : result([]),
      }), readCombinedRequest({ query: 'cached' }, 100))
      expect(first.files?.hits[0]?.freshness).toMatchObject({ state: 'fresh' })
      rmSync(file)
      // Inside the TTL the cached stat still answers fresh: that is the latency
      // win, and it bounds staleness to COMBINED_ENRICH_CACHE_TTL_MS.
      expect(COMBINED_ENRICH_CACHE_TTL_MS).toBeGreaterThan(0)
      const cached = await runCombinedSearch(deps({
        search: async args => args.filesOnly ? result([hit]) : result([]),
      }), readCombinedRequest({ query: 'cached' }, 100))
      expect(cached.files?.hits[0]?.freshness).toMatchObject({ state: 'fresh' })
      // With the cache disabled the real (now missing) stat shows through.
      const real = await runCombinedSearch(deps({
        search: async args => args.filesOnly ? result([hit]) : result([]),
      }), readCombinedRequest({ query: 'cached' }, 100), { cacheTtlMs: 0 })
      expect(real.files?.hits[0]?.freshness).toMatchObject({ state: 'missing' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips hashing on paths the caller marks as slow (9p/network)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-combined-slow-'))
    const file = join(dir, 'slow.md')
    writeFileSync(file, 'slow filesystem body')
    try {
      const response = await runCombinedSearch(deps({
        search: async args => args.filesOnly ? result([liveFileHit(file)]) : result([]),
      }), readCombinedRequest({ query: 'slow' }, 100), { skipHash: path => path === file })
      expect(response.files?.hits[0]?.hash).toBeUndefined()
      expect(response.files?.hits[0]?.freshness).toMatchObject({ state: 'fresh' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('classifies UNC shares as slow and local temp paths as fast', () => {
    if (process.platform === 'win32') {
      expect(isSlowFilesystemPath('\\\\server\\share\\x.md')).toBe(true)
    } else if (process.platform === 'linux') {
      expect(isSlowFilesystemPath(join(tmpdir(), 'locator-definitely-local'))).toBe(false)
    }
  })

  it('detects the real 9p mounts of this machine (skipped when there are none)', () => {
    if (process.platform !== 'linux') return
    let mountPoints: string[] = []
    try {
      mountPoints = readFileSync('/proc/self/mounts', 'utf8')
        .split('\n')
        .map(line => line.split(' '))
        .filter(parts => parts[2] === '9p')
        .map(parts => (parts[1] ?? '').replace(/\\040/g, ' '))
        .filter(point => point !== '' && point !== '/')
    } catch {
      return
    }
    for (const mountPoint of mountPoints) {
      expect(isSlowFilesystemPath(mountPoint + '/definitely-not-real')).toBe(true)
    }
  })

  it('reports the store query time as content.tookMs, not the enrichment time', async () => {
    const response = await runCombinedSearch(deps({
      contentSearch: async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
        return contentResult([])
      },
    }), readCombinedRequest({ query: 'note' }, 100))
    expect(response.content?.tookMs).toBeGreaterThanOrEqual(20)
    // The name group keeps the engine-reported (not wall-clock) time.
    expect(response.files?.tookMs).toBe(1)
  })

  it('propagates an aborted content query instead of degrading the group', async () => {
    const controller = new AbortController()
    const pending = runCombinedSearch(deps({
      contentSearch: async () => await new Promise((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')))
      }),
    }), readCombinedRequest({ query: 'note' }, 100), { signal: controller.signal })
    controller.abort()
    let caught: unknown
    try {
      await pending
    } catch (error) {
      caught = error
    }
    expect(isAbortError(caught)).toBe(true)
    expect(isAbortError(new Error('plain'))).toBe(false)
  })
})

describe('compact mode (P1)', () => {
  it('strips every evidence field and keeps the structural wire fields', async () => {
    const response = await runCombinedSearch(deps({
      contentSearch: async () => contentResult([contentHit('file', '/tmp/a.md')]),
      search: async args => args.filesOnly ? result([fileHit('/tmp/b.md')]) : result([dirHit('/tmp/d')]),
    }), readCombinedRequest({ query: 'note', compact: true }, 100))
    expect(response.compact).toBe(true)
    const content = response.content?.hits[0] as unknown as Record<string, unknown>
    expect(content.ref).toBeUndefined()
    expect(content.freshness).toBeUndefined()
    expect(content.permissions).toBeUndefined()
    expect(content.hash).toBeUndefined()
    expect(content.snippet).toBe('snippet')
    expect(content.path).toBe('/tmp/a.md')
    const file = response.files?.hits[0] as unknown as Record<string, unknown>
    expect(file.path).toBe('/tmp/b.md')
    expect(file.ref).toBeUndefined()
    expect(file.freshness).toBeUndefined()
    expect(file.permissions).toBeUndefined()
    const dir = response.dirs?.hits[0] as unknown as Record<string, unknown>
    expect(dir.path).toBe('/tmp/d')
    expect(dir.ref).toBeUndefined()
    // Counts and paging metadata stay identical to full mode.
    expect(response.files?.count).toEqual({ value: 1, kind: 'exact' })
    expect(response.files?.returned).toBe(1)
    expect(response.content?.returned).toBe(1)
    expect(response.content?.count).toEqual({ value: 1, kind: 'exact' })
    expect(typeof response.tookMs).toBe('number')
  })

  it('accepts the true/1/"1" spellings and defaults to full mode', () => {
    expect(readCombinedRequest({ query: 'x', compact: true }, 100).compact).toBe(true)
    expect(readCombinedRequest({ query: 'x', compact: 1 }, 100).compact).toBe(true)
    expect(readCombinedRequest({ query: 'x', compact: '1' }, 100).compact).toBe(true)
    expect(readCombinedRequest({ query: 'x', compact: false }, 100).compact).toBe(false)
    expect(readCombinedRequest({ query: 'x', compact: 'yes' }, 100).compact).toBe(false)
    expect(readCombinedRequest({ query: 'x' }, 100).compact).toBe(false)
  })

  it('skips stats/hashes entirely, so even a huge page stays evidence-free', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-combined-compact-'))
    try {
      const hits: SearchHit[] = []
      for (let index = 0; index < 10; index++) {
        const file = join(dir, 'c' + String(index) + '.md')
        writeFileSync(file, 'body ' + String(index))
        hits.push(liveFileHit(file))
      }
      const response = await runCombinedSearch(deps({
        search: async args => args.filesOnly ? result(hits) : result([]),
      }), readCombinedRequest({ query: 'c', compact: true, limit: 10 }, 100))
      expect(response.files?.hits).toHaveLength(10)
      for (const hit of response.files?.hits ?? []) {
        expect(hit.hash).toBeUndefined()
        expect(hit.freshness).toBeUndefined()
        expect(hit.ref).toBeUndefined()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('combined character budget (P0-15)', () => {
  function groups(): { content: ContentHit[]; files: SearchHit[]; dirs: SearchHit[] } {
    return {
      content: Array.from({ length: 5 }, (_, index) => contentHit('file', '/tmp/content-' + String(index) + '.md')),
      files: Array.from({ length: 5 }, (_, index) => fileHit('/tmp/file-' + String(index) + '.md')),
      dirs: Array.from({ length: 5 }, (_, index) => dirHit('/tmp/dir-' + String(index))),
    }
  }

  function budgetDeps(): CombinedDeps {
    const data = groups()
    return deps({
      contentSearch: async () => contentResult(data.content),
      search: async args => args.filesOnly ? result(data.files) : result(data.dirs),
    })
  }

  it('is absent by default and trims lowest-priority groups first when enabled', async () => {
    const unbudgeted = await runCombinedSearch(budgetDeps(), readCombinedRequest({ query: 'note' }, 100))
    expect(unbudgeted.budget).toBeUndefined()

    // A budget that exactly fits the content group: everything in dirs/files has
    // to go, while the (heaviest, most valuable) content group stays intact.
    const hitSize = (hits: readonly unknown[]): number => hits.reduce<number>((total, hit) => total + JSON.stringify(hit).length + 1, 0)
    const fullSize = JSON.stringify(unbudgeted).length
    const trimmedSize = hitSize(unbudgeted.dirs?.hits ?? []) + hitSize(unbudgeted.files?.hits ?? [])
    const limitChars = fullSize - trimmedSize + 200
    const budgeted = await runCombinedSearch(budgetDeps(), readCombinedRequest({ query: 'note' }, 100), { budgetChars: limitChars })
    expect(budgeted.budget).toBeDefined()
    expect(budgeted.budget?.limitChars).toBe(limitChars)
    expect(budgeted.budget?.dropped).toBeGreaterThan(0)
    expect(budgeted.budget?.truncated).toBe(true)
    expect(budgeted.budget?.usedChars).toBeGreaterThan(0)
    // Directories are the first group to shrink; content survives intact at
    // this budget because it is the most valuable group.
    expect(budgeted.dirs?.hits.length).toBeLessThan(5)
    expect(budgeted.dirs?.returned).toBe(budgeted.dirs?.hits.length)
    expect(budgeted.dirs?.truncated).toBe(true)
    expect(budgeted.content?.hits).toHaveLength(5)
    // The trimmed response is really smaller than the untrimmed one.
    expect(JSON.stringify(budgeted).length).toBeLessThan(JSON.stringify(unbudgeted).length)
  })

  it('keeps structural fields (counts, state, warnings) while trimming hits', async () => {
    const budgeted = await runCombinedSearch(budgetDeps(), readCombinedRequest({ query: 'note' }, 100), { budgetChars: 900 })
    expect(budgeted.files?.count).toEqual({ value: 5, kind: 'exact' })
    expect(budgeted.dirs?.count).toEqual({ value: 5, kind: 'exact' })
    expect(budgeted.content?.count).toEqual({ value: 5, kind: 'exact' })
    expect(budgeted.content?.warnings).toEqual([])
    expect(budgeted.contentEnabled).toBe(true)
  })
})
