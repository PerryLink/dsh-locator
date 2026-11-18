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
 * The CLI never talks to a live DSH host, never writes the index and never
 * mutates state: it is safe to run next to (or instead of) the plugin.
 *
 * Exit codes: 0 success, 1 unexpected runtime error, 2 usage/validation error,
 * 3 index or engine unavailable.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
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

/** Build the settings object every core function takes. */
export function makeSettings(overrides = {}, env = process.env) {
  return {
    roots: resolveRoots(overrides.roots ?? [], env),
    stateDir: resolveStateDir(overrides.state ?? overrides.stateDir, env),
    binary: typeof overrides.binary === 'string' && overrides.binary !== '' ? overrides.binary : resolveEngineBinary(env),
    timeoutMs: Number.isFinite(overrides.timeoutMs) ? Math.trunc(overrides.timeoutMs) : 15_000,
    contentDb: join(resolveStateDir(overrides.state ?? overrides.stateDir, env), 'content.db'),
  }
}

/**
 * Start one short-lived engine session (name index only, watcher disabled) and
 * return request/close helpers. Ready is signalled by the engine's "ready" or
 * "stats" event; a failed spawn, an early exit or the timeout rejects it.
 */
export function startEngine(settings) {
  if (!existsSync(settings.stateDir)) {
    try { mkdirSync(settings.stateDir, { recursive: true, mode: 0o700 }) } catch { /* engine reports the real error */ }
  }
  if (process.platform !== 'win32' && settings.binary.includes(sep)) {
    try { chmodSync(settings.binary, 0o755) } catch { /* read-only install */ }
  }
  const args = ['serve', '--state', settings.stateDir]
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
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const text = line.trim()
    if (text === '') return
    let message
    try { message = JSON.parse(text) } catch { return }
    if (message === null || typeof message !== 'object') return
    if (typeof message.event === 'string') {
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

  /** One engine request after readiness. */
  async function request(method, params = {}) {
    await ready
    const id = nextId++
    return await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectPromise(new CliError('engine-timeout', 'engine request ' + method + ' timed out', EXIT_UNAVAILABLE))
      }, settings.timeoutMs)
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
  return { request, close, child }
}

/** Run a name search through a one-shot engine session. */
export async function runNameSearch(settings, query, options = {}) {
  const limit = clampInt(options.limit, 1, 1000, 50)
  const offset = clampInt(options.offset, 0, 1_000_000, 0)
  const session = startEngine(settings)
  const started = Date.now()
  try {
    const result = await session.request('search', {
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
    const hits = Array.isArray(result.hits) ? result.hits : []
    return {
      ok: true,
      command: 'search',
      mode: 'names',
      query,
      limit,
      offset: typeof result.offset === 'number' ? result.offset : offset,
      total: typeof result.total === 'number' ? result.total : hits.length,
      returned: hits.length,
      truncated: result.truncated === true || typeof result.total === 'number' ? result.total > hits.length + offset : false,
      indexing: result.indexing === true,
      tookMs: Date.now() - started,
      hits,
    }
  } catch (error) {
    throw asCliError(error, 'name-search-failed')
  } finally {
    await session.close()
  }
}

/** Read-only handle to <state>/content.db with a schema sanity probe. */
export function openContentDb(stateDir) {
  const path = join(stateDir, 'content.db')
  if (!existsSync(path)) {
    throw new CliError('content-index-missing', 'content index not found: ' + path + ' (run a content search once in DSH)', EXIT_UNAVAILABLE)
  }
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    db.prepare('SELECT count(*) AS n FROM docs').get()
  } catch (error) {
    try { db?.close() } catch { /* ignore */ }
    throw new CliError('content-index-unreadable', 'cannot read ' + path + ': ' + String(error && error.message ? error.message : error), EXIT_UNAVAILABLE)
  }
  return { db, path }
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

/** Run one body query against content.db (read-only). */
export function runContentSearch(settings, query, options = {}) {
  const terms = contentTerms(query)
  const limit = clampInt(options.limit, 1, 100, 30)
  const offset = clampInt(options.offset, 0, 100_000, 0)
  const { db, path } = openContentDb(settings.stateDir)
  try {
    const match = terms.map(quoteFts).join(' AND ')
    const rows = db.prepare(
      'SELECT rowid AS rowid, kind AS kind, path AS path, title AS title, body AS body, session_id AS session_id, message_id AS message_id FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ? OFFSET ?',
    ).all(match, limit, offset)
    const hits = []
    for (const row of rows) {
      const body = typeof row.body === 'string' ? row.body : ''
      const snippet = snippetOf(body, terms)
      hits.push({
        kind: row.kind === 'session' ? 'session' : 'file',
        path: typeof row.path === 'string' ? row.path : '',
        ...(typeof row.title === 'string' && row.title !== '' ? { title: row.title } : {}),
        snippet: snippet.snippet,
        line: snippet.line,
        ...(typeof row.session_id === 'string' && row.session_id !== '' ? { sessionId: row.session_id } : {}),
        ...(typeof row.message_id === 'string' && row.message_id !== '' ? { messageId: row.message_id } : {}),
      })
    }
    let total
    try {
      total = Number(db.prepare('SELECT count(*) AS n FROM docs WHERE docs MATCH ?').get(match).n)
    } catch {
      total = undefined
    }
    return {
      ok: true,
      command: 'content-search',
      mode: 'content',
      query,
      db: path,
      limit,
      offset,
      ...(total === undefined ? {} : { total }),
      returned: hits.length,
      truncated: hits.length >= limit,
      hits,
    }
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError('content-query-failed', String(error && error.message ? error.message : error), EXIT_RUNTIME)
  } finally {
    try { db.close() } catch { /* ignore */ }
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

/** locator_find equivalent: body search plus optional context lines. */
export async function runFindSearch(settings, query, options = {}) {
  const result = runContentSearch(settings, query, options)
  const contextLines = clampInt(options.contextLines, 0, 10, 0)
  const hits = await withContext(result.hits, contextLines)
  const budgetChars = clampInt(options.budgetChars, 0, 10_000_000, 8_000)
  if (budgetChars > 0) {
    const kept = []
    let used = 0
    for (const hit of hits) {
      const size = JSON.stringify(hit).length
      if (kept.length > 0 && used + size > budgetChars) break
      kept.push(hit)
      used += size
    }
    const dropped = hits.length - kept.length
    result.hits = kept
    result.returned = kept.length
    result.truncated = result.truncated || dropped > 0
    result.budget = { limitChars: budgetChars, usedChars: used, truncated: dropped > 0, dropped }
  }
  result.command = 'find'
  return result
}

/** Aggregate status: engine stats plus read-only content.db counts. */
export async function runStatus(settings) {
  const result = {
    ok: true,
    command: 'status',
    roots: settings.roots,
    stateDir: settings.stateDir,
    binary: settings.binary,
    engine: { ok: false },
    content: { available: false },
    warnings: [],
  }
  const session = startEngine(settings)
  try {
    const stats = await session.request('status')
    result.engine = {
      ok: true,
      version: typeof stats.version === 'string' ? stats.version : '',
      platform: typeof stats.platform === 'string' ? stats.platform : '',
      entries: Number(stats.entries ?? 0),
      files: Number(stats.files ?? 0),
      dirs: Number(stats.dirs ?? 0),
      watching: stats.watching === true,
      scanning: stats.scanning === true,
      usn: stats.usn === true,
      stateDir: typeof stats.stateDir === 'string' ? stats.stateDir : settings.stateDir,
    }
    if (Array.isArray(stats.roots) && stats.roots.length > 0) result.roots = stats.roots
  } catch (error) {
    result.engine = { ok: false, error: error && error.code ? error.code + ': ' + error.message : String(error) }
    result.warnings.push('engine-unavailable')
  } finally {
    try { await session.close() } catch { /* already gone */ }
  }
  try {
    if (!existsSync(join(settings.stateDir, 'content.db'))) {
      result.content = { available: false, reason: 'missing' }
    } else {
      const { db } = openContentDb(settings.stateDir)
      try {
        const counts = { files: 0, sessions: 0, messages: 0 }
        for (const row of db.prepare('SELECT kind AS kind, count(*) AS n FROM docs GROUP BY kind').all()) {
          if (row.kind === 'file') counts.files = Number(row.n)
          else if (row.kind === 'session') counts.sessions = Number(row.n)
        }
        counts.messages = counts.sessions
        let refs = 0
        try { refs = Number(db.prepare('SELECT count(*) AS n FROM refs').get().n) } catch { refs = 0 }
        result.content = { available: true, ...counts, refs }
      } finally {
        try { db.close() } catch { /* ignore */ }
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
      const { db } = openContentDb(settings.stateDir)
      try {
        const row = db.prepare("SELECT m.path AS path, m.mtime AS mtime FROM docs_meta m JOIN docs d ON d.rowid = m.rowid WHERE d.kind = 'session' AND d.session_id = ? LIMIT 1").get(sessionId)
        sessionPath = row && typeof row.path === 'string' ? row.path : undefined
        indexedAt = row && typeof row.mtime === 'number' ? row.mtime : undefined
        if (parsed.kind === 'session-event' && sessionPath === undefined) {
          const eventRow = db.prepare("SELECT m.path AS path FROM docs_meta m JOIN docs d ON d.rowid = m.rowid WHERE d.kind = 'session' AND d.session_id = ? LIMIT 1").get(sessionId)
          sessionPath = eventRow && typeof eventRow.path === 'string' ? eventRow.path : undefined
        }
      } finally {
        try { db.close() } catch { /* ignore */ }
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
  '  locator-cli search <query> [--json] [--limit N] [--offset N] [--mode names|content] [--sort name|path|size|mtime|ext] [--desc] [--regex] [--case-sensitive] [--whole-word] [--files-only] [--dirs-only]',
  '  locator-cli find <query> [--json] [--limit N] [--offset N] [--context N]',
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
  '  --timeout <ms>   engine request timeout (default 15000)',
  '',
  'Environment: DSH_LOCATOR_STATE, DSH_LOCATOR_ROOTS (path-separator separated), DSH_LOCATOR_BIN.',
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
  if (result.command === 'search') {
    const lines = [String(result.returned) + ' of ' + String(result.total ?? '?') + ' match(es) for ' + JSON.stringify(result.query) + (result.truncated ? ' (truncated)' : '')]
    for (const hit of result.hits) lines.push(hit.path + (hit.dir ? '/' : ''))
    return lines.join('\n')
  }
  if (result.command === 'content-search' || result.command === 'find') {
    const lines = [String(result.returned) + ' content hit(s)' + (result.total === undefined ? '' : ' of ' + String(result.total)) + ' for ' + JSON.stringify(result.query)]
    for (const hit of result.hits) {
      const location = hit.kind === 'session' ? 'session ' + (hit.sessionId ?? '') : hit.path + (hit.line === undefined ? '' : ':' + String(hit.line))
      lines.push('[' + hit.kind + '] ' + location + ' — ' + hit.snippet)
      if (Array.isArray(hit.context)) lines.push('  ' + hit.context.map((line, index) => String((hit.contextStart ?? 1) + index) + ': ' + line).join('\n  '))
    }
    return lines.join('\n')
  }
  if (result.command === 'status') {
    const engine = result.engine ?? {}
    const content = result.content ?? {}
    return [
      'engine: ' + (engine.ok ? 'ok ' + String(engine.version ?? '') + ' · ' + String(engine.entries ?? 0) + ' entries (' + String(engine.files ?? 0) + ' files, ' + String(engine.dirs ?? 0) + ' dirs)' : 'unavailable' + (engine.error === undefined ? '' : ': ' + engine.error)),
      '  roots: ' + (result.roots ?? []).join(', '),
      '  state: ' + result.stateDir,
      '  binary: ' + result.binary,
      'content: ' + (content.available ? String(content.files ?? 0) + ' files / ' + String(content.sessions ?? 0) + ' sessions / ' + String(content.refs ?? 0) + ' refs' : 'unavailable (' + String(content.reason ?? 'missing') + ')'),
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
    if (parsed.flags.mode === 'content') return runContentSearch(settings, query, parsed.flags)
    if (parsed.flags.mode !== undefined && parsed.flags.mode !== 'names') usage('--mode must be names or content')
    return await runNameSearch(settings, query, parsed.flags)
  }
  if (parsed.command === 'find') {
    if (query === '') usage('find needs a query')
    return await runFindSearch(settings, query, { ...parsed.flags, budgetChars: parsed.flags.budgetChars ?? 8000 })
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
  }
}

// Run only when executed directly (the MCP server imports this module).
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  main().then(code => { process.exitCode = code }).catch(error => {
    process.stderr.write('locator-cli: fatal: ' + String(error && error.stack ? error.stack : error) + '\n')
    process.exitCode = EXIT_RUNTIME
  })
}
