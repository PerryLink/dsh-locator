import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Worker } from 'node:worker_threads'
import { strToU8, zipSync } from 'fflate'
import { estimateSymbolTokens } from '../src/symbols.ts'
import { zstdCompressSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { adaptivePressure, ContentIndex } from '../src/content.ts'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ContentOptions, ContentProgress } from '../src/content.ts'
import { CONTENT_STATE_SCHEMA } from '../src/find.ts'
import type { LocatorRuntime, DumpPage } from '../src/runtime.ts'

const cleanups: Array<() => void> = []
afterAll(() => { for (const cleanup of cleanups.reverse()) cleanup() })

async function settle(content: ContentIndex): Promise<void> {
  for (let i = 0; i < 200 && content.status().building; i++) await new Promise(resolve => setTimeout(resolve, 25))
}

describe('ContentIndex', () => {
  it('indexes text files into FTS5 and returns snippets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-content-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-content-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, '# Notes\n\nthe quick brown fox jumps over the lazy dog\n')
    const page: DumpPage = {
      entries: [{ path, name: 'notes.md', size: 52, mtime: Date.now(), ext: 'md', dir: false }],
      next: 1,
      done: true,
    }
    const runtime = { dump: async () => page } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, {
      stateDir: state,
      sessionDirs: [],
      maxFileBytes: 1_000_000,
      maxFiles: 100,
      maxSessions: 0,
    })
    cleanups.push(() => content.close())
    content.start()
    for (let i = 0; i < 100 && content.status().building; i++) await new Promise(resolve => setTimeout(resolve, 25))
    const hits = await content.search('brown fox', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.kind).toBe('file')
    expect(hits[0]?.path).toBe(path)
    expect(hits[0]?.snippet).toContain('brown fox')
  })

  it('defers an incremental refresh that collides with an engine re-scan instead of rebuilding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-defer-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-defer-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, '# Notes\n\nthe deferred refresh marker\n')
    const page: DumpPage = {
      entries: [{ path, name: 'notes.md', size: 40, mtime: Date.now() - 1000, ext: 'md', dir: false }],
      next: 1,
      done: true,
    }
    const runtime = { dump: async () => page, status: {} } as unknown as { dump: () => Promise<DumpPage>; status: { scanning?: unknown } }
    const content = new ContentIndex(runtime as unknown as LocatorRuntime, {
      stateDir: state,
      sessionDirs: [],
      maxFileBytes: 1_000_000,
      maxFiles: 100,
      maxSessions: 0,
    })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    const before = content.status()
    expect(before.files).toBe(1)
    expect(before.building).toBe(false)

    // A fallback rebuild starts between refreshes: the dump cursor moves, so the
    // refresh cannot finish. The database must survive and the next refresh retry.
    runtime.status.scanning = { phase: 'files' }
    content.refresh()
    await settle(content)
    const deferred = content.status()
    expect(deferred.building).toBe(false)
    expect(deferred.error).toBe('')
    expect(deferred.files).toBe(1)
    expect(deferred.updatedAt).toBe(before.updatedAt)
    expect(deferred.warnings).toContain('content-refresh-deferred')

    delete runtime.status.scanning
    content.refresh()
    await settle(content)
    const recovered = content.status()
    expect(recovered.building).toBe(false)
    expect(recovered.error).toBe('')
    expect(recovered.files).toBe(1)
    expect(recovered.warnings).not.toContain('content-refresh-deferred')
    expect(recovered.updatedAt).toBeGreaterThan(before.updatedAt)
  })

  it('indexes session messages with sessionId and messageId', async () => {
    const state = mkdtempSync(join(tmpdir(), 'locator-session-state-'))
    const sessions = mkdtempSync(join(tmpdir(), 'locator-sessions-'))
    cleanups.push(() => rmSync(state, { recursive: true, force: true }), () => rmSync(sessions, { recursive: true, force: true }))
    const dir = join(sessions, '--workspace--', 'session-abc')
    mkdirSync(dir, { recursive: true })
    const lines = [
      JSON.stringify({ type: 'user/message', data: { id: 'msg-1', seq: 1, content: [{ type: 'text', text: 'the launch decision is friday' }] } }),
      JSON.stringify({ type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'msg-2', content: [{ type: 'text', text: 'we will launch on friday' }] } } }),
    ].join('\n')
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines)))
    const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1000, maxFiles: 0, maxSessions: 10 })
    cleanups.push(() => content.close())
    content.start()
    for (let i = 0; i < 200 && content.status().building; i++) await new Promise(resolve => setTimeout(resolve, 25))
    const hits = await content.search('launch friday', 5)
    expect(hits.some(hit => hit.kind === 'session' && hit.sessionId === 'session-abc' && hit.messageId === 'msg-2')).toBe(true)
    expect(hits.find(hit => hit.messageId === 'msg-1')?.nodeKey).toBe('13:input-messagemsg-1')
    expect(hits.find(hit => hit.messageId === 'msg-2')?.nodeKey).toBe('14:assistant-step1:1')
  })

  it('leaves archived sessions out unless includeArchived is set', async () => {
    const home = mkdtempSync(join(tmpdir(), 'locator-home-'))
    const liveState = mkdtempSync(join(tmpdir(), 'locator-live-state-'))
    const archState = mkdtempSync(join(tmpdir(), 'locator-arch-state-'))
    cleanups.push(
      () => rmSync(home, { recursive: true, force: true }),
      () => rmSync(liveState, { recursive: true, force: true }),
      () => rmSync(archState, { recursive: true, force: true }),
    )
    const sessions = join(home, 'sessions')
    const sessionCases: Array<[string, string]> = [['session-live', 'LIVEMARK'], ['session-archived', 'ARCHIVEMARK']]
    for (const [id, marker] of sessionCases) {
      const dir = join(sessions, '--workspace--', id)
      mkdirSync(dir, { recursive: true })
      const line = JSON.stringify({ type: 'user/message', data: { id: `${id}-msg`, seq: 1, content: [{ type: 'text', text: `${marker} decision record` }] } })
      writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(line)))
    }
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { archivedSessionIds: ['session-archived'] }, tables: { workspaces: {} } }))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
      const base = { sessionDirs: [sessions], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 10 }
      const skipped = new ContentIndex(runtime, { ...base, stateDir: liveState })
      cleanups.push(() => skipped.close())
      skipped.start()
      await settle(skipped)
      expect((await skipped.search('LIVEMARK', 5)).length).toBeGreaterThan(0)
      // Archived logs are indexed either way but hidden from ordinary queries.
      expect((await skipped.search('ARCHIVEMARK', 5)).length).toBe(0)
      expect((await skipped.search('ARCHIVEMARK', 5, { includeArchived: true })).hits.length).toBeGreaterThan(0)

      const included = new ContentIndex(runtime, { ...base, stateDir: archState, includeArchived: true })
      cleanups.push(() => included.close())
      included.start()
      await settle(included)
      expect((await included.search('ARCHIVEMARK', 5)).length).toBeGreaterThan(0)
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('defers a session log that is still being written', async () => {
    const sessions = mkdtempSync(join(tmpdir(), 'locator-active-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-active-state-'))
    cleanups.push(() => rmSync(sessions, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const dir = join(sessions, '--workspace--', 'session-active')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'session.v4.jsonl.zstd')
    const line = JSON.stringify({ type: 'user/message', data: { id: 'active-msg', seq: 1, content: [{ type: 'text', text: 'ACTIVEMARK being written right now' }] } })
    writeFileSync(path, zstdCompressSync(Buffer.from(line)))
    const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 10, activeSessionDelayMs: 60_000 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect((await content.search('ACTIVEMARK', 5)).length).toBe(0)

    const quiet = new Date(Date.now() - 120_000)
    utimesSync(path, quiet, quiet)
    content.refresh()
    await settle(content)
    expect((await content.search('ACTIVEMARK', 5)).length).toBeGreaterThan(0)
  })

  it('spends a tight body budget on sessions before files and reports truncation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-budget-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-budget-state-'))
    const sessions = mkdtempSync(join(tmpdir(), 'locator-budget-sessions-'))
    cleanups.push(
      () => rmSync(root, { recursive: true, force: true }),
      () => rmSync(state, { recursive: true, force: true }),
      () => rmSync(sessions, { recursive: true, force: true }),
    )
    const dir = join(sessions, '--workspace--', 'session-budget')
    mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({ type: 'user/message', data: { id: 'budget-msg', seq: 1, content: [{ type: 'text', text: 'session-budget-marker decision friday' }] } })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(line)))
    const filePath = join(root, 'big.md')
    const fileBody = `FILEBUDGETMARK ${'x'.repeat(400)}`
    writeFileSync(filePath, fileBody)
    const entries = [{ path: filePath, name: 'big.md', size: fileBody.length, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1_000_000, maxTotalBytes: 120, maxFiles: 100, maxSessions: 10 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().truncated).toBe(true)
    expect((await content.search('session-budget-marker', 5)).length).toBeGreaterThan(0)
    expect((await content.search('FILEBUDGETMARK', 5)).length).toBe(0)
  })

  it('skips dependency and toolchain directories unless configured otherwise', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-skip-'))
    const skippedState = mkdtempSync(join(tmpdir(), 'locator-skip-state-'))
    const keptState = mkdtempSync(join(tmpdir(), 'locator-skip-open-'))
    cleanups.push(
      () => rmSync(root, { recursive: true, force: true }),
      () => rmSync(skippedState, { recursive: true, force: true }),
      () => rmSync(keptState, { recursive: true, force: true }),
    )
    const files: Record<string, string> = {
      notes: 'NOTESMARKER user document',
      dep: 'DEPMARKER dependency source',
      cargo: 'CARGOMARKER crate source',
      tool: 'TOOLMARKER toolchain source',
    }
    const paths: Record<string, string> = {
      notes: join(root, 'notes.md'),
      dep: join(root, 'node_modules', 'pkg', 'index.js'),
      cargo: join(root, '.cargo', 'registry', 'crate.rs'),
      tool: join(root, 'toolchain', 'go', 'main.go'),
    }
    for (const [key, path] of Object.entries(paths)) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, files[key]!)
    }
    const mtime = Date.now()
    const entries = Object.entries(paths).map(([key, path]) => ({ path, name: basename(path), size: files[key]!.length, mtime, ext: path.split('.').pop() ?? '', dir: false }))
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const base = { sessionDirs: [], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 }
    const skipped = new ContentIndex(runtime, { ...base, stateDir: skippedState, excludes: ['node_modules', '.cargo', 'toolchain'] })
    cleanups.push(() => skipped.close())
    skipped.start()
    await settle(skipped)
    expect((await skipped.search('NOTESMARKER', 5)).length).toBeGreaterThan(0)
    expect((await skipped.search('DEPMARKER', 5)).length).toBe(0)
    expect((await skipped.search('CARGOMARKER', 5)).length).toBe(0)
    expect((await skipped.search('TOOLMARKER', 5)).length).toBe(0)

    const kept = new ContentIndex(runtime, { ...base, stateDir: keptState, excludes: [] })
    cleanups.push(() => kept.close())
    kept.start()
    await settle(kept)
    expect((await kept.search('DEPMARKER', 5)).length).toBeGreaterThan(0)
    expect((await kept.search('CARGOMARKER', 5)).length).toBeGreaterThan(0)
  })

  it('recovers when another process replaces the database', async () => {
    if (process.platform === 'win32') return
    const root = mkdtempSync(join(tmpdir(), 'locator-replace-'))
    const stateA = mkdtempSync(join(tmpdir(), 'locator-replace-a-'))
    const stateB = mkdtempSync(join(tmpdir(), 'locator-replace-b-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(stateA, { recursive: true, force: true }), () => rmSync(stateB, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    const bodyA = 'REPLACEMARK-A from the first database\n'
    const bodyB = 'REPLACEMARK-B from the second database\n'
    writeFileSync(path, bodyA)
    const entriesA = [{ path, name: 'notes.md', size: bodyA.length, mtime: Date.now(), ext: 'md', dir: false }]
    const runtimeA = { dump: async () => ({ entries: entriesA, next: 1, done: true }) } as unknown as LocatorRuntime
    const first = new ContentIndex(runtimeA, { stateDir: stateA, sessionDirs: [], maxFileBytes: 10_000, maxTotalBytes: 0, maxFiles: 10, maxSessions: 0 })
    cleanups.push(() => first.close())
    first.start()
    await settle(first)
    expect((await first.search('REPLACEMARK-A', 5)).length).toBeGreaterThan(0)
    expect((await first.search('REPLACEMARK-B', 5)).length).toBe(0)

    writeFileSync(path, bodyB)
    const entriesB = [{ path, name: 'notes.md', size: bodyB.length, mtime: entriesA[0]!.mtime + 5_000, ext: 'md', dir: false }]
    const runtimeB = { dump: async () => ({ entries: entriesB, next: 1, done: true }) } as unknown as LocatorRuntime
    const second = new ContentIndex(runtimeB, { stateDir: stateB, sessionDirs: [], maxFileBytes: 10_000, maxTotalBytes: 0, maxFiles: 10, maxSessions: 0 })
    second.start()
    await settle(second)
    second.close()

    // Simulate another process rebuilding: unlink + new inode with different data.
    entriesA[0]!.mtime = entriesB[0]!.mtime
    rmSync(join(stateA, 'content.db'))
    copyFileSync(join(stateB, 'content.db'), join(stateA, 'content.db'))
    expect(await first.search('REPLACEMARK-B', 5)).toEqual([])
    expect(first.status().building).toBe(true)
    await settle(first)
    expect((await first.search('REPLACEMARK-B', 5)).length).toBeGreaterThan(0)
  })

  it('aborts a build when the engine starts a re-scan, then retries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-rescan-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-rescan-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'RESCANMARK content\n')
    const entries = [{ path, name: 'notes.md', size: 19, mtime: Date.now(), ext: 'md', dir: false }]
    let scanOnce = true
    const runtime: { status: { running: boolean; scanning?: { phase: string } }; dump: () => Promise<unknown> } = {
      status: { running: true },
      dump: async () => {
        if (scanOnce) {
          scanOnce = false
          runtime.status.scanning = { phase: 'walking' }
          return { entries, next: 1, done: false }
        }
        return { entries, next: 1, done: true }
      },
    }
    const content = new ContentIndex(runtime as unknown as LocatorRuntime, { stateDir: state, sessionDirs: [], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 10, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().error).toContain('re-scan')
    expect(content.status().building).toBe(false)

    delete runtime.status.scanning
    content.refresh()
    await settle(content)
    expect(content.status().error).toBe('')
    expect((await content.search('RESCANMARK', 5)).length).toBeGreaterThan(0)
  })

  it('rebuilds when the previous build never finished', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-interrupted-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-interrupted-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'INTERRUPTEDMARK content that survived\n')
    const entries = [{ path, name: 'notes.md', size: 34, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const options = { stateDir: state, sessionDirs: [], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 10, maxSessions: 0 }
    const first = new ContentIndex(runtime, options)
    cleanups.push(() => first.close())
    first.start()
    await settle(first)
    first.close()

    const db = new DatabaseSync(join(state, 'content.db'))
    db.prepare("UPDATE content_meta SET value = 0 WHERE key = 'complete'").run()
    db.prepare("UPDATE content_meta SET value = 999999999 WHERE key = 'total_bytes'").run()
    db.close()

    const second = new ContentIndex(runtime, options)
    cleanups.push(() => second.close())
    second.boot()
    await settle(second)
    expect(second.status().error).toBe('')
    expect((await second.search('INTERRUPTEDMARK', 5)).length).toBeGreaterThan(0)
    const check = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    const complete = check.prepare("SELECT value FROM content_meta WHERE key = 'complete'").get() as { value: number }
    const counter = check.prepare("SELECT value FROM content_meta WHERE key = 'total_bytes'").get() as { value: number }
    const sum = check.prepare('SELECT COALESCE(SUM(length(body)), 0) AS n FROM docs').get() as { n: number }
    check.close()
    expect(Number(complete.value)).toBe(1)
    expect(Number(counter.value)).toBe(Number(sum.n))
  })

  it('refuses to delete a content.db it does not own', async () => {
    const state = mkdtempSync(join(tmpdir(), 'locator-foreign-state-'))
    cleanups.push(() => rmSync(state, { recursive: true, force: true }))
    const foreign = new DatabaseSync(join(state, 'content.db'))
    foreign.exec('CREATE TABLE someone_elses_data (id INTEGER PRIMARY KEY)')
    foreign.exec('INSERT INTO someone_elses_data (id) VALUES (1)')
    foreign.close()
    const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 10, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().error).toContain('not a dsh-locator database')
    expect(existsSync(join(state, 'content.db'))).toBe(true)
    const check = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    expect((check.prepare('SELECT COUNT(*) AS n FROM someone_elses_data').get() as { n: number }).n).toBe(1)
    check.close()
  })

  it('rejects sub-trigram queries instead of scanning the whole corpus', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-short-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-short-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'big.md')
    writeFileSync(path, 'SHORTQ\n' + 'x'.repeat(5000))
    const entries = [{ path, name: 'big.md', size: 5007, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 100000, maxTotalBytes: 0, maxFiles: 10, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    const result = await content.search('x', 5, {})
    expect(result.hits).toEqual([])
    expect(result.error).toBe('content-query-too-short')
    expect(result.count).toEqual({ value: 0, kind: 'unknown' })
    // The legacy hit-array form must not fall back to an unbounded LIKE scan.
    expect(await content.search('x', 5)).toEqual([])
    // A real trigram query still returns a bounded snippet.
    const hits = await content.search('SHORTQ', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(400)
  })

  it('reports a pending lazy start and keeps the database private', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-pending-'))
    const state = join(root, 'state')
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    writeFileSync(join(root, 'a.md'), 'PENDINGMARK content\n')
    const entries = [{ path: join(root, 'a.md'), name: 'a.md', size: 20, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 10, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.markPending()
    expect(content.status().building).toBe(true)
    content.start()
    expect(content.status().building).toBe(true)
    content.clearPending()
    await settle(content)
    expect(content.status().building).toBe(false)
    if (process.platform !== 'win32') {
      expect(statSync(join(state, 'content.db')).mode & 0o777).toBe(0o600)
      expect(statSync(state).mode & 0o777).toBe(0o700)
    }
    const check = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    const index = check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'docs_meta_path_id'").get()
    const pathsIndex = check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'paths_path'").get()
    check.close()
    expect(index).toBeDefined()
    expect(pathsIndex).toBeDefined()
  })

  it('refuses a concurrent build but takes over a stale lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-lock-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-lock-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    writeFileSync(join(root, 'notes.md'), 'LOCKMARK content\n')
    const entries = [{ path: join(root, 'notes.md'), name: 'notes.md', size: 20, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const options = { stateDir: state, sessionDirs: [], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 10, maxSessions: 0 }
    writeFileSync(join(state, 'content.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'live-sibling' }))
    const blocked = new ContentIndex(runtime, options)
    cleanups.push(() => blocked.close())
    blocked.start()
    expect(blocked.status().error).toContain('another dsh-locator content build')
    expect(blocked.status().building).toBe(false)

    writeFileSync(join(state, 'content.lock'), JSON.stringify({ pid: 999_999_999, startedAt: Date.now() - 60 * 60_000, token: 'stale-sibling' }))
    const taken = new ContentIndex(runtime, options)
    cleanups.push(() => taken.close())
    taken.start()
    await settle(taken)
    expect(taken.status().error).toBe('')
    expect(taken.status().files).toBe(1)
    expect(existsSync(join(state, 'content.lock'))).toBe(false)
  })

  it('keeps the persisted body-byte counter equal to the stored bodies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-accounting-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-accounting-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const a = join(root, 'a.md')
    const b = join(root, 'b.md')
    const aBody = 'AAA'.padEnd(60, 'a')
    const bBody = 'BBB'.padEnd(60, 'b')
    writeFileSync(a, aBody)
    writeFileSync(b, bBody)
    let entries = [
      { path: a, name: 'a.md', size: aBody.length, mtime: Date.now(), ext: 'md', dir: false },
      { path: b, name: 'b.md', size: bBody.length, mtime: Date.now(), ext: 'md', dir: false },
    ]
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const options = { stateDir: state, sessionDirs: [], maxFileBytes: 1000, maxTotalBytes: 100, maxFiles: 10, maxSessions: 0 }
    const invariant = () => {
      const db = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
      const stored = Number((db.prepare("SELECT value FROM content_meta WHERE key = 'total_bytes'").get() as { value: number }).value)
      const actual = Number((db.prepare('SELECT COALESCE(SUM(length(body)), 0) AS n FROM docs').get() as { n: number }).n)
      db.close()
      return { stored, actual }
    }
    const first = new ContentIndex(runtime, options)
    cleanups.push(() => first.close())
    first.start()
    await settle(first)
    expect(first.status().truncated).toBe(true)
    expect(invariant()).toEqual({ stored: 60, actual: 60 })

    // Removing the indexed file frees its bytes during the same refresh, so the
    // deferred b is retried and stored instead of being blocked forever.
    rmSync(a)
    entries = [{ path: b, name: 'b.md', size: bBody.length, mtime: Date.now(), ext: 'md', dir: false }]
    first.refresh()
    await settle(first)
    expect(invariant()).toEqual({ stored: 60, actual: 60 })
    expect((await first.search('BBB', 5)).length).toBeGreaterThan(0)
    first.close()

    // A restart must read the counter back instead of rescanning the bodies.
    writeFileSync(join(root, 'c.md'), 'CCC'.padEnd(50, 'c'))
    entries = [
      { path: b, name: 'b.md', size: bBody.length, mtime: Date.now(), ext: 'md', dir: false },
      { path: join(root, 'c.md'), name: 'c.md', size: 50, mtime: Date.now(), ext: 'md', dir: false },
    ]
    const second = new ContentIndex(runtime, options)
    cleanups.push(() => second.close())
    second.boot()
    await settle(second)
    expect(invariant()).toEqual({ stored: 60, actual: 60 })
    expect(second.status().truncated).toBe(true)
  })

  it('reuses the database across restarts instead of rebuilding from scratch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-boot-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-boot-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'boot.md')
    writeFileSync(path, 'first boot content')
    let mtime = Date.now()
    let entries = [{ path, name: 'boot.md', size: 18, mtime, ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const options = { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 }
    const first = new ContentIndex(runtime, options)
    cleanups.push(() => first.close())
    first.start()
    await settle(first)
    expect((await first.search('first boot', 5)).length).toBeGreaterThan(0)
    first.close()

    writeFileSync(path, 'second boot content')
    mtime += 1_000
    entries = [{ path, name: 'boot.md', size: 19, mtime, ext: 'md', dir: false }]
    const second = new ContentIndex(runtime, options)
    cleanups.push(() => second.close())
    second.boot()
    await settle(second)
    expect((await second.search('second boot', 5)).length).toBeGreaterThan(0)
    expect((await second.search('first boot', 5)).length).toBe(0)
  })

  it('falls back to a full rebuild when the stored schema version is stale', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-schema-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-schema-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'schema.md')
    writeFileSync(path, 'schema probe content')
    const entries = [{ path, name: 'schema.md', size: 20, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const options = { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 }
    const first = new ContentIndex(runtime, options)
    cleanups.push(() => first.close())
    first.start()
    await settle(first)
    first.close()

    const db = new DatabaseSync(join(state, 'content.db'))
    db.exec('PRAGMA user_version = 0')
    db.close()
    const second = new ContentIndex(runtime, options)
    cleanups.push(() => second.close())
    second.boot()
    await settle(second)
    expect(second.status().error).toBe('')
    // 0.21.1: the successful rebuild resolved the condition, so the stale code
    // must not stay in the live warnings; the historical count stays visible.
    expect(second.status().warnings).not.toContain('content-db-incompatible')
    expect(second.diagnostics().warningCounts?.['content-db-incompatible']).toBeGreaterThanOrEqual(1)
    expect(contentMeta(state).get('warn:content-db-incompatible') ?? 0).toBeGreaterThanOrEqual(1)
    const quarantined = readdirSync(state).filter(name => name.startsWith('content.db.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect((await second.search('schema probe', 5)).length).toBeGreaterThan(0)
  })

  it('refreshes only changed files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-delta-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-delta-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'delta.md')
    writeFileSync(path, 'first generation content')
    let mtime = Date.now()
    let entries = [{ path, name: 'delta.md', size: 24, mtime, ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    for (let i = 0; i < 200 && content.status().building; i++) await new Promise(resolve => setTimeout(resolve, 25))
    expect((await content.search('first generation', 5)).length).toBeGreaterThan(0)
    writeFileSync(path, 'second generation content')
    mtime += 1_000
    entries = [{ path, name: 'delta.md', size: 25, mtime, ext: 'md', dir: false }]
    content.refresh()
    for (let i = 0; i < 200 && content.status().building; i++) await new Promise(resolve => setTimeout(resolve, 25))
    expect((await content.search('second generation', 5)).length).toBeGreaterThan(0)
    expect((await content.search('first generation', 5)).length).toBe(0)
  })
})

interface AdvancedFile {
  name: string
  body: string
}

interface AdvancedSession {
  id: string
  texts: string[]
}

async function makeAdvancedIndex(
  files: AdvancedFile[],
  sessionLogs: AdvancedSession[] = [],
): Promise<{ content: ContentIndex }> {
  const root = mkdtempSync(join(tmpdir(), 'locator-adv-'))
  const state = mkdtempSync(join(tmpdir(), 'locator-adv-state-'))
  const sessions = mkdtempSync(join(tmpdir(), 'locator-adv-sessions-'))
  cleanups.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => rmSync(state, { recursive: true, force: true }),
    () => rmSync(sessions, { recursive: true, force: true }),
  )
  const entries = files.map(file => {
    const path = join(root, file.name)
    writeFileSync(path, file.body)
    return { path, name: file.name, size: Buffer.byteLength(file.body), mtime: Date.now(), ext: file.name.split('.').pop() ?? '', dir: false }
  })
  for (const log of sessionLogs) {
    const dir = join(sessions, '--workspace--', log.id)
    mkdirSync(dir, { recursive: true })
    const lines = log.texts
      .map((text, index) => JSON.stringify({ type: 'user/message', data: { id: `${log.id}-${String(index)}`, seq: index, content: [{ type: 'text', text }] } }))
      .join('\n')
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines)))
  }
  const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
  const content = new ContentIndex(runtime, {
    stateDir: state,
    sessionDirs: [sessions],
    maxFileBytes: 1_000_000,
    maxTotalBytes: 0,
    maxFiles: 100,
    maxSessions: 10,
  })
  cleanups.push(() => content.close())
  content.start()
  await settle(content)
  return { content }
}

describe('advanced content search', () => {
  it('returns exact counts and a line number while keeping the legacy hit array', async () => {
    const { content } = await makeAdvancedIndex([
      { name: 'notes.md', body: '# Notes\n\nthe quick brown fox\nlast line' },
    ])
    const result = await content.search('brown fox', 5, {})
    expect(result.count).toEqual({ value: 1, kind: 'exact' })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.line).toBe(3)
    expect(result.hits[0]?.snippet).toContain('brown fox')
    expect(result.hits[0]?.snippet.length).toBeLessThanOrEqual(400)
    expect(typeof result.hits[0]?.score).toBe('number')
    const legacy = await content.search('brown fox', 5)
    expect(Array.isArray(legacy)).toBe(true)
    expect(legacy[0]?.path).toBe(result.hits[0]?.path)
  })

  it('rejects mixed long/short terms instead of an unbounded LIKE scan', async () => {
    const { content } = await makeAdvancedIndex([
      { name: 'a.md', body: 'sql ab together' },
      { name: 'b.md', body: 'sql only' },
    ])
    const result = await content.search('sql ab', 5, {})
    expect(result.hits).toEqual([])
    expect(result.error).toBe('content-query-too-short')
    expect(result.count).toEqual({ value: 0, kind: 'unknown' })
    // The short term is not silently ignored to make the long term match.
    expect((await content.search('sql ab', 5)).length).toBe(0)
    // A valid two-term query still works.
    expect((await content.search('sql together', 5)).map(hit => hit.title)).toEqual(['a.md'])
  })

  it('matches case exactly through GLOB and reports exact counts', async () => {
    const { content } = await makeAdvancedIndex([
      { name: 'upper.md', body: 'The Alpha release' },
      { name: 'lower.md', body: 'the alpha release' },
    ])
    const sensitive = await content.search('The', 10, { caseSensitive: true })
    expect(sensitive.hits.map(hit => hit.title)).toEqual(['upper.md'])
    expect(sensitive.count).toEqual({ value: 1, kind: 'exact' })
    const insensitive = await content.search('The', 10, {})
    expect(insensitive.count.value).toBe(2)
  })

  it('applies ASCII whole-word boundaries and bounds the count above the cap', async () => {
    const { content } = await makeAdvancedIndex([
      { name: 'testing.md', body: 'testing only' },
      { name: 'standalone.md', body: 'a test here' },
      { name: 'underscore.md', body: 'test_case marker' },
      { name: 'second.md', body: 'another test.' },
    ])
    const result = await content.search('test', 10, { wholeWord: true })
    expect(result.hits.map(hit => hit.title).sort()).toEqual(['second.md', 'standalone.md'])
    expect(result.count).toEqual({ value: 2, kind: 'exact' })
    const capped = await content.search('test', 10, { wholeWord: true, countLimit: 1 })
    expect(capped.count).toEqual({ value: 1, kind: 'bounded', limit: 1 })
    expect(capped.warnings).toContain('bounded-count')
  })

  it('matches extended-mode escapes as one literal and rejects malformed hex', async () => {
    const { content } = await makeAdvancedIndex([
      { name: 'multi.md', body: 'alpha beta\nsecond line\nab token' },
    ])
    const multiline = await content.search('alpha beta\\nsecond', 5, { matchMode: 'extended' })
    expect(multiline.hits).toHaveLength(1)
    expect(multiline.count).toEqual({ value: 1, kind: 'exact' })
    expect(multiline.hits[0]?.snippet).toContain('alpha beta second')
    const invalid = await content.search('bad\\xZZ', 5, { matchMode: 'extended' })
    expect(invalid.error).toBe('invalid-escape')
    expect(invalid.hits).toEqual([])
    const short = await content.search('ab', 5, { matchMode: 'extended' })
    expect(short.hits).toEqual([])
    expect(short.error).toBe('content-query-too-short')
    const caseSensitive = await content.search('Alpha', 5, { matchMode: 'extended', caseSensitive: true })
    expect(caseSensitive.hits).toHaveLength(0)
  })

  it('restricts hits to one session and reports unknown sessions', async () => {
    const { content } = await makeAdvancedIndex([], [
      { id: 'session-one', texts: ['ALPHAMARK one'] },
      { id: 'session-two', texts: ['ALPHAMARK two'] },
    ])
    const scoped = await content.search('ALPHAMARK', 10, { sessionId: 'session-one' })
    expect(scoped.hits.map(hit => hit.sessionId)).toEqual(['session-one'])
    expect(scoped.count).toEqual({ value: 1, kind: 'exact' })
    const missing = await content.search('ALPHAMARK', 10, { sessionId: 'session-missing' })
    expect(missing.hits).toEqual([])
    expect(missing.warnings).toEqual(['unknown-session'])
    const all = await content.search('ALPHAMARK', 10, {})
    expect(all.count.value).toBe(2)
  })

  it('honours count none/bounded and keeps GLOB literals escaped', async () => {
    const { content } = await makeAdvancedIndex([
      { name: 'one.md', body: 'COUNTMARK one' },
      { name: 'two.md', body: 'COUNTMARK two' },
      { name: 'three.md', body: 'COUNTMARK three' },
      { name: 'four.md', body: 'COUNTMARK four' },
      { name: 'five.md', body: 'COUNTMARK five' },
      { name: 'bracket.md', body: 'literal a[b]c token' },
      { name: 'plain.md', body: 'literal abc token' },
    ])
    expect((await content.search('COUNTMARK', 5, { count: 'none' })).count.kind).toBe('unknown')
    expect((await content.search('COUNTMARK', 5, { count: 'bounded', countLimit: 3 })).count).toEqual({ value: 3, kind: 'bounded', limit: 3 })
    expect((await content.search('COUNTMARK', 5, { count: 'bounded', countLimit: 10 })).count).toEqual({ value: 5, kind: 'exact' })
    const brackets = await content.search('a[b]c', 10, { caseSensitive: true })
    expect(brackets.hits.map(hit => hit.title)).toEqual(['bracket.md'])
    expect(brackets.count).toEqual({ value: 1, kind: 'exact' })
  })

  it('filters file hits by path prefix without hiding session hits', async () => {
    const { content } = await makeAdvancedIndex(
      [{ name: 'a.md', body: 'PREFIXMARK file body' }],
      [{ id: 'session-prefix', texts: ['PREFIXMARK session body'] }],
    )
    const all = await content.search('PREFIXMARK', 10, {})
    expect(all.hits).toHaveLength(2)
    const filePath = all.hits.find(hit => hit.kind === 'file')?.path ?? ''
    const outside = await content.search('PREFIXMARK', 10, { pathPrefix: '/definitely/not/this/root' })
    expect(outside.hits.map(hit => hit.kind)).toEqual(['session'])
    expect(outside.count).toEqual({ value: 1, kind: 'exact' })
    const inside = await content.search('PREFIXMARK', 10, { pathPrefix: dirname(filePath) })
    expect(inside.hits.map(hit => hit.kind).sort()).toEqual(['file', 'session'])
    expect(inside.count).toEqual({ value: 2, kind: 'exact' })
  })

  it('keeps quoted literals and GLOB metacharacters escaped', async () => {
    const { content } = await makeAdvancedIndex([
      { name: 'lit.md', body: 'percent 100% and a_b marker star *x* here' },
      { name: 'plain.md', body: 'percent 1000 and axb marker star xx here' },
    ])
    const percent = await content.search('100% and', 5, {})
    expect(percent.hits.map(hit => hit.title)).toEqual(['lit.md'])
    const underscore = await content.search('a_b marker', 5, {})
    expect(underscore.hits.map(hit => hit.title)).toEqual(['lit.md'])
    const glob = await content.search('*x*', 5, { caseSensitive: true })
    expect(glob.hits.map(hit => hit.title)).toEqual(['lit.md'])
    expect(glob.count).toEqual({ value: 1, kind: 'exact' })
  })

  it('pauses content in regex mode instead of scanning', async () => {
    const { content } = await makeAdvancedIndex([{ name: 'a.md', body: 'anything' }])
    const paused = await content.search('a.*g', 5, { matchMode: 'regex' })
    expect(paused).toEqual({ hits: [], count: { value: 0, kind: 'unknown' }, warnings: ['content-regex-paused'], error: 'content-regex-not-supported' })
  })
})

interface FakeWorker extends EventEmitter {
  postMessage(message: unknown): void
  terminate(): Promise<number>
}

/** Minimal Worker stand-in so the host-side protocol can be tested. */
function fakeWorker(onPost: (message: Record<string, unknown>, worker: FakeWorker) => void): Worker {
  const worker = new EventEmitter() as FakeWorker
  worker.postMessage = message => { onPost(message as Record<string, unknown>, worker) }
  worker.terminate = async () => 0
  return worker as unknown as Worker
}

async function makeWorkerIndex(extra: Partial<ContentOptions>): Promise<ContentIndex> {
  const root = mkdtempSync(join(tmpdir(), 'locator-worker-'))
  const state = mkdtempSync(join(tmpdir(), 'locator-worker-state-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
  const path = join(root, 'worker.md')
  const body = 'WORKERMARK content that the worker should find\n'
  writeFileSync(path, body)
  const entries = [{ path, name: 'worker.md', size: body.length, mtime: Date.now(), ext: 'md', dir: false }]
  const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
  const content = new ContentIndex(runtime, {
    stateDir: state,
    sessionDirs: [],
    maxFileBytes: 10_000,
    maxTotalBytes: 0,
    maxFiles: 10,
    maxSessions: 0,
    searchWorker: true,
    ...extra,
  })
  cleanups.push(() => content.close())
  content.start()
  await settle(content)
  return content
}

describe('content query boundaries', () => {
  it('rejects sub-trigram terms in normal, extended and case-sensitive modes', async () => {
    const { content } = await makeAdvancedIndex([{ name: 'a.md', body: 'ab cd long enough' }])
    for (const options of [{}, { matchMode: 'extended' as const }, { caseSensitive: true }]) {
      const result = await content.search('ab', 5, options)
      expect(result.hits).toEqual([])
      expect(result.error).toBe('content-query-too-short')
      expect(result.count).toEqual({ value: 0, kind: 'unknown' })
    }
  })

  it('bounds the query length and the number of terms', async () => {
    const { content } = await makeAdvancedIndex([{ name: 'a.md', body: 'whatever content' }])
    const long = await content.search('a'.repeat(300), 5, {})
    expect(long.error).toBe('content-query-too-long')
    const many = await content.search(Array.from({ length: 33 }, (_, index) => `term${String(index)}`).join(' '), 5, {})
    expect(many.error).toBe('content-query-too-many-terms')
    expect(many.hits).toEqual([])
  })

  it('rejects NUL and control characters instead of truncating the query in SQL', async () => {
    const { content } = await makeAdvancedIndex([{ name: 'a.md', body: 'alpha beta gamma' }])
    const nul = await content.search('alpha\u0000beta', 5, {})
    expect(nul.error).toBe('invalid-control-char')
    expect(nul.hits).toEqual([])
    const decodedNul = await content.search('alpha\\0beta', 5, { matchMode: 'extended' })
    expect(decodedNul.error).toBe('invalid-control-char')
    const control = await content.search('alpha\u0001beta', 5, {})
    expect(control.error).toBe('invalid-control-char')
  })

  it('measures the trigram floor in code points so emoji are not short-circuited', async () => {
    const { content } = await makeAdvancedIndex([{ name: 'emoji.md', body: '😀😀😀 emoji marker' }])
    // Two code points, four UTF-16 units: still too short for the trigram index.
    const short = await content.search('😀😀', 5, {})
    expect(short.error).toBe('content-query-too-short')
    expect(short.hits).toEqual([])
    const full = await content.search('😀😀😀', 5, {})
    expect(full.error).toBeUndefined()
    expect(full.hits.map(hit => hit.title)).toEqual(['emoji.md'])
  })
})

describe('whole-word scan budgets', () => {
  it('caps the scanned rows and keeps the hits found so far', async () => {
    const files = Array.from({ length: 6 }, (_, index) => ({ name: `w${String(index)}.md`, body: `test marker ${String(index)}` }))
    const { content } = await makeAdvancedIndex(files)
    const result = await content.search('test', 10, { wholeWord: true, scanBudget: { maxRows: 2 } })
    expect(result.warnings).toContain('scan-capped')
    expect(result.count).toEqual({ value: 2, kind: 'bounded', limit: 1000 })
    expect(result.hits).toHaveLength(2)
  })

  it('caps the scanned body bytes', async () => {
    const { content } = await makeAdvancedIndex([
      { name: 'a.md', body: 'test aaaaaaaaaaaaaaaa' },
      { name: 'b.md', body: 'test bbbbbbbbbbbbbbbb' },
    ])
    const result = await content.search('test', 10, { wholeWord: true, scanBudget: { maxBytes: 5 } })
    expect(result.warnings).toContain('scan-capped')
    expect(result.count.kind).toBe('bounded')
    expect(result.count.value).toBe(1)
    expect(result.hits).toHaveLength(1)
  })

  it('also caps a session-scoped whole-word scan', async () => {
    const { content } = await makeAdvancedIndex([], [
      { id: 'session-scan', texts: ['test one', 'test two', 'test three', 'test four'] },
    ])
    const result = await content.search('test', 10, { wholeWord: true, sessionId: 'session-scan', scanBudget: { maxRows: 2 } })
    expect(result.warnings).toContain('scan-capped')
    expect(result.count).toEqual({ value: 2, kind: 'bounded', limit: 1000 })
    expect(result.hits).toHaveLength(2)
    expect(result.hits.every(hit => hit.sessionId === 'session-scan')).toBe(true)
  })
})

describe('content search worker protocol', () => {
  /** The new protocol request shape: { id, method: 'search', params }. */
  const isSearchRequest = (message: Record<string, unknown>): boolean => message.method === 'search'

  it('reports a timeout instead of re-running the query on the host thread', async () => {
    const content = await makeWorkerIndex({
      searchWorkerTimeoutMs: 40,
      searchWorkerFactory: () => fakeWorker(() => { /* never answer */ }),
    })
    const result = await content.search('WORKERMARK', 5, {})
    expect(result.hits).toEqual([])
    expect(result.error).toBe('content-search-timeout')
    expect(result.count).toEqual({ value: 0, kind: 'unknown' })
    expect(result.warnings).toContain('content-search-timeout')
    // A host-thread fallback would have found the document immediately.
    expect((await content.search('WORKERMARK', 5)).length).toBe(0)
  })

  it('reports a malformed worker reply as a protocol error', async () => {
    const content = await makeWorkerIndex({
      searchWorkerTimeoutMs: 500,
      searchWorkerFactory: () => fakeWorker((message, worker) => {
        if (!isSearchRequest(message)) return
        setImmediate(() => { worker.emit('message', { id: message.id, ok: true, result: { hits: 'not-an-array', count: { value: 0, kind: 'exact' }, warnings: [] } }) })
      }),
    })
    const result = await content.search('WORKERMARK', 5, {})
    expect(result.hits).toEqual([])
    expect(result.error).toBe('content-search-worker-protocol-error')
    expect(result.warnings).toContain('content-search-worker-protocol-error')
  })

  it('reports a dead worker instead of falling back to a sync query', async () => {
    const content = await makeWorkerIndex({
      searchWorkerTimeoutMs: 500,
      searchWorkerFactory: () => fakeWorker((message, worker) => {
        if (!isSearchRequest(message)) return
        setImmediate(() => { worker.emit('exit', 1) })
      }),
    })
    const result = await content.search('WORKERMARK', 5, {})
    expect(result.hits).toEqual([])
    expect(result.error).toBe('content-search-worker-failed')
  })

  it('answers a valid worker result, strips the signal and pools two workers', async () => {
    const posted: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    const content = await makeWorkerIndex({
      searchWorkerTimeoutMs: 500,
      searchWorkers: 2,
      searchWorkerFactory: () => fakeWorker((message, worker) => {
        if (!isSearchRequest(message)) return
        posted.push(message)
        const params = message.params as { query: string }
        const result = {
          hits: [{ kind: 'file', path: '/tmp/worker.md', title: 'worker.md', snippet: params.query, score: 0 }],
          count: { value: 1, kind: 'exact' },
          warnings: [],
        }
        setImmediate(() => { worker.emit('message', { id: message.id, ok: true, result }) })
      }),
    })
    const signal = new AbortController().signal
    const [first, second] = await Promise.all([
      content.search('WORKERMARK', 5, {}, { signal }),
      content.search('OTHERMARK', 5, {}, { signal }),
    ])
    expect(first.hits).toHaveLength(1)
    expect(second.hits).toHaveLength(1)
    for (const message of posted) {
      const params = message.params as { options?: Record<string, unknown> }
      expect(params.options?.signal).toBeUndefined()
      expect(params.options?.rankAdaptive).toBe(true)
    }
    // Two concurrent queries used two pooled workers instead of serialising.
    expect(posted.length).toBe(2)
    for (const message of posted) seen.add(String(message.id))
    expect(seen.size).toBe(2)
  })

  it('rejects with an AbortError and asks the worker to cancel', async () => {
    const messages: Array<Record<string, unknown>> = []
    const content = await makeWorkerIndex({
      searchWorkerTimeoutMs: 5_000,
      searchWorkerFactory: () => fakeWorker((message) => { messages.push(message) }),
    })
    const controller = new AbortController()
    const pending = content.search('WORKERMARK', 5, {}, { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(messages.some(message => message.method === 'cancel')).toBe(true)
    // The worker is kept alive for the next query (only the request is cancelled).
    expect(messages.some(message => message.method === 'search')).toBe(true)
  })

  it('allows a budgeted in-process query only when the worker cannot be created', async () => {
    // Vitest resolves src/content-search-worker.js, which does not exist: the
    // worker cannot be spawned, so the documented sync fallback must answer.
    const content = await makeWorkerIndex({})
    const result = await content.search('WORKERMARK', 5, {})
    expect(result.error).toBeUndefined()
    expect(result.warnings).toContain('content-search-in-process')
    const count = (result.count as { kind: string }).kind
    if (count === 'bounded') expect(result.count.limit).toBe(200)
    expect(result.hits.map(hit => hit.title)).toEqual(['worker.md'])
  })
})

describe('refresh resilience', () => {
  it('does not let one unreadable file evict trailing documents or eat a maxFiles slot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-refresh-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-refresh-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const a = join(root, 'a.md')
    const b = join(root, 'b.md')
    const broken = join(root, 'broken.md')
    const bodyA = 'AAAAMARK first document'
    const bodyB = 'BBBBMARK second document'
    writeFileSync(a, bodyA)
    writeFileSync(b, bodyB)
    const base = Date.now() - 10_000
    let entries = [
      { path: a, name: 'a.md', size: bodyA.length, mtime: base, ext: 'md', dir: false },
      { path: b, name: 'b.md', size: bodyB.length, mtime: base, ext: 'md', dir: false },
    ]
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 10_000, maxTotalBytes: 0, maxFiles: 2, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().files).toBe(2)
    expect((await content.search('AAAAMARK', 5)).length).toBeGreaterThan(0)
    expect((await content.search('BBBBMARK', 5)).length).toBeGreaterThan(0)

    // `broken.md` is listed by the engine but cannot be read this refresh. It
    // must not consume one of the two maxFiles slots, otherwise the deletion
    // pass would drop b.md permanently.
    const newer = base + 5_000
    entries = [
      { path: broken, name: 'broken.md', size: 20, mtime: newer, ext: 'md', dir: false },
      { path: a, name: 'a.md', size: bodyA.length, mtime: newer, ext: 'md', dir: false },
      { path: b, name: 'b.md', size: bodyB.length, mtime: newer, ext: 'md', dir: false },
    ]
    content.refresh()
    await settle(content)
    expect(content.status().error).toBe('')
    expect(content.status().files).toBe(2)
    expect((await content.search('AAAAMARK', 5)).length).toBeGreaterThan(0)
    expect((await content.search('BBBBMARK', 5)).length).toBeGreaterThan(0)
  })

  it('keeps old session messages when a log cannot be decompressed and retries later', async () => {
    const sessions = mkdtempSync(join(tmpdir(), 'locator-badsession-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-badsession-state-'))
    cleanups.push(() => rmSync(sessions, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const dir = join(sessions, '--workspace--', 'session-broken')
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'session.v4.jsonl.zstd')
    const line = (id: string, text: string) => JSON.stringify({ type: 'user/message', data: { id, seq: 1, content: [{ type: 'text', text }] } })
    const first = Date.now() - 60_000
    writeFileSync(log, zstdCompressSync(Buffer.from(line('old-msg', 'OLDSESSIONMARK decision record'))))
    utimesSync(log, new Date(first), new Date(first))
    const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 10 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect((await content.search('OLDSESSIONMARK', 5)).length).toBeGreaterThan(0)

    // A newer but unreadable log: keep the old messages and the old mtime.
    const second = first + 5_000
    writeFileSync(log, Buffer.from('this is definitely not zstd data'))
    utimesSync(log, new Date(second), new Date(second))
    content.refresh()
    await settle(content)
    expect(content.status().warnings).toContain('content-session-log-unreadable')
    expect((await content.search('OLDSESSIONMARK', 5)).length).toBeGreaterThan(0)

    // Fix the log but keep the same mtime: because the failed attempt did not
    // update sources.mtime, the next refresh retries and indexes the new text.
    writeFileSync(log, zstdCompressSync(Buffer.from(line('new-msg', 'NEWSESSIONMARK replacement record'))))
    utimesSync(log, new Date(second), new Date(second))
    content.refresh()
    await settle(content)
    expect((await content.search('NEWSESSIONMARK', 5)).length).toBeGreaterThan(0)
    expect((await content.search('OLDSESSIONMARK', 5)).length).toBe(0)
  })
})

describe('content database self-healing', () => {
  it('quarantines a corrupt database and rebuilds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-corrupt-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-corrupt-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'HEALMARK after corruption\n')
    const entries = [{ path, name: 'notes.md', size: 26, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    writeFileSync(join(state, 'content.db'), 'this is not a sqlite database at all')
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 10, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.boot()
    await settle(content)
    expect(content.status().error).toBe('')
    expect(content.status().warnings).not.toContain('content-db-corrupt')
    expect(content.diagnostics().warningCounts?.['content-db-corrupt']).toBeGreaterThanOrEqual(1)
    expect(contentMeta(state).get('warn:content-db-corrupt') ?? 0).toBeGreaterThanOrEqual(1)
    expect(readdirSync(state).filter(name => name.startsWith('content.db.corrupt-'))).toHaveLength(1)
    expect((await content.search('HEALMARK', 5)).length).toBeGreaterThan(0)
  })

  it('quarantines a database that has only some dsh-locator tables (old schema)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-partial-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-partial-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'PARTIALDBMARK rebuilt\n')
    const entries = [{ path, name: 'notes.md', size: 20, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const old = new DatabaseSync(join(state, 'content.db'))
    old.exec('CREATE TABLE sources (path TEXT PRIMARY KEY)')
    old.close()
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 10, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.boot()
    await settle(content)
    expect(content.status().error).toBe('')
    expect(content.status().warnings).not.toContain('content-db-incompatible')
    expect(content.diagnostics().warningCounts?.['content-db-incompatible']).toBeGreaterThanOrEqual(1)
    expect(contentMeta(state).get('warn:content-db-incompatible') ?? 0).toBeGreaterThanOrEqual(1)
    expect(readdirSync(state).filter(name => name.startsWith('content.db.corrupt-'))).toHaveLength(1)
    expect((await content.search('PARTIALDBMARK', 5)).length).toBeGreaterThan(0)
  })

  it('quarantines a zero-byte database and rebuilds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-empty-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-empty-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'EMPTYDBMARK rebuilt\n')
    const entries = [{ path, name: 'notes.md', size: 20, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    writeFileSync(join(state, 'content.db'), '')
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 10, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.boot()
    await settle(content)
    expect(content.status().error).toBe('')
    expect(content.status().warnings).not.toContain('content-db-corrupt')
    expect(content.diagnostics().warningCounts?.['content-db-corrupt']).toBeGreaterThanOrEqual(1)
    expect(contentMeta(state).get('warn:content-db-corrupt') ?? 0).toBeGreaterThanOrEqual(1)
    expect(readdirSync(state).filter(name => name.startsWith('content.db.corrupt-'))).toHaveLength(1)
    expect((await content.search('EMPTYDBMARK', 5)).length).toBeGreaterThan(0)
  })


  it('pages content hits with an offset without changing the total count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-content-page-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-content-page-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const entries: Array<{ path: string; name: string; size: number; mtime: number; ext: string; dir: boolean }> = []
    for (let i = 0; i < 12; i++) {
      const path = join(root, `note-${String(i).padStart(2, '0')}.txt`)
      writeFileSync(path, `offset needle body ${i}\n`)
      entries.push({ path, name: `note-${String(i).padStart(2, '0')}.txt`, size: 30, mtime: Date.now(), ext: 'txt', dir: false })
    }
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 20, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.boot()
    await settle(content)
    const first = await content.search('needle', 5, { count: 'exact' })
    const second = await content.search('needle', 5, { count: 'exact', offset: 5 })
    expect(first.count).toMatchObject({ value: 12, kind: 'exact' })
    expect(second.count).toMatchObject({ value: 12, kind: 'exact' })
    expect(first.hits).toHaveLength(5)
    expect(second.hits).toHaveLength(5)
    expect(new Set([...first.hits, ...second.hits].map(hit => hit.path)).size).toBe(10)
  })



  it('indexes assistant reasoning only with includeReasoning and rebuilds when toggled', async () => {
    const state = mkdtempSync(join(tmpdir(), 'locator-reasoning-state-'))
    const sessions = mkdtempSync(join(tmpdir(), 'locator-reasoning-sessions-'))
    cleanups.push(() => rmSync(state, { recursive: true, force: true }), () => rmSync(sessions, { recursive: true, force: true }))
    const dir = join(sessions, '--workspace--', 'session-reasoning')
    mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'msg-reasoning',
          content: [
            { type: 'reasoning', text: 'THINK-MARKER private chain of thought' },
            { type: 'text', text: 'FINAL-MARKER public answer' },
          ],
        },
      },
    })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(line)))
    const runtime = { dump: async () => ({ entries: [], next: 1, done: true }) } as unknown as LocatorRuntime
    const make = (includeReasoning: boolean) => new ContentIndex(runtime, {
      stateDir: state, sessionDirs: [sessions], maxFileBytes: 10_000, maxTotalBytes: 0, maxFiles: 10, maxSessions: 10, includeReasoning,
    })
    const without = make(false)
    cleanups.push(() => without.close())
    without.boot()
    await settle(without)
    expect((await without.search('THINK-MARKER', 5)).length).toBe(0)
    expect((await without.search('FINAL-MARKER', 5)).length).toBeGreaterThan(0)
    without.close()

    const withReasoning = make(true)
    cleanups.push(() => withReasoning.close())
    withReasoning.boot()
    await settle(withReasoning)
    const thinking = await withReasoning.search('THINK-MARKER', 5)
    expect(thinking).toHaveLength(1)
    expect(thinking[0]?.messageId).toBe('msg-reasoning')
    expect(thinking[0]?.nodeKey).toBe('14:assistant-step1:1')
    expect((await withReasoning.search('FINAL-MARKER', 5)).length).toBeGreaterThan(0)
  })


  it('rebuilds only sessions when reasoning indexing is toggled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-reason-file-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-reason-file-state-'))
    const sessions = mkdtempSync(join(tmpdir(), 'locator-reason-file-sessions-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }), () => rmSync(sessions, { recursive: true, force: true }))
    const file = join(root, 'keep.txt')
    writeFileSync(file, 'KEEP-MARKER stays searchable')
    const dir = join(sessions, '--workspace--', 'session-reason-toggle')
    mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({ type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'msg-toggle', content: [{ type: 'reasoning', text: 'TOGGLE-THINK-MARKER' }, { type: 'text', text: 'TOGGLE-FINAL-MARKER' }] } } })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(line)))
    const entries = [{ path: file, name: 'keep.txt', size: 30, mtime: Date.now(), ext: 'txt', dir: false }]
    let dumps = 0
    const runtime = { dump: async () => { dumps++; return { entries, next: 1, done: true } } } as unknown as LocatorRuntime
    const make = (includeReasoning: boolean) => new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 10, maxSessions: 10, includeReasoning })
    const first = make(false)
    cleanups.push(() => first.close())
    first.boot()
    await settle(first)
    expect((await first.search('KEEP-MARKER', 5)).length).toBe(1)
    expect((await first.search('TOGGLE-THINK-MARKER', 5)).length).toBe(0)
    const dumpsAfterFirst = dumps
    first.close()
    const second = make(true)
    cleanups.push(() => second.close())
    second.boot()
    await settle(second)
    expect((await second.search('TOGGLE-THINK-MARKER', 5)).length).toBe(1)
    expect((await second.search('KEEP-MARKER', 5)).length).toBe(1)
    expect(dumps).toBe(dumpsAfterFirst)
  })

  it('enforces a smaller maxFiles cap on an existing database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-cap-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-cap-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const entries: Array<{ path: string; name: string; size: number; mtime: number; ext: string; dir: boolean }> = []
    for (let i = 0; i < 3; i++) {
      const path = join(root, `cap-${String(i)}.txt`)
      writeFileSync(path, `CAP-MARKER ${i}`)
      entries.push({ path, name: `cap-${String(i)}.txt`, size: 20, mtime: Date.now(), ext: 'txt', dir: false })
    }
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const first = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 3, maxSessions: 0 })
    cleanups.push(() => first.close())
    first.boot()
    await settle(first)
    expect(first.status().files).toBe(3)
    first.close()
    const second = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 1, maxSessions: 0 })
    cleanups.push(() => second.close())
    second.boot()
    await settle(second)
    expect(second.status().files).toBe(1)
    expect(second.status().truncated).toBe(true)
  })


  it('reports live file-build progress and clears it when the build finishes', async () => {
    const state = mkdtempSync(join(tmpdir(), 'locator-progress-state-'))
    cleanups.push(() => rmSync(state, { recursive: true, force: true }))
    // Directory entries are scanned but never read: a long, deterministic pass
    // that yields often enough between pages to observe the counters mid-build.
    const pages: DumpPage[] = []
    for (let page = 0; page < 40; page++) {
      const entries: Array<{ path: string; name: string; size: number; mtime: number; ext: string; dir: boolean }> = []
      for (let i = 0; i < 500; i++) {
        entries.push({ path: `/virtual/page-${String(page)}-${String(i)}`, name: `page-${String(page)}`, size: 0, mtime: 1, ext: '', dir: true })
      }
      pages.push({ entries, next: page + 1, done: page === 39 })
    }
    let call = 0
    const runtime = { dump: async () => pages[Math.min(call++, pages.length - 1)]! } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    let seen: ContentProgress | undefined
    let seenState: ReturnType<ContentIndex['status']> | undefined
    for (let i = 0; i < 2000 && content.status().building; i++) {
      const snapshot = content.status()
      if (snapshot.progress !== undefined && snapshot.progress.phase === 'files' && snapshot.progress.scanned > 0) {
        seen = snapshot.progress
        seenState = snapshot
      }
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(seen).toBeDefined()
    expect(seen?.phase).toBe('files')
    expect(seen?.scanned).toBeGreaterThan(0)
    expect(seen?.path).toBeTypeOf('string')
    expect(seen?.startedAt).toBeGreaterThan(0)
    const schema = CONTENT_STATE_SCHEMA as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, seenState)).toEqual([])
    expect(content.status().progress).toBeUndefined()
    expect(validateJsonSchemaValue(schema, content.status())).toEqual([])
  })

  it('publishes live file counts while a full build is running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-live-files-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-live-files-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const entries: GenerationEntry[] = []
    const total = 900
    for (let index = 0; index < total; index++) {
      const name = 'note-' + String(index).padStart(3, '0') + '.md'
      const path = join(root, name)
      const body = 'LIVE-COUNT-' + String(index) + ' body'
      writeFileSync(path, body)
      entries.push({ path, name, size: Buffer.byteLength(body), mtime: Date.now() + index, ext: 'md', dir: false })
    }
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    let observed = 0
    let lastLive = 0
    for (let i = 0; i < 20_000 && content.status().building; i++) {
      const snapshot = content.status()
      const progress = snapshot.progress
      if (progress !== undefined && progress.phase === 'files' && progress.indexed > 0) {
        // 0.21.1: status().files is the live count, never the old database's
        // total (0 on a first build) while progress.indexed already climbs.
        expect(snapshot.files).toBe(progress.indexed)
        expect(snapshot.files).toBeGreaterThanOrEqual(lastLive)
        expect(snapshot.files).toBe(content.diagnostics().coverage.indexedFiles)
        lastLive = snapshot.files
        observed++
      }
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(observed).toBeGreaterThan(0)
    expect(content.status().building).toBe(false)
    expect(content.status().progress).toBeUndefined()
    expect(content.status().files).toBe(total)
  })

  it('reports the session phase while building session documents', async () => {
    const state = mkdtempSync(join(tmpdir(), 'locator-progress-session-state-'))
    const sessions = mkdtempSync(join(tmpdir(), 'locator-progress-sessions-'))
    cleanups.push(() => rmSync(state, { recursive: true, force: true }), () => rmSync(sessions, { recursive: true, force: true }))
    const line = (id: string) => JSON.stringify({ type: 'user/message', data: { id, seq: 1, content: [{ type: 'text', text: `progress marker ${id}` }] } })
    for (let i = 0; i < 20; i++) {
      const dir = join(sessions, '--workspace--', `session-progress-${String(i)}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(line(`msg-${String(i)}`))))
    }
    const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 100 })
    cleanups.push(() => content.close())
    content.start()
    let seen: ContentProgress | undefined
    for (let i = 0; i < 4000 && content.status().building; i++) {
      const snapshot = content.status()
      if (snapshot.progress !== undefined && snapshot.progress.phase === 'sessions') seen = snapshot.progress
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(seen).toBeDefined()
    expect(seen?.total).toBe(20)
    expect(seen?.scanned).toBeGreaterThan(0)
    expect(content.status().progress).toBeUndefined()
  })

  it('publishes live session and message counts while the session phase is running', async () => {
    const state = mkdtempSync(join(tmpdir(), 'locator-live-sessions-state-'))
    const sessions = mkdtempSync(join(tmpdir(), 'locator-live-sessions-'))
    cleanups.push(() => rmSync(state, { recursive: true, force: true }), () => rmSync(sessions, { recursive: true, force: true }))
    const line = (id: string) => JSON.stringify({ type: 'user/message', data: { id, seq: 1, content: [{ type: 'text', text: `live session marker ${id}` }] } })
    const total = 60
    for (let i = 0; i < total; i++) {
      const dir = join(sessions, '--workspace--', `session-live-${String(i)}`)
      mkdirSync(dir, { recursive: true })
      const log = join(dir, 'session.v4.jsonl.zstd')
      writeFileSync(log, zstdCompressSync(Buffer.from(line(`msg-${String(i)}`))))
      const settledAt = new Date(Date.now() - 120_000)
      utimesSync(log, settledAt, settledAt)
    }
    const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1_000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 100 })
    cleanups.push(() => content.close())
    content.start()
    let observed = false
    for (let i = 0; i < 20_000 && content.status().building; i++) {
      const snapshot = content.status()
      const progress = snapshot.progress
      if (progress !== undefined && progress.phase === 'sessions' && progress.indexed > 0) {
        // 0.21.1: the indexed session logs and their message documents are
        // already stored; status must publish them instead of keeping 0.
        expect(snapshot.sessions).toBe(progress.indexed)
        expect(snapshot.messages).toBeGreaterThanOrEqual(snapshot.sessions)
        observed = true
      }
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(observed).toBe(true)
    await settle(content)
    expect(content.status().sessions).toBe(total)
    expect(content.status().messages).toBe(total)
  })

  it('composes session and workspace filters by document kind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-ws-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-ws-state-'))
    const sessions = mkdtempSync(join(tmpdir(), 'locator-ws-sessions-'))
    cleanups.push(
      () => rmSync(root, { recursive: true, force: true }),
      () => rmSync(state, { recursive: true, force: true }),
      () => rmSync(sessions, { recursive: true, force: true }),
    )
    const filePath = join(root, 'notes.md')
    writeFileSync(filePath, 'WORKSPACE-MARKER file body')
    const sessionDir = join(sessions, '--workspace--', 'session-ws')
    mkdirSync(sessionDir, { recursive: true })
    const sessionFile = join(sessionDir, 'session.v4.jsonl.zstd')
    writeFileSync(sessionFile, zstdCompressSync(Buffer.from(JSON.stringify({ type: 'user/message', data: { id: 'm-ws', seq: 1, content: [{ type: 'text', text: 'WORKSPACE-MARKER session body' }] } }))))
    const runtime = { dump: async () => ({ entries: [{ path: filePath, name: 'notes.md', size: 24, mtime: Date.now(), ext: 'md', dir: false }], next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 10 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    // Workspace scope: session rows from this log AND file rows under this cwd.
    const both = await content.search('WORKSPACE-MARKER', 10, { sessionPath: sessionFile, pathPrefix: root })
    expect(both.hits.map(hit => hit.kind).sort()).toEqual(['file', 'session'])
    expect(both.warnings).toEqual([])
  })

  it('falls back to file hits when the caller session is not indexed yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-ws2-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-ws2-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const filePath = join(root, 'early.md')
    writeFileSync(filePath, 'EARLY-MARKER body')
    const runtime = { dump: async () => ({ entries: [{ path: filePath, name: 'early.md', size: 16, mtime: Date.now(), ext: 'md', dir: false }], next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 10 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    const filesOnly = await content.search('EARLY-MARKER', 10, { sessionId: 'not-indexed-yet', sessionUnavailable: 'files-only' })
    expect(filesOnly.hits.map(hit => hit.kind)).toEqual(['file'])
    expect(filesOnly.warnings).toContain('unknown-session')
    // The panel's session scope keeps the strict behaviour.
    const strict = await content.search('EARLY-MARKER', 10, { sessionId: 'not-indexed-yet' })
    expect(strict.hits).toEqual([])
    expect(strict.warnings).toContain('unknown-session')
  })


  it('keeps session scoping while file hits come from every root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-ws3-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-ws3-state-'))
    const sessions = mkdtempSync(join(tmpdir(), 'locator-ws3-sessions-'))
    cleanups.push(
      () => rmSync(root, { recursive: true, force: true }),
      () => rmSync(state, { recursive: true, force: true }),
      () => rmSync(sessions, { recursive: true, force: true }),
    )
    const filePath = join(root, 'all-roots.md')
    writeFileSync(filePath, 'ALLROOTS-MARKER file body')
    const sessionDir = join(sessions, '--workspace--', 'session-allroots')
    mkdirSync(sessionDir, { recursive: true })
    const sessionFile = join(sessionDir, 'session.v4.jsonl.zstd')
    writeFileSync(sessionFile, zstdCompressSync(Buffer.from(JSON.stringify({ type: 'user/message', data: { id: 'm-ar', seq: 1, content: [{ type: 'text', text: 'ALLROOTS-MARKER session body' }] } }))))
    const runtime = { dump: async () => ({ entries: [{ path: filePath, name: 'all-roots.md', size: 22, mtime: Date.now(), ext: 'md', dir: false }], next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 10 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    const scoped = await content.search('ALLROOTS-MARKER', 10, { sessionPath: sessionFile })
    expect(scoped.hits.map(hit => hit.kind)).toEqual(['session'])
    const allRoots = await content.search('ALLROOTS-MARKER', 10, { sessionPath: sessionFile, fileHitsAllRoots: true })
    expect(allRoots.hits.map(hit => hit.kind).sort()).toEqual(['file', 'session'])
  })


  it('indexes tool results only when contentIndexToolResults is on', async () => {
    const state = mkdtempSync(join(tmpdir(), 'locator-tools-state-'))
    const sessions = mkdtempSync(join(tmpdir(), 'locator-tools-sessions-'))
    cleanups.push(() => rmSync(state, { recursive: true, force: true }), () => rmSync(sessions, { recursive: true, force: true }))
    const dir = join(sessions, '--workspace--', 'session-tools')
    mkdirSync(dir, { recursive: true })
    const lines = [
      JSON.stringify({ type: 'user/message', data: { id: 'u-tools', seq: 1, content: [{ type: 'text', text: 'please run the tool' }] } }),
      JSON.stringify({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'shell', arguments: '{}' } }),
      JSON.stringify({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'TOOLRESULT-MARKER output body' }] } } }),
    ].join('\n')
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines)))
    const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const off = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 10 })
    cleanups.push(() => off.close())
    off.start()
    await settle(off)
    expect((await off.search('TOOLRESULT-MARKER', 5)).length).toBe(0)
    expect(off.status().toolResultsIndex).toBe(false)
    off.close()
    // Flipping the flag on reuses the database: only session rows are rebuilt.
    const on = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 10, includeToolResults: true })
    cleanups.push(() => on.close())
    on.start()
    await settle(on)
    expect(on.status().toolResultsIndex).toBe(true)
    const hits = await on.search('TOOLRESULT-MARKER', 5)
    expect(hits.length).toBe(1)
    expect(hits[0]?.kind).toBe('session')
    expect(hits[0]?.messageId).toBe('call-1')
    expect(hits[0]?.title).toBe('shell')
  })


  it('records session cwd and filters session documents by allowed ids', async () => {
    const state = mkdtempSync(join(tmpdir(), 'locator-cwd-state-'))
    const sessions = mkdtempSync(join(tmpdir(), 'locator-cwd-sessions-'))
    cleanups.push(() => rmSync(state, { recursive: true, force: true }), () => rmSync(sessions, { recursive: true, force: true }))
    const dir = join(sessions, '--work-a--', 'session-ws-a')
    mkdirSync(dir, { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session', version: 4, id: 'session-ws-a', createdAt: 1, cwd: '/work/a', isSeeded: false, delegationDepth: 0 }),
      JSON.stringify({ type: 'user/message', data: { id: 'm-cwd', seq: 1, content: [{ type: 'text', text: 'CWD-MARKER body' }] } }),
    ].join('\n')
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines)))
    const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 10 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.sessionCwd('session-ws-a')).toBe('/work/a')
    const sameWorkspace = content.authorizedSessionIds('/work/a', 'caller-session')
    expect(sameWorkspace.has('session-ws-a')).toBe(true)
    expect(sameWorkspace.has('caller-session')).toBe(true)
    const otherWorkspace = content.authorizedSessionIds('/work/b', 'caller-session')
    expect(otherWorkspace.has('session-ws-a')).toBe(false)
    const allowed = await content.search('CWD-MARKER', 5, { allowedSessionIds: ['session-ws-a'] })
    expect(allowed.hits.some(hit => hit.sessionId === 'session-ws-a')).toBe(true)
    const denied = await content.search('CWD-MARKER', 5, { allowedSessionIds: ['some-other-session'] })
    expect(denied.hits).toHaveLength(0)
    const filesOnly = await content.search('CWD-MARKER', 5, { allowedSessionIds: [] })
    expect(filesOnly.hits).toHaveLength(0)
  })


  it('extracts URL, spill, attachment and session-event evidence refs in the same pass', async () => {
    const state = mkdtempSync(join(tmpdir(), 'locator-refs-state-'))
    const sessions = mkdtempSync(join(tmpdir(), 'locator-refs-sessions-'))
    cleanups.push(() => rmSync(state, { recursive: true, force: true }), () => rmSync(sessions, { recursive: true, force: true }))
    const dir = join(sessions, '--work-a--', 'session-refs-a')
    mkdirSync(dir, { recursive: true })
    const sha = 'b'.repeat(64)
    const spillPath = '/tmp/dsh-spill-test/session-refs-a/abcdef-notes.txt'
    const lines = [
      JSON.stringify({ type: 'session', version: 4, id: 'session-refs-a', createdAt: 1, cwd: '/work/a' }),
      JSON.stringify({ type: 'user/message', data: { id: 'm-user', source: { kind: 'user' }, content: [
        { type: 'text', text: 'look at this image' },
        { type: 'image', attachment: { attachmentId: `sha256:${sha}`, mediaType: 'image/png', bytes: 12 } },
      ] } }),
      JSON.stringify({ type: 'assistant/message', data: { turn: 0, step: 0, message: { id: 'm-assistant', content: [{ type: 'text', text: 'the answer' }] } } }),
      JSON.stringify({ type: 'tool/result', data: { seq: 3, message: { toolCallId: 'call-1', content: [
        { type: 'text', text: `(Omitted 5000 bytes. Full formatted result stored at: ${spillPath}. Use read with offset/limit, or grep this path to search within it.)` },
      ] }, meta: { sources: [{ url: 'https://example.com/a.pdf#page=3', title: 'Paper', snippet: 'abstract' }], truncated: false } } }),
      JSON.stringify({ type: 'tool/result', data: { seq: 4, message: { toolCallId: 'call-2', content: [{ type: 'text', text: 'fetched' }] }, meta: { url: 'https://example.com/b', statusCode: 200, truncated: false } } }),
    ].join('\n')
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines)))
    const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 10 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    const { attachmentRef, sessionEventRef, spillRef, urlRef } = await import('../src/refs.ts')
    const urls = content.refsFor(urlRef('https://example.com/a.pdf#page=3'))
    expect(urls).toHaveLength(1)
    expect(urls[0]).toMatchObject({ kind: 'url', sessionId: 'session-refs-a', messageId: 'call-1', origin: 'web_search' })
    expect(content.refsFor(urlRef('https://example.com/b'))).toHaveLength(1)
    expect(content.refsFor(spillRef({ path: spillPath, sessionId: 'session-refs-a', seq: 2 }))).toHaveLength(1)
    expect(content.refsFor(attachmentRef({ sha256: sha }))[0]).toMatchObject({ kind: 'attachment', origin: 'attachment', messageId: 'm-user' })
    const event = content.refsFor(sessionEventRef({ sessionId: 'session-refs-a', seq: 1 }))
    expect(event[0]).toMatchObject({ kind: 'session-event', messageId: 'm-assistant', seq: 1 })
    expect(content.refsForMessage('session-refs-a', 'm-user').some(row => row.kind === 'attachment')).toBe(true)
    const counts = content.refCount()
    expect(counts.occurrences).toBeGreaterThanOrEqual(5)
    // 0.17.0: ref counts for locator_status (distinct identities per kind).
    const refsByKind = content.refsByKind()
    expect(refsByKind.total).toBe(counts.refs)
    expect(refsByKind.byKind).toMatchObject({ url: 2, 'session-event': 2, spill: 1, attachment: 1 })
    expect(content.status().refs).toEqual(refsByKind)
    // 0.17.0: locator_find looks the stored session-event ref up by message id.
    const events = content.sessionEventRefs('session-refs-a', ['m-assistant', 'm-user'])
    expect(events.get('m-assistant')).toEqual({ seq: 1, ref: sessionEventRef({ sessionId: 'session-refs-a', seq: 1 }) })
    expect(events.get('m-user')).toEqual({ seq: 0, ref: sessionEventRef({ sessionId: 'session-refs-a', seq: 0 }) })
    expect(content.sessionEventRefs('session-refs-a', [])).toEqual(new Map())
    // 0.17.0: the lazy missing marker is written once and keeps counts stable.
    const spillKey = spillRef({ path: spillPath, sessionId: 'session-refs-a', seq: 2 })
    expect(content.markRefMissing(spillKey)).toBe(true)
    expect(content.refsFor(spillKey)[0]?.meta).toContain('"missing":true')
    expect(content.markRefMissing(spillKey)).toBe(false)
    expect(content.refsByKind().total).toBe(refsByKind.total)
    // An attachment occurrence already has metadata: the marker must merge, not replace.
    const attachmentKey = attachmentRef({ sha256: sha })
    expect(content.markRefMissing(attachmentKey)).toBe(true)
    const markedAttachment = content.refsFor(attachmentKey)[0]
    expect(markedAttachment?.meta).toContain('"missing":true')
    expect(markedAttachment?.meta).toContain('mediaType')
    expect(content.markRefMissing(attachmentKey)).toBe(false)
    // Additive upgrade: dropping the refs tables must make the next refresh
    // re-read session logs only and repopulate refs without touching file rows.
    const before = content.status()
    content.close()
    const raw = new DatabaseSync(join(state, 'content.db'))
    raw.exec('DROP TABLE refs'); raw.exec('DROP TABLE refs_meta'); raw.close()
    const reopened = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 10 })
    cleanups.push(() => reopened.close())
    reopened.start()
    await settle(reopened)
    expect(reopened.status().files).toBe(before.files)
    expect(reopened.refsFor(urlRef('https://example.com/a.pdf#page=3'))).toHaveLength(1)
    const version = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    expect(Number((version.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version)).toBe(4)
    version.close()
    content.close()
  })


})

/** Minimal but valid docx package whose body is one paragraph per line. */
function minimalDocx(text: string): Uint8Array {
  const wordNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="' + wordNs + '"><w:body>'
    + text.split('\n').map(paragraph => '<w:p><w:r><w:t>' + paragraph + '</w:t></w:r></w:p>').join('')
    + '</w:body></w:document>'
  const contentTypes = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  const relationships = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(relationships),
    'word/document.xml': strToU8(document),
  })
}

describe('document extraction (P1-1)', () => {
  const baseOptions = { sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 }

  it('indexes an extracted DOCX body and exposes its format on opt-in hits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-doc-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-doc-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const docPath = join(root, 'brief.docx')
    const textPath = join(root, 'notes.md')
    writeFileSync(docPath, minimalDocx('quarterly locator docx marker'))
    writeFileSync(textPath, 'plain text locator marker')
    const entries = [docPath, textPath].map(path => ({ path, name: basename(path), size: statSync(path).size, mtime: Date.now(), ext: 'docx', dir: false }))
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { ...baseOptions, stateDir: state, attachHitFormats: true })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().error).toBe('')
    expect(content.status().files).toBe(2)
    expect(content.docFormat(docPath)).toBe('docx')
    expect(content.docFormat(textPath)).toBeUndefined()
    expect(content.formatsFor([docPath, textPath]).get(docPath)).toBe('docx')
    expect(content.formatsFor([textPath]).size).toBe(0)
    const hits = await content.search('locator docx marker', 5)
    const docHit = hits.find(hit => hit.path === docPath)
    expect(docHit).toBeDefined()
    expect(docHit?.format).toBe('docx')
    const textHits = await content.search('plain text locator marker', 5)
    const textHit = textHits.find(hit => hit.path === textPath)
    expect(textHit).toBeDefined()
    expect(textHit !== undefined && 'format' in textHit).toBe(false)
    const raw = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    const row = raw.prepare('SELECT m.format AS format FROM docs_meta m JOIN paths p ON p.id = m.path_id WHERE p.path = ?').get(docPath) as { format?: string } | undefined
    raw.close()
    expect(row?.format).toBe('docx')
    // Hit enrichment is opt-in: without the flag a search carries no format, so
    // a tool schema that does not declare it yet cannot reject the output.
    content.close()
    const plain = new ContentIndex(runtime, { ...baseOptions, stateDir: state })
    cleanups.push(() => plain.close())
    plain.boot()
    await settle(plain)
    const plainHit = (await plain.search('locator docx marker', 5)).find(hit => hit.path === docPath)
    expect(plainHit).toBeDefined()
    expect(plainHit !== undefined && 'format' in plainHit).toBe(false)
    expect(plain.docFormat(docPath)).toBe('docx')
  })

  it('leaves documents out when extraction is disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-doc-off-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-doc-off-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const docPath = join(root, 'brief.docx')
    writeFileSync(docPath, minimalDocx('disabled locator docx marker'))
    const entries = [{ path: docPath, name: 'brief.docx', size: statSync(docPath).size, mtime: Date.now(), ext: 'docx', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { ...baseOptions, stateDir: state, extractDocuments: false })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().files).toBe(0)
    expect((await content.search('disabled locator docx marker', 5)).length).toBe(0)
  })

  it('skips oversized documents with a warning instead of reading them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-doc-large-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-doc-large-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const docPath = join(root, 'brief.docx')
    writeFileSync(docPath, minimalDocx('oversized locator docx marker'))
    const entries = [{ path: docPath, name: 'brief.docx', size: statSync(docPath).size, mtime: Date.now(), ext: 'docx', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { ...baseOptions, stateDir: state, extractMaxBytes: 16 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().files).toBe(0)
    expect(content.status().warnings).toContain('content-document-too-large')
  })

  it('skips paths rejected by the isIndexable scope hook before reading them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-doc-scope-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-doc-scope-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const skipped = join(root, 'secret.go')
    const kept = join(root, 'notes.md')
    writeFileSync(skipped, 'package demo\n\nfunc HiddenMarker() {}\n')
    writeFileSync(kept, 'visible locator marker')
    const entries = [skipped, kept].map(path => ({ path, name: basename(path), size: statSync(path).size, mtime: Date.now(), ext: path.split('.').pop() ?? '', dir: false }))
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { ...baseOptions, stateDir: state, isIndexable: path => !path.endsWith('.go') })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().files).toBe(1)
    expect((await content.search('HiddenMarker', 5)).length).toBe(0)
    expect((await content.search('visible locator marker', 5)).length).toBeGreaterThan(0)
    expect(content.outline(skipped)).toEqual([])
  })

  it('falls back to the OCR hook for a PDF without a text layer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-doc-ocr-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-doc-ocr-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const pdfPath = join(root, 'scan.pdf')
    writeFileSync(pdfPath, 'this is not really a pdf file')
    const calls: Array<[string, string]> = []
    const entries = [{ path: pdfPath, name: 'scan.pdf', size: statSync(pdfPath).size, mtime: Date.now(), ext: 'pdf', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, {
      ...baseOptions,
      stateDir: state,
      ocr: async (path, format) => { calls.push([path, format]); return 'ocr scanned locator marker' },
    })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().files).toBe(1)
    expect(content.docFormat(pdfPath)).toBe('pdf')
    expect(calls).toEqual([[pdfPath, 'pdf']])
    expect((await content.search('ocr scanned locator marker', 5)).some(hit => hit.path === pdfPath)).toBe(true)
  })

  it('writes the normalized schema v4 at user_version 4', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-doc-schema-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-doc-schema-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const docPath = join(root, 'brief.docx')
    writeFileSync(docPath, minimalDocx('schema locator docx marker'))
    const entries = [{ path: docPath, name: 'brief.docx', size: statSync(docPath).size, mtime: Date.now(), ext: 'docx', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { ...baseOptions, stateDir: state })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    const raw = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    const version = raw.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    const columns = (table: string): Set<string> => new Set(
      (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>)
        .map(row => row.name)
        .filter((name): name is string => typeof name === 'string'),
    )
    const docsMeta = columns('docs_meta')
    const symbols = columns('symbols')
    const paths = columns('paths')
    const partialIndexes = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('docs_meta_file_path', 'docs_meta_session_key')")
      .all() as Array<{ name?: string }>).map(row => row.name)
    raw.close()
    expect(Number(version?.user_version)).toBe(4)
    expect(content.diagnostics().schemaVersion).toBe(4)
    // docs_meta: normalized identity columns, no v3 path text/doc_key/kind.
    expect([...docsMeta].sort()).toEqual(['format', 'kind_id', 'mtime', 'node_key', 'path_id', 'rowid', 'session_key'])
    expect(symbols.has('path_id')).toBe(true)
    expect(symbols.has('path')).toBe(false)
    expect(paths.has('id')).toBe(true)
    expect(paths.has('path')).toBe(true)
    expect(partialIndexes.sort()).toEqual(['docs_meta_file_path', 'docs_meta_session_key'])
  })
})

describe('code symbols and repo map (P1-2)', () => {
  const baseOptions = { sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 }
  const fixtures: Array<[string, string]> = [
    ['main.go', ['package demo', '', 'type Server struct {', '\tName string', '}', '', 'func (s *Server) Start(port int) error {', '\treturn nil', '}', '', 'func NewServer() *Server {', '\treturn &Server{}', '}', ''].join('\n')],
    ['app.ts', ['export interface Point { x: number }', '', 'export class Shape {', '  move(dx: number): void {}', '}', '', 'export function area(p: Point): number { return 0 }', ''].join('\n')],
    ['tool.py', ['class Engine:', '    def start(self):', '        return True', '', 'def helper(value):', '    return value', '', 'MAX_RETRIES = 3', ''].join('\n')],
    ['README.md', ['# Title', '', '## Section', '', '### Deep', ''].join('\n')],
  ]

  async function buildSymbolIndex(): Promise<{ root: string; state: string; content: ContentIndex; paths: Record<string, string> }> {
    const root = mkdtempSync(join(tmpdir(), 'locator-symbols-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-symbols-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const paths: Record<string, string> = {}
    const entries = fixtures.map(([name, body]) => {
      const path = join(root, name)
      writeFileSync(path, body)
      paths[name] = path
      return { path, name, size: statSync(path).size, mtime: Date.now(), ext: name.split('.').pop() ?? '', dir: false }
    })
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { ...baseOptions, stateDir: state })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    return { root, state, content, paths }
  }

  it('stores symbols per code file and serves outline() in line order', async () => {
    const { content, paths } = await buildSymbolIndex()
    const go = content.outline(paths['main.go'] ?? '')
    expect(go.map(symbol => symbol.name)).toEqual(['Server', 'Start', 'NewServer'])
    expect(go[0]).toMatchObject({ kind: 'struct', line: 3, language: 'go' })
    expect(go[1]).toMatchObject({ kind: 'method', scope: 'Server', line: 7 })
    const python = content.outline(paths['tool.py'] ?? '')
    expect(python.map(symbol => symbol.name)).toEqual(['Engine', 'start', 'helper', 'MAX_RETRIES'])
    expect(python[1]).toMatchObject({ kind: 'method', scope: 'Engine' })
    expect(python[3]).toMatchObject({ kind: 'constant' })
    const markdown = content.outline(paths['README.md'] ?? '')
    expect(markdown.map(symbol => [symbol.name, symbol.kind])).toEqual([['Title', 'heading'], ['Section', 'heading'], ['Deep', 'heading']])
    expect(content.outline(paths['main.go'] ?? '')?.length).toBe(3)
    expect(content.outline('/tmp/not-indexed.go')).toEqual([])
  })

  it('finds symbols by name and honours the limit', async () => {
    const { content, paths } = await buildSymbolIndex()
    const server = content.findSymbols('Server')
    expect(server.length).toBeGreaterThan(0)
    expect(server[0]).toMatchObject({ path: paths['main.go'], kind: 'struct', line: 3 })
    const shape = content.findSymbols('Shape')
    expect(shape[0]).toMatchObject({ path: paths['app.ts'], kind: 'class' })
    expect(content.findSymbols('LocatorNotPresent')).toEqual([])
    // LIKE metacharacters are escaped: a bare % must not match every symbol.
    expect(content.findSymbols('%')).toEqual([])
    expect(content.findSymbols('   ')).toEqual([])
    expect(content.findSymbols('e', 1)).toHaveLength(1)
    expect(content.findSymbols('e', 500).length).toBeLessThanOrEqual(200)
  })

  it('builds a token-budgeted repo map ranked by symbol count', async () => {
    const { content, paths, root } = await buildSymbolIndex()
    const all = content.repoMap([root], 100_000)
    expect(all).toHaveLength(4)
    expect(all[0]?.path).toBe(paths['app.ts'])
    expect(all[0]?.symbols.length).toBe(4)
    expect(content.repoMap([root], 0)).toEqual([])
    const costs = all.map(entry => estimateSymbolTokens(entry.path, entry.symbols))
    const cheapest = Math.min(...costs)
    const tight = content.repoMap([root], cheapest)
    expect(tight.length).toBeGreaterThanOrEqual(1)
    expect(tight.length).toBeLessThan(4)
    const used = tight.reduce((sum, entry) => sum + estimateSymbolTokens(entry.path, entry.symbols), 0)
    expect(used).toBeLessThanOrEqual(cheapest)
    expect(content.repoMap([join(root, 'elsewhere')], 100_000)).toEqual([])
  })

  it('rebuilds a database with a damaged v4 shape instead of migrating online', async () => {
    const { content, state, paths } = await buildSymbolIndex()
    const indexed = content.status().files
    content.close()
    const raw = new DatabaseSync(join(state, 'content.db'))
    // A file whose normalized tables were dropped/partially created: the v4 SQL
    // cannot read it, and no online migration exists. It must be quarantined
    // and rebuilt transactionally rather than half-written.
    raw.exec('DROP TABLE symbols')
    raw.exec('DROP TABLE paths')
    raw.close()
    const entries = fixtures.map(([name]) => {
      const path = paths[name] ?? ''
      return { path, name, size: statSync(path).size, mtime: statSync(path).mtimeMs, ext: name.split('.').pop() ?? '', dir: false }
    })
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const reopened = new ContentIndex(runtime, { ...baseOptions, stateDir: state })
    cleanups.push(() => reopened.close())
    reopened.boot()
    await settle(reopened)
    expect(reopened.status().error).toBe('')
    expect(reopened.status().warnings).not.toContain('content-db-incompatible')
    expect(reopened.diagnostics().warningCounts?.['content-db-incompatible']).toBeGreaterThanOrEqual(1)
    expect(contentMeta(state).get('warn:content-db-incompatible') ?? 0).toBeGreaterThanOrEqual(1)
    expect(readdirSync(state).filter(name => name.startsWith('content.db.corrupt-'))).toHaveLength(1)
    expect(reopened.status().files).toBe(indexed)
    expect(reopened.outline(paths['main.go'] ?? '').map(symbol => symbol.name)).toEqual(['Server', 'Start', 'NewServer'])
    expect(reopened.findSymbols('Shape').length).toBeGreaterThan(0)
    const check = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    const version = check.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    const pathsTable = check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'paths'").get() as { n?: number } | undefined
    check.close()
    expect(Number(version?.user_version)).toBe(4)
    expect(Number(pathsTable?.n)).toBe(1)
  })

  it('normalizes paths and persists symbol kind/language as integer codes', async () => {
    const { content, state, paths } = await buildSymbolIndex()
    const db = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    const pathRows = db.prepare('SELECT id, path FROM paths ORDER BY id').all() as Array<{ id: number; path: string }>
    // One dictionary row per distinct stored spelling: four fixtures, no dupes.
    expect(pathRows).toHaveLength(Object.keys(paths).length)
    expect(new Set(pathRows.map(row => row.path)).size).toBe(pathRows.length)
    const mainId = pathRows.find(row => row.path === paths['main.go'])?.id
    expect(mainId).toBeDefined()
    const meta = db.prepare('SELECT COUNT(*) AS n FROM docs_meta WHERE kind_id = 0 AND path_id = ?').get(mainId ?? -1) as { n?: number }
    expect(Number(meta.n)).toBe(1)
    const codes = db.prepare('SELECT name, kind, language FROM symbols WHERE path_id = ? ORDER BY line, name').all(mainId ?? -1) as Array<{ name: string; kind: number; language: number }>
    expect(codes.map(row => row.name)).toEqual(['Server', 'Start', 'NewServer'])
    for (const row of codes) {
      expect(Number.isInteger(row.kind)).toBe(true)
      expect(Number.isInteger(row.language)).toBe(true)
    }
    db.close()
    // The public interface decodes the codes back into the string names.
    const outline = content.outline(paths['main.go'] ?? '')
    expect(outline.map(symbol => [symbol.kind, symbol.language])).toEqual([['struct', 'go'], ['method', 'go'], ['function', 'go']])
  })

  it('does not index symbols when indexSymbols is disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-symbols-off-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-symbols-off-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'main.go')
    writeFileSync(path, 'package demo\n\nfunc main() {}\n')
    const entries = [{ path, name: 'main.go', size: statSync(path).size, mtime: Date.now(), ext: 'go', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { ...baseOptions, stateDir: state, indexSymbols: false })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().files).toBe(1)
    expect(content.outline(path)).toEqual([])
    expect(content.findSymbols('main')).toEqual([])
    expect(content.repoMap([root], 1000)).toEqual([])
  })
})

describe('symbol lookups across a symlinked root', () => {
  it('serves outline/repoMap by the configured-root spelling and by the real path', async () => {
    const base = mkdtempSync(join(tmpdir(), 'locator-symlink-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-symlink-state-'))
    const realRoot = join(base, 'real-root')
    const linkRoot = join(base, 'link-root')
    mkdirSync(realRoot)
    try {
      symlinkSync(realRoot, linkRoot, 'dir')
    } catch {
      // Windows without the symlink privilege: nothing to verify on this host.
      rmSync(base, { recursive: true, force: true })
      rmSync(state, { recursive: true, force: true })
      return
    }
    cleanups.push(() => rmSync(base, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    // The engine indexes through the configured root, so every stored row keeps
    // the symlink spelling even though the tool layer authorizes real paths.
    const indexed = join(linkRoot, 'main.go')
    writeFileSync(indexed, 'package demo\n\ntype Server struct{}\n\nfunc Start() error { return nil }\n')
    const entries = [{ path: indexed, name: 'main.go', size: statSync(indexed).size, mtime: Date.now(), ext: 'go', dir: false }]
    const runtime = { roots: [linkRoot], dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0, stateDir: state })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    const realFile = join(realRoot, 'main.go')
    // Both spellings resolve to the same stored rows.
    expect(content.outline(indexed).map(symbol => symbol.name)).toEqual(['Server', 'Start'])
    expect(content.outline(realFile).map(symbol => symbol.name)).toEqual(['Server', 'Start'])
    expect(content.findSymbols('Server').map(hit => hit.path)).toEqual([indexed])
    expect(content.indexedMtime('file', realFile)).toBe(entries[0]?.mtime)
    // repoMap canonicalizes both sides: a real root finds the symlink-spelled
    // rows, and a sibling directory still selects nothing.
    expect(content.repoMap([realRoot], 100_000).map(file => file.path)).toEqual([indexed])
    expect(content.repoMap([linkRoot], 100_000).map(file => file.path)).toEqual([indexed])
    expect(content.repoMap([join(realRoot, 'elsewhere')], 100_000)).toEqual([])
    // The same lookups keep working through a plain (non-symlink) real path.
    const plain = join(realpathSync.native(base), 'real-root')
    expect(content.outline(join(plain, 'main.go')).map(symbol => symbol.name)).toEqual(['Server', 'Start'])
    // pathSpellings semantics survive normalization: only the engine spelling is
    // stored in the dictionary, and every alias resolves to that one row.
    const db = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    const storedPaths = (db.prepare('SELECT path FROM paths').all() as Array<{ path?: string }>).map(row => row.path)
    const symbols = db.prepare('SELECT COUNT(*) AS n FROM symbols s JOIN paths p ON p.id = s.path_id WHERE p.path = ?').get(indexed) as { n?: number }
    db.close()
    expect(storedPaths).toEqual([indexed])
    expect(Number(symbols.n)).toBeGreaterThan(0)
  })
})

describe('setRefMeta (P1-5 helper)', () => {
  it('merges a JSON patch into refs.meta, preserves the missing marker and bounds size', async () => {
    const sessions = mkdtempSync(join(tmpdir(), 'locator-ref-meta-sessions-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-ref-meta-state-'))
    cleanups.push(() => rmSync(sessions, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const dir = join(sessions, '--work--', 'session-ref-meta')
    mkdirSync(dir, { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session', version: 4, id: 'session-ref-meta', createdAt: 1, cwd: '/work' }),
      JSON.stringify({ type: 'assistant/message', data: { turn: 0, step: 0, message: { id: 'm-1', content: [{ type: 'text', text: 'refreshable evidence' }] } } }),
    ].join('\n')
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines)))
    const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 10 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    const { sessionEventRef, urlRef } = await import('../src/refs.ts')
    const key = sessionEventRef({ sessionId: 'session-ref-meta', seq: 0 })
    expect(content.refsFor(key)).toHaveLength(1)
    expect(content.setRefMeta('', { etag: 'x' })).toBe(false)
    expect(content.setRefMeta(urlRef('https://example.com/missing'), { etag: 'x' })).toBe(false)
    expect(content.setRefMeta(key, {})).toBe(false)
    expect(content.setRefMeta(key, { etag: 'W/"abc"', lastModified: 'Tue, 01 Jan 2030 00:00:00 GMT' })).toBe(true)
    const stored = content.refsFor(key)[0]?.meta
    expect(stored).toBeTruthy()
    expect(JSON.parse(stored ?? '{}')).toMatchObject({ etag: 'W/"abc"', lastModified: 'Tue, 01 Jan 2030 00:00:00 GMT' })
    // The lazy missing marker must survive later freshness patches.
    expect(content.markRefMissing(key)).toBe(true)
    expect(content.setRefMeta(key, { etag: 'W/"def"' })).toBe(true)
    const merged = JSON.parse(content.refsFor(key)[0]?.meta ?? '{}') as Record<string, unknown>
    expect(merged.missing).toBe(true)
    expect(merged.etag).toBe('W/"def"')
    expect(merged.lastModified).toBe('Tue, 01 Jan 2030 00:00:00 GMT')
    // A patch that cannot fit the bounded column must not corrupt the stored JSON.
    const before = content.refsFor(key)[0]?.meta
    expect(content.setRefMeta(key, { blob: 'x'.repeat(2000) })).toBe(false)
    expect(content.refsFor(key)[0]?.meta).toBe(before)
    expect(JSON.parse(content.refsFor(key)[0]?.meta ?? '{}')).toBeTypeOf('object')
  })
})

/** Read every content_meta flag from a finished database. */
function contentMeta(state: string): Map<string, number> {
  const db = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
  const rows = db.prepare('SELECT key, value FROM content_meta').all() as Array<{ key: string; value: number }>
  db.close()
  return new Map(rows.map(row => [row.key, Number(row.value)]))
}

interface GenerationEntry { path: string; name: string; size: number; mtime: number; ext: string; dir: boolean }
interface GenerationCall { after: number; limit: number; opts?: { since?: number; mtimeFrom?: number } }

/** A fake engine that honors the dump since/mtimeFrom filters like the real one. */
function generationEngine(root: string): {
  live: string
  engine: { generation: number; entries: GenerationEntry[]; calls: GenerationCall[] }
  runtime: LocatorRuntime
} {
  const live = join(root, 'live.md')
  writeFileSync(live, 'GENERATION-FIRST marker')
  const engine = {
    generation: 1,
    entries: [{ path: live, name: 'live.md', size: statSync(live).size, mtime: Date.now() - 60_000, ext: 'md', dir: false }] as GenerationEntry[],
    calls: [] as GenerationCall[],
  }
  const runtime = {
    dump: async (after: number, limit: number, opts?: { since?: number; mtimeFrom?: number }) => {
      engine.calls.push({ after, limit, ...(opts === undefined ? {} : { opts }) })
      if (opts?.since !== undefined && opts.since === engine.generation) {
        return { entries: [], next: 0, done: true, unchanged: true, generation: engine.generation }
      }
      const filtered = opts?.mtimeFrom === undefined
        ? engine.entries
        : engine.entries.filter(entry => entry.mtime >= (opts.mtimeFrom as number))
      return { entries: filtered, next: filtered.length, done: true, generation: engine.generation }
    },
  } as unknown as LocatorRuntime
  return { live, engine, runtime }
}

describe('file-index generation fast path (P0-7)', () => {
  it('skips the dump walk when the engine generation is unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-gen-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-gen-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const { live, engine, runtime } = generationEngine(root)
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0, fullSweepIntervalMs: 3_600_000 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().files).toBe(1)
    const callsAfterBuild = engine.calls.length
    // The file changes on disk but the engine does not report a new generation
    // (for example the watcher has not fired yet): the fast path must not dump.
    writeFileSync(live, 'GENERATION-SECOND marker')
    content.refresh()
    await settle(content)
    const probe = engine.calls.slice(callsAfterBuild)
    expect(probe).toHaveLength(1)
    expect(probe[0]?.opts?.since).toBe(1)
    expect((await content.search('GENERATION-SECOND', 5)).length).toBe(0)
    expect((await content.search('GENERATION-FIRST', 5)).length).toBeGreaterThan(0)
  })

  it('dumps only files newer than the stored floor when the generation advances', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-gen2-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-gen2-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const { live, engine, runtime } = generationEngine(root)
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0, fullSweepIntervalMs: 3_600_000 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    writeFileSync(live, 'GENERATION-THIRD marker')
    engine.generation = 2
    const entry = engine.entries[0]
    if (entry === undefined) throw new Error('fixture entry missing')
    entry.mtime = Date.now()
    entry.size = statSync(live).size
    content.refresh()
    await settle(content)
    const incremental = engine.calls[engine.calls.length - 1]
    expect(incremental?.opts?.since).toBe(1)
    expect(incremental?.opts?.mtimeFrom).toBeGreaterThan(0)
    expect((await content.search('GENERATION-THIRD', 5)).length).toBeGreaterThan(0)
    expect((await content.search('GENERATION-FIRST', 5)).length).toBe(0)
    expect(contentMeta(state).get('engine_generation')).toBe(2)
  })

  it('removes documents for deleted files with the periodic full sweep', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-gen3-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-gen3-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const { live, engine, runtime } = generationEngine(root)
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0, fullSweepIntervalMs: 1 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().files).toBe(1)
    await new Promise<void>(resolve => { setTimeout(resolve, 5) })
    rmSync(live)
    engine.generation = 2
    engine.entries = []
    content.refresh()
    await settle(content)
    const sweep = engine.calls[engine.calls.length - 1]
    expect(sweep?.opts).toBeUndefined()
    expect(content.status().files).toBe(0)
    expect((await content.search('GENERATION-FIRST', 5)).length).toBe(0)
  })
})

describe('body-budget eviction and coverage (P0-8)', () => {
  it('retains the newest documents under a tight budget without evicting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-evict-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-evict-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const base = Date.now() - 60_000
    const specs = [
      { name: 'a.md', marker: 'EVICT-A', mtime: base },
      { name: 'b.md', marker: 'EVICT-B', mtime: base + 1_000 },
      { name: 'c.md', marker: 'EVICT-C', mtime: base + 2_000 },
    ]
    const entries = specs.map(spec => {
      const path = join(root, spec.name)
      writeFileSync(path, spec.marker + ' ' + 'x'.repeat(145))
      return { path, name: spec.name, size: statSync(path).size, mtime: spec.mtime, ext: 'md', dir: false }
    })
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, {
      stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 400, maxFiles: 100, maxSessions: 0, evict: true,
    })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    // 0.20.2 P0-1: the plan keeps the newest documents and never reads the ones
    // that cannot fit, so no row is ever evicted during a fresh build.
    expect(content.status().files).toBe(2)
    expect(content.status().truncated).toBe(true)
    const diagnostics = content.diagnostics()
    expect(diagnostics.coverage.evictedDocs).toBe(0)
    expect(diagnostics.coverage.bodyBytes).toBeLessThanOrEqual(400)
    expect((await content.search('EVICT-A', 5)).length).toBe(0)
    expect((await content.search('EVICT-C', 5)).length).toBeGreaterThan(0)

    // An incremental refresh still evicts the oldest row to admit a newer file
    // when the budget is already saturated (the eviction path stays intact).
    const d = join(root, 'd.md')
    writeFileSync(d, 'EVICT-D ' + 'x'.repeat(145))
    const next = [...entries, { path: d, name: 'd.md', size: statSync(d).size, mtime: base + 3_000, ext: 'md', dir: false }]
    const refreshRuntime = { dump: async () => ({ entries: next, next: next.length, done: true }) } as unknown as LocatorRuntime
    const second = new ContentIndex(refreshRuntime, {
      stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 400, maxFiles: 100, maxSessions: 0, evict: true,
    })
    cleanups.push(() => second.close())
    second.boot()
    await settle(second)
    expect(second.status().error).toBe('')
    expect(second.status().files).toBe(2)
    expect(second.diagnostics().coverage.evictedDocs).toBeGreaterThanOrEqual(1)
    expect((await second.search('EVICT-D', 5)).length).toBeGreaterThan(0)
    expect((await second.search('EVICT-B', 5)).length).toBe(0)
    // Eviction releases the evicted file's path dictionary row, so the paths
    // table holds exactly the identities docs_meta still references.
    const check = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    const orphans = check.prepare('SELECT COUNT(*) AS n FROM paths p WHERE NOT EXISTS (SELECT 1 FROM docs_meta WHERE path_id = p.id) AND NOT EXISTS (SELECT 1 FROM symbols WHERE path_id = p.id)').get() as { n?: number }
    const pathRows = check.prepare('SELECT COUNT(*) AS n FROM paths').get() as { n?: number }
    const referenced = check.prepare('SELECT COUNT(DISTINCT path_id) AS n FROM docs_meta').get() as { n?: number }
    check.close()
    expect(Number(orphans.n)).toBe(0)
    expect(Number(pathRows.n)).toBe(Number(referenced.n))
  })

  it('reports persisted coverage counters without a body scan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-coverage-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-coverage-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const entries = Array.from({ length: 5 }, (_, index) => {
      const path = join(root, 'doc-' + String(index) + '.md')
      writeFileSync(path, 'COVERAGE-' + String(index) + ' body')
      return { path, name: 'doc-' + String(index) + '.md', size: 20, mtime: Date.now() + index, ext: 'md', dir: false }
    })
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 3, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    const coverage = content.diagnostics().coverage
    expect(coverage.indexedFiles).toBe(3)
    expect(coverage.candidateFiles).toBe(5)
    expect(coverage.ratio).toBeCloseTo(0.6)
    expect(coverage.fileBudget).toBe(3)
    expect(content.status().truncated).toBe(true)
    const meta = contentMeta(state)
    expect(meta.get('file_count')).toBe(3)
    expect(meta.get('candidate_files')).toBe(5)
  })
})
describe('content database maintenance (P1)', () => {
  it('optimizes the FTS index after a full build', async () => {
    const { content } = await makeAdvancedIndex([{ name: 'notes.md', body: 'fts optimize marker' }])
    const diagnostics = content.diagnostics()
    expect(diagnostics.ftsOptimizedAt).toBeGreaterThan(0)
    // 0.20.2 P0-2: the merge really converged (previously fts_optimized_at was
    // always 0 because the invalid merge syntax was swallowed). 0.21.0 reads
    // the exact segment count from the FTS5 structure record, so one segment.
    expect(diagnostics.ftsSegments).toBe(1)
    expect(diagnostics.optimizeWarnings).toBe(0)
    expect(diagnostics.dbLiveBytes).toBeGreaterThan(0)
    expect(diagnostics.dbLiveBytes).toBeLessThanOrEqual(diagnostics.dbBytes)
  })

  it('warns when content.db exceeds its byte budget without rebuild loops', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-dbbudget-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-dbbudget-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'db budget marker')
    const entries = [{ path, name: 'notes.md', size: 17, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0, maxDbBytes: 1_000 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().warnings).toContain('content-db-over-budget')
    expect(content.diagnostics().dbOverBudget).toBe(true)
    const before = content.status().updatedAt
    await new Promise<void>(resolve => { setTimeout(resolve, 5) })
    content.refresh()
    await settle(content)
    expect(content.status().error).toBe('')
    expect(content.status().updatedAt).toBeGreaterThan(before)
    expect(content.status().warnings).toContain('content-db-over-budget')
  })

  it('cleans stale quarantined databases and keeps the two newest archives', async () => {
    const state = mkdtempSync(join(tmpdir(), 'locator-corrupt-state-'))
    cleanups.push(() => rmSync(state, { recursive: true, force: true }))
    const old = join(state, 'content.db.corrupt-1')
    const older = join(state, 'content.db.corrupt-2')
    const fresh = join(state, 'content.db.corrupt-3')
    const newest = join(state, 'content.db.corrupt-4')
    for (const path of [old, older, fresh, newest]) writeFileSync(path, 'x')
    const stale = Date.now() - 30 * 24 * 60 * 60_000
    utimesSync(old, stale / 1000, stale / 1000)
    utimesSync(older, stale / 1000, stale / 1000)
    const root = mkdtempSync(join(tmpdir(), 'locator-corrupt-root-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'corrupt cleanup marker')
    const entries = [{ path, name: 'notes.md', size: 22, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    const archives = readdirSync(state).filter(name => name.startsWith('content.db.corrupt-')).sort()
    expect(archives).toEqual(['content.db.corrupt-3', 'content.db.corrupt-4'])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(older)).toBe(false)
  })
})

describe('adaptive refresh policy (P1)', () => {
  it('throttles on load, pressure and battery, and stays idle otherwise', () => {
    expect(adaptivePressure({ cpuCount: 4 }).busy).toBe(false)
    expect(adaptivePressure({ loadavg: '8.0 4.0 2.0', cpuCount: 4 })).toMatchObject({ busy: true, reasons: ['load'] })
    expect(adaptivePressure({ loadavg: '1.0 1.0 1.0', cpuCount: 4, ioPressure: 'some avg10=1.00 avg60=55.00 avg300=10.00 total=1' })).toMatchObject({ busy: true, reasons: ['io-pressure'] })
    expect(adaptivePressure({ cpuCount: 8, cpuPressure: 'some avg10=1.00 avg60=75.00 avg300=10.00 total=1', batteryStatus: 'Discharging' })).toMatchObject({ busy: true, reasons: ['cpu-pressure', 'battery'] })
    expect(adaptivePressure({ cpuCount: 8, batteryStatus: 'Charging' }).busy).toBe(false)
  })
})

describe('symbol slimming (P0-13)', () => {
  it('caps symbols per file, skips generated code and re-slims on cap change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-slim-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-slim-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const normal = join(root, 'normal.go')
    const hidden = join(root, 'hidden.go')
    const generatedPath = join(root, 'bundle.min.js')
    const headerGenerated = join(root, 'schema.go')
    writeFileSync(normal, Array.from({ length: 10 }, (_, index) => 'func Normal' + String(index) + '() {}').join('\n'))
    writeFileSync(hidden, Array.from({ length: 4 }, (_, index) => 'func Hidden' + String(index) + '() {}').join('\n'))
    writeFileSync(generatedPath, 'function minified() {}')
    writeFileSync(headerGenerated, '// Code generated by protoc-gen-go. DO NOT EDIT.\npackage demo\nfunc Generated() {}\n')
    const entries = [normal, hidden, generatedPath, headerGenerated].map(path => ({ path, name: basename(path), size: statSync(path).size, mtime: Date.now(), ext: path.split('.').pop() ?? '', dir: false }))
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const base = { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 }
    const first = new ContentIndex(runtime, { ...base, symbolsPerFile: 5 })
    cleanups.push(() => first.close())
    first.start()
    await settle(first)
    expect(first.outline(normal)).toHaveLength(5)
    expect(first.outline(hidden)).toHaveLength(4)
    expect(first.outline(generatedPath)).toEqual([])
    expect(first.outline(headerGenerated)).toEqual([])
    first.close()
    // A smaller cap must be applied to an existing database without a rebuild.
    const second = new ContentIndex(runtime, { ...base, symbolsPerFile: 2 })
    cleanups.push(() => second.close())
    second.boot()
    await settle(second)
    expect(second.outline(normal)).toHaveLength(2)
    const db = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    // Symbols are keyed by the normalized path id; a cap change rewrites them
    // in place without leaking duplicate path dictionary rows.
    const row = db.prepare('SELECT COUNT(*) AS n FROM symbols s JOIN paths p ON p.id = s.path_id WHERE p.path = ?').get(normal) as { n: number }
    const pathRows = db.prepare('SELECT COUNT(*) AS n FROM paths WHERE path = ?').get(normal) as { n: number }
    db.close()
    expect(Number(row.n)).toBe(2)
    expect(Number(pathRows.n)).toBe(1)
  })

  it('backfills symbols from stored bodies even when the file is gone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-symback-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-symback-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'backfill.go')
    writeFileSync(path, 'package demo\n\nfunc FromBody() {}\n')
    const entries = [{ path, name: 'backfill.go', size: statSync(path).size, mtime: Date.now(), ext: 'go', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const base = { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 }
    const first = new ContentIndex(runtime, base)
    cleanups.push(() => first.close())
    first.start()
    await settle(first)
    first.close()
    const db = new DatabaseSync(join(state, 'content.db'))
    db.exec('DELETE FROM symbols')
    db.prepare("INSERT OR REPLACE INTO content_meta (key, value) VALUES ('symbols', 0)").run()
    db.close()
    rmSync(path)
    const second = new ContentIndex(runtime, base)
    cleanups.push(() => second.close())
    second.boot()
    await settle(second)
    expect(second.findSymbols('FromBody').map(hit => hit.path)).toEqual([path])
    // The refilled rows still point at the existing path dictionary entry and
    // still carry the integer codec (schema v4).
    const check = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    const code = check.prepare('SELECT s.kind AS kind, s.language AS language FROM symbols s JOIN paths p ON p.id = s.path_id WHERE p.path = ?').get(path) as { kind?: number; language?: number } | undefined
    const pathRows = check.prepare('SELECT COUNT(*) AS n FROM paths WHERE path = ?').get(path) as { n?: number }
    check.close()
    expect(typeof code?.kind).toBe('number')
    expect(typeof code?.language).toBe('number')
    expect(Number(pathRows.n)).toBe(1)
  })
})
describe('session streaming and tail refresh (P1-6)', () => {
  const sessionFrame = (event: Record<string, unknown>): Buffer => zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n'))
  const sessionHeader = (id: string): Record<string, unknown> => ({ type: 'session', version: 4, id, createdAt: 1, cwd: '/work' })
  const userMessage = (id: string, text: string): Record<string, unknown> => ({ type: 'user/message', data: { id, seq: 1, content: [{ type: 'text', text }] } })

  it('appends only new frames and keeps earlier messages searchable', async () => {
    const sessions = mkdtempSync(join(tmpdir(), 'locator-tail-sessions-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-tail-state-'))
    cleanups.push(() => rmSync(sessions, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const dir = join(sessions, '--workspace--', 'session-tail')
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'session.v4.jsonl.zstd')
    const firstFrame = sessionFrame(sessionHeader('session-tail'))
    const secondFrame = sessionFrame(userMessage('m-1', 'TAIL-FIRST marker'))
    writeFileSync(log, Buffer.concat([firstFrame, secondFrame]))
    const initialSize = statSync(log).size
    const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 10 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect((await content.search('TAIL-FIRST', 5)).length).toBeGreaterThan(0)
    // DSH appends one zstd frame per durable batch: the refresh reads only the tail.
    appendFileSync(log, sessionFrame(userMessage('m-2', 'TAIL-SECOND marker')))
    content.refresh()
    await settle(content)
    expect((await content.search('TAIL-FIRST', 5)).length).toBeGreaterThan(0)
    expect((await content.search('TAIL-SECOND', 5)).length).toBeGreaterThan(0)
    const db = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    const row = db.prepare('SELECT byte_len AS byteLen, last_line AS lastLine, capped FROM sources WHERE path = ?').get(log) as { byteLen?: number; lastLine?: number; capped?: number } | undefined
    db.close()
    expect(Number(row?.byteLen)).toBe(statSync(log).size)
    expect(Number(row?.byteLen)).toBeGreaterThan(initialSize)
    expect(Number(row?.lastLine)).toBe(3)
    expect(Number(row?.capped ?? 0)).toBe(0)
    // Evidence refs keep working through the multi-frame reader.
    const body = await content.sessionEventBody('session-tail', 0)
    expect(body).toContain('TAIL-FIRST')
  })

  it('re-reads a rewritten log and keeps old rows when the rewrite is unreadable', async () => {
    const sessions = mkdtempSync(join(tmpdir(), 'locator-rewrite-sessions-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-rewrite-state-'))
    cleanups.push(() => rmSync(sessions, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const dir = join(sessions, '--workspace--', 'session-rewrite')
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(log, Buffer.concat([
      sessionFrame(sessionHeader('session-rewrite')),
      sessionFrame(userMessage('r-1', 'REWRITE-FIRST marker')),
    ]))
    const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 10 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect((await content.search('REWRITE-FIRST', 5)).length).toBeGreaterThan(0)
    writeFileSync(log, 'this is not a zstd session log')
    content.refresh()
    await settle(content)
    expect(content.status().warnings).toContain('content-session-log-unreadable')
    // The failed re-read must not delete the previously indexed messages.
    expect((await content.search('REWRITE-FIRST', 5)).length).toBeGreaterThan(0)
  })

  it('indexes only the head of a log over sessionMaxBytes', async () => {
    const sessions = mkdtempSync(join(tmpdir(), 'locator-head-sessions-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-head-state-'))
    cleanups.push(() => rmSync(sessions, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const dir = join(sessions, '--workspace--', 'session-head')
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'session.v4.jsonl.zstd')
    const headerFrame = sessionFrame(sessionHeader('session-head'))
    const firstMessage = sessionFrame(userMessage('h-1', 'HEAD-FIRST marker'))
    const hugeMessage = sessionFrame(userMessage('h-2', 'HEAD-HIDDEN marker ' + 'y'.repeat(8_000)))
    writeFileSync(log, Buffer.concat([headerFrame, firstMessage, hugeMessage]))
    const cap = headerFrame.length + firstMessage.length + 8
    const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 10, sessionMaxBytes: cap })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect((await content.search('HEAD-FIRST', 5)).length).toBeGreaterThan(0)
    expect((await content.search('HEAD-HIDDEN', 5)).length).toBe(0)
    expect(content.status().warnings).toContain('content-session-truncated')
    const db = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    const row = db.prepare('SELECT capped FROM sources WHERE path = ?').get(log) as { capped?: number } | undefined
    db.close()
    expect(Number(row?.capped)).toBe(1)
    // A capped log is not re-read (its tail is beyond the configured budget).
    const next = Date.now() + 5_000
    utimesSync(log, next / 1000, next / 1000)
    content.refresh()
    await settle(content)
    expect((await content.search('HEAD-HIDDEN', 5)).length).toBe(0)
    expect((await content.search('HEAD-FIRST', 5)).length).toBeGreaterThan(0)
  })
})

describe('content search cache and pooling (P1)', () => {
  it('single-flights, caches and invalidates identical worker queries', async () => {
    let posts = 0
    const content = await makeWorkerIndex({
      searchWorkerTimeoutMs: 1_000,
      queryCacheSize: 16,
      queryCacheTtlMs: 60_000,
      searchWorkerFactory: () => fakeWorker((message, worker) => {
        if (message.method !== 'search') return
        posts++
        setTimeout(() => {
          worker.emit('message', { id: message.id, ok: true, result: { hits: [], count: { value: 0, kind: 'unknown' }, warnings: [] } })
        }, 10)
      }),
    })
    await Promise.all([content.search('CACHEMARK', 5, {}), content.search('CACHEMARK', 5, {})])
    expect(posts).toBe(1)
    await content.search('CACHEMARK', 5, {})
    expect(posts).toBe(1)
    await content.search('OTHERMARK', 5, {})
    expect(posts).toBe(2)
    // A build invalidates the cache so stale hits cannot survive a refresh.
    content.refresh()
    await settle(content)
    await content.search('CACHEMARK', 5, {})
    expect(posts).toBe(3)
  })

  it('expires cached results after the configured TTL', async () => {
    let posts = 0
    const content = await makeWorkerIndex({
      searchWorkerTimeoutMs: 1_000,
      queryCacheSize: 8,
      queryCacheTtlMs: 5,
      searchWorkerFactory: () => fakeWorker((message, worker) => {
        if (message.method !== 'search') return
        posts++
        setImmediate(() => {
          worker.emit('message', { id: message.id, ok: true, result: { hits: [], count: { value: 0, kind: 'unknown' }, warnings: [] } })
        })
      }),
    })
    await content.search('TTLMARK', 5, {})
    await content.search('TTLMARK', 5, {})
    expect(posts).toBe(1)
    await new Promise<void>(resolve => { setTimeout(resolve, 12) })
    await content.search('TTLMARK', 5, {})
    expect(posts).toBe(2)
  })
})

describe('symbol SQL lookups (P0-11)', () => {
  it('finds a substring fragment and ranks exact matches first', async () => {
    const { content } = await makeAdvancedIndex([{ name: 'server.go', body: 'package demo\n\nfunc MiddlewareHandler() {}\nfunc Handler() {}\n' }])
    const middle = content.findSymbols('dleware')
    expect(middle.map(hit => hit.name)).toEqual(['MiddlewareHandler'])
    const exact = content.findSymbols('Handler')
    expect(exact[0]?.name).toBe('Handler')
  })

  it('repoMap aggregates by root, ranks by symbol count and ignores sibling prefixes', async () => {
    const { content } = await makeAdvancedIndex([
      { name: 'big.go', body: Array.from({ length: 6 }, (_, index) => 'func Big' + String(index) + '() {}').join('\n') },
      { name: 'small.go', body: 'package demo\n\nfunc Small() {}\n' },
    ])
    const hit = content.findSymbols('Big0')[0]
    if (hit === undefined) throw new Error('fixture symbol missing')
    const root = dirname(hit.path)
    const mapped = content.repoMap([root], 200)
    expect(mapped[0]?.path).toBe(join(root, 'big.go'))
    expect(mapped.map(file => basename(file.path))).toContain('small.go')
    expect(content.repoMap([root + '-sibling'], 200)).toEqual([])
  })
})

describe('build transaction batching (P0-14)', () => {
  it('crosses batch boundaries without losing rows or the byte counter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-batch-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-batch-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const entries = Array.from({ length: 320 }, (_, index) => {
      const path = join(root, 'batch-' + String(index) + '.md')
      writeFileSync(path, 'BATCH-' + String(index) + ' ' + 'z'.repeat(30))
      return { path, name: 'batch-' + String(index) + '.md', size: 38, mtime: Date.now(), ext: 'md', dir: false }
    })
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 1_000, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().files).toBe(320)
    expect(content.status().error).toBe('')
    expect((await content.search('BATCH-319', 5)).length).toBeGreaterThan(0)
    const db = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    const stored = Number((db.prepare("SELECT value FROM content_meta WHERE key = 'total_bytes'").get() as { value: number }).value)
    const actual = Number((db.prepare('SELECT COALESCE(SUM(length(body)), 0) AS n FROM docs').get() as { n: number }).n)
    const complete = Number((db.prepare("SELECT value FROM content_meta WHERE key = 'complete'").get() as { value: number }).value)
    db.close()
    expect(stored).toBe(actual)
    expect(complete).toBe(1)
  })
})

describe('integration seams for impl-runtime/impl-content-query', () => {
  it('accepts the abort signal through ContentSearchOptions as runtime passes it', async () => {
    const content = await makeWorkerIndex({
      searchWorkerTimeoutMs: 5_000,
      searchWorkerFactory: () => fakeWorker(() => { /* never answer */ }),
    })
    const controller = new AbortController()
    const pending = content.search('SIGNALMARK', 5, { signal: controller.signal } as never)
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('forwards rankAdaptive=false unchanged to the worker', async () => {
    let observed: unknown
    const content = await makeWorkerIndex({
      searchWorkerTimeoutMs: 1_000,
      rankAdaptive: false,
      searchWorkerFactory: () => fakeWorker((message, worker) => {
        if (message.method !== 'search') return
        const params = message.params as { options?: { rankAdaptive?: unknown } }
        observed = params.options?.rankAdaptive
        setImmediate(() => {
          worker.emit('message', { id: message.id, ok: true, result: { hits: [], count: { value: 0, kind: 'unknown' }, warnings: [] } })
        })
      }),
    })
    await content.search('RANKMARK', 5, {})
    expect(observed).toBe(false)
  })

  it('rebuilds an over-budget database at idle instead of blocking refreshes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-db-idle-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-db-idle-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'idle rebuild marker')
    const entries = [{ path, name: 'notes.md', size: 19, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0, maxDbBytes: 1_000 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    const db = new DatabaseSync(join(state, 'content.db'))
    db.prepare("INSERT OR REPLACE INTO content_meta (key, value) VALUES ('db_budget_rebuilt_at', 0)").run()
    db.close()
    content.refresh()
    await settle(content)
    expect(content.status().error).toBe('')
    expect(content.diagnostics().lastRefreshMode).toBe('full')
    expect((await content.search('idle rebuild', 5)).length).toBeGreaterThan(0)
    expect(contentMeta(state).get('complete')).toBe(1)
  })
})

describe('two-phase full build (P0-1)', () => {
  it('plans the retention set newest-first and stores the exact candidate count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-plan-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-plan-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const base = Date.now() - 60_000
    const specs = [
      { name: 'old.md', marker: 'PLAN-OLD', mtime: base },
      { name: 'mid.md', marker: 'PLAN-MID', mtime: base + 1_000 },
      { name: 'new.md', marker: 'PLAN-NEW', mtime: base + 2_000 },
    ]
    const entries = specs.map(spec => {
      const path = join(root, spec.name)
      writeFileSync(path, spec.marker + ' ' + 'x'.repeat(145))
      return { path, name: spec.name, size: statSync(path).size, mtime: spec.mtime, ext: 'md', dir: false }
    })
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, {
      stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 400, maxFiles: 100, maxSessions: 0, parallelPrefetch: 3,
    })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().files).toBe(2)
    expect(content.status().truncated).toBe(true)
    const coverage = content.diagnostics().coverage
    expect(coverage.candidateFiles).toBe(3)
    expect(coverage.ratio).toBeCloseTo(2 / 3)
    expect(coverage.evictedDocs).toBe(0)
    expect((await content.search('PLAN-OLD', 5)).length).toBe(0)
    expect((await content.search('PLAN-MID', 5)).length).toBeGreaterThan(0)
    expect((await content.search('PLAN-NEW', 5)).length).toBeGreaterThan(0)
    const meta = contentMeta(state)
    expect(meta.get('file_count')).toBe(2)
    expect(meta.get('candidate_files')).toBe(3)
  })

  it('spends budget a conservative estimate left unused in the fill pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-fill-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-fill-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const base = Date.now() - 60_000
    const marker = (name: string) => name + ' ' + 'y'.repeat(145)
    const a = join(root, 'a.md')
    const b = join(root, 'b.md')
    const c = join(root, 'c.md')
    writeFileSync(a, marker('FILL-OLD'))
    writeFileSync(b, marker('FILL-MID'))
    writeFileSync(c, marker('FILL-NEW'))
    // The newest candidate is listed but unreadable: its planned bytes stay
    // unused and the fill pass must spend them on the next-newest file.
    const missing = join(root, 'vanished.md')
    const entries = [
      { path: missing, name: 'vanished.md', size: 153, mtime: base + 3_000, ext: 'md', dir: false },
      { path: c, name: 'c.md', size: statSync(c).size, mtime: base + 2_000, ext: 'md', dir: false },
      { path: b, name: 'b.md', size: statSync(b).size, mtime: base + 1_000, ext: 'md', dir: false },
      { path: a, name: 'a.md', size: statSync(a).size, mtime: base, ext: 'md', dir: false },
    ]
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, {
      stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 400, maxFiles: 100, maxSessions: 0,
    })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().files).toBe(2)
    expect(content.diagnostics().coverage.candidateFiles).toBe(4)
    expect((await content.search('FILL-NEW', 5)).length).toBeGreaterThan(0)
    expect((await content.search('FILL-MID', 5)).length).toBeGreaterThan(0)
    expect((await content.search('FILL-OLD', 5)).length).toBe(0)
  })
})

describe('extensionless text sniff (P1-7)', () => {
  const buildSniff = async (textSniff: boolean): Promise<ContentIndex> => {
    const root = mkdtempSync(join(tmpdir(), 'locator-sniff-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-sniff-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const write = (name: string, body: string | Buffer): string => {
      const path = join(root, name)
      writeFileSync(path, body)
      return path
    }
    const license = write('LICENSE', 'MIT license text for the sniff fixture')
    const gitignore = write('.gitignore', 'node_modules/' + String.fromCharCode(10))
    const script = write('runner', '#!/bin/sh' + String.fromCharCode(10) + 'echo sniff' + String.fromCharCode(10))
    const binary = write('blob', Buffer.from([0, 1, 2, 3, 4, 250, 251]))
    const sourcemap = write('bundle.js.map', '{"version":3}')
    const unknownExt = write('notes.unknownext', 'unknown extension text body')
    const entries = [license, gitignore, script, binary, sourcemap, unknownExt].map(path => ({
      path, name: basename(path), size: statSync(path).size, mtime: Date.now(),
      ext: path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : '', dir: false,
    }))
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, {
      stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0, textSniff,
    })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    return content
  }

  it('indexes extensionless text, dotfiles and known names but not binary blobs', async () => {
    const content = await buildSniff(true)
    expect(content.status().files).toBe(3)
    expect(content.diagnostics().coverage.candidateFiles).toBe(3)
    expect((await content.search('MIT license', 5)).length).toBeGreaterThan(0)
    expect((await content.search('node_modules', 5)).length).toBeGreaterThan(0)
    expect((await content.search('echo sniff', 5)).length).toBeGreaterThan(0)
    expect((await content.search('unknown extension', 5)).length).toBe(0)
  })

  it('only takes known extensionless names when textSniff is off', async () => {
    const content = await buildSniff(false)
    expect(content.status().files).toBe(2)
    expect((await content.search('MIT license', 5)).length).toBeGreaterThan(0)
    expect((await content.search('echo sniff', 5)).length).toBe(0)
  })
})

describe('warnings persistence (P1-8)', () => {
  it('counts a warning in content_meta and keeps the counter across a restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-warn-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-warn-state-'))
    const sessions = mkdtempSync(join(tmpdir(), 'locator-warn-sessions-'))
    cleanups.push(
      () => rmSync(root, { recursive: true, force: true }),
      () => rmSync(state, { recursive: true, force: true }),
      () => rmSync(sessions, { recursive: true, force: true }),
    )
    const dir = join(sessions, '--workspace--', 'session-broken-warn')
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(log, Buffer.from('not a zstd frame at all'))
    const settledAt = new Date(Date.now() - 120_000)
    utimesSync(log, settledAt, settledAt)
    const path = join(root, 'notes.md')
    writeFileSync(path, 'warning counter marker')
    const entries = [{ path, name: 'notes.md', size: 22, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const options = { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 10 }
    const first = new ContentIndex(runtime, options)
    first.start()
    await settle(first)
    expect(first.status().warnings).toContain('content-session-log-unreadable')
    expect(contentMeta(state).get('warn:content-session-log-unreadable')).toBeGreaterThanOrEqual(1)
    expect(first.diagnostics().warningCounts?.['content-session-log-unreadable']).toBeGreaterThanOrEqual(1)
    first.close()
    const second = new ContentIndex(runtime, options)
    cleanups.push(() => second.close())
    second.boot()
    await settle(second)
    expect(second.diagnostics().warningCounts?.['content-session-log-unreadable']).toBeGreaterThanOrEqual(1)
  })
  it('keeps only the current build warnings and preserves the resolved counts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-warn-history-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-warn-history-state-'))
    const sessions = mkdtempSync(join(tmpdir(), 'locator-warn-history-sessions-'))
    cleanups.push(
      () => rmSync(root, { recursive: true, force: true }),
      () => rmSync(state, { recursive: true, force: true }),
      () => rmSync(sessions, { recursive: true, force: true }),
    )
    const path = join(root, 'history.md')
    writeFileSync(path, 'warning history marker')
    const entries = [{ path, name: 'history.md', size: 21, mtime: Date.now(), ext: 'md', dir: false }]
    // Build 1 starts from a corrupt database: the successful full rebuild
    // resolves it, so the stale code must not survive in the live warnings.
    writeFileSync(join(state, 'content.db'), 'this is not a sqlite database at all')
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const options = { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 10 }
    const content = new ContentIndex(runtime, options)
    cleanups.push(() => content.close())
    content.boot()
    await settle(content)
    expect(content.status().error).toBe('')
    expect(content.status().warnings).not.toContain('content-db-corrupt')
    expect(content.diagnostics().warningCounts?.['content-db-corrupt']).toBeGreaterThanOrEqual(1)
    expect(contentMeta(state).get('warn:content-db-corrupt') ?? 0).toBeGreaterThanOrEqual(1)
    expect((await content.search('warning history', 5)).length).toBeGreaterThan(0)

    // Build 2 adds a current problem (an unreadable settled session log).
    // status().warnings must show exactly that, not build 1's resolved code.
    const dir = join(sessions, '--workspace--', 'session-warn-history')
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(log, Buffer.from('not a zstd frame at all'))
    const settledAt = new Date(Date.now() - 120_000)
    utimesSync(log, settledAt, settledAt)
    content.refresh()
    await settle(content)
    expect(content.status().warnings).toContain('content-session-log-unreadable')
    expect(content.status().warnings.filter(code => code.startsWith('content-db-'))).toEqual([])
    // The history survives in content_meta and diagnostics for AI readers.
    expect(content.diagnostics().warningCounts?.['content-db-corrupt']).toBeGreaterThanOrEqual(1)
    expect(content.diagnostics().warningCounts?.['content-session-log-unreadable']).toBeGreaterThanOrEqual(1)
    expect(contentMeta(state).get('warn:content-db-corrupt') ?? 0).toBeGreaterThanOrEqual(1)

    // Build 3 is a second full rebuild: it must neither resurrect the resolved
    // database warning nor drop the cumulative history recorded in build 1.
    content.start()
    await settle(content)
    expect(content.status().warnings.filter(code => code.startsWith('content-db-'))).toEqual([])
    expect(content.status().warnings).toContain('content-session-log-unreadable')
    expect(content.diagnostics().warningCounts?.['content-db-corrupt']).toBeGreaterThanOrEqual(1)
    expect(contentMeta(state).get('warn:content-db-corrupt') ?? 0).toBeGreaterThanOrEqual(1)
  })
})

describe('content database live-page budget (P0-5)', () => {
  it('ignores a large free list when deciding whether content.db is over budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-live-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-live-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'live page budget marker')
    const entries = [{ path, name: 'notes.md', size: 25, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const options = { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 }
    const first = new ContentIndex(runtime, options)
    first.start()
    await settle(first)
    first.close()
    const raw = new DatabaseSync(join(state, 'content.db'))
    raw.exec('CREATE TABLE bloat (b BLOB)')
    raw.prepare('INSERT INTO bloat (b) VALUES (?)').run(Buffer.alloc(2 * 1024 * 1024))
    raw.exec('DELETE FROM bloat')
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    raw.close()
    expect(statSync(join(state, 'content.db')).size).toBeGreaterThan(2 * 1024 * 1024)
    const second = new ContentIndex(runtime, { ...options, maxDbBytes: 1_000_000 })
    cleanups.push(() => second.close())
    second.boot()
    await settle(second)
    const diagnostics = second.diagnostics()
    expect(diagnostics.dbBytes).toBeGreaterThan(2 * 1024 * 1024)
    expect(diagnostics.dbLiveBytes).toBeLessThan(1_000_000)
    expect(diagnostics.freelistBytes).toBeGreaterThan(1_000_000)
    expect(diagnostics.dbOverBudget).toBe(false)
    expect(second.status().warnings).not.toContain('content-db-over-budget')
  })
})

describe('session window stability (P1-6)', () => {
  it('keeps previously indexed sessions when a newer log pushes them out of the window', async () => {
    const sessions = mkdtempSync(join(tmpdir(), 'locator-window-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-window-state-'))
    cleanups.push(() => rmSync(sessions, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const writeLog = (id: string, marker: string, mtime: number): string => {
      const dir = join(sessions, '--workspace--', id)
      mkdirSync(dir, { recursive: true })
      const log = join(dir, 'session.v4.jsonl.zstd')
      const line = JSON.stringify({ type: 'user/message', data: { id: id + '-msg', seq: 1, content: [{ type: 'text', text: marker }] } })
      writeFileSync(log, zstdCompressSync(Buffer.from(line)))
      const when = new Date(mtime)
      utimesSync(log, when, when)
      return log
    }
    const base = Date.now() - 120_000
    const oldLog = writeLog('session-window-old', 'WINDOW-OLD marker', base)
    writeLog('session-window-new', 'WINDOW-NEW marker', base + 60_000)
    const runtime = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const options = { stateDir: state, sessionDirs: [sessions], maxFileBytes: 1_000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 2 }
    const first = new ContentIndex(runtime, options)
    first.start()
    await settle(first)
    expect((await first.search('WINDOW-OLD', 5)).length).toBeGreaterThan(0)
    first.close()
    const limited = new ContentIndex(runtime, { ...options, maxSessions: 1 })
    cleanups.push(() => limited.close())
    limited.boot()
    await settle(limited)
    expect(limited.status().error).toBe('')
    // The window only decides what is newly indexed; the older indexed log
    // stays searchable while its file exists.
    expect((await limited.search('WINDOW-OLD', 5)).length).toBeGreaterThan(0)
    expect((await limited.search('WINDOW-NEW', 5)).length).toBeGreaterThan(0)
    rmSync(oldLog)
    limited.refresh()
    await settle(limited)
    expect((await limited.search('WINDOW-OLD', 5)).length).toBe(0)
  })
})

describe('parallel prefetch (P1-9)', () => {
  it('indexes a batch with one unreadable file without losing the others', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-prefetch-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-prefetch-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const entries: Array<{ path: string; name: string; size: number; mtime: number; ext: string; dir: boolean }> = []
    for (let i = 0; i < 12; i++) {
      const path = join(root, 'prefetch-' + String(i) + '.md')
      writeFileSync(path, 'PREFETCH-' + String(i) + ' body')
      entries.push({ path, name: 'prefetch-' + String(i) + '.md', size: 20, mtime: Date.now(), ext: 'md', dir: false })
    }
    const missing = join(root, 'never-written.md')
    entries.splice(5, 0, { path: missing, name: 'never-written.md', size: 20, mtime: Date.now(), ext: 'md', dir: false })
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, {
      stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0, parallelPrefetch: 4,
    })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().error).toBe('')
    expect(content.status().files).toBe(12)
    for (let i = 0; i < 12; i++) expect((await content.search('PREFETCH-' + String(i) + ' body', 1)).length).toBeGreaterThan(0)
  })
})

describe('0.20.2 storage maintenance', () => {
  it('crosses the 4,000-operation batch boundary without losing rows or the byte counter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-batch4000-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-batch4000-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    // One document write per addDoc batch tick: 4,050 documents commit once in
    // the middle of the pass, so the boundary and its reopen are exercised.
    const entries = Array.from({ length: 4_050 }, (_, index) => {
      const path = join(root, 'b-' + String(index) + '.md')
      writeFileSync(path, 'BATCH4000-' + String(index))
      return { path, name: 'b-' + String(index) + '.md', size: 15, mtime: Date.now(), ext: 'md', dir: false }
    })
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 5_000, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().files).toBe(4_050)
    const meta = contentMeta(state)
    expect(meta.get('complete')).toBe(1)
    const db = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    const stored = Number((db.prepare("SELECT value FROM content_meta WHERE key = 'total_bytes'").get() as { value: number }).value)
    const actual = Number((db.prepare('SELECT COALESCE(SUM(length(body)), 0) AS n FROM docs').get() as { n: number }).n)
    db.close()
    expect(stored).toBe(actual)
  })

  it('creates new databases with incremental auto-vacuum and the mtime index', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-vacuum-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-vacuum-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'auto vacuum marker')
    const entries = [{ path, name: 'notes.md', size: 18, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 })
    content.start()
    await settle(content)
    content.close()
    const db = new DatabaseSync(join(state, 'content.db'), { readOnly: true })
    const autoVacuum = (db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum?: number }).auto_vacuum
    const indexes = (db.prepare("PRAGMA index_list('docs_meta')").all() as Array<{ name?: string }>).map(row => row.name)
    db.close()
    expect(autoVacuum).toBe(2)
    expect(indexes).toContain('docs_meta_mtime')
    expect(indexes).toContain('docs_meta_path_id')
    expect(indexes).toContain('docs_meta_file_path')
    expect(indexes).toContain('docs_meta_session_key')
    expect(content.diagnostics().schemaVersion).toBe(4)
  })
})

describe('mtimesForPaths (combined freshness seam)', () => {
  it('answers a large chunked request and keeps path spelling compatibility', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-mtimes-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-mtimes-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const base = Date.now() - 30_000
    const paths = [join(root, 'm1.md'), join(root, 'm2.md'), join(root, 'm3.md')]
    const entries = paths.map((path, index) => {
      writeFileSync(path, 'MTIMES-' + String(index))
      return { path, name: basename(path), size: 8, mtime: base + index * 1_000, ext: 'md', dir: false }
    })
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    const canonical = paths.map(path => realpathSync(path))
    const filler = Array.from({ length: 420 }, (_, index) => join(root, 'absent-' + String(index) + '.md'))
    const asked = [...filler, ...paths, ...canonical, join(root, 'absent-final.md')]
    const mtimes = content.mtimesForPaths(asked)
    expect(mtimes.size).toBe(new Set([...paths, ...canonical]).size)
    for (let index = 0; index < paths.length; index++) {
      expect(mtimes.get(paths[index]!)).toBe(base + index * 1_000)
      expect(mtimes.get(canonical[index]!)).toBe(base + index * 1_000)
    }
    expect(content.mtimesForPaths([]).size).toBe(0)
  })
})

describe('idle FTS optimize (P0-2)', () => {
  it('merges after the build reports done when optimizeInIdle is set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-idle-opt-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-idle-opt-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'idle optimize marker')
    const entries = [{ path, name: 'notes.md', size: 20, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, {
      stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0, optimizeInIdle: true,
    })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    for (let i = 0; i < 200 && content.diagnostics().ftsOptimizedAt === 0; i++) await new Promise(resolve => setTimeout(resolve, 25))
    const diagnostics = content.diagnostics()
    expect(diagnostics.ftsOptimizedAt).toBeGreaterThan(0)
    expect(diagnostics.optimizeWarnings).toBe(0)
    expect(diagnostics.ftsSegments).toBe(1)
    expect((await content.search('idle optimize', 5)).length).toBeGreaterThan(0)
  })
})

describe('optimize failure reporting (P0-2)', () => {
  it('counts a merge failure instead of swallowing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-optfail-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-optfail-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'optimize failure marker')
    const entries = [{ path, name: 'notes.md', size: 21, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: 1, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    ;(content as unknown as { addWarning: (warning: string) => void }).addWarning('content-fts-optimize-failed')
    expect(content.diagnostics().optimizeWarnings).toBe(1)
    expect(content.diagnostics().warningCounts?.['content-fts-optimize-failed']).toBe(1)
    expect(contentMeta(state).get('warn:content-fts-optimize-failed')).toBe(1)
    content.close()
    const reopened = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 })
    cleanups.push(() => reopened.close())
    reopened.boot()
    await settle(reopened)
    expect(reopened.diagnostics().optimizeWarnings).toBeGreaterThanOrEqual(1)
  })
})

describe('0.21.0 build connection settings', () => {
  it('opens the content connection with a 64 MiB cache, a memory temp store and WAL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-pragma-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-pragma-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'pragma marker')
    const entries = [{ path, name: 'notes.md', size: statSync(path).size, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    const db = (content as unknown as { db: DatabaseSync }).db
    expect((db.prepare('PRAGMA cache_size').get() as { cache_size?: number }).cache_size).toBe(-65536)
    expect((db.prepare('PRAGMA temp_store').get() as { temp_store?: number }).temp_store).toBe(2)
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string }).journal_mode).toBe('wal')
    // The build restores the FTS5 default; a persisted 0 would make every later
    // incremental refresh defer its merges.
    const automerge = db.prepare("SELECT v AS v FROM docs_config WHERE k = 'automerge'").get() as { v?: number }
    expect(automerge.v).toBe(4)
  })

  it('turns FTS automerge off for the fresh insert pass and restores it before the merge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-automerge-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-automerge-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'automerge marker')
    const entries = [{ path, name: 'notes.md', size: statSync(path).size, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 })
    cleanups.push(() => content.close())
    // Spy on the FTS5 configuration writes: 0 before the insert pass, 4 before
    // the bounded merge (the protocol this test protects).
    const proto = DatabaseSync.prototype as unknown as { exec: (sql: string) => void }
    const original = proto.exec
    const writes: number[] = []
    proto.exec = function (this: DatabaseSync, sql: string) {
      if (sql.includes("'automerge'")) writes.push(sql.includes(', 0)') ? 0 : 4)
      return original.call(this, sql)
    }
    try {
      content.start()
      await settle(content)
    } finally {
      proto.exec = original
    }
    expect(writes[0]).toBe(0)
    expect(writes[writes.length - 1]).toBe(4)
    expect(content.diagnostics().optimizeWarnings).toBe(0)
  })
})

describe('0.21.0 full-sweep budget', () => {
  it('uses its own budget instead of the 8 s live-refresh budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-sweepbudget-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-sweepbudget-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'sweep budget marker')
    const entries = [{ path, name: 'notes.md', size: statSync(path).size, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    const internal = content as unknown as {
      refreshStartedAt: number
      sweepStartedAt: number
      refreshBudgetExceeded: () => boolean
      sweepBudgetExceeded: () => boolean
      fullSweepBudgetMs: () => number
    }
    expect(internal.fullSweepBudgetMs()).toBe(45_000)
    // A sweep that started now is fine even though the live-refresh clock is
    // already 30 s old — the sweep no longer inherits the 8 s incremental limit.
    internal.refreshStartedAt = Date.now() - 30_000
    internal.sweepStartedAt = Date.now()
    expect(internal.refreshBudgetExceeded()).toBe(true)
    expect(internal.sweepBudgetExceeded()).toBe(false)
    internal.refreshStartedAt = Date.now()
    internal.sweepStartedAt = Date.now() - 60_000
    expect(internal.sweepBudgetExceeded()).toBe(true)
  })

  it('defers an over-budget sweep and completes it on a later refresh', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-sweepdefer-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-sweepdefer-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const { live, engine, runtime } = generationEngine(root)
    const options = { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0, fullSweepIntervalMs: 1 }
    // A 0 ms budget aborts a sweep before it reads a page (test seam).
    const aborted = new ContentIndex(runtime, { ...options, fullSweepBudgetMs: 0 } as ContentOptions)
    cleanups.push(() => aborted.close())
    aborted.start()
    await settle(aborted)
    expect(aborted.status().files).toBe(1)
    await new Promise<void>(resolve => { setTimeout(resolve, 10) })
    rmSync(live)
    engine.generation = 2
    engine.entries = []
    aborted.refresh()
    await settle(aborted)
    // The partial sweep must keep the live rows and warn about the budget.
    expect(aborted.status().files).toBe(1)
    expect(aborted.status().warnings).toContain('content-refresh-budget')
    aborted.close()
    const resumed = new ContentIndex(runtime, options)
    cleanups.push(() => resumed.close())
    resumed.boot()
    await settle(resumed)
    expect(resumed.status().files).toBe(0)
    expect(await resumed.search('GENERATION-FIRST', 5)).toHaveLength(0)
  })
})

describe('0.21.0 sweep coverage denominator', () => {
  it('keeps extensionless binaries out of the sweep denominator like a full build does', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-sweepcov-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-sweepcov-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const textA = join(root, 'a.md')
    const textB = join(root, 'b.md')
    const blob = join(root, 'binary-blob')
    writeFileSync(textA, 'SWEEPCOV-A text')
    writeFileSync(textB, 'SWEEPCOV-B text')
    writeFileSync(blob, Buffer.from([0, 1, 2, 3, 4, 5, 250, 251]))
    const entries = [textA, textB, blob].map(path => ({ path, name: basename(path), size: statSync(path).size, mtime: Date.now(), ext: path.includes('.') ? 'md' : '', dir: false }))
    const runtime = { dump: async () => ({ entries: [...entries], next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, {
      stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0, textSniff: true, fullSweepIntervalMs: 1,
    })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    expect(content.status().files).toBe(2)
    expect(content.diagnostics().coverage.candidateFiles).toBe(2)
    // A new extensionless binary appears; the full sweep must sniff it before
    // counting a candidate, or the denominator (and the reported ratio) lies.
    const blob2 = join(root, 'another-blob')
    writeFileSync(blob2, Buffer.from([9, 8, 7, 0, 6, 5, 4, 3]))
    entries.push({ path: blob2, name: basename(blob2), size: statSync(blob2).size, mtime: Date.now(), ext: '', dir: false })
    await new Promise<void>(resolve => { setTimeout(resolve, 10) })
    content.refresh()
    await settle(content)
    const coverage = content.diagnostics().coverage
    expect(coverage.indexedFiles).toBe(2)
    expect(coverage.candidateFiles).toBe(2)
    expect(coverage.ratio).toBeCloseTo(1)
    expect(content.status().files).toBe(2)
  })
})

describe('0.21.0 idle maintenance', () => {
  it('creates deferred symbol indexes after the build reports done, never during it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-idlesym-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-idlesym-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const source = join(root, 'demo.ts')
    writeFileSync(source, 'export function idleSymbolMarker(): number {\n  return 42\n}\n')
    const entries = [{ path: source, name: 'demo.ts', size: statSync(source).size, mtime: Date.now(), ext: 'ts', dir: false }]
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, {
      stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0, optimizeInIdle: true,
    })
    cleanups.push(() => content.close())
    const internal = content as unknown as { ensureSymbolIndexes: () => void }
    const original = internal.ensureSymbolIndexes.bind(content)
    const calls: boolean[] = []
    internal.ensureSymbolIndexes = () => {
      calls.push(content.status().building)
      original()
    }
    content.start()
    await settle(content)
    // The build ended without paying the one-time CREATE INDEX.
    expect(calls).toHaveLength(0)
    for (let i = 0; i < 200 && content.diagnostics().ftsOptimizedAt === 0; i++) await new Promise(resolve => setTimeout(resolve, 25))
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(building => building === false)).toBe(true)
    const db = (content as unknown as { db: DatabaseSync }).db
    const indexes = (db.prepare("PRAGMA index_list('symbols')").all() as Array<{ name?: string }>).map(row => row.name)
    expect(indexes).toContain('symbols_path')
    expect(indexes).toContain('symbols_name')
    expect(content.findSymbols('idleSymbolMarker').length).toBeGreaterThan(0)
  })

  it('re-merges a split index after an incremental refresh and ends with one segment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-idlemerge-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-idlemerge-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const entries: Array<{ path: string; name: string; size: number; mtime: number; ext: string; dir: boolean }> = []
    for (let i = 0; i < 5; i++) {
      const path = join(root, 'm' + String(i) + '.md')
      writeFileSync(path, 'IDLEMERGE-' + String(i) + ' body')
      entries.push({ path, name: 'm' + String(i) + '.md', size: 17, mtime: Date.now(), ext: 'md', dir: false })
    }
    const runtime = { dump: async () => ({ entries: [...entries], next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, {
      stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0, optimizeInIdle: true, fullSweepIntervalMs: 1,
    })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    for (let i = 0; i < 200 && content.diagnostics().ftsOptimizedAt === 0; i++) await new Promise(resolve => setTimeout(resolve, 25))
    expect(content.diagnostics().ftsSegments).toBe(1)
    // Change two files: the refresh commits its own transaction, which appends a
    // second segment on top of the merged one.
    for (const index of [1, 3]) {
      const path = join(root, 'm' + String(index) + '.md')
      writeFileSync(path, 'IDLEMERGE-NEW-' + String(index) + ' body')
      const entry = entries[index]
      if (entry !== undefined) { entry.mtime = Date.now(); entry.size = statSync(path).size }
    }
    await new Promise<void>(resolve => { setTimeout(resolve, 10) })
    content.refresh()
    await settle(content)
    expect(content.diagnostics().ftsSegments).toBeGreaterThan(1)
    for (let i = 0; i < 200 && content.diagnostics().ftsSegments !== 1; i++) await new Promise(resolve => setTimeout(resolve, 25))
    const diagnostics = content.diagnostics()
    expect(diagnostics.ftsSegments).toBe(1)
    expect(diagnostics.optimizeWarnings).toBe(0)
    expect((await content.search('IDLEMERGE-NEW-1', 5)).length).toBeGreaterThan(0)
  })

  it('vacuum shards free pages back and reports lastVacuumBytes/lastVacuumAt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-idlevac-root-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-idlevac-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const path = join(root, 'notes.md')
    writeFileSync(path, 'vacuum marker')
    const entries = [{ path, name: 'notes.md', size: statSync(path).size, mtime: Date.now(), ext: 'md', dir: false }]
    const runtime = { dump: async () => ({ entries, next: entries.length, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 100, maxSessions: 0 })
    cleanups.push(() => content.close())
    content.start()
    await settle(content)
    const internal = content as unknown as { db: DatabaseSync; generation: number; vacuumFreePages: (generation: number) => Promise<void> }
    internal.db.exec('CREATE TABLE bloat (b BLOB)')
    internal.db.prepare('INSERT INTO bloat (b) VALUES (?)').run(Buffer.alloc(2 * 1024 * 1024))
    internal.db.exec('DROP TABLE bloat')
    await internal.vacuumFreePages(internal.generation)
    const diagnostics = content.diagnostics()
    expect(diagnostics.freelistBytes).toBe(0)
    expect(diagnostics.lastVacuumAt).toBeGreaterThan(0)
    expect(diagnostics.lastVacuumBytes).toBeGreaterThan(1_000_000)
    // The measurement is persisted for the next process.
    expect(contentMeta(state).get('last_vacuum_at')).toBe(diagnostics.lastVacuumAt)
  })
})
