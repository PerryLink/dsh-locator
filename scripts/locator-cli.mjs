#!/usr/bin/env node
/**
 * locator-cli.mjs — public, host-free CLI and the shared core of the read-only
 * MCP server (scripts/locator-mcp.mjs imports this module).
 *
 * Two data paths, exactly like the plugin:
 *   - file names: spawn the bundled Go engine (indexd serve --no-watch) and
 *     speak its line-delimited JSON-RPC over stdio;
 *   - file bodies: open <state>/content.db with node:sqlite in read-only mode
 *     and run the same FTS5 trigram query the plugin uses.
 *
 * P0 read-only contract (0.21.1): the engine never sees the caller's state
 * directory. prepareReadOnlyState() copies index.snapshot / index.journal /
 * meta.json into a private mkdtemp directory and every engine spawn points at
 * that copy, so a search/status invocation cannot create, rewrite, append to or
 * fsync the live index. The content database is opened through SQLite's
 * immutable URI (or a temporary copy on platforms without URI support), which
 * keeps SQLite from creating -wal/-shm side files next to the caller's DB.
 *
 * The CLI never talks to a live DSH host and never mutates state: it is safe to
 * run next to (or instead of) the plugin.
 *
 * Exit codes: 0 success, 1 unexpected runtime error, 2 usage/validation error,
 * 3 index or engine unavailable.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, constants as fsConstants, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Exit codes shared by the CLI and the MCP tool wrapper. */
export const EXIT_OK = 0
export const EXIT_RUNTIME = 1
export const EXIT_USAGE = 2
export const EXIT_UNAVAILABLE = 3

/** Structured CLI failure; carries the stable code and its exit status. */
export class CliError extends Error {
  /**
   * @param {string} code - stable machine-readable code.
   * @param {string} message - human-readable detail.
   * @param {number} exitCode - process exit status.
   */
  constructor(code, message, exitCode = EXIT_RUNTIME) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Package root (the script lives in <root>/scripts/). */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Package version, read from package.json (no dynamic import side effects). */
export const version = (() => {
  try {
    return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Platform tag used by the bundled engine directories. */
export function platformTag() {
  return process.platform + '-' + process.arch
}

/** Bundled engine file name for this platform. */
export function engineName() {
  return process.platform === 'win32' ? 'indexd.exe' : 'indexd'
}

/** Default snapshot directory, mirroring src/paths.ts. */
export function defaultStateDir() {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'dsh-locator')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'dsh-locator')
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dsh-locator')
}

/** Resolve the engine binary: explicit override, bundled build, then PATH. */
export function resolveEngineBinary(env = process.env) {
  const explicit = env.DSH_LOCATOR_BIN
  if (typeof explicit === 'string' && explicit !== '') return resolve(explicit)
  const name = engineName()
  const bundled = join(packageRoot, 'bin', platformTag(), name)
  if (existsSync(bundled)) return bundled
  const plain = join(packageRoot, 'bin', name)
  if (existsSync(plain)) return plain
  return name
}

/** Resolve the index roots: --root flags, DSH_LOCATOR_ROOTS, then the home directory. */
export function resolveRoots(flagRoots = [], env = process.env) {
  const envRoots = typeof env.DSH_LOCATOR_ROOTS === 'string' && env.DSH_LOCATOR_ROOTS !== ''
    ? env.DSH_LOCATOR_ROOTS.split(delimiter).filter(part => part !== '')
    : []
  const candidates = flagRoots.length > 0 ? flagRoots : envRoots
  const roots = candidates.length > 0 ? candidates : [homedir()]
  return roots.map(root => resolve(root))
}

/** Resolve the snapshot directory: --state flag, DSH_LOCATOR_STATE, platform default. */
export function resolveStateDir(flag, env = process.env) {
  if (typeof flag === 'string' && flag !== '') return resolve(flag)
  const fromEnv = env.DSH_LOCATOR_STATE
  if (typeof fromEnv === 'string' && fromEnv !== '') return resolve(fromEnv)
  return defaultStateDir()
}

/** Files a locator engine reads from and writes to its state directory. */
export const STATE_FILE_NAMES = Object.freeze(['index.snapshot', 'index.journal', 'meta.json'])

/** Prefix of every temporary engine-state copy (diagnostics only). */
const READ_ONLY_STATE_PREFIX = 'dsh-locator-readonly-'

/** Prefix of every temporary content-database copy. */
const CONTENT_COPY_PREFIX = 'dsh-locator-content-'

/** Default soft output budget for search/find results, in characters. */
export const DEFAULT_SEARCH_BUDGET_CHARS = 8_000

/** Maximum page size, aligned with the host locator tools (src/config.ts maxResults). */
export const MAX_SEARCH_LIMIT = 100

/** Temporary engine-state copies that still need cleanup (also cleaned on process exit). */
const liveReadOnlyStates = new Set()
let readOnlyExitHookInstalled = false

/** Copy one file, preferring a copy-on-write reflink and falling back to a byte copy. */
function copyFileForReadOnly(from, to) {
  if (typeof fsConstants.COPYFILE_FICLONE === 'number') {
    try {
      copyFileSync(from, to, fsConstants.COPYFILE_FICLONE)
      return
    } catch { /* reflink unsupported; fall through to a plain copy */ }
  }
  copyFileSync(from, to)
}

/** Remove every temporary state copy before the process disappears. */
function installReadOnlyExitHook() {
  if (readOnlyExitHookInstalled || typeof process === 'undefined' || typeof process.once !== 'function') return
  readOnlyExitHookInstalled = true
  process.once('exit', () => {
    for (const state of [...liveReadOnlyStates]) {
      try { state.cleanup() } catch { /* best effort while exiting */ }
    }
  })
}

/**
 * Build a private, read-only copy of a caller's engine state directory.
 *
 * The engine (indexd serve) needs a writable state directory: it appends
 * index.journal and rewrites index.snapshot/meta.json while it runs. Pointing
 * it at the caller's live state would mutate a running plugin's index, so the
 * three state files are copied into a fresh mkdtemp directory and the engine is
 * spawned against that copy. Nothing is ever written to sourceStateDir (it is
 * not even created when it does not exist).
 *
 * @param sourceStateDir - the caller's state directory (may not exist).
 * @returns the temporary engine state plus a cleanup function.
 */
export function prepareReadOnlyState(sourceStateDir) {
  const engineStateDir = mkdtempSync(join(tmpdir(), READ_ONLY_STATE_PREFIX))
  const copied = []
  let sourceExists = false
  try {
    sourceExists = statSync(sourceStateDir).isDirectory()
  } catch {
    sourceExists = false
  }
  try {
    if (sourceExists) {
      for (const name of STATE_FILE_NAMES) {
        const from = join(sourceStateDir, name)
        let info
        try { info = statSync(from) } catch { continue }
        if (!info.isFile()) continue
        copyFileForReadOnly(from, join(engineStateDir, name))
        copied.push(name)
      }
    }
  } catch (error) {
    try { rmSync(engineStateDir, { recursive: true, force: true }) } catch { /* best effort */ }
    throw new CliError(
      'read-only-state-failed',
      'cannot prepare a read-only copy of ' + String(sourceStateDir) + ': ' + String(error && error.message ? error.message : error),
      EXIT_UNAVAILABLE,
    )
  }
  const state = {
    sourceStateDir,
    engineStateDir,
    copied,
    readOnly: true,
    cleanup: () => {
      if (!liveReadOnlyStates.delete(state)) return
      try { rmSync(engineStateDir, { recursive: true, force: true, maxRetries: 2 }) } catch { /* best effort */ }
    },
  }
  liveReadOnlyStates.add(state)
  installReadOnlyExitHook()
  return state
}

/** Remove every still-live temporary state copy (tests and fatal paths). */
export function cleanupReadOnlyStates() {
  for (const state of [...liveReadOnlyStates]) {
    try { state.cleanup() } catch { /* best effort */ }
  }
}

/**
 * One lazy, long-lived engine session backed by a temporary read-only state
 * copy. The first request spawns the engine; every later request reuses it, so
 * a long-lived MCP server starts exactly one engine and one state copy.
 * @param settings - resolved roots/binary/timeouts (the caller's stateDir).
 * @returns a session with start/request/waitForInitialScan/close helpers.
 */
export function createEngineSession(settings) {
  let engine = null
  let prepared = null
  let closed = false
  let spawnCount = 0
  const ensure = () => {
    if (closed) throw new CliError('engine-closed', 'the read-only engine session is already closed', EXIT_UNAVAILABLE)
    if (engine === null) {
      prepared = prepareReadOnlyState(settings.stateDir)
      engine = startEngine(settings, prepared.engineStateDir)
      spawnCount++
    }
    return engine
  }
  const session = {
    /** Number of engine processes spawned by this session (0 or 1 in practice). */
    get spawnCount() { return spawnCount },
    /** The temporary state directory the engine actually uses, once started. */
    get engineStateDir() { return prepared === null ? undefined : prepared.engineStateDir },
    /** State files copied from the caller's directory. */
    get copiedFiles() { return prepared === null ? [] : prepared.copied },
    /** Spawn the engine now (the MCP server does this during initialize). */
    start() { ensure(); return session },
    /** One engine RPC, spawning the engine on first use. */
    async request(method, params = {}, timeoutMs) { return await ensure().request(method, params, timeoutMs) },
    /** Wait for the engine's first scan, spawning the engine on first use. */
    async waitForInitialScan(timeoutMs) { return await ensure().waitForInitialScan(timeoutMs) },
    /** Stop the engine and delete the temporary state copy. Idempotent. */
    async close() {
      if (closed) return
      closed = true
      const current = engine
      engine = null
      try {
        if (current !== null) await current.close()
      } finally {
        const state = prepared
        prepared = null
        if (state !== null) state.cleanup()
      }
    },
  }
  return session
}

/** Default wait for the engine's background first scan before a one-shot search. */
export const INITIAL_SCAN_TIMEOUT_MS = 10_000

/** Status-poll interval while waiting for the initial scan. */
const INITIAL_SCAN_POLL_MS = 25

/** How long one scan-status probe may take before the engine counts as unresponsive. */
const SCAN_STATUS_PROBE_TIMEOUT_MS = 1_000

/** Effective first-scan wait: DSH_LOCATOR_SCAN_TIMEOUT overrides the 10 s default. */
export function scanTimeoutFrom(env = process.env) {
  const raw = env.DSH_LOCATOR_SCAN_TIMEOUT
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : INITIAL_SCAN_TIMEOUT_MS
}

/** Build the settings object every core function takes. */
export function makeSettings(overrides = {}, env = process.env) {
  return {
    roots: resolveRoots(overrides.roots ?? [], env),
    stateDir: resolveStateDir(overrides.state ?? overrides.stateDir, env),
    binary: typeof overrides.binary === 'string' && overrides.binary !== '' ? overrides.binary : resolveEngineBinary(env),
    timeoutMs: Number.isFinite(overrides.timeoutMs) ? Math.trunc(overrides.timeoutMs) : 15_000,
    scanTimeoutMs: Number.isFinite(overrides.scanTimeoutMs) ? Math.max(0, Math.trunc(overrides.scanTimeoutMs)) : scanTimeoutFrom(env),
    contentDb: join(resolveStateDir(overrides.state ?? overrides.stateDir, env), 'content.db'),
  }
}

/**
 * Start one engine session (name index only, watcher disabled) and return
 * request/close helpers. Ready is signalled by the engine's "ready" or "stats"
 * event; a failed spawn, an early exit or the timeout rejects it.
 *
 * engineStateDir must already exist and should be a temporary read-only copy
 * (see prepareReadOnlyState); the caller's stateDir is never created here.
 */
export function startEngine(settings, engineStateDir = settings.stateDir) {
  // Never create the caller's state directory here: the engine only ever runs
  // against the temporary copy prepared by prepareReadOnlyState() (see
  // createEngineSession), which already exists. A caller that explicitly asks
  // for a fresh state directory gets it created by the engine on first save.
  if (process.platform !== 'win32' && settings.binary.includes(sep)) {
    try { chmodSync(settings.binary, 0o755) } catch { /* read-only install */ }
  }
  const args = ['serve', '--state', engineStateDir]
  for (const root of settings.roots) args.push('--root', root)
  args.push('--no-watch')
  const child = spawn(settings.binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const pending = new Map()
  const waiterList = []
  let stderr = ''
  let nextId = 1
  let settled = false
  let resolveReady
  let rejectReady
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise
    rejectReady = rejectPromise
  })
  const settle = error => {
    if (settled) return
    settled = true
    if (error === undefined) resolveReady()
    else rejectReady(error)
  }
  const failAll = error => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
    for (const waiter of waiterList.splice(0)) waiter.reject(error)
  }
  // The engine emits ready *before* the background root scan starts, so track
  // what the events say about the first scan: 'unknown' when the engine does
  // not report a scanning flag at all (then waiting would be guesswork),
  // 'scanning' or 'idle' otherwise. waitForInitialScan() also polls status in
  // case an event is missed.
  let initialScanState = 'unknown'
  const noteEngineEvent = (event, params) => {
    if (params === null || typeof params !== 'object') return
    if (event === 'scan') {
      if (params.phase === 'done') initialScanState = 'idle'
      else if (typeof params.phase === 'string' && initialScanState !== 'idle') initialScanState = 'scanning'
      return
    }
    if (event !== 'ready' && event !== 'stats') return
    if (params.scanning === false) initialScanState = 'idle'
    else if (params.scanning === true && initialScanState !== 'idle') initialScanState = 'scanning'
  }
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const text = line.trim()
    if (text === '') return
    let message
    try { message = JSON.parse(text) } catch { return }
    if (message === null || typeof message !== 'object') return
    if (typeof message.event === 'string') {
      noteEngineEvent(message.event, message.params)
      if (message.event === 'ready' || message.event === 'stats') settle(undefined)
      return
    }
    if (typeof message.id === 'number') {
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error !== undefined && message.error !== null) {
        entry.reject(new Error(String(message.error.message ?? message.error.code ?? 'engine request failed')))
      } else {
        entry.resolve(message.result)
      }
      return
    }
  })
  child.stderr.on('data', chunk => {
    if (stderr.length < 8_192) stderr += chunk.toString('utf8')
  })
  child.once('error', error => {
    settle(new CliError('engine-unavailable', 'cannot start the locator engine: ' + error.message, EXIT_UNAVAILABLE))
    failAll(new CliError('engine-unavailable', error.message, EXIT_UNAVAILABLE))
  })
  child.once('exit', (code, signal) => {
    const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)
    const error = new CliError('engine-unavailable', 'locator engine exited (code ' + String(code ?? signal) + ')' + (detail === '' ? '' : ': ' + detail), EXIT_UNAVAILABLE)
    settle(error)
    failAll(error)
  })
  const readyTimer = setTimeout(() => {
    settle(new CliError('engine-timeout', 'locator engine did not become ready in ' + String(settings.timeoutMs) + ' ms', EXIT_UNAVAILABLE))
  }, settings.timeoutMs)
  ready.then(() => { clearTimeout(readyTimer) }, () => { clearTimeout(readyTimer) })

  /**
   * One engine request after readiness.
   * @param method - RPC method name.
   * @param params - request payload.
   * @param timeoutMs - per-request timeout (defaults to the CLI timeout).
   */
  async function request(method, params = {}, timeoutMs = settings.timeoutMs) {
    await ready
    const id = nextId++
    return await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectPromise(new CliError('engine-timeout', 'engine request ' + method + ' timed out', EXIT_UNAVAILABLE))
      }, timeoutMs)
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
      try {
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        rejectPromise(new CliError('engine-unavailable', String(error && error.message ? error.message : error), EXIT_UNAVAILABLE))
      }
    })
  }

  /**
   * Wait until the engine's background initial scan has finished.
   *
   * A one-shot search sent right after `ready` can legitimately see zero
   * entries on a slow or cold filesystem (Windows/macOS CI runners are much
   * slower than a warm Linux tmpdir), so poll the `status` RPC until
   * `scanning` is false instead of trusting event timing. Resolves false on
   * timeout (the caller then returns a partial result plus a warning) and when
   * the engine dies (the search that follows reports the real failure).
   * @param timeoutMs - maximum wait; defaults to the configured scan timeout.
   * @returns true when the scan finished, false when the wait timed out/aborted.
   */
  async function waitForInitialScan(timeoutMs = settings.scanTimeoutMs ?? INITIAL_SCAN_TIMEOUT_MS) {
    try {
      await ready
    } catch {
      return false
    }
    // An engine that does not report a scanning flag cannot be waited for;
    // answer from whatever it returns instead of stalling every custom engine.
    if (initialScanState === 'idle' || initialScanState === 'unknown') return true
    const deadline = Date.now() + Math.max(0, timeoutMs)
    for (;;) {
      const remaining = deadline - Date.now()
      try {
        const status = await request('status', {}, Math.max(1, Math.min(SCAN_STATUS_PROBE_TIMEOUT_MS, remaining)))
        if (status === null || typeof status !== 'object' || status.scanning !== true) {
          initialScanState = 'idle'
          return true
        }
      } catch {
        return false
      }
      if (Date.now() >= deadline) return false
      await new Promise(resolvePromise => setTimeout(resolvePromise, INITIAL_SCAN_POLL_MS))
    }
  }

  /** Ask the engine to shut down and wait for the process to exit. */
  async function close() {
    if (child.exitCode !== null) return
    try { child.stdin.write(JSON.stringify({ id: 0, method: 'shutdown', params: {} }) + '\n') } catch { /* pipe already gone */ }
    await new Promise(resolvePromise => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        resolvePromise()
      }, 1_000)
      child.once('exit', () => { clearTimeout(timer); resolvePromise() })
    })
  }
  return { request, close, child, waitForInitialScan }
}

/** Build a canonical ref://file URI (mirrors src/refs.ts fileRef). */
export function fileRefOf(input) {
  const params = new URLSearchParams()
  params.set('path', input.path)
  if (typeof input.mtime === 'number' && Number.isFinite(input.mtime)) params.set('mtime', String(Math.trunc(input.mtime)))
  if (typeof input.size === 'number' && Number.isFinite(input.size)) params.set('size', String(Math.trunc(input.size)))
  if (typeof input.line === 'number' && Number.isInteger(input.line) && input.line > 0) params.set('line', String(input.line))
  return 'ref://file?' + params.toString()
}

/** Build the canonical dsh-session: URI for one session id (mirrors src/refs.ts). */
export function sessionRefOf(sessionId) {
  return 'dsh-session:' + Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')
}

/** Apply the additive output budget block to one page of hits (mirrors src/scope.ts). */
export function applyHitBudget(items, limitChars) {
  const limit = typeof limitChars === 'number' && Number.isFinite(limitChars) ? Math.trunc(limitChars) : 0
  if (limit <= 0) return { items: [...items], budget: { limitChars: limit, usedChars: 0, truncated: false, dropped: 0 } }
  const kept = []
  let used = 0
  for (const item of items) {
    const size = JSON.stringify(item)?.length ?? 0
    if (kept.length > 0 && used + size > limit) break
    kept.push(item)
    used += size
  }
  const dropped = items.length - kept.length
  return { items: kept, budget: { limitChars: limit, usedChars: used, truncated: dropped > 0 || used > limit, dropped } }
}

/** Add the citable ref / freshness / permissions fields AI clients expect. */
function decorateNameHit(hit, observedAt) {
  if (hit === null || typeof hit !== 'object') return hit
  const path = typeof hit.path === 'string' ? hit.path : ''
  if (path === '') return hit
  const mtime = typeof hit.mtime === 'number' && Number.isFinite(hit.mtime) ? hit.mtime : undefined
  const size = typeof hit.size === 'number' && Number.isFinite(hit.size) ? hit.size : undefined
  const decorated = { ...hit, kind: hit.dir === true ? 'dir' : 'file' }
  if (hit.dir !== true) decorated.ref = fileRefOf({ path, ...(mtime === undefined ? {} : { mtime }), ...(size === undefined ? {} : { size }) })
  decorated.freshness = { state: 'unknown', observedAt, ...(mtime === undefined ? {} : { mtime }) }
  decorated.refStatus = 'unknown'
  decorated.permissions = { read: 'allowed', visibility: 'roots', reason: 'name hits come from the configured index roots' }
  return decorated
}

/** Run a name search through a shared read-only engine session. */
export async function runNameSearch(settings, query, options = {}) {
  const limit = clampInt(options.limit, 1, MAX_SEARCH_LIMIT, 50)
  const offset = clampInt(options.offset, 0, 1_000_000, 0)
  const budgetChars = clampInt(options.budgetChars, 0, 10_000_000, DEFAULT_SEARCH_BUDGET_CHARS)
  const engine = options.engine ?? createEngineSession(settings)
  const ownsEngine = options.engine === undefined
  const started = Date.now()
  try {
    // Wait for the engine's first scan before querying. `ready` is emitted
    // before the scan starts, so an immediate search could return zero hits on
    // a slow/cold filesystem (observed on Windows and macOS CI runners). On
    // timeout the search still runs and the result carries a warning.
    const scanComplete = await engine.waitForInitialScan()
    const result = await engine.request('search', {
      query,
      limit,
      offset,
      sort: options.sort ?? 'name',
      desc: options.desc === true,
      regex: options.regex === true,
      case: options.caseSensitive === true,
      wholeWord: options.wholeWord === true,
      filesOnly: options.filesOnly === true,
      dirsOnly: options.dirsOnly === true,
    })
    const observedAt = Date.now()
    const hits = (Array.isArray(result.hits) ? result.hits : []).map(hit => decorateNameHit(hit, observedAt))
    const budgeted = applyHitBudget(hits, budgetChars)
    const lossy = budgeted.budget.dropped > 0
    const hasTotal = typeof result.total === 'number'
    const total = hasTotal ? result.total : hits.length
    const truncated = result.truncated === true || (hasTotal ? total > offset + hits.length : hits.length >= limit) || lossy
    const nextOffset = truncated ? offset + (lossy ? hits.length : budgeted.items.length) : undefined
    return {
      ok: true,
      command: 'search',
      mode: 'names',
      query,
      limit,
      offset: typeof result.offset === 'number' ? result.offset : offset,
      total,
      totalCount: total,
      returned: budgeted.items.length,
      truncated,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      budget: budgeted.budget,
      indexing: result.indexing === true || !scanComplete,
      ...(scanComplete ? {} : { warnings: ['initial-scan-incomplete'] }),
      tookMs: Date.now() - started,
      hits: budgeted.items,
    }
  } catch (error) {
    throw asCliError(error, 'name-search-failed')
  } finally {
    if (ownsEngine) await engine.close()
  }
}

/**
 * Open a SQLite database with the immutable URI, which tells SQLite the file
 * will not change and therefore forbids it from creating -wal/-shm side files
 * next to the caller's database. Returns a read-only connection.
 */
function openImmutableContent(path) {
  // A file: URL keeps spaces / '%' / '#' in the path safe; SQLite accepts the
  // URL when the URI filename flag is enabled (node:sqlite sets it).
  return new DatabaseSync(pathToFileURL(path).href + '?immutable=1', { readOnly: true })
}

/** Copy content.db (+ its WAL, if present) into a temporary read-only directory. */
function openCopiedContent(path) {
  let dir
  try {
    dir = mkdtempSync(join(tmpdir(), CONTENT_COPY_PREFIX))
    copyFileForReadOnly(path, join(dir, 'content.db'))
    const wal = path + '-wal'
    if (existsSync(wal)) {
      try { if (statSync(wal).size > 0) copyFileForReadOnly(wal, join(dir, 'content.db-wal')) } catch { /* a vanished WAL is not fatal */ }
    }
    const db = new DatabaseSync(join(dir, 'content.db'), { readOnly: true })
    db.prepare('SELECT count(*) AS n FROM docs').get()
    return {
      db,
      path,
      readOnly: 'copy',
      walIgnored: false,
      close: () => {
        try { db.close() } catch { /* already closed */ }
        try { rmSync(dir, { recursive: true, force: true, maxRetries: 2 }) } catch { /* best effort */ }
      },
    }
  } catch (error) {
    if (dir !== undefined) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 2 }) } catch { /* best effort */ }
    }
    throw error
  }
}

/**
 * Read-only handle to <state>/content.db with a schema sanity probe.
 *
 * The caller's content directory is never written: the primary path opens the
 * database through SQLite's immutable URI (no -wal/-shm side files), and the
 * fallback copies the database into a temporary directory for SQLite builds
 * that do not accept URI filenames. Callers must use the returned close().
 */
export function openContentDb(stateDir) {
  const path = join(stateDir, 'content.db')
  if (!existsSync(path)) {
    throw new CliError('content-index-missing', 'content index not found: ' + path + ' (run a content search once in DSH)', EXIT_UNAVAILABLE)
  }
  let walIgnored = false
  try {
    const wal = path + '-wal'
    walIgnored = existsSync(wal) && statSync(wal).size > 0
  } catch { walIgnored = false }
  try {
    const db = openImmutableContent(path)
    db.prepare('SELECT count(*) AS n FROM docs').get()
    return {
      db,
      path,
      readOnly: 'immutable',
      walIgnored,
      close: () => { try { db.close() } catch { /* already closed */ } },
    }
  } catch (immutableError) {
    try {
      return openCopiedContent(path)
    } catch (copyError) {
      const detail = error => String(error && error.message ? error.message : error)
      throw new CliError('content-index-unreadable', 'cannot read ' + path + ': ' + detail(immutableError) + ' / ' + detail(copyError), EXIT_UNAVAILABLE)
    }
  }
}

/** Split a content query into trigram terms, rejecting shorter ones. */
export function contentTerms(query) {
  const terms = query.trim().split(/\s+/).filter(term => term !== '').map(term => term.replace(/^"|"$/g, ''))
  if (terms.length === 0) throw new CliError('content-query-empty', 'content query is empty', EXIT_USAGE)
  const short = terms.filter(term => Array.from(term).length < 3)
  if (short.length > 0) {
    throw new CliError('content-query-too-short', 'content search needs terms of at least 3 characters (got: ' + short.join(', ') + ')', EXIT_USAGE)
  }
  return terms
}

/** Escape one term as an FTS5 quoted phrase. */
function quoteFts(term) {
  return '"' + term.replace(/"/g, '""') + '"'
}

/** First line number and a bounded snippet around the first term occurrence. */
function snippetOf(body, terms) {
  const hay = body.toLowerCase()
  let best = -1
  let bestLength = 0
  for (const term of terms) {
    const index = hay.indexOf(term.toLowerCase())
    if (index < 0) continue
    if (best === -1 || index < best) { best = index; bestLength = term.length }
  }
  if (best === -1) {
    const flat = body.replace(/\s+/g, ' ').trim()
    return { snippet: flat.length > 240 ? flat.slice(0, 239) + '…' : flat, line: 1 }
  }
  const start = Math.max(0, best - 80)
  const end = Math.min(body.length, best + bestLength + 120)
  const flat = body.slice(start, end).replace(/\s+/g, ' ')
  const snippet = (start > 0 ? '…' : '') + flat + (end < body.length ? '…' : '')
  let line = 1
  for (let index = 0; index < best; index++) if (body.charCodeAt(index) === 10) line++
  return { snippet: snippet.length > 320 ? snippet.slice(0, 319) + '…' : snippet, line }
}

/** Escape LIKE metacharacters so a root path matches literally. */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, character => '\\' + character)
}

/** Trim trailing separators, keeping filesystem roots like "/" or "C:\\" intact. */
function trimTrailingSeparators(value) {
  if (value === '/' || /^[A-Za-z]:[\\/]$/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+$/.test(value)) return value
  return value.replace(/[\\/]+$/, '')
}

/**
 * SQL prefilter for the configured roots. Paths are compared lexically here;
 * the canonical containment check (resolveWithinRoots) still runs on every
 * returned row, so this is a performance aid and never the trust boundary.
 */
function contentPathScope(roots) {
  const prefixes = new Set()
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') continue
    for (const candidate of [root, resolve(root)]) prefixes.add(candidate)
    const canonical = realPathOf(root)
    if (canonical !== undefined) prefixes.add(canonical.path)
  }
  const clauses = []
  const params = []
  for (const prefix of prefixes) {
    const base = trimTrailingSeparators(prefix)
    if (base === '') continue
    clauses.push('docs.path = ?')
    params.push(base)
    for (const suffix of new Set([sep, '/', '\\'])) {
      clauses.push("docs.path LIKE ? ESCAPE '\\'")
      params.push(escapeLike(base + suffix) + '%')
    }
  }
  return { sql: clauses.length === 0 ? '0' : '(' + clauses.join(' OR ') + ')', params }
}

/** Look up the workspace cwd recorded for one indexed session log (schema v4 sources). */
function sessionWorkspaceOf(db, path, cache) {
  if (cache.has(path)) return cache.get(path)
  let cwd
  try {
    const row = db.prepare('SELECT cwd FROM sources WHERE path = ?').get(path)
    if (row !== undefined && row !== null && typeof row.cwd === 'string' && row.cwd !== '') cwd = row.cwd
  } catch { cwd = undefined }
  cache.set(path, cwd)
  return cwd
}

/** Canonical roots/session boundary for one content hit. */
function contentHitAllowed(hit, settings, allowSessions, db, cwdCache) {
  if (typeof hit.path !== 'string' || hit.path === '') return false
  if (resolveWithinRoots(hit.path, settings.roots) === undefined) return false
  if (hit.kind !== 'session') return true
  if (!allowSessions) return false
  const cwd = sessionWorkspaceOf(db, hit.path, cwdCache)
  if (cwd !== undefined && resolveWithinRoots(cwd, settings.roots) === undefined) return false
  return true
}

/** Map one content.db row into a hit carrying the AI contract fields. */
function toContentHit(row, terms, observedAt) {
  const body = typeof row.body === 'string' ? row.body : ''
  const snippet = snippetOf(body, terms)
  const kind = row.kind === 'session' ? 'session' : 'file'
  const path = typeof row.path === 'string' ? row.path : ''
  const sessionId = typeof row.session_id === 'string' && row.session_id !== '' ? row.session_id : undefined
  const hit = {
    kind,
    path,
    ...(typeof row.title === 'string' && row.title !== '' ? { title: row.title } : {}),
    snippet: snippet.snippet,
    line: snippet.line,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(typeof row.message_id === 'string' && row.message_id !== '' ? { messageId: row.message_id } : {}),
  }
  if (path !== '') {
    hit.ref = kind === 'session' && sessionId !== undefined ? sessionRefOf(sessionId) : fileRefOf({ path, line: snippet.line })
    hit.freshness = { state: 'unknown', observedAt }
    hit.refStatus = 'unknown'
    hit.permissions = kind === 'session'
      ? { read: 'allowed', visibility: 'session', reason: 'session log is inside the configured roots' }
      : { read: 'allowed', visibility: 'roots', reason: 'file is inside the configured roots' }
  }
  return hit
}

/**
 * Run one body query against content.db (read-only, roots/session bounded).
 *
 * Trust boundary: file hits are restricted to the configured roots; session
 * documents are omitted by default and only returned with allowSessions plus a
 * canonical path check (and, when the database records it, a workspace cwd
 * check). The SQL prefilter is not the boundary: every returned row is checked
 * again through resolveWithinRoots.
 */
export function runContentSearch(settings, query, options = {}) {
  const terms = contentTerms(query)
  const limit = clampInt(options.limit, 1, MAX_SEARCH_LIMIT, 30)
  const offset = clampInt(options.offset, 0, 100_000, 0)
  const allowSessions = options.allowSessions === true
  const { db, path, close, walIgnored } = openContentDb(settings.stateDir)
  try {
    const match = terms.map(quoteFts).join(' AND ')
    const scope = contentPathScope(settings.roots)
    const where = 'WHERE docs MATCH ?' + (allowSessions ? '' : " AND docs.kind = 'file'") + (scope.sql === '0' ? ' AND 0' : ' AND ' + scope.sql)
    const rows = db.prepare(
      'SELECT rowid AS rowid, kind AS kind, path AS path, title AS title, body AS body, session_id AS session_id, message_id AS message_id FROM docs ' + where + ' ORDER BY rank LIMIT ? OFFSET ?',
    ).all(match, ...scope.params, limit, offset)
    const observedAt = Date.now()
    const cwdCache = new Map()
    const hits = []
    let scopeDropped = 0
    for (const row of rows) {
      const hit = toContentHit(row, terms, observedAt)
      if (!contentHitAllowed(hit, settings, allowSessions, db, cwdCache)) { scopeDropped++; continue }
      hits.push(hit)
    }
    let total
    try {
      total = Number(db.prepare('SELECT count(*) AS n FROM docs ' + where).get(match, ...scope.params).n)
    } catch {
      total = undefined
    }
    const budgetChars = clampInt(options.budgetChars, 0, 10_000_000, 0)
    const budgeted = budgetChars > 0 ? applyHitBudget(hits, budgetChars) : { items: hits, budget: undefined }
    const lossy = scopeDropped > 0 || (budgeted.budget !== undefined && budgeted.budget.dropped > 0)
    const pageFull = rows.length >= limit
    const truncated = pageFull || lossy || (total !== undefined && total > offset + rows.length)
    const nextOffset = truncated ? offset + (lossy ? rows.length : budgeted.items.length) : undefined
    const warnings = []
    if (scopeDropped > 0) warnings.push('scope-filtered:' + String(scopeDropped))
    if (walIgnored === true) warnings.push('content-wal-not-visible')
    return {
      ok: true,
      command: 'content-search',
      mode: 'content',
      query,
      db: path,
      limit,
      offset,
      ...(total === undefined ? {} : { total }),
      returned: budgeted.items.length,
      truncated,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      ...(budgeted.budget === undefined ? {} : { budget: budgeted.budget }),
      ...(warnings.length === 0 ? {} : { warnings }),
      hits: budgeted.items,
    }
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError('content-query-failed', String(error && error.message ? error.message : error), EXIT_RUNTIME)
  } finally {
    close()
  }
}

/** Add surrounding source lines to file hits (find mode). */
export async function withContext(hits, contextLines) {
  if (contextLines <= 0) return hits
  return await Promise.all(hits.map(async hit => {
    if (hit.kind !== 'file' || typeof hit.line !== 'number') return hit
    try {
      const info = statSync(hit.path)
      if (!info.isFile() || info.size > 4 * 1024 * 1024) return hit
      const text = await readFile(hit.path, 'utf8')
      const all = text.split('\n')
      const center = Math.min(all.length, hit.line)
      const start = Math.max(1, center - contextLines)
      const end = Math.min(all.length, center + contextLines)
      return { ...hit, context: all.slice(start - 1, end).map(line => line.replace(/\r$/, '')), contextStart: start }
    } catch {
      return hit
    }
  }))
}

/** locator_find equivalent: body search plus context lines and the output budget. */
export async function runFindSearch(settings, query, options = {}) {
  const result = runContentSearch(settings, query, { ...options, budgetChars: 0 })
  const contextLines = clampInt(options.contextLines, 0, 10, 0)
  const hits = await withContext(result.hits, contextLines)
  const budgetChars = clampInt(options.budgetChars, 0, 10_000_000, DEFAULT_SEARCH_BUDGET_CHARS)
  const budgeted = applyHitBudget(hits, budgetChars)
  const lossy = budgeted.budget.dropped > 0
  const pageFull = result.hits.length >= result.limit
  const truncated = pageFull || lossy || (result.total !== undefined && result.total > result.offset + result.hits.length)
  const nextOffset = truncated ? result.offset + (lossy ? result.hits.length : budgeted.items.length) : undefined
  result.hits = budgeted.items
  result.returned = budgeted.items.length
  result.truncated = truncated
  result.budget = budgeted.budget
  if (nextOffset === undefined) delete result.nextOffset
  else result.nextOffset = nextOffset
  result.command = 'find'
  return result
}

/** Column names of one SQLite table, or an empty set when it does not exist. */
function tableColumns(db, table) {
  const names = new Set()
  try {
    for (const column of db.prepare('PRAGMA table_info(' + table + ')').all()) {
      if (column !== null && typeof column.name === 'string') names.add(column.name)
    }
  } catch { /* missing table */ }
  return names
}

/** Content-database counts with schema-v4 semantics (files / sessions / messages). */
function contentCounts(db) {
  const counts = { files: 0, sessions: 0, messages: 0 }
  const metaColumns = tableColumns(db, 'docs_meta')
  if (metaColumns.has('kind_id')) {
    for (const row of db.prepare('SELECT kind_id AS kindId, count(*) AS n FROM docs_meta GROUP BY kind_id').all()) {
      const kindId = Number(row.kindId)
      if (kindId === 0) counts.files = Number(row.n)
      else if (kindId === 1) counts.messages = Number(row.n)
    }
  } else {
    // Legacy pre-v4 database: the kind text lives on the docs row.
    for (const row of db.prepare('SELECT kind AS kind, count(*) AS n FROM docs GROUP BY kind').all()) {
      if (row.kind === 'file') counts.files = Number(row.n)
      else if (row.kind === 'session') counts.messages = Number(row.n)
    }
  }
  // v4 stores one sources row per indexed session log. A database written by
  // the plugin always has a sources row for every session document; a
  // hand-built or partially migrated database may not, so fall back to distinct
  // session ids only in that (empty-sources) case.
  try {
    counts.sessions = Number(db.prepare('SELECT count(*) AS n FROM sources').get().n)
  } catch { counts.sessions = 0 }
  if (counts.sessions === 0 && counts.messages > 0) {
    try {
      counts.sessions = Number(db.prepare("SELECT count(DISTINCT session_id) AS n FROM docs WHERE kind = 'session' AND session_id IS NOT NULL").get().n)
    } catch { /* keep the sources-derived zero */ }
  }
  return counts
}

/** Aggregate status: engine stats plus read-only content.db counts. */
export async function runStatus(settings, options = {}) {
  const session = options.engine ?? createEngineSession(settings)
  const ownsSession = options.engine === undefined
  const result = {
    ok: true,
    command: 'status',
    readOnly: true,
    roots: settings.roots,
    stateDir: settings.stateDir,
    binary: settings.binary,
    engine: { ok: false },
    content: { available: false },
    warnings: [],
  }
  try {
    try {
      const stats = await session.request('status')
      result.engine = {
        ok: true,
        readOnly: true,
        version: typeof stats.version === 'string' ? stats.version : '',
        platform: typeof stats.platform === 'string' ? stats.platform : '',
        entries: Number(stats.entries ?? 0),
        files: Number(stats.files ?? 0),
        dirs: Number(stats.dirs ?? 0),
        watching: stats.watching === true,
        scanning: stats.scanning === true,
        usn: stats.usn === true,
        stateDir: settings.stateDir,
      }
      if (Array.isArray(stats.roots) && stats.roots.length > 0) result.roots = stats.roots
      if (session.copiedFiles.length > 0) result.copiedStateFiles = session.copiedFiles
    } catch (error) {
      result.engine = { ok: false, error: error && error.code ? error.code + ': ' + error.message : String(error) }
      result.warnings.push('engine-unavailable')
    }
  } finally {
    if (ownsSession) {
      try { await session.close() } catch { /* already gone */ }
    }
  }
  try {
    if (!existsSync(join(settings.stateDir, 'content.db'))) {
      result.content = { available: false, reason: 'missing' }
    } else {
      const { db, close, readOnly, walIgnored } = openContentDb(settings.stateDir)
      try {
        const counts = contentCounts(db)
        let refs = 0
        try { refs = Number(db.prepare('SELECT count(*) AS n FROM refs').get().n) } catch { refs = 0 }
        result.content = { available: true, ...counts, refs, readOnly }
        if (walIgnored === true) result.warnings.push('content-wal-not-visible')
      } finally {
        close()
      }
    }
  } catch (error) {
    result.content = { available: false, reason: error && error.code ? error.code : 'unreadable' }
    result.warnings.push('content-index-unavailable')
  }
  return result
}

/** Canonical real path of a target or its nearest existing ancestor. */
export function realPathOf(target) {
  if (typeof target !== 'string' || target === '' || !isAbsolute(target)) return undefined
  const absolute = resolve(target)
  const missing = []
  let current = absolute
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return { path: missing.length === 0 ? real : join(real, ...missing.reverse()), exists: missing.length === 0 }
    } catch (error) {
      if (!(error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) return undefined
      const parent = dirname(current)
      if (parent === current) return undefined
      missing.push(basename(current))
      current = parent
    }
  }
}

/** Authorize one path against the configured roots on canonical paths. */
export function resolveWithinRoots(target, roots) {
  const real = realPathOf(target)
  if (real === undefined) return undefined
  for (const root of roots) {
    const canonical = realPathOf(root)
    if (canonical === undefined) continue
    const rel = relative(canonical.path, real.path)
    if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep) && !rel.startsWith('../'))) {
      return real
    }
  }
  return undefined
}

/** Decode a base64url JSON string (session ids in refs). */
function decodeBase64Json(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    return typeof parsed === 'string' && parsed !== '' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Parse any ref this release understands (mirrors src/refs.ts). */
export function parseRef(ref) {
  if (typeof ref !== 'string' || ref.trim() === '') return undefined
  const text = ref.trim()
  if (text.startsWith('dsh-session:')) {
    const sessionId = decodeBase64Json(text.slice('dsh-session:'.length))
    return sessionId === undefined ? undefined : { kind: 'session', ref: text, sessionId }
  }
  if (!text.startsWith('ref://')) return undefined
  let url
  try { url = new URL(text) } catch { return undefined }
  if (url.host === 'file') {
    const path = url.searchParams.get('path')
    if (path === null || path === '') return undefined
    const mtime = Number(url.searchParams.get('mtime') ?? '')
    const sha256 = url.searchParams.get('sha256') ?? undefined
    return { kind: 'file', ref: text, path, ...(Number.isFinite(mtime) && mtime > 0 ? { mtime: Math.trunc(mtime) } : {}), ...(sha256 ? { sha256 } : {}) }
  }
  if (url.host === 'url') {
    const target = url.searchParams.get('url') ?? url.searchParams.get('u')
    return target === null || target === '' ? undefined : { kind: 'url', ref: text, url: target }
  }
  if (url.host === 'session-event') {
    const sessionId = decodeBase64Json(url.searchParams.get('sid'))
    const seq = Number(url.searchParams.get('seq') ?? '')
    return sessionId === undefined || !Number.isInteger(seq) || seq < 0 ? undefined : { kind: 'session-event', ref: text, sessionId, seq }
  }
  if (url.host === 'spill') {
    const path = url.searchParams.get('path')
    if (path === null || path === '') return undefined
    const sessionId = decodeBase64Json(url.searchParams.get('sid'))
    return { kind: 'spill', ref: text, path, ...(sessionId === undefined ? {} : { sessionId }) }
  }
  if (url.host === 'attachment') {
    const sha256 = (url.searchParams.get('sha256') ?? '').toLowerCase()
    return /^[0-9a-f]{64}$/.test(sha256) ? { kind: 'attachment', ref: text, sha256 } : undefined
  }
  return undefined
}

/** Read the head of a file for an excerpt (bounded). */
async function readHead(path, maxBytes) {
  try {
    const info = statSync(path)
    if (!info.isFile()) return undefined
    const buffer = await readFile(path)
    return buffer.subarray(0, Math.min(maxBytes, buffer.length)).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Find the indexed log path for one session id.
 *
 * Schema v4 keeps one `sources` row per session log (the session id is the log
 * directory name); older databases are answered from the docs/docs_meta rows.
 * @returns the log path plus the mtime the index recorded, or undefined.
 */
function findSessionLog(db, sessionId) {
  try {
    for (const row of db.prepare('SELECT path, mtime FROM sources').all()) {
      if (typeof row.path !== 'string' || row.path === '') continue
      if (basename(dirname(row.path)) !== sessionId) continue
      return { path: row.path, ...(typeof row.mtime === 'number' ? { mtime: Math.trunc(row.mtime) } : {}) }
    }
  } catch { /* no sources table (legacy schema) */ }
  const metaColumns = tableColumns(db, 'docs_meta')
  try {
    if (metaColumns.has('path_id') && tableColumns(db, 'paths').has('path')) {
      const row = db.prepare('SELECT p.path AS path, m.mtime AS mtime FROM docs_meta m JOIN paths p ON p.id = m.path_id JOIN docs d ON d.rowid = m.rowid WHERE m.kind_id = 1 AND d.session_id = ? LIMIT 1').get(sessionId)
      if (row !== undefined && row !== null && typeof row.path === 'string') {
        return { path: row.path, ...(typeof row.mtime === 'number' ? { mtime: Math.trunc(row.mtime) } : {}) }
      }
    } else if (metaColumns.has('path')) {
      const row = db.prepare("SELECT m.path AS path, m.mtime AS mtime FROM docs_meta m JOIN docs d ON d.rowid = m.rowid WHERE d.kind = 'session' AND d.session_id = ? LIMIT 1").get(sessionId)
      if (row !== undefined && row !== null && typeof row.path === 'string') {
        return { path: row.path, ...(typeof row.mtime === 'number' ? { mtime: Math.trunc(row.mtime) } : {}) }
      }
    }
  } catch { /* fall through to the docs row */ }
  try {
    const row = db.prepare("SELECT path FROM docs WHERE kind = 'session' AND session_id = ? LIMIT 1").get(sessionId)
    if (row !== undefined && row !== null && typeof row.path === 'string' && row.path !== '') return { path: row.path }
  } catch { /* no usable docs row */ }
  return undefined
}

/** Resolve one evidence ref to metadata (read-only, roots-authorized). */
export async function resolveRef(settings, ref, options = {}) {
  const parsed = parseRef(ref)
  if (parsed === undefined) throw new CliError('invalid-ref', 'unsupported or malformed ref: ' + String(ref).slice(0, 120), EXIT_USAGE)
  const observedAt = Date.now()
  const mode = options.mode === 'excerpt' ? 'excerpt' : 'meta'
  const maxBytes = clampInt(options.maxBytes, 1, 65536, 2048)
  const denied = path => ({
    ok: false,
    ref: parsed.ref,
    kind: parsed.kind,
    error: 'content-path-denied',
    warnings: ['path-outside-roots'],
    permissions: { read: 'denied', visibility: 'roots', reason: 'path is outside every configured root' },
    path,
  })
  if (parsed.kind === 'file' || parsed.kind === 'spill') {
    const authorized = resolveWithinRoots(parsed.path, settings.roots)
    if (authorized === undefined) return denied(parsed.path)
    let info
    try { info = statSync(authorized.path) } catch { info = undefined }
    if (info === undefined) {
      return {
        ok: true,
        ref: parsed.ref,
        kind: parsed.kind,
        path: authorized.path,
        title: basename(authorized.path),
        freshness: { state: 'missing', observedAt },
        permissions: { read: 'allowed', visibility: 'roots', reason: 'path is inside the configured roots' },
        warnings: ['file-missing'],
      }
    }
    const hash = info.size <= 8 * 1024 * 1024
      ? createHash('sha256').update(await readFile(authorized.path)).digest('hex')
      : undefined
    const referenceMtime = typeof parsed.mtime === 'number' ? parsed.mtime : undefined
    const state = referenceMtime === undefined ? (parsed.sha256 !== undefined && hash !== undefined ? (hash === parsed.sha256 ? 'fresh' : 'stale') : 'fresh') : (Math.abs(info.mtimeMs - referenceMtime) < 1 ? 'fresh' : 'stale')
    const excerpt = mode === 'excerpt' ? await readHead(authorized.path, maxBytes) : undefined
    return {
      ok: true,
      ref: parsed.ref,
      kind: parsed.kind,
      path: authorized.path,
      title: basename(authorized.path),
      size: info.size,
      ...(hash === undefined ? {} : { hash }),
      freshness: { state, observedAt, mtime: Math.trunc(info.mtimeMs) },
      permissions: { read: 'allowed', visibility: 'roots', reason: 'path is inside the configured roots' },
      ...(excerpt === undefined ? {} : { excerpt }),
    }
  }
  if (parsed.kind === 'url') {
    return {
      ok: true,
      ref: parsed.ref,
      kind: 'url',
      title: parsed.url,
      provenance: { origin: 'web', url: parsed.url },
      freshness: { state: 'unknown', observedAt },
      permissions: { read: 'allowed', visibility: 'external', reason: 'external URL metadata; no network read' },
      warnings: ['url-not-fetched'],
    }
  }
  if (parsed.kind === 'session' || parsed.kind === 'session-event') {
    const sessionId = parsed.sessionId
    // Resolve the session log path from the read-only content database and
    // require it to live inside the allowed roots; no session body is exposed
    // without that containment.
    let sessionPath
    let indexedAt
    try {
      const { db, close } = openContentDb(settings.stateDir)
      try {
        const log = findSessionLog(db, sessionId)
        sessionPath = log === undefined ? undefined : log.path
        indexedAt = log === undefined ? undefined : log.mtime
      } finally {
        close()
      }
    } catch {
      sessionPath = undefined
    }
    if (sessionPath === undefined) {
      return {
        ok: false,
        ref: parsed.ref,
        kind: parsed.kind,
        error: 'content-index-unavailable',
        warnings: ['session-log-not-found'],
        permissions: { read: 'denied', visibility: 'session', reason: 'session log is not present in the local content index' },
      }
    }
    const authorized = resolveWithinRoots(sessionPath, settings.roots)
    if (authorized === undefined) {
      return {
        ok: false,
        ref: parsed.ref,
        kind: parsed.kind,
        error: 'content-scope-denied',
        warnings: ['session-outside-roots'],
        permissions: { read: 'denied', visibility: 'session', reason: 'session log is outside the configured roots' },
      }
    }
    let currentMtime
    try { currentMtime = statSync(authorized.path).mtimeMs } catch { currentMtime = undefined }
    const state = currentMtime === undefined ? 'missing' : indexedAt === undefined || Math.abs(currentMtime - indexedAt) < 1 ? 'fresh' : 'stale'
    return {
      ok: true,
      ref: parsed.ref,
      kind: parsed.kind,
      path: authorized.path,
      title: 'session ' + sessionId.slice(0, 12),
      ...(indexedAt === undefined ? {} : { provenance: { origin: 'index', sessionId, indexedAt: Math.trunc(indexedAt) } }),
      freshness: { state, observedAt, ...(currentMtime === undefined ? {} : { mtime: Math.trunc(currentMtime) }) },
      permissions: { read: 'allowed', visibility: 'session', reason: 'session log is inside the configured roots' },
      warnings: ['session-body-read-only'],
    }
  }
  // attachment: identity is a digest in the local attachment store.
  const home = process.env.DSH_HOME
  const root = join(home === undefined || home === '' ? join(homedir(), '.dsh') : home, 'attachments', 'v1')
  const prefix = parsed.sha256.slice(0, 2)
  for (const candidate of [join(root, 'objects', prefix, parsed.sha256), join(root, 'file-objects', prefix, parsed.sha256)]) {
    if (!existsSync(candidate)) continue
    if (resolveWithinRoots(candidate, settings.roots) === undefined) return denied(candidate)
    const info = statSync(candidate)
    return {
      ok: true,
      ref: parsed.ref,
      kind: 'attachment',
      path: candidate,
      title: 'attachment ' + parsed.sha256.slice(0, 12),
      size: info.size,
      freshness: { state: 'fresh', observedAt, mtime: Math.trunc(info.mtimeMs) },
      permissions: { read: 'allowed', visibility: 'roots', reason: 'attachment object is inside the configured roots' },
    }
  }
  throw new CliError('ref-not-found', 'no local object for ref: ' + parsed.ref, EXIT_UNAVAILABLE)
}

/** Render citations for one ref list (mirrors locator_cite). */
export function citeRefs(refs, format = 'markdown') {
  if (!Array.isArray(refs) || refs.length === 0) throw new CliError('usage', 'cite needs at least one ref', EXIT_USAGE)
  const citations = []
  for (const raw of refs.slice(0, 20)) {
    const parsed = parseRef(raw)
    if (parsed === undefined) throw new CliError('invalid-ref', 'unsupported or malformed ref: ' + String(raw).slice(0, 120), EXIT_USAGE)
    if (parsed.kind === 'session') {
      const label = 'session ' + parsed.sessionId.slice(0, 12)
      const mention = '@[' + label + '](' + parsed.ref + ')'
      citations.push({ ref: parsed.ref, kind: parsed.kind, label, markdown: mention, mention })
      continue
    }
    if (parsed.kind === 'url') {
      citations.push({ ref: parsed.ref, kind: parsed.kind, label: parsed.url, markdown: '[' + parsed.url + '](' + parsed.ref + ')' })
      continue
    }
    if (parsed.kind === 'attachment') {
      const label = 'attachment ' + parsed.sha256.slice(0, 12)
      citations.push({ ref: parsed.ref, kind: parsed.kind, label, markdown: '[' + label + '](' + parsed.ref + ')' })
      continue
    }
    const label = parsed.kind === 'session-event' ? 'session ' + parsed.sessionId.slice(0, 12) + ' event ' + String(parsed.seq) : basename(parsed.path)
    citations.push({ ref: parsed.ref, kind: parsed.kind, label, markdown: '[' + label + '](' + parsed.ref + ')' })
  }
  return { ok: true, command: 'cite', format, citations }
}

/** Clamp a numeric option to an integer range. */
export function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Normalize an unknown failure to a CliError. */
export function asCliError(error, fallbackCode = 'failed') {
  if (error instanceof CliError) return error
  return new CliError(fallbackCode, String(error && error.message ? error.message : error), EXIT_RUNTIME)
}

/** One parsed command line. */
const USAGE = [
  'dsh-locator CLI ' + version,
  '',
  'Usage:',
  '  locator-cli search <query> [--json] [--limit N] [--offset N] [--mode names|content] [--allow-sessions] [--sort name|path|size|mtime|ext] [--desc] [--regex] [--case-sensitive] [--whole-word] [--files-only] [--dirs-only]',
  '  locator-cli find <query> [--json] [--limit N] [--offset N] [--context N] [--allow-sessions]',
  '  locator-cli status [--json]',
  '  locator-cli resolve <ref> [--json] [--excerpt]',
  '  locator-cli cite <ref...> [--json] [--format markdown|json|mention]',
  '  locator-cli version | help',
  '',
  'Options:',
  '  --root <dir>     index root to query (repeatable; default DSH_LOCATOR_ROOTS or home)',
  '  --state <dir>    snapshot directory (default DSH_LOCATOR_STATE or the platform cache)',
  '  --bin <path>     engine binary (default DSH_LOCATOR_BIN or the bundled build)',
  '  --json           machine-readable JSON on stdout',
  '  --limit <n>      page size, clamped to 1..100 (the host tools use the same cap)',
  '  --timeout <ms>   engine request timeout (default 15000)',
  '  --budget <chars>  soft output budget for search/find hits (default 8000)',
  '  --allow-sessions  include session-log body hits (default: files only; path and recorded workspace must be inside the roots)',
  '',
  'Read-only: the engine runs against a temporary copy of index.snapshot/index.journal/meta.json;',
  'the caller state directory is never created or written.',
  '',
  'Environment: DSH_LOCATOR_STATE, DSH_LOCATOR_ROOTS (path-separator separated), DSH_LOCATOR_BIN, DSH_LOCATOR_SCAN_TIMEOUT (ms).',
  'Exit codes: 0 ok, 1 runtime error, 2 usage error, 3 index/engine unavailable.',
].join('\n')

/** Throw a usage error. */
function usage(message) {
  throw new CliError('usage', message, EXIT_USAGE)
}

/** Parse one argv into the command, positional query/refs and typed flags. */
export function parseCliArgs(argv) {
  const flags = { json: false, roots: [] }
  const positional = []
  const booleanFlags = new Map([
    ['--json', 'json'],
    ['--desc', 'desc'],
    ['--regex', 'regex'],
    ['--case-sensitive', 'caseSensitive'],
    ['--whole-word', 'wholeWord'],
    ['--files-only', 'filesOnly'],
    ['--dirs-only', 'dirsOnly'],
    ['--excerpt', 'excerpt'],
    ['--allow-sessions', 'allowSessions'],
  ])
  const valueFlags = new Map([
    ['--limit', 'limit'],
    ['--offset', 'offset'],
    ['--context', 'contextLines'],
    ['--sort', 'sort'],
    ['--mode', 'mode'],
    ['--state', 'state'],
    ['--bin', 'binary'],
    ['--timeout', 'timeoutMs'],
    ['--format', 'format'],
    ['--root', 'root'],
    ['--budget', 'budgetChars'],
  ])
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') return { command: 'help', positional: [], flags }
    if (argument === '--version' || argument === '-V') return { command: 'version', positional: [], flags }
    const boolean = booleanFlags.get(argument)
    if (boolean !== undefined) {
      flags[boolean] = true
      continue
    }
    const valueName = valueFlags.get(argument)
    if (valueName !== undefined) {
      const value = argv[++index]
      if (value === undefined) usage(argument + ' needs a value')
      if (valueName === 'root') flags.roots.push(value)
      else if (['limit', 'offset', 'contextLines', 'timeoutMs', 'budgetChars'].includes(valueName)) {
        if (!/^\d+$/.test(value)) usage(argument + ' needs a non-negative integer')
        flags[valueName] = Number(value)
      } else flags[valueName] = value
      continue
    }
    if (argument.startsWith('-')) usage('unknown option: ' + argument)
    positional.push(argument)
  }
  const command = positional.shift() ?? 'help'
  return { command, positional, flags }
}

/** Build settings from parsed flags (CLI and MCP share it). */
export function settingsFromFlags(flags = {}, env = process.env) {
  return makeSettings({
    roots: flags.roots ?? [],
    state: flags.state,
    binary: flags.binary,
    timeoutMs: flags.timeoutMs,
  }, env)
}

/** Render a result as human text (the CLI default). */
export function renderText(result) {
  /** One trailing "(truncated; nextOffset N; ...)" note shared by search and find. */
  const pageNote = value => {
    if (value.truncated !== true && value.nextOffset === undefined) return ''
    const bits = []
    if (value.nextOffset !== undefined) bits.push('nextOffset ' + String(value.nextOffset))
    if (value.budget !== undefined && value.budget.dropped > 0) bits.push(String(value.budget.dropped) + ' hit(s) over the ' + String(value.budget.limitChars ?? 0) + '-char budget')
    return ' (truncated' + (bits.length === 0 ? '' : '; ' + bits.join('; ')) + ')'
  }
  if (result.command === 'search') {
    const lines = [String(result.returned) + ' of ' + String(result.total ?? '?') + ' match(es) for ' + JSON.stringify(result.query) + pageNote(result)]
    for (const hit of result.hits) lines.push(hit.path + (hit.dir ? '/' : ''))
    if (Array.isArray(result.warnings) && result.warnings.length > 0) lines.push('warnings: ' + result.warnings.join(', '))
    return lines.join('\n')
  }
  if (result.command === 'content-search' || result.command === 'find') {
    const lines = [String(result.returned) + ' content hit(s)' + (result.total === undefined ? '' : ' of ' + String(result.total)) + ' for ' + JSON.stringify(result.query) + pageNote(result)]
    for (const hit of result.hits) {
      const location = hit.kind === 'session' ? 'session ' + (hit.sessionId ?? '') : hit.path + (hit.line === undefined ? '' : ':' + String(hit.line))
      lines.push('[' + hit.kind + '] ' + location + ' — ' + hit.snippet)
      if (Array.isArray(hit.context)) lines.push('  ' + hit.context.map((line, index) => String((hit.contextStart ?? 1) + index) + ': ' + line).join('\n  '))
    }
    if (Array.isArray(result.warnings) && result.warnings.length > 0) lines.push('warnings: ' + result.warnings.join(', '))
    return lines.join('\n')
  }
  if (result.command === 'status') {
    const engine = result.engine ?? {}
    const content = result.content ?? {}
    return [
      'engine: ' + (engine.ok ? 'ok ' + String(engine.version ?? '') + ' · ' + String(engine.entries ?? 0) + ' entries (' + String(engine.files ?? 0) + ' files, ' + String(engine.dirs ?? 0) + ' dirs)' : 'unavailable' + (engine.error === undefined ? '' : ': ' + engine.error)),
      '  roots: ' + (result.roots ?? []).join(', '),
      '  state: ' + result.stateDir + (result.readOnly === true ? ' (read-only; engine uses a temporary copy)' : ''),
      '  binary: ' + result.binary,
      'content: ' + (content.available ? String(content.files ?? 0) + ' files / ' + String(content.sessions ?? 0) + ' sessions / ' + String(content.messages ?? 0) + ' messages / ' + String(content.refs ?? 0) + ' refs' : 'unavailable (' + String(content.reason ?? 'missing') + ')'),
      ...(result.warnings.length === 0 ? [] : ['warnings: ' + result.warnings.join(', ')]),
    ].join('\n')
  }
  if (result.command === 'resolve') {
    return JSON.stringify(result, null, 2)
  }
  if (result.command === 'cite') {
    return (result.citations ?? []).map(citation => citation.markdown).join('\n')
  }
  return JSON.stringify(result, null, 2)
}

/** Run one parsed CLI command and return its result object. */
export async function runCliCommand(parsed, env = process.env) {
  const settings = settingsFromFlags(parsed.flags, env)
  if (parsed.command === 'help' || parsed.command === 'version') return { ok: true, command: parsed.command }
  if (parsed.command === 'status') return await runStatus(settings)
  const query = parsed.positional.join(' ').trim()
  if (parsed.command === 'search') {
    if (query === '') usage('search needs a query')
    if (parsed.flags.mode === 'content') {
      return runContentSearch(settings, query, {
        ...parsed.flags,
        allowSessions: parsed.flags.allowSessions === true,
        budgetChars: parsed.flags.budgetChars ?? DEFAULT_SEARCH_BUDGET_CHARS,
      })
    }
    if (parsed.flags.mode !== undefined && parsed.flags.mode !== 'names') usage('--mode must be names or content')
    return await runNameSearch(settings, query, parsed.flags)
  }
  if (parsed.command === 'find') {
    if (query === '') usage('find needs a query')
    return await runFindSearch(settings, query, {
      ...parsed.flags,
      allowSessions: parsed.flags.allowSessions === true,
      budgetChars: parsed.flags.budgetChars ?? DEFAULT_SEARCH_BUDGET_CHARS,
    })
  }
  if (parsed.command === 'resolve') {
    if (query === '') usage('resolve needs a ref')
    const result = await resolveRef(settings, query, parsed.flags)
    result.command = 'resolve'
    return result
  }
  if (parsed.command === 'cite') {
    const refs = parsed.positional
    if (refs.length === 0) usage('cite needs at least one ref')
    return citeRefs(refs, parsed.flags.format ?? 'markdown')
  }
  usage('unknown command: ' + parsed.command)
}

/** CLI entrypoint; returns the process exit code. */
export async function main(argv = process.argv.slice(2), env = process.env, io = process) {
  let parsed
  try {
    parsed = parseCliArgs(argv)
  } catch (error) {
    const failure = asCliError(error, 'usage')
    io.stderr.write(failure.message + '\n\n' + USAGE + '\n')
    return failure.exitCode
  }
  try {
    if (parsed.command === 'help') {
      io.stdout.write(USAGE + '\n')
      return EXIT_OK
    }
    if (parsed.command === 'version') {
      io.stdout.write(version + '\n')
      return EXIT_OK
    }
    const result = await runCliCommand(parsed, env)
    io.stdout.write((parsed.flags.json === true ? JSON.stringify(result, null, 2) : renderText(result)) + '\n')
    return EXIT_OK
  } catch (error) {
    const failure = asCliError(error)
    if (parsed.flags.json === true) {
      io.stdout.write(JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } }, null, 2) + '\n')
    } else {
      io.stderr.write('locator-cli: ' + failure.code + ': ' + failure.message + '\n')
    }
    return failure.exitCode
  } finally {
    cleanupReadOnlyStates()
  }
}

// Run only when executed directly (the MCP server imports this module).
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  // Ctrl+C / termination must not leak a temporary state copy.
  const stop = code => {
    cleanupReadOnlyStates()
    process.exit(code)
  }
  process.once('SIGINT', () => stop(130))
  process.once('SIGTERM', () => stop(143))
  main().then(code => { process.exitCode = code }).catch(error => {
    process.stderr.write('locator-cli: fatal: ' + String(error && error.stack ? error.stack : error) + '\n')
    process.exitCode = EXIT_RUNTIME
  })
}
