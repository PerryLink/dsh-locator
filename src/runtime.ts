/**
 * Lifecycle of the locator engine child process and its line-delimited JSON
 * protocol.
 * @module dsh-locator/runtime
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Config } from './config.ts'

/** One search hit. */
export interface SearchHit {
  path: string
  name: string
  size: number
  mtime: number
  ext: string
  dir: boolean
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
  scanning: boolean
  usn: boolean
  uptimeSec: number
  stateDir: string
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
    const args = ['serve', '--state', this.stateDir]
    for (const root of this.roots) args.push('--root', root)
    for (const exclude of this.config.excludes) args.push('--exclude', exclude)
    if (!this.config.watch) args.push('--no-watch')
    if (this.config.refreshIntervalMs > 0) args.push('--refresh', `${String(this.config.refreshIntervalMs)}ms`)
    if (this.config.scanWorkers > 0) args.push('--workers', String(this.config.scanWorkers))
    if (this.config.memoryLimitMB > 0) args.push('--memory-limit-mb', String(this.config.memoryLimitMB))
    if (this.config.windowsUsn) args.push('--usn')

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
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
      scanning: params.scanning === true,
      usn: params.usn === true,
      uptimeSec: numberOr(params.uptimeSec, 0),
      stateDir: typeof params.stateDir === 'string' ? params.stateDir : this.stateDir,
    }
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

  /** Read one page of the index for an export. */
  async dump(after: number, limit: number): Promise<DumpPage> {
    return await this.request<DumpPage>('dump', { after, limit })
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
