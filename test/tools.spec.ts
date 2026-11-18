/**
 * Tool-level safety: locator_export target authorization / atomic replace /
 * ownership marker, locator_rebuild scope narrowing, and the canonical path
 * helpers shared by the reveal/open routes (realpath + symlink containment,
 * executable-open refusal).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { LocatorRuntime, SearchHit } from '../src/runtime.ts'
import {
  DEFAULT_EXPORT_NAME,
  EXPORT_DB_USER_VERSION,
  isOwnExportDatabase,
  makeExportTool,
  resolveExportTarget,
  type SqliteModuleLike,
} from '../src/export.ts'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ContentHit, ContentIndex, ContentState } from '../src/content.ts'
import { makeExploreTool, exploreQueries } from '../src/explore.ts'
import { makeFindTool } from '../src/find.ts'
import {
  applyOutputBudget,
  compileGlobMatcher,
  matchesAnyGlob,
  parseCommandLine,
  rerankHits,
  runOcrCommand,
  Scope,
  scopeFromConfig,
  validateExternalCommand,
} from '../src/scope.ts'
import { makeOutlineTool, makeRebuildTool, makeRepoMapTool, makeSearchTool, makeStatusTool, makeSymbolTool, validateRebuildArguments } from '../src/tools.ts'
import {
  executableFileRejection,
  resolveWithinRoots,
  withinRoots,
} from '../src/reveal.ts'

const sqlite = { DatabaseSync } as unknown as SqliteModuleLike

interface DumpEntry {
  path: string
  name: string
  size: number
  mtime: number
  ext: string
  dir: boolean
}

interface ExportCallCounts {
  started: number
  dumps: number
}

function fakeExportRuntime(
  stateDir: string,
  entries: readonly DumpEntry[],
  options: { fail?: boolean } = {},
): { runtime: LocatorRuntime; calls: ExportCallCounts } {
  const calls: ExportCallCounts = { started: 0, dumps: 0 }
  const runtime = {
    stateDir,
    roots: [],
    status: { running: false },
    config: { maxResults: 100, excludes: [] },
    start() {
      calls.started++
    },
    async dump(after: number, limit: number) {
      calls.dumps++
      if (options.fail === true) throw new Error('dump exploded')
      const page = entries.slice(after, after + limit)
      const next = after + page.length
      return { entries: page, next, done: next >= entries.length }
    },
  } as unknown as LocatorRuntime
  return { runtime, calls }
}

function fakeExec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext
}

function searchHit(path: string, overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    path,
    name: path.split('/').pop() ?? path,
    size: 12,
    mtime: 1_700_000_000_000,
    ext: (path.split('.').pop() ?? ''),
    dir: false,
    ...overrides,
  }
}

/** Minimal fake runtime for name-index tool tests. */
function fakeSearchRuntime(roots: readonly string[], hits: SearchHit[], total = hits.length): LocatorRuntime {
  return {
    roots: [...roots],
    config: { maxResults: 100, outputBudgetChars: 8000, excludes: [] },
    status: { running: true },
    stateDir: '/tmp/state',
    binary: '/tmp/indexd',
    start: () => {},
    engineStatus: async () => undefined,
    async search(args: { offset: number; limit: number }) {
      const page = hits.slice(args.offset, args.offset + args.limit)
      return { total, returned: page.length, offset: args.offset, truncated: total > args.offset + page.length, tookNs: 1_500_000, hits: page }
    },
  } as unknown as LocatorRuntime
}

function contentState(overrides: Partial<ContentState> = {}): ContentState {
  return { building: false, files: 1, sessions: 0, messages: 0, truncated: false, updatedAt: 1, error: '', warnings: [], ...overrides }
}

/** Minimal fake content index; captures the options passed to search. */
function fakeContent(hits: ContentHit[], calls: Array<{ query: string; limit: number; options: Record<string, unknown> }> = []): ContentIndex {
  return {
    status: () => contentState(),
    authorizedSessionIds: () => new Set(['caller-session']),
    indexedMtime: () => undefined,
    sessionEventRefs: () => new Map(),
    async search(query: string, limit: number, options: Record<string, unknown>) {
      calls.push({ query, limit, options })
      return { hits, count: { value: hits.length, kind: 'exact' as const }, warnings: [] }
    },
  } as unknown as ContentIndex
}

function contentHit(path: string, overrides: Partial<ContentHit> = {}): ContentHit {
  return {
    kind: 'file',
    path,
    title: path.split('/').pop() ?? path,
    snippet: 'body text around the match',
    line: 2,
    score: 1,
    ...overrides,
  }
}

function entry(path: string): DumpEntry {
  return {
    path,
    name: path.split('/').pop() ?? path,
    size: 1,
    mtime: 1_700_000_000_000,
    ext: '',
    dir: false,
  }
}

const cleanups: Array<() => void> = []
afterAll(() => {
  for (const cleanup of cleanups.reverse()) cleanup()
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return join(realpathSync.native(dirname(path)), basename(path))
  }
}

function samePath(path: string | undefined): string | undefined {
  return path === undefined ? undefined : canonical(path).toLowerCase()
}

describe('canonical path containment', () => {
  it('authorizes the root, existing descendants and not-yet-existing descendants', () => {
    const root = tempDir('locator-path-root-')
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'report.pdf'), 'x')
    expect(withinRoots(root, [root])).toBe(true)
    expect(samePath(resolveWithinRoots(join(root, 'docs', 'report.pdf'), [root])?.path)).toBe(samePath(join(root, 'docs', 'report.pdf')))
    const future = resolveWithinRoots(join(root, 'docs', 'later.txt'), [root])
    expect(future?.exists).toBe(false)
    expect(samePath(future?.path)).toBe(samePath(join(root, 'docs', 'later.txt')))
  })

  it('rejects prefix siblings, parent escapes and relative paths', () => {
    const root = tempDir('locator-path-root-')
    expect(withinRoots(`${root}-other`, [root])).toBe(false)
    expect(withinRoots(join(root, '..', 'elsewhere'), [root])).toBe(false)
    expect(withinRoots('relative/file.txt', [root])).toBe(false)
    expect(withinRoots('', [root])).toBe(false)
  })

  it('rejects a symlink whose real target leaves the root', () => {
    const root = tempDir('locator-path-root-')
    const outside = tempDir('locator-path-outside-')
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'nope')
    const link = join(root, 'innocent.txt')
    try {
      symlinkSync(secret, link, 'file')
    } catch {
      return // Symlinks require privileges on some Windows runners.
    }
    expect(withinRoots(link, [root])).toBe(false)
    expect(resolveWithinRoots(link, [root])).toBeUndefined()
    // The same file is fine when the root really contains it.
    expect(samePath(resolveWithinRoots(secret, [outside])?.path)).toBe(samePath(secret))
  })

  it('rejects a symlinked parent directory that leaves the root', () => {
    const root = tempDir('locator-path-root-')
    const outside = tempDir('locator-path-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    const link = join(root, 'linked-dir')
    try {
      symlinkSync(outside, link, 'dir')
    } catch {
      return
    }
    expect(withinRoots(join(link, 'secret.txt'), [root])).toBe(false)
    expect(withinRoots(join(link, 'not-there-yet.txt'), [root])).toBe(false)
  })

})

describe('executable open refusal', () => {
  it('refuses launchers and scripts case-insensitively', () => {
    for (const name of ['a.exe', 'a.BAT', 'a.cmd', 'a.ps1', 'a.sh', 'a.desktop', 'a.APP', 'a.vbs', 'a.jar']) {
      expect(executableFileRejection(`/tmp/${name}`), name).toBeDefined()
    }
  })

  it('allows ordinary documents', () => {
    for (const name of ['report.pdf', 'notes.md', 'photo.PNG', 'data.csv', 'archive.zip', 'noext']) {
      expect(executableFileRejection(`/tmp/${name}`), name).toBeUndefined()
    }
  })

  it('refuses an executable permission bit on Unix', () => {
    if (process.platform === 'win32') {
      expect(executableFileRejection('/tmp/tool', 0o100755)).toBeUndefined()
      return
    }
    expect(executableFileRejection('/tmp/tool', 0o100755)).toBeDefined()
    expect(executableFileRejection('/tmp/tool', 0o100644)).toBeUndefined()
  })
})

describe('locator_rebuild scope narrowing', () => {
  const configuredRoots = (): string[] => [tempDir('locator-rebuild-root-')]
  const configuredExcludes = ['node_modules', '.git']

  it('accepts configured roots and nested directories, canonicalized', () => {
    const root = configuredRoots()[0]!
    mkdirSync(join(root, 'src'))
    const canonicalRoot = resolveWithinRoots(root, [root])?.path
    const canonicalSrc = resolveWithinRoots(join(root, 'src'), [root])?.path
    const result = validateRebuildArguments([root, join(root, 'src')], undefined, [root], configuredExcludes)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.roots).toEqual([canonicalRoot, canonicalSrc])
    expect(result.excludes).toBeUndefined()
  })

  it('rejects roots outside the configured set', () => {
    const root = configuredRoots()[0]!
    const outside = tempDir('locator-rebuild-outside-')
    const outsideResult = validateRebuildArguments([outside], undefined, [root], configuredExcludes)
    expect(outsideResult).toMatchObject({ ok: false })
    const siblingResult = validateRebuildArguments([`${root}-sibling`], undefined, [root], configuredExcludes)
    expect(siblingResult).toMatchObject({ ok: false })
  })

  it('rejects a symlinked root that resolves outside the configured set', () => {
    const root = configuredRoots()[0]!
    const outside = tempDir('locator-rebuild-outside-')
    const link = join(root, 'escape')
    try {
      symlinkSync(outside, link, 'dir')
    } catch {
      return
    }
    const result = validateRebuildArguments([link], undefined, [root], configuredExcludes)
    expect(result).toMatchObject({ ok: false })
  })

  it('rejects malformed root lists', () => {
    expect(validateRebuildArguments([], undefined, ['/tmp'], configuredExcludes)).toMatchObject({ ok: false })
    expect(validateRebuildArguments([''], undefined, ['/tmp'], configuredExcludes)).toMatchObject({ ok: false })
  })

  it('only accepts configured excludes', () => {
    expect(validateRebuildArguments(undefined, ['node_modules'], ['/tmp'], configuredExcludes)).toMatchObject({
      ok: true,
      excludes: ['node_modules'],
    })
    expect(validateRebuildArguments(undefined, ['custom-cache'], ['/tmp'], configuredExcludes)).toMatchObject({ ok: false })
    expect(validateRebuildArguments(undefined, [''], ['/tmp'], configuredExcludes)).toMatchObject({ ok: false })
  })

  it('does not reach the engine when the requested scope is widened', async () => {
    const root = configuredRoots()[0]!
    const outside = tempDir('locator-rebuild-outside-')
    let rebuilds = 0
    const runtime = {
      roots: [root],
      config: { excludes: configuredExcludes, maxResults: 100 },
      start: () => {},
      async rebuild() {
        rebuilds++
        return { started: true }
      },
    } as unknown as LocatorRuntime
    const tool = makeRebuildTool(runtime)
    const value = await tool.execute({ roots: [outside] }, fakeExec()) as { ok: boolean; error?: string }
    expect(value.ok).toBe(false)
    expect(String(value.error)).toContain('outside the configured roots')
    expect(rebuilds).toBe(0)
  })
})

describe('locator_export target authorization', () => {
  it('defaults to the state directory and accepts in-scope paths', () => {
    const state = tempDir('locator-export-state-')
    // Relative paths inside an existing state directory are canonicalized, so
    // compare against the real path (tmpdir itself can be a symlink on macOS).
    const canonicalState = resolveWithinRoots(state, [state])?.path ?? state
    expect(resolveExportTarget(undefined, state, false)).toEqual({ ok: true, path: join(state, DEFAULT_EXPORT_NAME) })
    expect(resolveExportTarget('', state, false)).toEqual({ ok: true, path: join(state, DEFAULT_EXPORT_NAME) })
    expect(resolveExportTarget('out.sqlite', state, false)).toEqual({ ok: true, path: join(canonicalState, 'out.sqlite') })
    const absolute = join(state, 'nested', 'out.sqlite')
    expect(resolveExportTarget(absolute, state, false)).toEqual({ ok: true, path: join(canonicalState, 'nested', 'out.sqlite') })
  })

  it('refuses absolute paths outside the state directory unless explicitly allowed', () => {
    const state = tempDir('locator-export-state-')
    const outside = tempDir('locator-export-outside-')
    const target = join(outside, 'index.sqlite')
    const refused = resolveExportTarget(target, state, false)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error).toContain('state directory')
    expect(resolveExportTarget(target, state, true)).toEqual({ ok: true, path: target })
  })

  it('refuses a relative path that escapes the state directory', () => {
    const state = tempDir('locator-export-state-')
    expect(resolveExportTarget('../escape.sqlite', state, false)).toMatchObject({ ok: false })
    expect(resolveExportTarget(join('..', 'escape.sqlite'), state, false)).toMatchObject({ ok: false })
  })
})

describe('locator_export database ownership marker', () => {
  it('recognizes a database this tool creates', () => {
    const dir = tempDir('locator-export-own-')
    const target = join(dir, 'own.sqlite')
    const db = new DatabaseSync(target)
    db.exec(`CREATE TABLE entries (path TEXT PRIMARY KEY, name TEXT NOT NULL, dir INTEGER NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, ext TEXT NOT NULL) WITHOUT ROWID`)
    db.exec(`PRAGMA user_version = ${String(EXPORT_DB_USER_VERSION)}`)
    db.close()
    expect(isOwnExportDatabase(sqlite, target)).toBe(true)
  })

  it('refuses arbitrary SQLite files, wrong schemas and non-SQLite data', () => {
    const dir = tempDir('locator-export-foreign-')
    const unmarked = join(dir, 'unmarked.sqlite')
    const db = new DatabaseSync(unmarked)
    db.exec('CREATE TABLE entries (path TEXT PRIMARY KEY)')
    db.close()
    expect(isOwnExportDatabase(sqlite, unmarked)).toBe(false)

    const wrongSchema = join(dir, 'wrong-schema.sqlite')
    const other = new DatabaseSync(wrongSchema)
    other.exec('CREATE TABLE something_else (x INTEGER)')
    other.exec(`PRAGMA user_version = ${String(EXPORT_DB_USER_VERSION)}`)
    other.close()
    expect(isOwnExportDatabase(sqlite, wrongSchema)).toBe(false)

    const text = join(dir, 'notes.txt')
    writeFileSync(text, 'not a database')
    expect(isOwnExportDatabase(sqlite, text)).toBe(false)
    expect(isOwnExportDatabase(sqlite, join(dir, 'missing.sqlite'))).toBe(false)
  })
})

describe('locator_export execution', () => {
  const entries: DumpEntry[] = [
    entry('/a/report.pdf'),
    entry('/a/notes.md'),
    entry('/a/main.go'),
  ]

  it('writes an atomic export inside the state directory', async () => {
    const state = tempDir('locator-export-state-')
    const { runtime } = fakeExportRuntime(state, entries)
    const tool = makeExportTool(runtime)
    const value = await tool.execute({}, fakeExec()) as { ok: boolean; rows?: number; error?: string }
    expect(value.ok, value.error).toBe(true)
    expect(value.rows).toBe(3)
    const target = join(state, DEFAULT_EXPORT_NAME)
    expect(existsSync(target)).toBe(true)
    // No temporary sibling may be left behind.
    expect(readdirSync(state).filter(name => name.endsWith('.tmp'))).toEqual([])
    const db = new DatabaseSync(target, { readOnly: true })
    try {
      expect((db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c).toBe(3)
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(EXPORT_DB_USER_VERSION)
    } finally {
      db.close()
    }
  })

  it('refuses to write outside the state directory without the explicit opt-in', async () => {
    const state = tempDir('locator-export-state-')
    const outside = tempDir('locator-export-outside-')
    const { runtime, calls } = fakeExportRuntime(state, entries)
    const tool = makeExportTool(runtime)
    const target = join(outside, 'index.sqlite')
    const value = await tool.execute({ path: target }, fakeExec()) as { ok: boolean; error?: string }
    expect(value.ok).toBe(false)
    expect(String(value.error)).toContain('state directory')
    expect(calls.started).toBe(0)
    expect(existsSync(target)).toBe(false)
  })

  it('writes outside only when allowOutsideStateDir is explicitly true', async () => {
    const state = tempDir('locator-export-state-')
    const outside = tempDir('locator-export-outside-')
    const { runtime } = fakeExportRuntime(state, entries)
    const tool = makeExportTool(runtime)
    const target = join(outside, 'index.sqlite')
    const value = await tool.execute({ path: target, allowOutsideStateDir: true }, fakeExec()) as {
      ok: boolean
      rows?: number
      error?: string
    }
    expect(value.ok, value.error).toBe(true)
    expect(value.rows).toBe(3)
    expect(existsSync(target)).toBe(true)
  })

  it('never overwrites a file this tool did not create', async () => {
    const state = tempDir('locator-export-state-')
    const target = join(state, 'foreign.sqlite')
    const db = new DatabaseSync(target)
    db.exec('CREATE TABLE keep_me (value TEXT)')
    db.exec("INSERT INTO keep_me VALUES ('precious')")
    db.close()
    const { runtime } = fakeExportRuntime(state, entries)
    const tool = makeExportTool(runtime)
    const value = await tool.execute({ path: 'foreign.sqlite', overwrite: true }, fakeExec()) as { ok: boolean; error?: string }
    expect(value.ok).toBe(false)
    expect(String(value.error)).toContain('not a database created by locator_export')
    const check = new DatabaseSync(target, { readOnly: true })
    try {
      expect((check.prepare('SELECT value FROM keep_me').get() as { value: string }).value).toBe('precious')
    } finally {
      check.close()
    }
  })

  it('refuses overwrite without the flag and then replaces its own database atomically', async () => {
    const state = tempDir('locator-export-state-')
    const first = fakeExportRuntime(state, entries)
    const tool = makeExportTool(first.runtime)
    expect((await tool.execute({ path: 'mirror.sqlite' }, fakeExec()) as { ok: boolean }).ok).toBe(true)
    const refused = await tool.execute({ path: 'mirror.sqlite' }, fakeExec()) as { ok: boolean }
    expect(refused.ok).toBe(false)

    const second = fakeExportRuntime(state, entries.slice(0, 1))
    const replaced = await makeExportTool(second.runtime).execute({ path: 'mirror.sqlite', overwrite: true }, fakeExec()) as {
      ok: boolean
      rows?: number
    }
    expect(replaced.ok).toBe(true)
    expect(replaced.rows).toBe(1)
    const db = new DatabaseSync(join(state, 'mirror.sqlite'), { readOnly: true })
    try {
      expect((db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c).toBe(1)
    } finally {
      db.close()
    }
  })

  it('leaves no partial file or temp database when the dump fails', async () => {
    const state = tempDir('locator-export-state-')
    const { runtime } = fakeExportRuntime(state, entries, { fail: true })
    const tool = makeExportTool(runtime)
    const value = await tool.execute({ path: 'broken.sqlite' }, fakeExec()) as { ok: boolean; error?: string }
    expect(value.ok).toBe(false)
    expect(String(value.error)).toContain('dump exploded')
    expect(existsSync(join(state, 'broken.sqlite'))).toBe(false)
    expect(readdirSync(state)).toEqual([])
  })

  it('reports the content index and validates its declared schema', async () => {
    const contentState = {
      building: true,
      files: 2,
      sessions: 1,
      messages: 3,
      truncated: false,
      error: '',
      warnings: [],
      updatedAt: 1,
      fullIndex: true,
      reasoningIndex: true,
      refs: { total: 7, byKind: { url: 4, spill: 2, attachment: 1 } },
      progress: { phase: 'files' as const, scanned: 5, indexed: 2, total: 10, path: '/tmp/a.md', startedAt: 1 },
    }
    const runtime = {
      start: () => {},
      status: { running: true },
      roots: ['/tmp'],
      stateDir: '/tmp/state',
      binary: '/tmp/indexd',
      engineStatus: async () => ({
        version: '0.11.6', platform: 'linux/amd64', roots: ['/tmp'], entries: 1, files: 1, dirs: 0,
        nameBytes: 1, deleted: 0, watching: true, scanning: false, usn: false, uptimeSec: 1, stateDir: '/tmp/state',
      }),
    } as unknown as LocatorRuntime
    const content = { status: () => contentState } as unknown as ContentIndex
    const tool = makeStatusTool(runtime, content)
    const value = await tool.execute({}, fakeExec())
    expect(value).toMatchObject({ content: { enabled: true, ...contentState } })
    const schema = tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, value)).toEqual([])
    const text = tool.output.render({}, value as never).map(block => (block as { text?: string }).text ?? '').join('\n')
    expect(text).toContain('building: files 5 / 10 scanned')
    expect(text).toContain('refs: 7 (url 4, spill 2, attachment 1)')
  })

  it('keeps locator_status valid when the content index is disabled', async () => {
    const runtime = {
      start: () => {},
      status: { running: true },
      roots: ['/tmp'],
      stateDir: '/tmp/state',
      binary: '/tmp/indexd',
      engineStatus: async () => undefined,
    } as unknown as LocatorRuntime
    const tool = makeStatusTool(runtime)
    const value = await tool.execute({}, fakeExec())
    const schema = tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, value)).toEqual([])
    expect((value as { content?: unknown }).content).toBeUndefined()
  })

})

describe('scope globs and layered ignore semantics', () => {
  it('matches basenames at any depth, directory segments and path suffixes', () => {
    expect(matchesAnyGlob('/a/b/x.log', ['*.log'], { caseInsensitive: false })).toBe(true)
    expect(matchesAnyGlob('/a/b/x.txt', ['*.log'], { caseInsensitive: false })).toBe(false)
    expect(matchesAnyGlob('/a/node_modules/pkg/x.js', ['node_modules'])).toBe(true)
    expect(matchesAnyGlob('/a/build/x/y.js', ['build/**'])).toBe(true)
    expect(matchesAnyGlob('/a/buildx/x.js', ['build/**'])).toBe(false)
    expect(matchesAnyGlob('/home/u/secret/x', ['/home/u/secret/**'])).toBe(true)
    expect(matchesAnyGlob('/other/secret/x', ['/home/u/secret/**'])).toBe(false)
  })

  it('supports ?, character classes, paths with backslashes and negation order', () => {
    expect(matchesAnyGlob('/a/note1.md', ['note?.md'], { caseInsensitive: false })).toBe(true)
    expect(matchesAnyGlob('/a/note12.md', ['note?.md'], { caseInsensitive: false })).toBe(false)
    expect(matchesAnyGlob('/a/x1.txt', ['x[0-9].txt'], { caseInsensitive: false })).toBe(true)
    expect(matchesAnyGlob('C:\\work\\tmp\\x.bin', ['tmp'], { caseInsensitive: false })).toBe(true)
    const matcher = compileGlobMatcher(['*.log', '!keep.log'], { caseInsensitive: false })
    expect(matcher('/a/other.log')).toBe(true)
    expect(matcher('/a/keep.log')).toBe(false)
  })

  it('keeps the three layers independent', () => {
    const scope = new Scope({ notSearchable: ['*.secret'], notReadable: ['private/**'], notIndexed: ['*.tmp'] }, false)
    expect(scope.isSearchable('/a/x.secret')).toBe(false)
    expect(scope.isReadable('/a/private/notes.md')).toBe(false)
    expect(scope.isIndexable('/a/x.tmp')).toBe(false)
    expect(scope.contentVisible('/a/x.secret')).toBe(false)
    expect(scope.contentVisible('/a/ok.md')).toBe(true)
    // A notReadable path may still be named, but not read.
    expect(scope.filterSearchable([{ path: '/a/private/n.md' }]).hits).toHaveLength(1)
    expect(scope.readability('/a/private/n.md')).toMatchObject({ read: 'denied' })
    const filtered = scope.filterContent([
      { path: '/a/x.secret' },
      { path: '/a/private/n.md' },
      { path: '/a/x.tmp' },
      { path: '/a/ok.md' },
    ])
    expect(filtered.hits.map(hit => hit.path)).toEqual(['/a/ok.md'])
    expect(filtered.dropped).toBe(3)
    expect(filtered.layers.sort()).toEqual(['indexed', 'readable', 'searchable'])
    expect(scope.describe().activeRules).toBe(3)
    expect(scopeFromConfig({}).describe().activeRules).toBe(0)
  })
})

describe('result budget', () => {
  it('trims hits to the character cap but always keeps the first one', () => {
    const items = [{ path: '/a', snippet: 'x'.repeat(100) }, { path: '/b', snippet: 'y'.repeat(100) }, { path: '/c' }]
    const trimmed = applyOutputBudget(items, 260)
    expect(trimmed.items.length).toBe(2)
    expect(trimmed.budget.truncated).toBe(true)
    expect(trimmed.budget.dropped).toBe(1)
    const tiny = applyOutputBudget(items, 10)
    expect(tiny.items).toHaveLength(1)
    expect(tiny.budget.truncated).toBe(true)
    expect(applyOutputBudget(items, 0).budget.truncated).toBe(false)
  })
})

describe('external command hooks', () => {
  const reverseScript = 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const q=JSON.parse(d);process.stdout.write(JSON.stringify({order:q.hits.map((_,i)=>q.hits.length-1-i)}))})'
  const nodeCommand = (script: string) => JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(script)

  it('splits a command line without a shell and rejects unbalanced quotes', () => {
    expect(parseCommandLine('"/opt/my tool/bin" --flag "a b"')).toEqual({ file: '/opt/my tool/bin', args: ['--flag', 'a b'] })
    expect(parseCommandLine('C:\\tools\\x.exe --flag')).toEqual({ file: 'C:\\tools\\x.exe', args: ['--flag'] })
    expect(parseCommandLine('"unclosed')).toBeUndefined()
    expect(validateExternalCommand('')).toBeUndefined()
    expect(validateExternalCommand('"unclosed')).toContain('unbalanced')
  })

  it('reorders hits through the rerank protocol and fails open', async () => {
    const hits = [{ path: '/a' }, { path: '/b' }, { path: '/c' }]
    const reordered = await rerankHits(nodeCommand(reverseScript), 'q', hits)
    expect(reordered.warnings).toEqual([])
    expect(reordered.hits.map(hit => hit.path)).toEqual(['/c', '/b', '/a'])
    const broken = await rerankHits(nodeCommand('process.exit(3)'), 'q', hits)
    expect(broken.hits.map(hit => hit.path)).toEqual(['/a', '/b', '/c'])
    expect(broken.warnings[0]).toContain('rerank-failed')
    const invalid = await rerankHits(nodeCommand('process.stdout.write("{}")'), 'q', hits)
    expect(invalid.warnings).toEqual(['rerank-invalid-output'])
    expect((await rerankHits('', 'q', hits)).hits).toHaveLength(3)
  })

  it('runs the OCR hook and reports a disabled command', async () => {
    const ocr = await runOcrCommand(nodeCommand('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify({text:"hello from ocr"})))'), { path: '/tmp/x.pdf' })
    expect(ocr).toEqual({ ok: true, text: 'hello from ocr' })
    expect(await runOcrCommand('', { path: '/tmp/x.pdf' })).toEqual({ ok: false, error: 'ocr-disabled' })
  })
})

describe('locator_search modes, scope and budget', () => {
  const exec = {} as never

  it('keeps the names default and adds totalCount/nextOffset/budget', async () => {
    const rt = fakeSearchRuntime(['/root'], [searchHit('/root/a.md'), searchHit('/root/b.md'), searchHit('/root/c.md')])
    const tool = makeSearchTool(rt, { budgetChars: 8000 })
    const value = await tool.execute({ query: 'a', limit: 2 }, exec) as {
      ok: boolean
      mode?: string
      totalCount?: number
      returned?: number
      nextOffset?: number
      truncated?: boolean
      hits?: SearchHit[]
      budget?: { truncated?: boolean }
    }
    expect(value.ok).toBe(true)
    expect(value.mode).toBe('names')
    expect(value.totalCount).toBe(3)
    expect(value.returned).toBe(2)
    expect(value.nextOffset).toBe(2)
    expect(value.truncated).toBe(true)
    const schema = tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, value)).toEqual([])
  })

  it('honours headLimit, filters notSearchable hits and trims to the budget', async () => {
    const rt = fakeSearchRuntime(['/root'], [searchHit('/root/a.md'), searchHit('/root/secret.md'), searchHit('/root/c.md')])
    const scope = new Scope({ notSearchable: ['secret.md'], notReadable: [], notIndexed: [] }, false)
    const scoped = makeSearchTool(rt, { scope, budgetChars: 8000 })
    const limited = await scoped.execute({ query: 'a', limit: 10, headLimit: 1 }, exec) as { returned?: number; hits?: SearchHit[] }
    expect(limited.returned).toBe(1)
    const filtered = await scoped.execute({ query: 'a', limit: 10 }, exec) as { warnings?: string[]; hits?: Array<{ path: string }>; truncated?: boolean; nextOffset?: number }
    expect(filtered.hits?.map(hit => hit.path)).not.toContain('/root/secret.md')
    expect(filtered.warnings).toContain('scope-filtered:1')
    expect(filtered.truncated).toBe(true)
    // A lossy page consumes the whole fetched page so a later page cannot
    // duplicate the hits that were kept from this one.
    expect(filtered.nextOffset).toBe(3)
    const budgeted = await makeSearchTool(rt, { budgetChars: 200 }).execute({ query: 'a', limit: 10 }, exec) as { hits?: unknown[]; budget?: { truncated?: boolean; dropped?: number } }
    expect(budgeted.hits?.length).toBe(1)
    expect(budgeted.budget?.dropped).toBeGreaterThan(0)
  })

  it('marks notReadable name hits read-denied and drops their refs', async () => {
    const rt = fakeSearchRuntime(['/root'], [searchHit('/root/private/notes.md')])
    const tool = makeSearchTool(rt, { scope: new Scope({ notSearchable: [], notReadable: ['private/**'], notIndexed: [] }, false) })
    const value = await tool.execute({ query: 'notes' }, exec) as { hits?: Array<{ ref?: string; permissions?: { read?: string } }> }
    expect(value.hits?.[0]?.ref).toBeUndefined()
    expect(value.hits?.[0]?.permissions?.read).toBe('denied')
  })

  it('runs content and count modes through the content index', async () => {
    const dir = tempDir('locator-search-content-')
    const file = join(dir, 'notes.md')
    writeFileSync(file, 'line one\nline two needle\nline three\nline four\n')
    const calls: Array<{ query: string; limit: number; options: Record<string, unknown> }> = []
    const content = fakeContent([contentHit(file)], calls)
    const rt = fakeSearchRuntime([dir], [searchHit('/root/a.md')])
    const tool = makeSearchTool(rt, { content, budgetChars: 8000 })
    const value = await tool.execute({ query: 'needle', mode: 'content', limit: 5, contextLines: 1 }, exec) as {
      ok: boolean
      mode?: string
      contentHits?: Array<{ ref?: string; refStatus?: string; context?: string[]; contextStart?: number }>
      contentCount?: { value: number; kind: string }
      totalCount?: number
    }
    expect(value.ok).toBe(true)
    expect(value.mode).toBe('content')
    expect(value.contentHits).toHaveLength(1)
    expect(value.contentHits?.[0]?.ref).toMatch(/^ref:\/\/file\?/)
    expect(value.contentHits?.[0]?.refStatus).toBe('fresh')
    expect(value.contentHits?.[0]?.contextStart).toBe(1)
    expect(value.contentHits?.[0]?.context).toHaveLength(3)
    expect(calls[0]?.options).toMatchObject({ sessionUnavailable: 'files-only' })
    expect(calls[0]?.options.excludeSessions).toBeUndefined()
    const schema = tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, value)).toEqual([])
    const count = await tool.execute({ query: 'needle', mode: 'count' }, exec) as { totalCount?: number; contentCount?: { value: number } }
    expect(count.contentCount?.value).toBe(1)
    expect(count.totalCount).toBe(1)
    const unavailable = await makeSearchTool(rt).execute({ query: 'x', mode: 'content' }, exec) as { ok: boolean; error?: string }
    expect(unavailable.ok).toBe(false)
    expect(unavailable.error).toBe('content-index-unavailable')
  })
})

describe('locator_find modes, context and scope', () => {
  const exec = {} as never

  it('adds refStatus, budgets and page metadata to content hits', async () => {
    const dir = tempDir('locator-find-mode-')
    const file = join(dir, 'notes.md')
    writeFileSync(file, 'one\ntwo needle\nthree\nfour\n')
    const content = fakeContent([contentHit(file, { format: 'pdf' })])
    const tool = makeFindTool(content, undefined, [dir])
    const value = await tool.execute({ query: 'needle', limit: 5 }, exec) as {
      ok: boolean
      mode?: string
      hits?: Array<{ refStatus?: string; format?: string; context?: string[]; contextStart?: number }>
      totalCount?: number
      truncated?: boolean
      budget?: { limitChars?: number }
    }
    expect(value.ok).toBe(true)
    expect(value.mode).toBe('content')
    expect(value.hits?.[0]?.refStatus).toBe('fresh')
    // Extracted document formats are additive on content hits.
    expect(value.hits?.[0]?.format).toBe('pdf')
    expect(value.totalCount).toBe(1)
    expect(value.truncated).toBe(false)
    expect(value.budget?.limitChars).toBe(8000)
    const withContext = await tool.execute({ query: 'needle', limit: 5, contextLines: 1 }, exec) as { hits?: Array<{ context?: string[]; contextStart?: number }> }
    expect(withContext.hits?.[0]?.contextStart).toBe(1)
    expect(withContext.hits?.[0]?.context).toEqual(['one', 'two needle', 'three'])
    const schema = tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, value)).toEqual([])
  })

  it('supports names and count modes', async () => {
    const dir = tempDir('locator-find-names-')
    const file = join(dir, 'notes.md')
    writeFileSync(file, 'one needle\n')
    const content = fakeContent([contentHit(file)])
    const rt = fakeSearchRuntime([dir], [searchHit(file), searchHit(join(dir, 'other.md'))])
    const tool = makeFindTool(content, undefined, [dir], false, { rt })
    const names = await tool.execute({ query: 'notes', mode: 'names', limit: 5 }, exec) as { ok: boolean; mode?: string; hits?: Array<{ kind: string }>; totalCount?: number }
    expect(names.ok).toBe(true)
    expect(names.mode).toBe('names')
    expect(names.hits).toHaveLength(2)
    expect(names.totalCount).toBe(2)
    const count = await tool.execute({ query: 'needle', mode: 'count' }, exec) as { ok: boolean; mode?: string; hits?: unknown[]; totalCount?: number; count?: { value: number } }
    expect(count.hits).toEqual([])
    expect(count.totalCount).toBe(1)
    expect(count.count?.value).toBe(1)
    const unavailable = await makeFindTool(content).execute({ query: 'x', mode: 'names' }, exec) as { ok: boolean; error?: string }
    expect(unavailable.error).toBe('name-index-unavailable')
  })

  it('filters content hits through the scope and reranks through a hook', async () => {
    const dir = tempDir('locator-find-scope-')
    const file = join(dir, 'notes.md')
    const secret = join(dir, 'secret.md')
    writeFileSync(file, 'needle a\n')
    writeFileSync(secret, 'needle b\n')
    const content = fakeContent([contentHit(file), contentHit(secret)])
    const scope = new Scope({ notSearchable: ['secret.md'], notReadable: [], notIndexed: [] }, false)
    const tool = makeFindTool(content, undefined, [dir], false, { scope })
    const value = await tool.execute({ query: 'needle', limit: 5 }, exec) as { hits?: Array<{ path: string }>; warnings?: string[] }
    expect(value.hits?.map(hit => hit.path)).toEqual([file])
    expect(value.warnings).toContain('scope-filtered:1')
    const reverseScript = 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const q=JSON.parse(d);process.stdout.write(JSON.stringify({order:q.hits.map((_,i)=>q.hits.length-1-i)}))})'
    const reranked = makeFindTool(fakeContent([contentHit(file), contentHit(secret)]), undefined, [dir], false, {
      rerankCommand: JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(reverseScript),
    })
    const reordered = await reranked.execute({ query: 'needle', limit: 5 }, exec) as { hits?: Array<{ path: string }> }
    expect(reordered.hits?.map(hit => hit.path)).toEqual([secret, file])
  })
})

describe('locator_status scope report', () => {
  it('shows effective rules, budget and hook state', async () => {
    const runtime = {
      start: () => {},
      status: { running: true },
      roots: ['/tmp'],
      stateDir: '/tmp/state',
      binary: '/tmp/indexd',
      config: { maxResults: 100, excludes: [], outputBudgetChars: 4000, rerankCommand: 'rerank --json', ocrCommand: '' },
      engineStatus: async () => ({
        version: '0.19.0', platform: 'linux/amd64', roots: ['/tmp'], entries: 1, files: 1, dirs: 0,
        nameBytes: 1, deleted: 0, watching: true, scanning: false, usn: false, uptimeSec: 1, stateDir: '/tmp/state',
        refreshFallback: true,
        incrementalRefresh: true,
        watchUnwatchedRoots: ['/tmp'],
        refreshMode: 'incremental',
        refreshReason: 'watch-incomplete',
        refreshScannedRoots: ['/tmp'],
        refreshSkippedRoots: ['/home'],
        refreshEntries: 3,
        refreshTookMs: 42,
        refreshAt: 1_700_000_000_000,
      }),
    } as unknown as LocatorRuntime
    const scope = new Scope({ notSearchable: ['*.secret'], notReadable: ['private/**'], notIndexed: ['*.tmp'] }, false)
    const tool = makeStatusTool(runtime, undefined, scope)
    const value = await tool.execute({}, fakeExec()) as {
      scope?: { activeRules?: number; outputBudgetChars?: number; rerankCommand?: string; notSearchable?: string[] }
      incrementalRefresh?: boolean
      refreshMode?: string
      refreshSkippedRoots?: string[]
      refreshTookMs?: number
    }
    expect(value.scope).toMatchObject({ activeRules: 3, outputBudgetChars: 4000, rerankCommand: 'rerank --json' })
    expect(value).toMatchObject({
      incrementalRefresh: true,
      refreshMode: 'incremental',
      refreshSkippedRoots: ['/home'],
      refreshTookMs: 42,
    })
    expect(value.scope?.notSearchable).toEqual(['*.secret'])
    const schema = tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, value)).toEqual([])
    const text = tool.output.render({}, value as never).map(block => (block as { text?: string }).text ?? '').join('\n')
    expect(text).toContain('scope: 3 rule(s)')
    expect(text).toContain('budget: 4000 chars/result')
    expect(text).toContain('rerank on')
    expect(text).toContain('ocr off')
    expect(text).toContain('incremental: on')
    expect(text).toContain('skipped 1 healthy root(s), last incremental in 42 ms (3 entries)')
    const invalid = makeStatusTool(runtime, undefined, scope)
    const invalidRuntime = { ...runtime, config: { ...runtime.config, rerankCommand: '"unclosed' } } as unknown as LocatorRuntime
    const invalidTool = makeStatusTool(invalidRuntime, undefined, scope)
    const invalidValue = await invalidTool.execute({}, fakeExec()) as { scope?: { warnings?: string[] } }
    expect(invalidValue.scope?.warnings?.[0]).toContain('rerankCommand')
    expect(invalid).toBeDefined()
  })
})

describe('symbol data layer tools', () => {
  interface FakeSymbol { path: string; name: string; kind: string; line: number; language?: string; scope?: string }

  /** Fake content index exposing the additive symbol methods. */
  function fakeSymbolContent(symbols: FakeSymbol[]): ContentIndex {
    return {
      outline: (path: string) => symbols.filter(symbol => symbol.path === path).map(symbol => ({
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        ...(symbol.language === undefined ? {} : { language: symbol.language }),
        ...(symbol.scope === undefined ? {} : { scope: symbol.scope }),
      })),
      findSymbols: (name: string, limit: number) => symbols
        .filter(symbol => symbol.name.toLowerCase().includes(name.toLowerCase()))
        .slice(0, limit)
        .map(symbol => ({ path: symbol.path, name: symbol.name, kind: symbol.kind, line: symbol.line, language: symbol.language ?? 'ts', ...(symbol.scope === undefined ? {} : { scope: symbol.scope }) })),
      repoMap: (roots: readonly string[], _tokenBudget: number) => {
        const byPath = new Map<string, FakeSymbol[]>()
        for (const symbol of symbols) {
          if (roots.length > 0 && !roots.some(root => symbol.path.startsWith(root))) continue
          const existing = byPath.get(symbol.path)
          if (existing === undefined) byPath.set(symbol.path, [symbol])
          else existing.push(symbol)
        }
        return [...byPath.entries()].map(([path, rows]) => ({
          path,
          symbols: rows.map(row => ({ name: row.name, kind: row.kind, line: row.line, ...(row.scope === undefined ? {} : { scope: row.scope }) })),
        }))
      },
      formatsFor: () => new Map(),
    } as unknown as ContentIndex
  }

  const dir = (): string => tempDir('locator-symbols-')

  it('lists an outline with lines and denies paths outside the roots', async () => {
    const root = dir()
    const file = join(root, 'lib.ts')
    writeFileSync(file, 'export function parseConfig() {}\n')
    const content = fakeSymbolContent([
      { path: file, name: 'parseConfig', kind: 'function', line: 1, language: 'ts' },
      { path: file, name: 'Config', kind: 'interface', line: 8, language: 'ts' },
    ])
    const tool = makeOutlineTool(content, undefined, [root])
    const value = await tool.execute({ path: file }, {} as never) as { ok: boolean; symbols?: Array<{ name: string; line: number }>; totalCount?: number; truncated?: boolean }
    expect(value.ok).toBe(true)
    expect(value.totalCount).toBe(2)
    expect(value.symbols?.map(symbol => symbol.name)).toEqual(['parseConfig', 'Config'])
    const schema = tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, value)).toEqual([])
    const outside = await tool.execute({ path: '/etc/passwd' }, {} as never) as { ok: boolean; error?: string }
    expect(outside.ok).toBe(false)
    expect(outside.error).toBe('content-path-denied')
    const scope = new Scope({ notSearchable: [], notReadable: ['lib.ts'], notIndexed: [] }, false)
    const hidden = await makeOutlineTool(content, undefined, [root], scope).execute({ path: file }, {} as never) as { ok: boolean; error?: string; warnings?: string[] }
    expect(hidden.ok).toBe(false)
    expect(hidden.warnings).toContain('path-not-readable')
  })

  it('finds symbols by name and drops scope-filtered hits', async () => {
    const root = dir()
    const file = join(root, 'lib.ts')
    const secret = join(root, 'secret.ts')
    writeFileSync(file, 'export function parseConfig() {}\n')
    writeFileSync(secret, 'export function parseConfigSecret() {}\n')
    const content = fakeSymbolContent([
      { path: file, name: 'parseConfig', kind: 'function', line: 1, language: 'ts' },
      { path: secret, name: 'parseConfigSecret', kind: 'function', line: 1, language: 'ts' },
    ])
    const scope = new Scope({ notSearchable: ['secret.ts'], notReadable: [], notIndexed: [] }, false)
    const tool = makeSymbolTool(content, undefined, scope)
    const value = await tool.execute({ name: 'parseConfig' }, {} as never) as { ok: boolean; symbols?: Array<{ path: string; ref?: string }>; count?: number; warnings?: string[]; totalCount?: number }
    expect(value.ok).toBe(true)
    expect(value.totalCount).toBe(2)
    expect(value.count).toBe(1)
    expect(value.symbols?.map(hit => hit.path)).toEqual([file])
    expect(value.symbols?.[0]?.ref).toMatch(/^ref:\/\/file\?/)
    expect(value.warnings).toContain('scope-filtered:1')
    const schema = tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, value)).toEqual([])
  })

  it('builds a repo map and validates its roots', async () => {
    const root = dir()
    const src = join(root, 'src')
    mkdirSync(src)
    const a = join(src, 'a.ts')
    const b = join(root, 'b.ts')
    const content = fakeSymbolContent([
      { path: a, name: 'alpha', kind: 'function', line: 1 },
      { path: a, name: 'Beta', kind: 'class', line: 5 },
      { path: b, name: 'gamma', kind: 'function', line: 1 },
    ])
    const tool = makeRepoMapTool(content, undefined, [root])
    const value = await tool.execute({ tokenBudget: 500 }, {} as never) as { ok: boolean; files?: Array<{ path: string; ref?: string; symbols: unknown[] }>; count?: number; tokensEstimated?: number; tokenBudget?: number }
    expect(value.ok).toBe(true)
    expect(value.tokenBudget).toBe(500)
    expect(value.count).toBe(2)
    expect(value.tokensEstimated).toBeGreaterThan(0)
    expect(value.files?.every(file => typeof file.ref === 'string')).toBe(true)
    const schema = tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, value)).toEqual([])
    const narrowed = await tool.execute({ tokenBudget: 500, roots: [src] }, {} as never) as { files?: Array<{ path: string }> }
    expect(narrowed.files?.map(file => file.path)).toEqual([a])
    const outside = await tool.execute({ roots: ['/etc'] }, {} as never) as { ok: boolean; error?: string }
    expect(outside.ok).toBe(false)
    expect(outside.error).toBe('content-path-denied')
  })
})


describe('locator_explore', () => {
  it('derives bounded name and content probes from a question', () => {
    const plan = { nameQueries: 3, contentQueries: 2, limit: 20, perQuery: 8 }
    const probes = exploreQueries('Where did we decide the retry policy "exponential backoff" for checkout?', plan)
    expect(probes.names.length).toBeLessThanOrEqual(3)
    expect(probes.content.length).toBeLessThanOrEqual(2)
    expect(probes.names).toContain('exponential backoff')
    const content = probes.content.join(' ')
    expect(content).toContain('retry')
    expect(content).not.toContain('the ')
    // Two-character words are usable for names but not for trigram body search.
    expect(exploreQueries('go io', plan).content).toEqual([])
  })

  it('merges name and content evidence, dedupes and reports a digest', async () => {
    const dir = tempDir('locator-explore-')
    const file = join(dir, 'notes.md')
    writeFileSync(file, 'one\nthe retry policy is exponential backoff\n')
    const calls: string[] = []
    const rt = {
      roots: [dir],
      config: { maxResults: 100, excludes: [] },
      start: () => {},
      async search(args: { query: string }) {
        calls.push('name:' + args.query)
        return { total: 1, returned: 1, offset: 0, truncated: false, tookNs: 1_000_000, hits: [searchHit(file)] }
      },
    } as unknown as LocatorRuntime
    const content = fakeContent([contentHit(file)])
    const tool = makeExploreTool(rt, { content, roots: [dir], budgetChars: 8000 })
    const value = await tool.execute({ question: 'retry policy exponential backoff', thoroughness: 'quick' }, fakeExec()) as {
      ok: boolean
      summary?: string
      refs?: Array<{ path: string; origin?: string; ref?: string }>
      counts?: { nameHits?: number; contentHits?: number; refs?: number; deduped?: number }
      queries?: { names?: string[]; content?: string[] }
      warnings?: string[]
    }
    expect(value.ok).toBe(true)
    expect(value.counts?.nameHits).toBeGreaterThan(0)
    expect(value.counts?.contentHits).toBeGreaterThan(0)
    expect(value.refs).toHaveLength(1)
    expect(value.refs?.[0]).toMatchObject({ path: file, origin: 'content' })
    expect(value.refs?.[0]?.ref).toMatch(/^ref:\/\/file\?/)
    expect(value.summary).toContain('locator_explore')
    expect(value.summary).toContain('evidence ref')
    const schema = tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, value)).toEqual([])
    expect(calls.some(call => call.startsWith('name:'))).toBe(true)
  })

  it('honours thoroughness, scope and a missing content index', async () => {
    const dir = tempDir('locator-explore-depth-')
    const file = join(dir, 'notes.md')
    writeFileSync(file, 'alpha beta gamma delta epsilon\n')
    const queries: string[] = []
    const rt = {
      roots: [dir],
      config: { maxResults: 100, excludes: [] },
      start: () => {},
      async search(args: { query: string }) {
        queries.push(args.query)
        return { total: 1, returned: 1, offset: 0, truncated: false, tookNs: 1, hits: [searchHit(file)] }
      },
    } as unknown as LocatorRuntime
    const content = fakeContent([contentHit(file)])
    const quick = await makeExploreTool(rt, { content, roots: [dir] }).execute({ question: 'alpha beta gamma delta epsilon', thoroughness: 'quick' }, fakeExec()) as { queries?: { names?: string[]; content?: string[] } }
    const quickCount = queries.length
    const deep = await makeExploreTool(rt, { content, roots: [dir] }).execute({ question: 'alpha beta gamma delta epsilon', thoroughness: 'deep' }, fakeExec()) as { queries?: { names?: string[]; content?: string[] } }
    expect(deep.queries?.content?.length ?? 0).toBeGreaterThanOrEqual(quick.queries?.content?.length ?? 0)
    expect(queries.length).toBeGreaterThan(quickCount)
    const noContent = await makeExploreTool(rt, { roots: [dir] }).execute({ question: 'alpha beta', thoroughness: 'quick' }, fakeExec()) as { ok: boolean; warnings?: string[]; refs?: Array<{ origin?: string }> }
    expect(noContent.ok).toBe(true)
    expect(noContent.warnings).toContain('content-index-unavailable')
    expect(noContent.refs?.[0]?.origin).toBe('name')
    const scoped = makeExploreTool(rt, { content, roots: [dir], scope: new Scope({ notSearchable: ['*.md'], notReadable: [], notIndexed: [] }, false) })
    const scopedValue = await scoped.execute({ question: 'alpha beta', thoroughness: 'quick' }, fakeExec()) as { ok: boolean; refs?: unknown[] }
    expect(scopedValue.refs).toHaveLength(0)
  })
})

