import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ContentIndex } from '../src/content.ts'
import type { LocatorRuntime } from '../src/runtime.ts'

const cleanups: Array<() => void> = []
afterAll(() => { for (const cleanup of cleanups.reverse()) cleanup() })

describe('content build cooperativeness', () => {
  it('yields to the event loop instead of blocking the DSH host for the whole build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-lag-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-lag-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const count = 60
    const size = 200_000
    const filler = 'the quick brown fox jumps over the lazy dog. lorem ipsum dolor sit amet. '.repeat(3000)
    const entries: Array<{ path: string; name: string; size: number; mtime: number; ext: string; dir: boolean }> = []
    for (let i = 0; i < count; i++) {
      const path = join(root, `doc-${String(i).padStart(3, '0')}.txt`)
      const body = `LAGTEXT-${i}\n` + filler.slice(0, size)
      writeFileSync(path, body)
      entries.push({ path, name: `doc-${String(i).padStart(3, '0')}.txt`, size: body.length, mtime: Date.now(), ext: 'txt', dir: false })
    }
    const runtime = {
      dump: async (after: number) => ({ entries: entries.slice(after, after + 500), next: Math.min(after + 500, entries.length), done: after + 500 >= entries.length }),
    } as unknown as LocatorRuntime
    const content = new ContentIndex(runtime, { stateDir: state, sessionDirs: [], maxFileBytes: 1_000_000, maxTotalBytes: 0, maxFiles: 1000, maxSessions: 0 })
    cleanups.push(() => content.close())

    const gaps: number[] = []
    let last = performance.now()
    const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now }, 5)
    const started = performance.now()
    content.start()
    for (let i = 0; i < 600 && content.status().building; i++) await new Promise(resolve => setTimeout(resolve, 10))
    const totalMs = performance.now() - started
    clearInterval(timer)
    const maxGap = Math.max(...gaps)
    const status = content.status()
    // The build must finish, and a single synchronous page/session must not hold
    // the host for longer than an interactive frame budget.
    expect(status.building).toBe(false)
    expect(status.files).toBe(count)
    expect(totalMs).toBeGreaterThan(0)
    expect(gaps.length).toBeGreaterThan(10)
    expect(maxGap).toBeLessThan(200)
  })
})
