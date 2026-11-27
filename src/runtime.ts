/**
 * Lifecycle of the locator engine child process and its line-delimited JSON
 * protocol.
 * @module dsh-locator/runtime
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Config } from './config.ts'
import { packageVersion, secureStateDir, type StateDirPermissions } from './paths.ts'

/** One search hit. */
export interface SearchHit {
  path: string
  name: string
  size: number
  mtime: number
  ext: string
  dir: boolean
  /** Citable evidence ref for this name hit (ref://file). */
  ref?: string
}

/** One search result page. */
export interface SearchResult {
  total: number
  returned: number
  offset: number
  truncated: boolean
  indexing?: boolean
  tookNs: number
  hits: SearchHit[]
}

/** Search arguments forwarded to the engine. */
export interface SearchArgs {
  query: string
  limit: number
  offset: number
  sort: string
  desc: boolean
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  filesOnly: boolean
  dirsOnly: boolean
}

/** One row of a paginated index dump. */
export interface DumpEntry {
  path: string
  name: string
  size: number
  mtime: number
  ext: string
  dir: boolean
}

/** One page of an index dump. */
export interface DumpPage {
  entries: DumpEntry[]
  next: number
  done: boolean
  /**
   * Set when the caller's `since` generation already matches the engine's
   * current generation: the page is empty and there is nothing to walk.
   */
  unchanged?: boolean
  /** Index generation this page was read from (content refresh fast path). */
  generation?: number
}

/** Optional narrowing for one dump walk (content refresh fast path). */
export interface DumpOptions {
  /** Only walk when the index generation differs from this value. */
  since?: number
  /** Only return entries modified at/after this epoch millisecond. */
  mtimeFrom?: number
}

/** Engine status as reported by the `status` method and events. */
export interface EngineStatus {
  version: string
  platform: string
  roots: string[]
  entries: number
  files: number
  dirs: number
  nameBytes: number
  deleted: number
  watching: boolean
  /** The native watcher covers only part of the configured roots. */
  watchDegraded?: boolean
  watchReason?: string
  /** Number of roots actually watched. */
  watchRoots?: number
  /** Periodic rebuild fallback is active because the watcher is incomplete. */
  refreshFallback?: boolean
  /** The fallback refreshes only watcher-less roots instead of re-scanning all. */
  incrementalRefresh?: boolean
  /** Configured roots no native watcher covers (refreshed by the fallback). */
  watchUnwatchedRoots?: string[]
  /** Last fallback refresh mode: incremental or full. */
  refreshMode?: string
  /** Why the last fallback refresh ran. */
  refreshReason?: string
  /** Roots scanned by the last fallback refresh. */
  refreshScannedRoots?: string[]
  /** Healthy roots skipped by the last incremental refresh. */
  refreshSkippedRoots?: string[]
  /** Entries re-read by the last fallback refresh. */
  refreshEntries?: number
  /** Wall-clock cost of the last fallback refresh. */
  refreshTookMs?: number
  /** Epoch milliseconds of the last fallback refresh. */
  refreshAt?: number
  /** Configured refresh cadence for roots without a native watcher, in ms (0 = engine default). */
  unwatchedRefreshMs?: number
  /** Epoch milliseconds of the next scheduled fallback refresh. */
  nextRefreshAt?: number
  /** Completed fallback-refresh rounds since engine start. */
  refreshRounds?: number
  /** Fallback refreshes skipped by the pressure gate since engine start. */
  refreshSkippedByPressure?: number
  scanning: boolean
  usn: boolean
  uptimeSec: number
  stateDir: string
  /** Index generation (moves on every real mutation); used by the content fast path. */
  generation?: number
  /** Epoch milliseconds of the snapshot the index was loaded/built from (ms, not ns). */
  builtAt?: number
  /** The async watcher install is still running; `watching` fills in on a later stats event. */
  watchInitializing?: boolean
  /** Completed query RPCs since engine start. */
  queryCount?: number
  /** Wall-clock cost of the last query RPC, in milliseconds. */
  lastQueryMs?: number
  /** Ring of the last query durations in ms, newest last. */
  recentQueryMs?: number[]
  /** Go heap size in bytes. */
  heapBytes?: number
  /** Number of completed GC cycles. */
  numGC?: number
  /** Current refresh retry backoff, in milliseconds. */
  refreshBackoffMs?: number
  /** Engine process resident set size, in bytes (observability, optional). */
  rssBytes?: number
  /** Engine process peak resident set size, in bytes (observability, optional). */
  hwmBytes?: number
  /** Directories currently watched by the native watcher. */
  watchDirs?: number
  /** Configured watcher directory budget (`watchMaxDirs`). */
  watchLimit?: number
  /** The watcher hit its directory budget and leaves the rest to incremental refresh. */
  watchLimited?: boolean
  /** On-disk snapshot size in bytes. */
  snapshotBytes?: number
  /** Bytes written by the last snapshot save. */
  saveBytes?: number
  /** Wall-clock cost of the last snapshot save. */
  saveMs?: number
  /** Snapshot saves since engine start. */
  saveCount?: number
  /** Pending work queue depth (refresh/scan), when the engine reports it. */
  queueDepth?: number
  /**
   * Another live engine owns the state directory (0.23 state-dir write lock):
   * this engine serves the snapshot read-only and does not write.
   */
  readOnly?: boolean
  /** PID of the engine that owns the state-directory write lock. */
  lockPid?: number
}

/** One prepared engine binary: the path to spawn plus what had to be done. */
export interface PreparedEngineBinary {
  /** The executable to spawn. */
  path: string
  /** True when the executable was copied out of the package (Windows only). */
  copied: boolean
  /** Copy directories removed while pruning old package versions. */
  cleaned: string[]
  /** A non-fatal problem; the package binary is then used unchanged. */
  warning?: string
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface RpcError {
  code?: string
  message?: string
}

/** Runtime status exposed to the status tool. */
export interface RuntimeStatus {
  running: boolean
  error?: string
  warning?: string
  scanning?: { phase: string; entries?: number; current?: string }
  engine?: EngineStatus
  /** Result of the startup state-directory permission pass (P0-2 follow-up). */
  permissions?: StateDirPermissions
}

/** Smallest automatic engine heap limit, in MiB. */
export const AUTO_MEMORY_MIN_MB = 384
/** Largest automatic engine heap limit, in MiB. */
export const AUTO_MEMORY_MAX_MB = 1024

/**
 * Derive the automatic Go heap limit that `memoryLimitMB: 0` means: a quarter
 * of physical memory clamped to {@link AUTO_MEMORY_MIN_MB}-{@link AUTO_MEMORY_MAX_MB}
 * MiB. The result is always passed to the engine as `--memory-limit-mb` so an
 * unset configuration never leaves the engine without a GOMEMLIMIT (the 0.19.x
 * behavior that let the engine grow past 1 GB RSS).
 * @param totalBytes - physical memory in bytes (defaults to this machine).
 * @returns the limit in MiB.
 */
export function autoMemoryLimitMB(totalBytes: number = totalmem()): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return AUTO_MEMORY_MIN_MB
  const quarterMB = Math.trunc(totalBytes / (1024 * 1024) / 4)
  return Math.min(AUTO_MEMORY_MAX_MB, Math.max(AUTO_MEMORY_MIN_MB, quarterMB))
}

/**
 * Build the argv for one `indexd serve` session.
 *
 * Extracted so the fallback-refresh switch (`--no-incremental-refresh`), the
 * 0.20.0 resource flags (`--include-caches`, `--watch-max-dirs`,
 * `--snapshot-compression`) and the always-present `--memory-limit-mb` can be
 * asserted without spawning a process.
 *
 * Optional config fields (the 0.20.0 additions) are omitted from the argv when
 * they are `undefined`, which keeps the engine's own defaults in force and keeps
 * hand-built configs (tests/embedders) valid; a profile load always materializes
 * them through the schema, so production always passes them.
 * @param config - validated plugin configuration.
 * @param roots - resolved index roots.
 * @param stateDir - snapshot directory.
 * @returns the engine argv.
 */
export function engineServeArgs(
  config: Pick<
    Config,
    | 'excludes'
    | 'watch'
    | 'refreshIntervalMs'
    | 'refreshIncremental'
    | 'scanWorkers'
    | 'memoryLimitMB'
    | 'windowsUsn'
    | 'includeCaches'
    | 'watchMaxDirs'
    | 'snapshotCompression'
    | 'unwatchedRefreshIntervalMs'
  >,
  roots: readonly string[],
  stateDir: string,
): string[] {
  const args = ['serve', '--state', stateDir]
  for (const root of roots) args.push('--root', root)
  for (const exclude of config.excludes) args.push('--exclude', exclude)
  if (!config.watch) args.push('--no-watch')
  // Default true: periodic fallback refreshes only watcher-less roots. false
  // restores the 0.18 full-rescan behavior.
  if (config.refreshIncremental === false) args.push('--no-incremental-refresh')
  if (config.refreshIntervalMs > 0) args.push('--refresh', String(config.refreshIntervalMs) + 'ms')
  // Roots without a native watcher (9p/DrvFs, NFS, SMB) get their own, usually
  // faster cadence. Absent/0 keeps the engine default (min(unwatched, base)).
  const unwatchedRefreshMs = config.unwatchedRefreshIntervalMs
  if (typeof unwatchedRefreshMs === 'number' && Number.isFinite(unwatchedRefreshMs) && unwatchedRefreshMs > 0) {
    args.push('--unwatched-refresh', String(Math.trunc(unwatchedRefreshMs)) + 'ms')
  }
  if (config.scanWorkers > 0) args.push('--workers', String(config.scanWorkers))
  // 0 means "auto": derive the machine-sized limit and always pass it, so an
  // unset memoryLimitMB no longer leaves the engine unbounded.
  const memoryLimitMB = config.memoryLimitMB > 0 ? Math.trunc(config.memoryLimitMB) : autoMemoryLimitMB()
  args.push('--memory-limit-mb', String(memoryLimitMB))
  // Absent means "exclude the toolchain/package caches"; only an explicit true
  // restores the pre-0.20 full-coverage scan.
  if (config.includeCaches === true) args.push('--include-caches')
  if (typeof config.watchMaxDirs === 'number' && Number.isFinite(config.watchMaxDirs) && config.watchMaxDirs > 0) {
    args.push('--watch-max-dirs', String(Math.trunc(config.watchMaxDirs)))
  }
  // Compression is opt-in and wave2-only: absent keeps the engine's `none` default.
  if (config.snapshotCompression === 'zstd') args.push('--snapshot-compression', 'zstd')
  if (config.windowsUsn) args.push('--usn')
  return args
}

/**
 * Copy the package engine binary below the state directory on Windows.
 *
 * Windows locks a running executable against replacement, so upgrading the
 * plugin in place fails with a sharing violation while the old engine is still
 * running from `bin/win32-<arch>/indexd.exe`. Spawning from
 * `<stateDir>/engine/<packageVersion>/indexd.exe` instead decouples the
 * running engine from the package directory: npm can replace the package, the
 * old engine keeps its private copy, and the next start uses the new version.
 *
 * Copies for other package versions are pruned afterwards (best effort: an old
 * engine may still hold its executable, which Windows refuses to delete and the
 * next boot retries). On every other platform the package binary is executed
 * directly and this function is a no-op.
 * @param binary - the package engine binary.
 * @param stateDir - the resolved state directory.
 * @param version - the package version the copy is keyed by.
 * @param platform - the platform to prepare for (defaults to this one).
 * @returns the executable path and what was copied/cleaned.
 */
export function prepareEngineBinary(
  binary: string,
  stateDir: string,
  version: string,
  platform: NodeJS.Platform = process.platform,
): PreparedEngineBinary {
  const result: PreparedEngineBinary = { path: binary, copied: false, cleaned: [] }
  if (platform !== 'win32') return result
  const engineDir = join(stateDir, 'engine')
  // A directory name, never a path: separators become '_' and leading dots are
  // stripped so a hostile package version cannot escape the engine directory.
  const safeVersion = version
    .replace(/[^0-9A-Za-z._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '') || 'unknown'
  const copyDir = join(engineDir, safeVersion)
  const copy = join(copyDir, 'indexd.exe')
  try {
    mkdirSync(copyDir, { recursive: true, mode: 0o700 })
  } catch (error) {
    result.warning = `cannot create the engine copy directory ${copyDir}: ${errorMessage(error)}`
    return result
  }
  let stale = true
  try {
    const source = statSync(binary)
    const existing = statSync(copy)
    stale = existing.size !== source.size || existing.mtimeMs < source.mtimeMs
  } catch {
    // Missing copy (first run) or missing source; the copyFileSync below reports
    // a missing package binary properly.
    stale = true
  }
  if (stale) {
    const temporary = copy + '.tmp-' + String(process.pid)
    try {
      copyFileSync(binary, temporary)
      try { chmodSync(temporary, 0o755) } catch { /* Windows ignores POSIX modes */ }
      renameSync(temporary, copy)
      result.copied = true
      result.path = copy
    } catch (error) {
      try { rmSync(temporary, { force: true }) } catch { /* keep the old copy */ }
      result.warning = `cannot copy the engine to ${copy}: ${errorMessage(error)}; spawning ${binary} instead`
      return result
    }
  } else {
    result.path = copy
  }
  try {
    for (const entry of readdirSync(engineDir)) {
      if (entry === safeVersion) continue
      const old = join(engineDir, entry)
      try {
        rmSync(old, { recursive: true, force: true })
        result.cleaned.push(old)
      } catch {
        // A still-running engine from that version holds its executable; the
        // next boot retries. Not a warning: this is the normal upgrade path.
      }
    }
  } catch {
    // The directory disappeared between mkdir and readdir; the copy above is fine.
  }
  return result
}

/** Message of an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Owns the engine process. Tools await {@link LocatorRuntime.waitReady} before
 * issuing requests; a missing binary or a crashed engine surfaces as a tool
 * error carrying the engine's own message.
 */
export class LocatorRuntime {
  readonly status: RuntimeStatus = { running: false }

  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private started = false
  private disposed = false
  private failure: string | null = null
  private readonly ready: Promise<void>
  private settleReady!: (failure?: string) => void
  private settled = false
  private startupTimer: NodeJS.Timeout | undefined
  /** Epoch ms of the last stats event/RPC reply; drives the status TTL cache. */
  private lastStatsAt: number | undefined

  constructor(
    readonly config: Config,
    readonly roots: string[],
    readonly stateDir: string,
    readonly binary: string,
    readonly cwd: string,
  ) {
    this.ready = new Promise<void>(resolve => {
      this.settleReady = (failure?: string) => {
        if (this.settled) return
        this.settled = true
        if (failure !== undefined) this.failure = failure
        resolve()
      }
    })
  }

  /** Start the engine once. Safe to call repeatedly. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    // Old (<=0.22) engines created the state directory 0755 and the snapshot
    // 0644. Tighten what already exists before the engine opens it; the new
    // engine writes 0700/0600 itself. Best effort: a read-only profile must not
    // prevent the engine from starting.
    const permissions = secureStateDir(this.stateDir)
    this.status.permissions = permissions
    this.spawn()
  }

  private spawn(): void {
    // npm and git checkouts can lose the executable bit on the bundled engine.
    // Restore it (best effort) before spawning; Windows does not use it.
    if (process.platform !== 'win32') {
      try {
        chmodSync(this.binary, 0o755)
      } catch {
        // A read-only install cannot be fixed here; spawn reports the real error.
      }
    }
    // Windows: spawn a private copy below the state directory so an in-place
    // package upgrade can replace bin/ while this engine keeps running.
    const prepared = prepareEngineBinary(this.binary, this.stateDir, packageVersion())
    if (prepared.warning !== undefined) console.error(`[dsh-locator] ${prepared.warning}`)
    const args = engineServeArgs(this.config, this.roots, this.stateDir)

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(prepared.path, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      this.fail(error)
      return
    }
    this.child = child
    this.status.running = true
    delete this.status.error

    const out = createInterface({ input: child.stdout })
    out.on('line', line => this.onLine(line))
    const err = createInterface({ input: child.stderr })
    err.on('line', line => {
      if (line.trim() !== '') console.error(`[dsh-locator] ${line}`)
    })

    child.once('error', error => this.fail(error))
    child.once('exit', (code, signal) => this.onExit(code, signal))

    this.startupTimer = setTimeout(() => {
      this.fail(
        `locator engine did not become ready in ${String(this.config.startupTimeoutMs)} ms; ` +
          `a very large root may still be scanning (state: ${this.stateDir})`,
      )
    }, this.config.startupTimeoutMs)
  }

  private onLine(line: string): void {
    if (line.trim() === '') return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      console.error(`[dsh-locator] malformed engine output: ${line.slice(0, 200)}`)
      return
    }
    if (!isRecord(message)) return
    if (typeof message.event === 'string') {
      this.onEvent(message.event, message.params)
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (isRecord(message.error)) {
      const rpc = message.error as RpcError
      pending.reject(new Error(rpc.message ?? rpc.code ?? 'engine request failed'))
      return
    }
    pending.resolve(message.result)
  }

  private onEvent(event: string, params: unknown): void {
    switch (event) {
      case 'ready':
      case 'stats':
        this.applyStats(params)
        this.clearStartupTimer()
        this.settleReady()
        break
      case 'scan': {
        if (!isRecord(params)) break
        const phase = typeof params.phase === 'string' ? params.phase : ''
        if (phase === 'done') {
          delete this.status.scanning
        } else if (phase !== '') {
          const scanning: { phase: string; entries?: number; current?: string } = { phase }
          if (typeof params.entries === 'number') scanning.entries = params.entries
          if (typeof params.current === 'string' && params.current !== '') scanning.current = params.current
          this.status.scanning = scanning
        }
        break
      }
      case 'warning':
        if (isRecord(params) && typeof params.message === 'string') this.status.warning = params.message
        break
      case 'error':
        if (isRecord(params) && typeof params.message === 'string') this.status.error = params.message
        break
      default:
        break
    }
  }

  private applyStats(params: unknown): void {
    if (!isRecord(params)) return
    const roots = Array.isArray(params.roots) ? params.roots.filter((r): r is string => typeof r === 'string') : this.roots
    this.status.engine = {
      version: typeof params.version === 'string' ? params.version : '0.1.0',
      platform: typeof params.platform === 'string' ? params.platform : '',
      roots,
      entries: numberOr(params.entries, 0),
      files: numberOr(params.files, 0),
      dirs: numberOr(params.dirs, 0),
      nameBytes: numberOr(params.nameBytes, 0),
      deleted: numberOr(params.deleted, 0),
      watching: params.watching === true,
      ...(params.watchDegraded === true ? { watchDegraded: true } : {}),
      ...(typeof params.watchReason === 'string' ? { watchReason: params.watchReason } : {}),
      ...(typeof params.watchRoots === 'number' ? { watchRoots: params.watchRoots } : {}),
      ...(params.refreshFallback === true ? { refreshFallback: true } : {}),
      ...(typeof params.incrementalRefresh === 'boolean' ? { incrementalRefresh: params.incrementalRefresh } : {}),
      ...(Array.isArray(params.watchUnwatchedRoots) ? { watchUnwatchedRoots: stringList(params.watchUnwatchedRoots) } : {}),
      ...(typeof params.refreshMode === 'string' ? { refreshMode: params.refreshMode } : {}),
      ...(typeof params.refreshReason === 'string' ? { refreshReason: params.refreshReason } : {}),
      ...(Array.isArray(params.refreshScannedRoots) ? { refreshScannedRoots: stringList(params.refreshScannedRoots) } : {}),
      ...(Array.isArray(params.refreshSkippedRoots) ? { refreshSkippedRoots: stringList(params.refreshSkippedRoots) } : {}),
      ...(typeof params.refreshEntries === 'number' ? { refreshEntries: params.refreshEntries } : {}),
      ...(typeof params.refreshTookMs === 'number' ? { refreshTookMs: params.refreshTookMs } : {}),
      ...(typeof params.refreshAt === 'number' ? { refreshAt: params.refreshAt } : {}),
      ...(typeof params.unwatchedRefreshMs === 'number' ? { unwatchedRefreshMs: params.unwatchedRefreshMs } : {}),
      ...(typeof params.nextRefreshAt === 'number' ? { nextRefreshAt: params.nextRefreshAt } : {}),
      ...(typeof params.refreshRounds === 'number' ? { refreshRounds: params.refreshRounds } : {}),
      ...(typeof params.refreshSkippedByPressure === 'number' ? { refreshSkippedByPressure: params.refreshSkippedByPressure } : {}),
      ...(typeof params.generation === 'number' ? { generation: params.generation } : {}),
      ...(typeof params.builtAt === 'number' ? { builtAt: params.builtAt } : {}),
      ...(typeof params.rssBytes === 'number' ? { rssBytes: params.rssBytes } : {}),
      ...(typeof params.hwmBytes === 'number' ? { hwmBytes: params.hwmBytes } : {}),
      ...(typeof params.watchDirs === 'number' ? { watchDirs: params.watchDirs } : {}),
      ...(typeof params.watchLimit === 'number' ? { watchLimit: params.watchLimit } : {}),
      ...(params.watchLimited === true ? { watchLimited: true } : {}),
      ...(typeof params.snapshotBytes === 'number' ? { snapshotBytes: params.snapshotBytes } : {}),
      ...(typeof params.saveBytes === 'number' ? { saveBytes: params.saveBytes } : {}),
      ...(typeof params.saveMs === 'number' ? { saveMs: params.saveMs } : {}),
      ...(typeof params.saveCount === 'number' ? { saveCount: params.saveCount } : {}),
      ...(typeof params.queueDepth === 'number' ? { queueDepth: params.queueDepth } : {}),
      ...(params.readOnly === true ? { readOnly: true } : {}),
      ...(typeof params.lockPid === 'number' ? { lockPid: params.lockPid } : {}),
      ...(params.watchInitializing === true ? { watchInitializing: true } : {}),
      ...(typeof params.queryCount === 'number' ? { queryCount: params.queryCount } : {}),
      ...(typeof params.lastQueryMs === 'number' ? { lastQueryMs: params.lastQueryMs } : {}),
      ...(Array.isArray(params.recentQueryMs) ? { recentQueryMs: numberList(params.recentQueryMs) } : {}),
      ...(typeof params.heapBytes === 'number' ? { heapBytes: params.heapBytes } : {}),
      ...(typeof params.numGC === 'number' ? { numGC: params.numGC } : {}),
      ...(typeof params.refreshBackoffMs === 'number' ? { refreshBackoffMs: params.refreshBackoffMs } : {}),
      scanning: params.scanning === true,
      usn: params.usn === true,
      uptimeSec: numberOr(params.uptimeSec, 0),
      stateDir: typeof params.stateDir === 'string' ? params.stateDir : this.stateDir,
    }
    this.lastStatsAt = Date.now()
  }

  private clearStartupTimer(): void {
    if (this.startupTimer !== undefined) {
      clearTimeout(this.startupTimer)
      this.startupTimer = undefined
    }
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.clearStartupTimer()
    this.status.running = false
    this.status.error = message
    this.settleReady(message)
    this.rejectPending(new Error(message))
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.clearStartupTimer()
    this.child = null
    this.status.running = false
    const message = this.disposed
      ? 'locator engine stopped'
      : `locator engine exited (code ${String(code)}, signal ${String(signal)})`
    if (!this.disposed) this.status.error = message
    this.settleReady(message)
    this.rejectPending(new Error(message))
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  /** Wait until the engine is ready, or throw the recorded startup failure. */
  async waitReady(): Promise<void> {
    await this.ready
    if (this.failure !== null) throw new Error(this.failure)
  }

  /** Issue one request against the engine. */
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.waitReady()
    const child = this.child
    if (child === null || !child.stdin.writable) throw new Error('locator engine is not running')
    const id = this.nextId++
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`locator engine request "${method}" timed out after ${String(this.config.requestTimeoutMs)} ms`))
      }, this.config.requestTimeoutMs)
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      })
    })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    return promise
  }

  /** Run a search. */
  async search(args: SearchArgs): Promise<SearchResult> {
    const result = await this.request<SearchResult>('search', {
      query: args.query,
      limit: args.limit,
      offset: args.offset,
      sort: args.sort,
      desc: args.desc,
      regex: args.regex,
      case: args.caseSensitive,
      wholeWord: args.wholeWord,
      filesOnly: args.filesOnly,
      dirsOnly: args.dirsOnly,
    })
    return {
      ...result,
      hits: Array.isArray(result.hits) ? result.hits : [],
    }
  }

  /**
   * Read one page of the index for an export or the content refresh.
   *
   * `since` is an index generation: when it still matches, the engine answers
   * `unchanged: true` without walking the index (content refresh fast path).
   * `mtimeFrom` narrows the walk to entries modified at/after that epoch ms.
   * Both are omitted when they are not positive finite numbers, so the
   * historical `dump(after, limit)` call keeps its exact behavior.
   * @param after - pagination cursor (entry index).
   * @param limit - page size.
   * @param opts - optional generation/mtime narrowing.
   * @returns one dump page.
   */
  async dump(after: number, limit: number, opts: DumpOptions = {}): Promise<DumpPage> {
    const params: Record<string, unknown> = { after, limit }
    if (typeof opts.since === 'number' && Number.isFinite(opts.since) && opts.since > 0) params.since = opts.since
    if (typeof opts.mtimeFrom === 'number' && Number.isFinite(opts.mtimeFrom) && opts.mtimeFrom > 0) params.mtimeFrom = opts.mtimeFrom
    return await this.request<DumpPage>('dump', params)
  }

  /** Read live status from the engine, refreshing the cached event copy. */
  async engineStatus(): Promise<EngineStatus | undefined> {
    try {
      const raw = await this.request<Record<string, unknown>>('status')
      this.applyStats(raw)
      return this.status.engine
    } catch {
      return this.status.engine
    }
  }

  /**
   * Engine status served from the pushed stats cache for `ttlMs` (default 1 s),
   * falling back to one status RPC when the copy is absent or stale.
   *
   * The engine emits a `stats` event on every state change and the runtime
   * keeps the latest copy, so a panel polling `/status` no longer pays an IPC
   * round-trip on every tick (0.20.0 P0-12).
   * @param ttlMs - how long a pushed stats copy stays fresh.
   * @returns the current engine status, if any.
   */
  async engineStatusCached(ttlMs = 1_000): Promise<EngineStatus | undefined> {
    const last = this.lastStatsAt
    if (this.status.engine !== undefined && last !== undefined && Date.now() - last < ttlMs) return this.status.engine
    return await this.engineStatus()
  }

  /** Ask the engine to rebuild the whole index in the background. */
  async rebuild(roots?: string[], excludes?: string[]): Promise<{ started: boolean }> {
    return await this.request<{ started: boolean }>('rebuild', {
      ...(roots === undefined ? {} : { roots }),
      ...(excludes === undefined ? {} : { excludes }),
    })
  }

  /** Stop the engine and wait for its process to exit. */
  async stop(): Promise<void> {
    this.disposed = true
    this.clearStartupTimer()
    const child = this.child
    if (child === null) return
    try {
      child.stdin.write(JSON.stringify({ id: 0, method: 'shutdown', params: {} }) + '\n')
    } catch {
      // The pipe is already gone; the kill below still applies.
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 1500)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.child = null
    this.status.running = false
  }
}

/** Numeric engine status fields copied through to the status outputs. */
const ENGINE_NUMBER_FIELDS = [
  'generation',
  'builtAt',
  'rssBytes',
  'hwmBytes',
  'watchDirs',
  'watchLimit',
  'snapshotBytes',
  'saveBytes',
  'saveMs',
  'saveCount',
  'queueDepth',
  'queryCount',
  'lastQueryMs',
  'heapBytes',
  'numGC',
  'refreshBackoffMs',
  'unwatchedRefreshMs',
  'nextRefreshAt',
  'refreshRounds',
  'refreshSkippedByPressure',
] as const

/**
 * The additive engine resource/observability fields, ready to spread into a
 * status payload (locator_status, HTTP /status).
 *
 * The 0.20.0 engine reports these as optional numbers; a field the running
 * engine does not know about is simply absent, so old snapshots/binaries keep
 * rendering. Only finite numbers and true booleans are forwarded (a 0 is a
 * meaningful value and is kept).
 * @param engine - engine status, if the engine already answered.
 * @returns a bounded record of present fields.
 */
export function engineResourceFields(engine: EngineStatus | undefined): Record<string, number | boolean | number[]> {
  if (engine === undefined) return {}
  const source = engine as unknown as Record<string, unknown>
  const fields: Record<string, number | boolean | number[]> = {}
  for (const key of ENGINE_NUMBER_FIELDS) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) fields[key] = value
  }
  if (source.watchLimited === true) fields.watchLimited = true
  if (source.watchInitializing === true) fields.watchInitializing = true
  const recent = source.recentQueryMs
  if (Array.isArray(recent)) {
    fields.recentQueryMs = recent.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  }
  return fields
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Only the string entries of an engine array field. */
function stringList(value: readonly unknown[]): string[] {
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** Only the finite-number entries of an engine array field. */
function numberList(value: readonly unknown[]): number[] {
  return value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
}
