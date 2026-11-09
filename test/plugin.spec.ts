import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import type { Config } from '../src/config.ts'

const binary = join(import.meta.dirname, '..', 'bin', `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`, 'indexd')

interface RegisteredTool {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

const cleanups: Array<() => void> = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) cleanup()
  // A disposer stops the engine asynchronously; let its final snapshot land
  // before the temporary state directory is removed.
  await new Promise(resolve => setTimeout(resolve, 300))
})

describe.skipIf(!existsSync(binary))('plugin mount', () => {
  it('registers the three tools and runs a search end to end', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-plugin-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-plugin-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'report.pdf'), 'x')

    const tools: RegisteredTool[] = []
    const disposers: Array<() => void> = []
    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
      effect: (factory: () => () => void) => {
        disposers.push(factory())
      },
      tools: {
        register: (tool: RegisteredTool) => {
          tools.push(tool)
        },
      },
    } as unknown as Context

    const config: Config = {
      enabled: true,
      roots: [root],
      excludes: ['node_modules'],
      watch: true,
    refreshIntervalMs: 1_800_000,
    scanWorkers: 0,
      stateDir: state,
      binaryPath: binary,
      maxResults: 100,
      startupTimeoutMs: 30_000,
      requestTimeoutMs: 10_000,
    }
    apply(ctx, config)
    cleanups.push(() => {
      for (const dispose of disposers.reverse()) dispose()
    })

    expect(tools.map(tool => tool.name).sort()).toEqual(['locator_rebuild', 'locator_search', 'locator_status'])
    const search = tools.find(tool => tool.name === 'locator_search')
    expect(search).toBeDefined()
    const value = (await search?.execute({ query: 'report ext:pdf', limit: 5 }, { signal: new AbortController().signal })) as {
      ok: boolean
      total: number
      hits: Array<{ path: string }>
    }
    expect(value.ok).toBe(true)
    expect(value.total).toBe(1)
    expect(value.hits[0]?.path).toBe(join(root, 'docs', 'report.pdf'))
  })
})
