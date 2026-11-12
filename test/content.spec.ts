import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { ContentIndex } from '../src/content.ts'
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

  it('bounds the snippet of a one-character LIKE query', async () => {
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
    const hits = await content.search('x', 5)
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
