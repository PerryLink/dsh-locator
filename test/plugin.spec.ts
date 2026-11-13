import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import type { Config } from '../src/config.ts'

const binary = join(import.meta.dirname, '..', 'bin', `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`, process.platform === 'win32' ? 'indexd.exe' : 'indexd')

interface RegisteredTool {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

const cleanups: Array<() => void> = []
const stopEngines: Array<() => void> = []

async function waitForIndex(statusTool: RegisteredTool | undefined): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const status = (await statusTool?.execute({}, { signal: new AbortController().signal })) as { entries?: number; scanning?: boolean }
    if ((status.entries ?? 0) >= 3 && status.scanning !== true) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('initial scan did not finish')
}
afterAll(async () => {
  for (const stop of stopEngines.reverse()) stop()
  // A disposer stops the engine asynchronously; let its final snapshot land
  // before the temporary state directory is removed.
  await new Promise(resolve => setTimeout(resolve, 300))
  for (const cleanup of cleanups.reverse()) cleanup()
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
    memoryLimitMB: 0,
    contentIndex: false,
    contentLazy: true,
    contentMaxFileBytes: 1_000_000,
    contentMaxTotalBytes: 0,
    contentRefreshMs: 120_000,
    contentMaxFiles: 0,
      contentFullIndex: false,
      contentIndexReasoning: false,
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
    stopEngines.push(() => {
      for (const dispose of disposers.reverse()) dispose()
    })

    expect(tools.map(tool => tool.name).sort()).toEqual(['locator_export', 'locator_rebuild', 'locator_search', 'locator_status'])
    const statusTool = tools.find(tool => tool.name === 'locator_status')
    await waitForIndex(statusTool)
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

  it('starts the content index only on the first content search', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-lazy-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-lazy-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    writeFileSync(join(root, 'notes.md'), 'LAZYCONTENTMARK the body is only indexed on demand\n')
    writeFileSync(join(root, 'other.txt'), 'unrelated content\n')
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
      watch: false,
      refreshIntervalMs: 1_800_000,
      scanWorkers: 0,
      memoryLimitMB: 0,
      contentIndex: true,
      contentLazy: true,
      contentMaxFileBytes: 1_000_000,
      contentMaxTotalBytes: 0,
      contentRefreshMs: 0,
      contentMaxFiles: 0,
      contentFullIndex: false,
      contentIndexReasoning: false,
      contentMaxSessions: 0,
      contentSessionDirs: [],
      contentExcludes: [],
      contentIncludeArchived: false,
      contentActiveSessionDelayMs: 0,
      windowsUsn: false,
      stateDir: state,
      binaryPath: binary,
      maxResults: 100,
      startupTimeoutMs: 30_000,
      requestTimeoutMs: 10_000,
      httpConnectionOptional: false,
    }
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(root, 'dsh-home')
    try {
      apply(ctx, config)
      stopEngines.push(() => { for (const dispose of disposers.reverse()) dispose() })
      const statusTool = tools.find(tool => tool.name === 'locator_status') as RegisteredTool
      await waitForIndex(statusTool)
      // Nothing content-related must exist before the first content use.
      expect(existsSync(join(state, 'content.db'))).toBe(false)
      const find = tools.find(tool => tool.name === 'locator_find') as RegisteredTool
      await find.execute({ query: 'LAZYCONTENTMARK', limit: 5 }, { signal: new AbortController().signal })
      let value = { state: { building: false, files: 0 } }
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        const next = (await find.execute({ query: 'LAZYCONTENTMARK', limit: 5 }, { signal: new AbortController().signal })) as {
          hits: Array<{ path: string }>
          state: { building: boolean; files: number }
        }
        value = next as never
        if (!next.state.building && next.state.files > 0) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(value.state.files).toBeGreaterThan(0)
      const hits = (value as unknown as { hits: Array<{ path: string }> }).hits
      expect(hits[0]?.path).toBe(join(root, 'notes.md'))
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('uses the cordis timer service for the boot delay and the refresh cadence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locator-timers-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-timers-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    writeFileSync(join(root, 'a.md'), 'timer content alpha\n')
    writeFileSync(join(root, 'b.md'), 'timer content beta\n')
    const tools: RegisteredTool[] = []
    const disposers: Array<() => void> = []
    const timeoutDelays: number[] = []
    const intervalDelays: number[] = []
    const disposed: string[] = []
    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
      effect: (factory: () => () => void) => { disposers.push(factory()) },
      tools: { register: (tool: RegisteredTool) => { tools.push(tool) } },
      get: (name: string) => name === 'timer'
        ? {
            timeout: (callback: () => void, delay: number) => {
              timeoutDelays.push(delay)
              callback()
              return () => { disposed.push('timeout') }
            },
            interval: (_callback: () => void, delay: number) => {
              intervalDelays.push(delay)
              return () => { disposed.push('interval') }
            },
          }
        : undefined,
    } as unknown as Context
    const config: Config = {
      enabled: true,
      roots: [root],
      excludes: ['node_modules'],
      watch: false,
      refreshIntervalMs: 1_800_000,
      scanWorkers: 0,
      memoryLimitMB: 0,
      contentIndex: true,
      contentLazy: false,
      contentMaxFileBytes: 1_000_000,
      contentMaxTotalBytes: 0,
      contentRefreshMs: 60_000,
      contentMaxFiles: 0,
      contentFullIndex: false,
      contentIndexReasoning: false,
      contentMaxSessions: 0,
      contentSessionDirs: [],
      contentExcludes: [],
      contentIncludeArchived: false,
      contentActiveSessionDelayMs: 0,
      windowsUsn: false,
      stateDir: state,
      binaryPath: binary,
      maxResults: 100,
      startupTimeoutMs: 30_000,
      requestTimeoutMs: 10_000,
      httpConnectionOptional: false,
    }
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(root, 'dsh-home')
    try {
      apply(ctx, config)
      stopEngines.push(() => { for (const dispose of disposers.reverse()) dispose() })
      const statusTool = tools.find(tool => tool.name === 'locator_status') as RegisteredTool
      await waitForIndex(statusTool)
      const find = tools.find(tool => tool.name === 'locator_find') as RegisteredTool
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const value = (await find.execute({ query: 'timer', limit: 5 }, { signal: new AbortController().signal })) as { state?: { building?: boolean; files?: number } }
        if (value.state?.building === false && (value.state?.files ?? 0) > 0) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(timeoutDelays).toEqual([1500])
      expect(intervalDelays).toEqual([60_000])
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

})

describe('HTTP surface gating (no engine required)', () => {
  interface Mounted {
    routes: string[]
    tools: string[]
    dispose: () => void
  }

  /** Mount the plugin with a recording Web server and an optional connection service. */
  function mount(connection?: unknown): Mounted {
    const routes: string[] = []
    const tools: RegisteredTool[] = []
    const disposers: Array<() => void> = []
    const root = mkdtempSync(join(tmpdir(), 'locator-http-mount-'))
    const state = mkdtempSync(join(tmpdir(), 'locator-http-mount-state-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }))
    const services: Record<string, unknown> = {
      webServer: {
        register: (route: { path: string }) => {
          routes.push(route.path)
          return () => {}
        },
      },
      ...(connection === undefined ? {} : { connection }),
    }
    const scoped = {
      effect: (factory: () => () => void) => { disposers.push(factory()) },
      get: (name: string) => services[name],
    }
    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
      effect: (factory: () => () => void) => { disposers.push(factory()) },
      tools: { register: (tool: RegisteredTool) => { tools.push(tool) } },
      inject: (deps: string[], callback: (scopedCtx: Context) => void) => {
        if (deps.every(dep => services[dep] !== undefined)) callback(scoped as unknown as Context)
      },
    } as unknown as Context
    const config: Config = {
      enabled: true,
      roots: [root],
      excludes: ['node_modules'],
      watch: false,
      refreshIntervalMs: 0,
      scanWorkers: 0,
      memoryLimitMB: 0,
      contentIndex: false,
      contentLazy: true,
      contentMaxFileBytes: 1_000_000,
      contentMaxTotalBytes: 0,
      contentRefreshMs: 0,
      contentMaxFiles: 0,
      contentFullIndex: false,
      contentIndexReasoning: false,
      contentMaxSessions: 0,
      contentSessionDirs: [],
      contentExcludes: [],
      contentIncludeArchived: false,
      contentActiveSessionDelayMs: 0,
      windowsUsn: false,
      stateDir: state,
      binaryPath: binary,
      maxResults: 100,
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      httpConnectionOptional: false,
    }
    apply(ctx, config)
    return {
      routes,
      tools: tools.map(tool => tool.name),
      dispose: () => { for (const dispose of disposers.reverse()) dispose() },
    }
  }

  it('mounts no panel routes without the connection trust fence', () => {
    // A Web server alone is not enough: exposing the routes would be fail-open.
    const mounted = mount()
    try {
      expect(mounted.tools).toEqual(expect.arrayContaining(['locator_search', 'locator_status']))
      expect(mounted.routes).toEqual([])
    } finally {
      mounted.dispose()
    }
  })

  it('mounts the panel routes when webServer and connection are both present', () => {
    const mounted = mount({ requestRejection: () => undefined })
    try {
      expect(mounted.routes.sort()).toEqual([
        '/dsh-locator/combined',
        '/dsh-locator/open',
        '/dsh-locator/reveal',
        '/dsh-locator/search',
        '/dsh-locator/status',
      ])
    } finally {
      mounted.dispose()
    }
  })
})
