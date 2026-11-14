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
import type { LocatorRuntime } from '../src/runtime.ts'
import {
  DEFAULT_EXPORT_NAME,
  EXPORT_DB_USER_VERSION,
  isOwnExportDatabase,
  makeExportTool,
  resolveExportTarget,
  type SqliteModuleLike,
} from '../src/export.ts'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ContentIndex } from '../src/content.ts'
import { makeRebuildTool, makeStatusTool, validateRebuildArguments } from '../src/tools.ts'
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
