import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { ContentIndex } from '../src/content.ts'
import type { LocatorRuntime, DumpPage } from '../src/runtime.ts'

const cleanups: Array<() => void> = []
afterAll(() => { for (const cleanup of cleanups.reverse()) cleanup() })

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
    const hits = content.search('brown fox', 5)
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
    const hits = content.search('launch friday', 5)
    expect(hits.some(hit => hit.kind === 'session' && hit.sessionId === 'session-abc' && hit.messageId === 'msg-2')).toBe(true)
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
    expect(content.search('first generation', 5).length).toBeGreaterThan(0)
    writeFileSync(path, 'second generation content')
    mtime += 1_000
    entries = [{ path, name: 'delta.md', size: 25, mtime, ext: 'md', dir: false }]
    content.refresh()
    for (let i = 0; i < 200 && content.status().building; i++) await new Promise(resolve => setTimeout(resolve, 25))
    expect(content.search('second generation', 5).length).toBeGreaterThan(0)
    expect(content.search('first generation', 5).length).toBe(0)
  })
})
