import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import type { Config } from '../src/config.ts'

const binary = join(import.meta.dirname, '..', 'bin', `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`, process.platform === 'win32' ? 'indexd.exe' : 'indexd')

interface RegisteredTool {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

const cleanups: Array<() => void> = []
// The index engine process can outlive `dispose()` by a few milliseconds on
// macOS runners; retry the temporary-directory removal instead of failing the
// suite with ENOTEMPTY when a state file is still being closed.
function removeTree(path: string): void {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
  rmSync(path, { recursive: true, force: true })
}
afterAll(() => {
  for (const cleanup of cleanups.reverse()) cleanup()
})

describe.skipIf(!existsSync(binary))('locator_export', () => {
  it('writes a queryable SQLite mirror of the index', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-export-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-export-state-'))
    const dbPath = join(root, 'index.sqlite')
    cleanups.push(() => removeTree(root), () => removeTree(state))
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'report.pdf'), 'x')
    writeFileSync(join(root, 'main.go'), 'package main')

    const tools: RegisteredTool[] = []
    const disposers: Array<() => void> = []
    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
      effect: (factory: () => () => void) => { disposers.push(factory()) },
      tools: { register: (tool: RegisteredTool) => { tools.push(tool) } },
    } as unknown as Context
    const config: Config = {
      enabled: true,
      roots: [root],
      excludes: ['node_modules'],
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
      stateDir: state,
      binaryPath: binary,
      maxResults: 100,
      startupTimeoutMs: 30_000,
      requestTimeoutMs: 10_000,
      httpConnectionOptional: false,
    }
    apply(ctx, config)
    cleanups.push(() => { for (const dispose of disposers.reverse()) dispose() })

    const status = tools.find(tool => tool.name === 'locator_status')
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const value = (await status?.execute({}, { signal: new AbortController().signal })) as { entries?: number; scanning?: boolean }
      if ((value.entries ?? 0) >= 3 && value.scanning !== true) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    const exporter = tools.find(tool => tool.name === 'locator_export')
    expect(exporter).toBeDefined()
    // The export path is deliberately outside the state directory here; the
    // tool now requires an explicit opt-in for that (see test/tools.spec.ts).
    const result = (await exporter?.execute({ path: dbPath, overwrite: true, allowOutsideStateDir: true }, { signal: new AbortController().signal })) as {
      ok: boolean
      rows: number
      error?: string
    }
    expect(result.ok, result.error).toBe(true)
    expect(result.rows).toBeGreaterThanOrEqual(3)

    const db = new DatabaseSync(dbPath, { readOnly: true })
    const count = db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }
    expect(Number(count.c)).toBe(result.rows)
    const found = db.prepare('SELECT name FROM entries WHERE name = ?').get('report.pdf') as { name: string } | undefined
    expect(found?.name).toBe('report.pdf')
    db.close()
  })
})
