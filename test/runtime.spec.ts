import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Config } from '../src/config.ts'
import { LocatorRuntime } from '../src/runtime.ts'

const binary = join(import.meta.dirname, '..', 'bin', `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`, process.platform === 'win32' ? 'indexd.exe' : 'indexd')

function config(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    roots: [],
    excludes: ['node_modules', '.git'],
    watch: true,
    refreshIntervalMs: 1_800_000,
    scanWorkers: 0,
    memoryLimitMB: 0,
    contentIndex: false,
    contentLazy: false,
    contentMaxFileBytes: 1_000_000,
    contentMaxTotalBytes: 0,
    contentRefreshMs: 120_000,
    contentMaxFiles: 0,
    contentFullIndex: false,
    contentIndexReasoning: false,
      contentIndexToolResults: false,
    contentMaxSessions: 0,
    contentSessionDirs: [],
    contentExcludes: [],
    contentIncludeArchived: false,
    contentActiveSessionDelayMs: 120000,
    windowsUsn: false,
    stateDir: '',
    binaryPath: '',
    maxResults: 100,
    startupTimeoutMs: 30_000,
    requestTimeoutMs: 10_000,
    httpConnectionOptional: false,
    ...overrides,
  }
}

const cleanups: Array<() => void> = []

async function waitForIndex(rt: LocatorRuntime): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const status = await rt.engineStatus()
    if (status !== undefined && !status.scanning) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('initial scan did not finish')
}
afterAll(() => {
  for (const cleanup of cleanups.reverse()) cleanup()
})

describe.skipIf(!existsSync(binary))('locator engine integration', () => {
  it('indexes, searches, and follows filesystem changes', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'locator-test-')))
    const state = mkdtempSync(join(tmpdir(), 'locator-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    mkdirSync(join(root, 'docs'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'docs', 'report.pdf'), 'x')
    writeFileSync(join(root, 'src', 'main.go'), 'package main')

    const rt = new LocatorRuntime(config(), [root], state, binary, process.cwd())
    rt.start()
    cleanups.push(() => void rt.stop())
    await rt.waitReady()
    await waitForIndex(rt)

    const first = await rt.search({
      query: 'report ext:pdf',
      limit: 10,
      offset: 0,
      sort: 'name',
      desc: false,
      regex: false,
      caseSensitive: false,
      wholeWord: false,
      filesOnly: false,
      dirsOnly: false,
    })
    expect(first.total).toBe(1)
    expect(first.hits[0]?.path).toBe(join(root, 'docs', 'report.pdf'))

    writeFileSync(join(root, 'src', 'added.ts'), 'export {}')
    await new Promise(resolve => setTimeout(resolve, 700))
    const watched = await rt.search({
      query: 'added',
      limit: 10,
      offset: 0,
      sort: 'name',
      desc: false,
      regex: false,
      caseSensitive: false,
      wholeWord: false,
      filesOnly: false,
      dirsOnly: false,
    })
    expect(watched.total).toBe(1)

    const status = await rt.engineStatus()
    expect(status?.entries).toBeGreaterThanOrEqual(6)
    expect(status?.watching).toBe(true)

    await rt.stop()
  })

  it('reports a missing engine binary as a tool-visible error', async () => {
    const rt = new LocatorRuntime(config(), [tmpdir()], mkdtempSync(join(tmpdir(), 'locator-state-')), join(tmpdir(), 'missing-indexd'), process.cwd())
    rt.start()
    await expect(rt.waitReady()).rejects.toThrow(/ENOENT|locator engine/)
    await rt.stop()
  })
})
