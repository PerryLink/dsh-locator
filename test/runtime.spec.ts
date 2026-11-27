import { chmodSync, realpathSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Config } from '../src/config.ts'
import {
  AUTO_MEMORY_MAX_MB,
  AUTO_MEMORY_MIN_MB,
  LocatorRuntime,
  autoMemoryLimitMB,
  engineResourceFields,
  engineServeArgs,
  prepareEngineBinary,
} from '../src/runtime.ts'

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
      allowCrossWorkspaceSessions: false,
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

/** A runtime whose RPC layer is replaced by one capturing callback. */
function fakeRpcRuntime(): { rt: LocatorRuntime; calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const rt = new LocatorRuntime(config(), [], '/state', '/nonexistent-indexd', process.cwd())
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  Object.assign(rt, {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      return {}
    },
  })
  return { rt, calls }
}

/** One engine status payload as the engine will send it in 0.20.0. */
function statusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.20.0',
    platform: 'linux/amd64',
    roots: ['/root'],
    entries: 5,
    files: 4,
    dirs: 1,
    nameBytes: 100,
    deleted: 0,
    watching: true,
    scanning: false,
    usn: false,
    uptimeSec: 3,
    stateDir: '/state',
    ...overrides,
  }
}

describe('automatic memory limit', () => {
  it('clamps a quarter of physical memory to 384-1024 MiB', () => {
    expect(AUTO_MEMORY_MIN_MB).toBe(384)
    expect(AUTO_MEMORY_MAX_MB).toBe(1024)
    expect(autoMemoryLimitMB(512 * 1024 * 1024)).toBe(384) // 128 -> clamped up
    expect(autoMemoryLimitMB(2 * 1024 * 1024 * 1024)).toBe(512) // 512 exactly
    expect(autoMemoryLimitMB(8 * 1024 * 1024 * 1024)).toBe(1024) // 2048 -> clamped down
    expect(autoMemoryLimitMB(15.7 * 1024 * 1024 * 1024)).toBe(1024)
    expect(autoMemoryLimitMB(0)).toBe(384)
    expect(autoMemoryLimitMB(Number.NaN)).toBe(384)
  })
})

describe('engine serve arguments', () => {
  it('passes the incremental-refresh switch only when it is explicitly off', () => {
    const base = config()
    const incremental = engineServeArgs(base, ['/root'], '/state')
    // memoryLimitMB is always present now; 0 means the machine-sized auto value.
    expect(incremental).toEqual([
      'serve', '--state', '/state', '--root', '/root',
      '--exclude', 'node_modules', '--exclude', '.git',
      '--refresh', '1800000ms',
      '--memory-limit-mb', String(autoMemoryLimitMB()),
    ])
    expect(engineServeArgs({ ...base, watch: false }, ['/root'], '/state')).toContain('--no-watch')
    const legacy = engineServeArgs({ ...base, refreshIncremental: false }, ['/root'], '/state')
    expect(legacy).toContain('--no-incremental-refresh')
    const explicit = engineServeArgs({ ...base, refreshIncremental: true }, ['/root'], '/state')
    expect(explicit).not.toContain('--no-incremental-refresh')
  })

  it('pins an explicit memory limit instead of the automatic one', () => {
    const args = engineServeArgs({ ...config(), memoryLimitMB: 512 }, ['/root'], '/state')
    expect(args[args.indexOf('--memory-limit-mb') + 1]).toBe('512')
    // A fractional value is truncated to whole MiB.
    const fractional = engineServeArgs({ ...config(), memoryLimitMB: 400.9 }, ['/root'], '/state')
    expect(fractional[fractional.indexOf('--memory-limit-mb') + 1]).toBe('400')
  })

  it('passes the 0.20.0 resource flags only when configured', () => {
    const base = config()
    expect(engineServeArgs(base, ['/root'], '/state')).not.toContain('--include-caches')
    expect(engineServeArgs({ ...base, includeCaches: true }, ['/root'], '/state')).toContain('--include-caches')

    // Hand-built configs without the optional fields keep the engine defaults.
    expect(engineServeArgs(base, ['/root'], '/state')).not.toContain('--watch-max-dirs')
    const limited = engineServeArgs({ ...base, watchMaxDirs: 60_000 }, ['/root'], '/state')
    expect(limited[limited.indexOf('--watch-max-dirs') + 1]).toBe('60000')
    expect(engineServeArgs({ ...base, watchMaxDirs: 0 }, ['/root'], '/state')).not.toContain('--watch-max-dirs')

    // Compression stays opt-in so the pre-wave2 engine never sees an unknown flag.
    expect(engineServeArgs({ ...base, snapshotCompression: 'none' }, ['/root'], '/state')).not.toContain('--snapshot-compression')
    const zstd = engineServeArgs({ ...base, snapshotCompression: 'zstd' }, ['/root'], '/state')
    expect(zstd[zstd.indexOf('--snapshot-compression') + 1]).toBe('zstd')
  })

  it('passes the unwatched-root refresh cadence only when it is positive', () => {
    const base = config()
    // Hand-built configs without the optional field keep the engine default.
    expect(engineServeArgs(base, ['/root'], '/state')).not.toContain('--unwatched-refresh')
    const tuned = engineServeArgs({ ...base, unwatchedRefreshIntervalMs: 600_000 }, ['/root'], '/state')
    expect(tuned[tuned.indexOf('--unwatched-refresh') + 1]).toBe('600000ms')
    // A fractional value is truncated to whole milliseconds.
    const fractional = engineServeArgs({ ...base, unwatchedRefreshIntervalMs: 599_999.9 }, ['/root'], '/state')
    expect(fractional[fractional.indexOf('--unwatched-refresh') + 1]).toBe('599999ms')
    expect(engineServeArgs({ ...base, unwatchedRefreshIntervalMs: 0 }, ['/root'], '/state')).not.toContain('--unwatched-refresh')
    expect(engineServeArgs({ ...base, unwatchedRefreshIntervalMs: -5 }, ['/root'], '/state')).not.toContain('--unwatched-refresh')
  })
})

describe('dump narrowing options', () => {
  it('forwards since/mtimeFrom only when they are positive finite numbers', async () => {
    const { rt, calls } = fakeRpcRuntime()
    await rt.dump(0, 100)
    await rt.dump(5, 50, { since: 7, mtimeFrom: 1_700_000_000_000 })
    await rt.dump(0, 10, { since: 0, mtimeFrom: -1 })
    expect(calls.map(call => call.params)).toEqual([
      { after: 0, limit: 100 },
      { after: 5, limit: 50, since: 7, mtimeFrom: 1_700_000_000_000 },
      { after: 0, limit: 10 },
    ])
    expect(calls.every(call => call.method === 'dump')).toBe(true)
  })
})

describe('engine status cache', () => {
  it('serves a fresh stats copy within the TTL and refreshes after it', async () => {
    const { rt, calls } = fakeRpcRuntime()
    let statusCalls = 0
    Object.assign(rt, {
      request: async (method: string) => {
        calls.push({ method, params: {} })
        if (method !== 'status') return {}
        statusCalls++
        return statusPayload()
      },
    })
    const first = await rt.engineStatusCached(1_000)
    expect(first?.entries).toBe(5)
    expect(statusCalls).toBe(1)
    // A second poll within the TTL must not pay another IPC round-trip.
    const second = await rt.engineStatusCached(1_000)
    expect(second).toBe(first)
    expect(statusCalls).toBe(1)
    // TTL 0 forces a real refresh.
    await rt.engineStatusCached(0)
    expect(statusCalls).toBe(2)
  })

  it('copies the 0.20.0 observability fields off the status payload', async () => {
    const { rt } = fakeRpcRuntime()
    Object.assign(rt, {
      request: async (method: string) => method === 'status'
        ? statusPayload({
            rssBytes: 123_456_789,
            hwmBytes: 200_000_000,
            watchDirs: 55_000,
            watchLimit: 120_000,
            watchLimited: true,
            watchInitializing: true,
            snapshotBytes: 40_000_000,
            saveBytes: 39_000_000,
            saveMs: 210,
            saveCount: 3,
            generation: 42,
            builtAt: 1_700_000_000_000,
            queueDepth: 2,
            queryCount: 9,
            lastQueryMs: 1.5,
            recentQueryMs: [1, 2, 2.5],
            heapBytes: 90_000_000,
            numGC: 7,
            refreshBackoffMs: 4_000,
            unwatchedRefreshMs: 600_000,
            nextRefreshAt: 1_700_000_600_000,
            refreshRounds: 12,
            refreshSkippedByPressure: 3,
          })
        : {},
    })
    const engine = await rt.engineStatus()
    expect(engine).toMatchObject({
      rssBytes: 123_456_789,
      watchDirs: 55_000,
      watchLimit: 120_000,
      watchLimited: true,
      watchInitializing: true,
      snapshotBytes: 40_000_000,
      generation: 42,
      builtAt: 1_700_000_000_000,
      recentQueryMs: [1, 2, 2.5],
      unwatchedRefreshMs: 600_000,
      nextRefreshAt: 1_700_000_600_000,
      refreshRounds: 12,
      refreshSkippedByPressure: 3,
    })
    const fields = engineResourceFields(engine)
    expect(fields).toMatchObject({
      rssBytes: 123_456_789,
      saveCount: 3,
      recentQueryMs: [1, 2, 2.5],
      unwatchedRefreshMs: 600_000,
      nextRefreshAt: 1_700_000_600_000,
      refreshRounds: 12,
      refreshSkippedByPressure: 3,
    })
    expect(fields).not.toHaveProperty('version')
    expect(engineResourceFields(undefined)).toEqual({})
  })
})

describe('windows engine copy', () => {
  /** A throwaway package binary fixture. */
  function fixture(sourceSize = 1024): { source: string; state: string } {
    const base = mkdtempSync(join(tmpdir(), 'locator-engine-copy-'))
    cleanups.push(() => rmSync(base, { recursive: true, force: true }))
    const source = join(base, 'package', 'indexd.exe')
    mkdirSync(join(base, 'package'))
    writeFileSync(source, 'MZ'.repeat(sourceSize / 2))
    return { source, state: join(base, 'state') }
  }

  it('is a no-op outside Windows', () => {
    const { source, state } = fixture()
    const prepared = prepareEngineBinary(source, state, '0.23.0', 'linux')
    expect(prepared.path).toBe(source)
    expect(prepared.copied).toBe(false)
    expect(prepared.cleaned).toEqual([])
    expect(prepared.warning).toBeUndefined()
    expect(existsSync(join(state, 'engine'))).toBe(false)
  })

  it('copies the binary below the state directory and prunes old versions', () => {
    const { source, state } = fixture()
    const oldCopy = join(state, 'engine', '0.22.3', 'indexd.exe')
    mkdirSync(join(state, 'engine', '0.22.3'), { recursive: true })
    writeFileSync(oldCopy, 'old')

    const prepared = prepareEngineBinary(source, state, '0.23.0', 'win32')
    const expected = join(state, 'engine', '0.23.0', 'indexd.exe')
    expect(prepared.path).toBe(expected)
    expect(prepared.copied).toBe(true)
    expect(existsSync(expected)).toBe(true)
    expect(readFileSync(expected)).toEqual(readFileSync(source))
    // The previous package version's copy is gone.
    expect(prepared.cleaned).toContain(join(state, 'engine', '0.22.3'))
    expect(existsSync(oldCopy)).toBe(false)
    if (process.platform !== 'win32') expect(statSync(expected).mode & 0o777).toBe(0o755)
  })

  it('reuses a fresh copy and recopies when the package binary changes', () => {
    const { source, state } = fixture()
    const first = prepareEngineBinary(source, state, '0.23.0', 'win32')
    expect(first.copied).toBe(true)
    const second = prepareEngineBinary(source, state, '0.23.0', 'win32')
    expect(second.path).toBe(first.path)
    expect(second.copied).toBe(false)
    // A longer package binary means an in-place upgrade; the copy is refreshed.
    writeFileSync(source, 'MZ'.repeat(4096))
    const third = prepareEngineBinary(source, state, '0.23.0', 'win32')
    expect(third.copied).toBe(true)
    expect(readFileSync(third.path)).toEqual(readFileSync(source))
  })

  it('keeps a hostile version from escaping the engine directory', () => {
    const { source, state } = fixture()
    const prepared = prepareEngineBinary(source, state, '..\\..\\evil', 'win32')
    expect(prepared.path.startsWith(join(state, 'engine') + '/')).toBe(true)
    expect(prepared.path).not.toContain('..')
  })

  it('falls back to the package binary when the source is missing', () => {
    const state = mkdtempSync(join(tmpdir(), 'locator-engine-copy-'))
    cleanups.push(() => rmSync(state, { recursive: true, force: true }))
    const missing = join(state, 'missing-indexd.exe')
    const prepared = prepareEngineBinary(missing, state, '0.23.0', 'win32')
    expect(prepared.path).toBe(missing)
    expect(prepared.warning).toMatch(/cannot copy the engine/)
  })
})

describe.skipIf(process.platform === 'win32')('state directory permissions at startup', () => {
  it('tightens an existing state directory before the engine starts', async () => {
    const state = mkdtempSync(join(tmpdir(), 'locator-perm-state-'))
    cleanups.push(() => rmSync(state, { recursive: true, force: true }))
    writeFileSync(join(state, 'meta.json'), '{}')
    chmodSync(join(state, 'meta.json'), 0o644)
    chmodSync(state, 0o755)

    const rt = new LocatorRuntime(config(), [], state, join(tmpdir(), 'missing-indexd'), process.cwd())
    rt.start()
    await expect(rt.waitReady()).rejects.toThrow(/ENOENT|locator engine/)
    expect(rt.status.permissions?.fixed).toContain('meta.json')
    expect(statSync(join(state, 'meta.json')).mode & 0o777).toBe(0o600)
    expect(statSync(state).mode & 0o777).toBe(0o700)
    await rt.stop()
  })
})

describe('read-only engine status', () => {
  it('copies the state-directory lock fields off the status payload', async () => {
    const { rt } = fakeRpcRuntime()
    Object.assign(rt, {
      request: async (method: string) => method === 'status' ? statusPayload({ readOnly: true, lockPid: 4242 }) : {},
    })
    const engine = await rt.engineStatus()
    expect(engine).toMatchObject({ readOnly: true, lockPid: 4242 })
    // They are control fields, not numeric resource metrics.
    expect(engineResourceFields(engine)).not.toHaveProperty('lockPid')
  })
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

    // A first dump page reports a generation; asking again with the same
    // generation short-circuits to the unchanged fast path.
    const page = await rt.dump(0, 100)
    expect(typeof page.generation).toBe('number')
    const since = page.generation
    const again = await rt.dump(0, 100, since === undefined ? {} : { since })
    expect(again.unchanged).toBe(true)
    expect(again.entries).toEqual([])

    await rt.stop()
  })

  it('reports a missing engine binary as a tool-visible error', async () => {
    const rt = new LocatorRuntime(config(), [tmpdir()], mkdtempSync(join(tmpdir(), 'locator-state-')), join(tmpdir(), 'missing-indexd'), process.cwd())
    rt.start()
    await expect(rt.waitReady()).rejects.toThrow(/ENOENT|locator engine/)
    await rt.stop()
  })
})
