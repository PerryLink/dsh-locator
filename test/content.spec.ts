import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Worker } from 'node:worker_threads'
import { zstdCompressSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { ContentIndex } from '../src/content.ts'
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
      expect((await skipped.search('ARCHIVEMARK', 5)).length).toBe(0)

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
    const index = check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'docs_meta_path'").get()
    check.close()
    expect(index).toBeDefined()
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
    expect(second.status().warnings).toContain('content-db-incompatible')
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
        if (typeof message.query !== 'string') return
        setImmediate(() => { worker.emit('message', { id: message.id, result: { hits: 'not-an-array', count: { value: 0, kind: 'exact' }, warnings: [] } }) })
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
        if (typeof message.query !== 'string') return
        setImmediate(() => { worker.emit('exit', 1) })
      }),
    })
    const result = await content.search('WORKERMARK', 5, {})
    expect(result.hits).toEqual([])
    expect(result.error).toBe('content-search-worker-failed')
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
    expect(content.status().warnings).toContain('content-db-corrupt')
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
    expect(content.status().warnings).toContain('content-db-incompatible')
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
    expect(content.status().warnings).toContain('content-db-corrupt')
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

})
