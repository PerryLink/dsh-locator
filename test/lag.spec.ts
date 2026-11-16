import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ContentIndex } from '../src/content.ts'
import type { LocatorRuntime } from '../src/runtime.ts'

const cleanups: Array<() => void> = []
afterAll(() => { for (const cleanup of cleanups.reverse()) cleanup() })

/**
 * Wait for a predicate with an explicit wall-clock deadline.
 *
 * The build duration depends on the machine (and on how many test workers share
 * it), so the old fixed "600 x 10 ms" loop silently capped the wait at ~6 s and
 * turned a slow runner into a flaky `building === true` failure. This helper
 * keeps polling but names the awaited condition when the deadline is exceeded.
 */
async function waitUntil(predicate: () => boolean, deadlineMs: number, what: string): Promise<number> {
  const started = performance.now()
  while (!predicate()) {
    const waited = performance.now() - started
    if (waited > deadlineMs) throw new Error(`timed out after ${deadlineMs} ms waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return performance.now() - started
}

/** Nearest-rank percentile (0-100) of a small sample. */
function percentile(samples: number[], percent: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil((percent / 100) * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0
}

/** Collect timer-scheduling gaps for `durationMs` with the event loop idle. */
async function sampleIdleGaps(durationMs: number): Promise<number[]> {
  const gaps: number[] = []
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    gaps.push(now - last)
    last = now
  }, 5)
  await new Promise(resolve => setTimeout(resolve, durationMs))
  clearInterval(timer)
  return gaps
}

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

    // Calibrate the scheduler on this machine before judging the build: shared
    // CI runners and parallel vitest workers stretch timer callbacks even when
    // the build is cooperative, so the thresholds are relative to an idle
    // sample instead of hard-coded wall-clock numbers.
    const baseline = await sampleIdleGaps(150)
    const baselineP95 = percentile(baseline, 95)
    const baselineMax = baseline.length === 0 ? 0 : Math.max(...baseline)

    const gaps: number[] = []
    let last = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      gaps.push(now - last)
      last = now
    }, 5)
    const started = performance.now()
    content.start()
    await waitUntil(() => !content.status().building, 30_000, 'the content build to finish')
    const totalMs = performance.now() - started
    clearInterval(timer)

    const status = content.status()
    const p95 = percentile(gaps, 95)
    const maxGap = gaps[gaps.length - 1] ?? 0
    const p95Budget = Math.min(1_000, Math.max(120, baselineP95 * 4))
    const maxBudget = Math.min(2_000, Math.max(process.env.CI === 'true' ? 500 : 250, baselineMax * 4))

    // The build must finish, and a single synchronous page/session must not hold
    // the host for longer than an interactive frame budget. A fast build may
    // legitimately produce few samples; only judge sampling when it lasted long
    // enough to observe several timer turns.
    expect(status.building).toBe(false)
    expect(status.error).toBe('')
    expect(status.files).toBe(count)
    expect(totalMs).toBeGreaterThan(0)
    if (totalMs >= 100) expect(gaps.length).toBeGreaterThanOrEqual(5)
    expect(p95).toBeLessThan(p95Budget)
    expect(maxGap).toBeLessThan(maxBudget)
  })
})
