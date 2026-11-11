/**
 * Content search: text files and DSH session messages in SQLite FTS5.
 *
 * File names stay in the Go engine. This store is built from the engine's
 * `dump` RPC plus the session logs: Node reads text bodies, decompresses
 * `session.v4.jsonl.zstd`, and SQLite's trigram tokenizer gives substring and
 * CJK search. A meta table stores each source's mtime so refresh() only
 * re-reads what changed; rebuild() drops and rebuilds everything.
 *
 * Everything here runs inside the DSH host process, so the build must never
 * monopolise its event loop: file reads and zstd decoding are asynchronous and
 * the loops yield to the scheduler every ~8 ms of work. Session logs are read
 * only once they have settled (an actively written session is skipped until it
 * has been quiet for `activeSessionDelayMs`), and archived sessions are left
 * alone unless `includeArchived` is set.
 * @module dsh-locator/content
 */

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import { scheduler } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { searchContent } from './content-search.ts'
import type { LocatorRuntime } from './runtime.ts'

const SCHEMA_VERSION = 2

/** Work budget between two event-loop yields; keeps host latency low. */
const SLICE_MS = 8

/** Wall-clock start of this process; distinguishes a reused pid from a live sibling. */
const PROCESS_START = Math.round(Date.now() - process.uptime() * 1000)

/** Session bodies are short: a message, not a whole file. */
const SESSION_BODY_BYTES = 8_000

const zstdDecompressAsync = promisify(zstdDecompress)

// `scheduler.yield` is newer than the oldest supported Node line; fall back to
// setImmediate so a build on Node 22 still yields instead of throwing.
const yieldToLoop: () => Promise<void> = typeof (scheduler as { yield?: unknown }).yield === 'function'
  ? () => scheduler.yield()
  : () => new Promise<void>(resolve => { setImmediate(resolve) })

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv', '.json', '.jsonl',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.html', '.htm',
  '.css', '.scss', '.less', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.go', '.rs', '.py', '.rb', '.php', '.java', '.kt', '.swift', '.c', '.h',
  '.cc', '.cpp', '.hpp', '.cs', '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.sql', '.graphql', '.proto', '.tex', '.org', '.adoc',
])

export interface ContentHit {
  kind: 'file' | 'session'
  path: string
  title: string
  snippet: string
  sessionId?: string
  messageId?: string
  score: number
}

export interface ContentState {
  building: boolean
  files: number
  sessions: number
  messages: number
  truncated: boolean
  error: string
  updatedAt: number
}

export interface ContentOptions {
  stateDir: string
  sessionDirs?: string[] | undefined
  /** Path segments or substrings never read into the content index. */
  excludes?: string[]
  /** Index archived sessions too; false (the default) leaves them out. */
  includeArchived?: boolean
  /**
   * Skip session logs modified more recently than this many milliseconds, so
   * the session being written right now is not re-read on every refresh.
   */
  activeSessionDelayMs?: number
  maxFileBytes: number
  maxTotalBytes?: number
  maxFiles: number
  maxSessions: number
  /**
   * Run content queries in a worker thread so a slow search never blocks the
   * DSH host event loop. Off by default so direct embedders and tests stay
   * single-threaded.
   */
  searchWorker?: boolean
}

interface DocRow {
  key: string
  body: string
  kind: 'file' | 'session'
  path: string
  title: string
  sessionId: string | null
  messageId: string | null
  mtime: number
}

export class ContentIndex {
  private db: DatabaseSync | null = null
  private readonly state: ContentState = { building: false, files: 0, sessions: 0, messages: 0, truncated: false, error: '', updatedAt: 0 }
  private generation = 0
  private totalBytes = 0
  private sliceDeadline = 0
  private worker: Worker | null = null
  private lockHeld = false
  private readonly lockToken = randomUUID()
  private workerSeq = 0
  private pendingStart = false
  private dbIdentity: { dev: number; ino: number } | null = null
  private readonly pending = new Map<number, { resolve: (hits: ContentHit[]) => void; reject: (error: Error) => void }>()

  constructor(private readonly rt: LocatorRuntime, private readonly options: ContentOptions) {}

  status(): ContentState {
    if (this.db !== null && !this.state.building && !this.databaseIsCurrent()) this.recoverExternal()
    return { ...this.state, building: this.state.building || this.pendingStart }
  }

  /**
   * Report a lazy build as in progress before the asynchronous start reaches
   * `boot()`, so the panel/agent sees "building" on the very first query
   * instead of an empty result with no hint.
   */
  markPending(): void {
    if (this.state.building) return
    this.state.error = ''
    this.pendingStart = true
  }

  /** Drop the pending flag when the lazy start failed before it began. */
  clearPending(): void {
    this.pendingStart = false
  }

  /** Queue a full rebuild; false when one is already running. */
  rebuild(): boolean {
    if (this.state.building) return false
    this.start()
    return true
  }

  /** Queue an incremental refresh; false when one is already running. */
  refreshNow(): boolean {
    if (this.state.building) return false
    this.refresh()
    return true
  }

  close(): void {
    this.generation++
    this.db?.close()
    this.db = null
    this.state.building = false
    this.stopWorker()
    this.releaseLock()
    this.pendingStart = false
    this.dbIdentity = null
  }

  /** Build everything from scratch. */
  start(): void { this.begin('full') }

  /**
   * Start at plugin boot: reuse an existing database and refresh it
   * incrementally, so a restart does not re-read and re-index gigabytes of
   * text. A missing or incompatible database falls back to a full build.
   */
  boot(): void {
    // A content operation that ran before the deferred boot may have built the
    // database already; do not start a second pass behind it.
    if (this.state.updatedAt > 0) return
    this.begin(existsSync(join(this.options.stateDir, 'content.db')) ? 'incremental' : 'full')
  }

  /** Re-read changed files/sessions; open the DB when this is the first run. */
  refresh(): void { this.begin(this.db === null ? 'full' : 'incremental') }

  /**
   * Serialize content builds across plugin instances and DSH processes that
   * share a state directory: a stale lock (dead pid or older than 30 minutes)
   * is taken over, a live one keeps this instance from writing concurrently.
   * @returns whether this instance owns the build lock.
   */
  private acquireLock(): boolean {
    if (this.lockHeld) return true
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 })
    const path = join(this.options.stateDir, 'content.lock')
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, 'wx', 0o600)
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: this.lockToken, procStart: PROCESS_START }))
        closeSync(fd)
        this.lockHeld = true
        return true
      } catch {
        let holder: { pid?: number; startedAt?: number; token?: string; procStart?: number } = {}
        try { holder = JSON.parse(readFileSync(path, 'utf8')) as typeof holder } catch { /* unreadable: treat as stale */ }
        const age = Date.now() - Number(holder.startedAt ?? 0)
        let alive = false
        if (typeof holder.pid === 'number' && age < 30 * 60_000) {
          try { process.kill(holder.pid, 0); alive = true } catch (error) {
            alive = (error as NodeJS.ErrnoException).code === 'EPERM'
          }
        }
        // A live sibling instance (for example during profile HMR) blocks even
        // when it shares our pid; the per-instance token tells them apart. A
        // reused pid from an earlier process incarnation is stale, not live.
        const sameProcess = holder.procStart === undefined || Math.abs(Number(holder.procStart) - PROCESS_START) < 5_000
        if (alive && sameProcess && holder.token !== this.lockToken) return false
        try { rmSync(path, { force: true }) } catch { return false }
      }
    }
    return false
  }

  private releaseLock(): void {
    if (!this.lockHeld) return
    this.lockHeld = false
    try { rmSync(join(this.options.stateDir, 'content.lock'), { force: true }) } catch { /* ignore */ }
  }

  private begin(mode: 'full' | 'incremental'): void {
    if (this.state.building) return
    this.pendingStart = false
    if (!this.acquireLock()) {
      this.state.error = 'another dsh-locator content build is running'
      return
    }
    const generation = ++this.generation
    this.state.building = true
    this.state.error = ''
    this.state.truncated = false
    const run = mode === 'full' ? this.full(generation) : this.incremental(generation)
    void run.catch(error => {
      if (generation !== this.generation) return
      this.state.error = messageOf(error)
      this.state.building = false
    }).finally(() => {
      this.releaseLock()
    })
  }

  private async full(generation: number): Promise<void> {
    this.open(true)
    this.totalBytes = 0
    await this.indexSessions(generation)
    if (generation !== this.generation) return
    await this.indexFiles(generation)
    if (generation !== this.generation) return
    this.finish()
  }

  private async incremental(generation: number): Promise<void> {
    try {
      this.open(false)
      const stored = (this.db!.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0
      if (Number(stored) !== SCHEMA_VERSION) return await this.full(generation)
      // A database whose last build never finished (crash, update, forced
      // reload) has a stale byte counter; rebuild instead of trusting it.
      if (this.readFlag('complete') !== 1) return await this.full(generation)
      this.totalBytes = this.readTotalBytes()
      await this.refreshFiles(generation)
      if (generation !== this.generation) return
      await this.refreshSessions(generation)
      if (generation !== this.generation) return
      this.finish()
    } catch {
      if (generation !== this.generation) return
      // A corrupt or outdated database must not disable content search for the
      // rest of the session: rebuild it from scratch instead.
      this.db?.close()
      this.db = null
      await this.full(generation)
    }
  }

  private open(fresh: boolean): void {
    const existedDir = existsSync(this.options.stateDir)
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 })
    if (!existedDir) {
      try { chmodSync(this.options.stateDir, 0o700) } catch { /* Windows or a read-only profile */ }
    }
    const dbPath = join(this.options.stateDir, 'content.db')
    const existed = existsSync(dbPath)
    if (existed && !this.ownedDatabase(dbPath)) {
      throw new Error(`content.db is not a dsh-locator database, refusing to touch it: ${dbPath}`)
    }
    let oldFileRemained = false
    if (fresh) {
      // A full rebuild throws every row away. Dropping the FTS tables in place
      // on a multi-GB database blocks the host for about a second, so recreate
      // the file instead: the worker is stopped and the sidecars go with it.
      this.stopWorker()
      try { this.db?.close() } catch { /* ignore */ }
      this.db = null
      for (const suffix of ['', '-wal', '-shm']) {
        try { rmSync(dbPath + suffix, { force: true }) } catch { /* Windows keeps a busy file; DROP below still works */ }
      }
      oldFileRemained = existsSync(dbPath)
    }
    this.db?.close()
    this.db = new DatabaseSync(dbPath)
    this.dbIdentity = this.identityOf(dbPath)
    try { chmodSync(dbPath, 0o600) } catch { /* Windows or a read-only profile */ }
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = OFF')
    if (fresh && oldFileRemained) {
      // Fallback for the rare recreate failure above: still start from empty.
      this.db.exec('DROP TABLE IF EXISTS docs')
      this.db.exec('DROP TABLE IF EXISTS docs_meta')
      this.db.exec('DROP TABLE IF EXISTS sources')
    }
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
      body, kind UNINDEXED, path UNINDEXED, title UNINDEXED,
      session_id UNINDEXED, message_id UNINDEXED, tokenize = 'trigram'
    )`)
    this.db.exec('CREATE TABLE IF NOT EXISTS docs_meta (rowid INTEGER PRIMARY KEY, doc_key TEXT UNIQUE, path TEXT, mtime INTEGER, kind TEXT)')
    this.db.exec('CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, mtime INTEGER)')
    this.db.exec('CREATE INDEX IF NOT EXISTS docs_meta_path ON docs_meta(path)')
    if (fresh) {
      this.db.exec('DROP TABLE IF EXISTS content_meta')
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS content_meta (key TEXT PRIMARY KEY, value INTEGER)')
    if (fresh) {
      this.db.exec("INSERT OR REPLACE INTO content_meta (key, value) VALUES ('total_bytes', 0)")
      this.db.exec("INSERT OR REPLACE INTO content_meta (key, value) VALUES ('complete', 0)")
    }
    if (fresh) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    this.reopenWorker()
  }

  private reopenWorker(): void {
    if (this.worker === null) return
    this.worker.postMessage({ id: ++this.workerSeq, open: join(this.options.stateDir, 'content.db') })
  }

  private stopWorker(): void {
    const worker = this.worker
    this.worker = null
    for (const entry of this.pending.values()) entry.resolve([])
    this.pending.clear()
    if (worker !== null) void worker.terminate()
  }

  private ensureWorker(): void {
    if (this.options.searchWorker !== true || this.worker !== null) return
    // In a TypeScript test run the compiled worker does not exist next to the
    // source; skip spawning and answer queries in-process instead.
    const workerPath = fileURLToPath(new URL('./content-search-worker.js', import.meta.url))
    if (!existsSync(workerPath)) return
    try {
      const worker = new Worker(workerPath, {
        workerData: { dbPath: join(this.options.stateDir, 'content.db') },
      })
      worker.on('message', (message: { id: number; hits?: ContentHit[] }) => {
        const entry = this.pending.get(message.id)
        if (entry === undefined) return
        this.pending.delete(message.id)
        entry.resolve(message.hits ?? [])
      })
      const fail = (): void => {
        if (this.worker !== worker) return
        this.worker = null
        for (const entry of this.pending.values()) entry.reject(new Error('content search worker failed'))
        this.pending.clear()
      }
      worker.on('error', fail)
      worker.on('exit', fail)
      this.worker = worker
    } catch {
      this.worker = null
    }
  }

  private identityOf(path: string): { dev: number; ino: number } | null {
    try {
      const info = statSync(path)
      return { dev: Number(info.dev), ino: Number(info.ino) }
    } catch {
      return null
    }
  }

  /**
   * Whether the open handle still points at the file on disk. Another DSH
   * process that shares this `stateDir` can recreate `content.db` during its
   * full rebuild; our handle would then keep reading the unlinked inode until
   * the process exits. Windows reports ino 0 for some filesystems, in which
   * case the check is skipped rather than producing false positives.
   */
  private databaseIsCurrent(): boolean {
    if (this.dbIdentity === null || this.dbIdentity.ino === 0) return true
    const current = this.identityOf(join(this.options.stateDir, 'content.db'))
    return current !== null && current.dev === this.dbIdentity.dev && current.ino === this.dbIdentity.ino
  }

  /** Close the stale handle and reopen/rebuild from the file now on disk. */
  private recoverExternal(): void {
    if (this.state.building) return
    this.generation++
    try { this.db?.close() } catch { /* ignore */ }
    this.db = null
    this.dbIdentity = null
    this.stopWorker()
    this.totalBytes = 0
    this.state.updatedAt = 0
    this.state.error = ''
    this.state.truncated = false
    this.state.files = 0
    this.state.sessions = 0
    this.state.messages = 0
    this.boot()
  }

  /** Whether the engine is re-scanning, which can move its dump cursor. */
  private engineRescanning(): boolean {
    const scanning = (this.rt as { status?: { scanning?: unknown } }).status?.scanning
    return scanning !== undefined && scanning !== null
  }

  /** Whether `path` is a SQLite database this plugin created (has docs_meta). */
  private ownedDatabase(path: string): boolean {
    let probe: DatabaseSync | undefined
    try {
      probe = new DatabaseSync(path, { readOnly: true })
      const row = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'docs_meta'").get()
      return row !== undefined
    } catch {
      return false
    } finally {
      try { probe?.close() } catch { /* ignore */ }
    }
  }

  private readFlag(key: string): number | undefined {
    const row = this.db!.prepare('SELECT value FROM content_meta WHERE key = ?').get(key) as { value?: number } | undefined
    return row?.value === undefined ? undefined : Number(row.value)
  }

  private writeFlag(key: string, value: number): void {
    this.db!.prepare('INSERT OR REPLACE INTO content_meta (key, value) VALUES (?, ?)').run(key, value)
  }

  /**
   * Body bytes already stored. Reading a persisted counter avoids a full scan
   * of every FTS body (measured ~0.6 s for 1 GB) at the start of each refresh.
   * A database written before the counter existed falls back to one scan.
   */
  private readTotalBytes(): number {
    const row = this.db!.prepare("SELECT value FROM content_meta WHERE key = 'total_bytes'").get() as { value?: number } | undefined
    if (row?.value !== undefined) return Number(row.value)
    const scanned = Number((this.db!.prepare('SELECT COALESCE(SUM(length(body)), 0) AS n FROM docs').get() as { n: number }).n)
    this.db!.prepare("INSERT OR REPLACE INTO content_meta (key, value) VALUES ('total_bytes', ?)").run(scanned)
    return scanned
  }

  private writeTotalBytes(): void {
    this.db!.prepare("INSERT OR REPLACE INTO content_meta (key, value) VALUES ('total_bytes', ?)").run(Math.max(0, Math.round(this.totalBytes)))
  }

  /** Yield to the host event loop once the current ~8 ms work slice is spent. */
  private async breathe(): Promise<void> {
    const now = performance.now()
    if (now < this.sliceDeadline) return
    this.sliceDeadline = now + SLICE_MS
    await yieldToLoop()
  }

  /** True when a session log has been quiet long enough to be read safely. */
  private settled(mtime: number): boolean {
    const delay = this.options.activeSessionDelayMs ?? 0
    return delay <= 0 || Date.now() - mtime >= delay
  }

  private finish(): void {
    const counts = this.db!.prepare("SELECT kind, COUNT(*) AS n FROM docs_meta GROUP BY kind").all() as Array<{ kind: string; n: number }>
    this.state.files = Number(counts.find(row => row.kind === 'file')?.n ?? 0)
    this.state.messages = Number(counts.find(row => row.kind === 'session')?.n ?? 0)
    this.state.sessions = Number((this.db!.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n)
    this.state.building = false
    this.state.updatedAt = Date.now()
    this.writeTotalBytes()
    this.writeFlag('complete', 1)
    this.reopenWorker()
  }

  private addDoc(row: DocRow): boolean {
    const cap = this.options.maxTotalBytes ?? 0
    if (cap > 0 && this.totalBytes + row.body.length > cap) {
      this.state.truncated = true
      return false
    }
    this.deleteDoc(row.key)
    const meta = this.db!.prepare('INSERT INTO docs_meta (doc_key, path, mtime, kind) VALUES (?, ?, ?, ?)').run(row.key, row.path, row.mtime, row.kind)
    const rowid = meta.lastInsertRowid
    this.db!.prepare('INSERT INTO docs (rowid, body, kind, path, title, session_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(rowid, row.body, row.kind, row.path, row.title, row.sessionId, row.messageId)
    this.totalBytes += row.body.length
    return true
  }

  private deleteDoc(key: string): void {
    const row = this.db!.prepare('SELECT rowid FROM docs_meta WHERE doc_key = ?').get(key) as { rowid: number } | undefined
    if (row === undefined) return
    const body = this.db!.prepare('SELECT length(body) AS n FROM docs WHERE rowid = ?').get(row.rowid) as { n: number } | undefined
    if (body !== undefined) this.totalBytes = Math.max(0, this.totalBytes - Number(body.n))
    this.db!.prepare('DELETE FROM docs WHERE rowid = ?').run(row.rowid)
    this.db!.prepare('DELETE FROM docs_meta WHERE rowid = ?').run(row.rowid)
  }

  private deletePath(path: string): void {
    const rows = this.db!.prepare(`SELECT m.rowid AS rowid, length(d.body) AS n
      FROM docs_meta m JOIN docs d ON d.rowid = m.rowid WHERE m.path = ?`).all(path) as Array<{ rowid: number; n: number }>
    const delDoc = this.db!.prepare('DELETE FROM docs WHERE rowid = ?')
    const delMeta = this.db!.prepare('DELETE FROM docs_meta WHERE rowid = ?')
    for (const row of rows) {
      this.totalBytes = Math.max(0, this.totalBytes - Number(row.n))
      delDoc.run(row.rowid)
      delMeta.run(row.rowid)
    }
  }

  private async indexFiles(generation: number): Promise<void> {
    let after = 0
    let seen = 0
    let scanned = 0
    for (;;) {
      if (generation !== this.generation) return
      if (this.engineRescanning()) throw new Error('engine re-scan started during content build')
      const page = await this.rt.dump(after, 2_000)
      for (const entry of page.entries) {
        if ((++scanned & 0xff) === 0) await this.breathe()
        if (generation !== this.generation) return
        if (entry.dir || entry.size <= 0 || entry.size > this.options.maxFileBytes) continue
        if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()) || contentSkipPath(entry.path, this.options.excludes ?? [])) continue
        if (this.options.maxFiles > 0 && seen >= this.options.maxFiles) break
        const row = await this.readFileDoc(entry.path, entry.name, entry.mtime)
        if (row === null) continue
        seen++
        if (!this.addDoc(row)) return
        await this.breathe()
      }
      after = page.next
      if (page.done || page.entries.length === 0) break
    }
  }

  private async refreshFiles(generation: number): Promise<void> {
    const meta = new Map<string, number>()
    for (const row of this.db!.prepare("SELECT doc_key, mtime FROM docs_meta WHERE kind = 'file'").all() as Array<{ doc_key: string; mtime: number }>) meta.set(row.doc_key, row.mtime)
    const seen = new Set<string>()
    const deferred: Array<{ path: string; name: string; mtime: number; size: number }> = []
    let after = 0
    let indexed = 0
    let scanned = 0
    for (;;) {
      if (generation !== this.generation) return
      if (this.engineRescanning()) throw new Error('engine re-scan started during content build')
      const page = await this.rt.dump(after, 2_000)
      for (const entry of page.entries) {
        if ((++scanned & 0xff) === 0) await this.breathe()
        if (generation !== this.generation) return
        if (entry.dir || entry.size <= 0 || entry.size > this.options.maxFileBytes) continue
        if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()) || contentSkipPath(entry.path, this.options.excludes ?? [])) continue
        if (this.options.maxFiles > 0 && indexed >= this.options.maxFiles) break
        const key = `file:${entry.path}`
        seen.add(key)
        indexed++
        if (meta.get(key) === entry.mtime) continue
        if (this.wouldExceed(entry.size)) {
          deferred.push({ path: entry.path, name: entry.name, mtime: entry.mtime, size: entry.size })
          continue
        }
        this.deleteDoc(key)
        const row = await this.readFileDoc(entry.path, entry.name, entry.mtime)
        if (row !== null && !this.addDoc(row)) {
          deferred.push({ path: entry.path, name: entry.name, mtime: entry.mtime, size: entry.size })
        }
        await this.breathe()
      }
      after = page.next
      if (page.done || page.entries.length === 0) break
    }
    // Removing rows for files that disappeared frees budget before the deferred
    // files are retried; otherwise a stale large entry would block new ones.
    for (const key of meta.keys()) if (!seen.has(key)) this.deleteDoc(key)
    for (const entry of deferred) {
      if (generation !== this.generation) return
      if (this.wouldExceed(entry.size)) { this.state.truncated = true; continue }
      this.deleteDoc(`file:${entry.path}`)
      const row = await this.readFileDoc(entry.path, entry.name, entry.mtime)
      if (row === null || !this.addDoc(row)) { this.state.truncated = true; continue }
      await this.breathe()
    }
  }

  /** Would storing a file of this size overflow the configured body budget? */
  private wouldExceed(size: number): boolean {
    const cap = this.options.maxTotalBytes ?? 0
    if (cap <= 0) return false
    return this.totalBytes + Math.min(size, this.options.maxFileBytes) > cap
  }

  private async readFileDoc(path: string, name: string, mtime: number): Promise<DocRow | null> {
    let buffer: Buffer
    try { buffer = await readFile(path) } catch { return null }
    if (buffer.includes(0)) return null
    const body = buffer.toString('utf8').slice(0, this.options.maxFileBytes)
    return { key: `file:${path}`, body, kind: 'file', path, title: name, sessionId: null, messageId: null, mtime }
  }

  private async indexSessions(generation: number): Promise<void> {
    const files = (await this.sessionCandidates()).filter(file => this.settled(file.mtime))
    for (const file of files) {
      if (generation !== this.generation) return
      this.deletePath(file.path)
      if (!(await this.indexSessionFile(file, generation))) return
      this.db!.prepare('INSERT OR REPLACE INTO sources (path, mtime) VALUES (?, ?)').run(file.path, file.mtime)
      await this.breathe()
    }
  }

  private async refreshSessions(generation: number): Promise<void> {
    const known = new Map<string, number>()
    for (const row of this.db!.prepare('SELECT path, mtime FROM sources').all() as Array<{ path: string; mtime: number }>) known.set(row.path, row.mtime)
    const files = await this.sessionCandidates()
    const present = new Set<string>()
    for (const file of files) {
      if (generation !== this.generation) return
      present.add(file.path)
      // The session being written right now is left for a later refresh: keep
      // its existing rows instead of re-reading the whole growing log.
      if (!this.settled(file.mtime)) continue
      if (known.get(file.path) === file.mtime) continue
      this.deletePath(file.path)
      if (!(await this.indexSessionFile(file, generation))) return
      this.db!.prepare('INSERT OR REPLACE INTO sources (path, mtime) VALUES (?, ?)').run(file.path, file.mtime)
      await this.breathe()
    }
    for (const path of known.keys()) {
      if (present.has(path)) continue
      this.deletePath(path)
      this.db!.prepare('DELETE FROM sources WHERE path = ?').run(path)
    }
  }

  private async indexSessionFile(file: { path: string; mtime: number }, generation: number): Promise<boolean> {
    let text: string
    try { text = (await zstdDecompressAsync(await readFile(file.path))).toString('utf8') } catch { return true }
    if (generation !== this.generation) return false
    const sessionId = basename(dirname(file.path))
    let title = ''
    let parsed = 0
    for (const line of text.split('\n')) {
      if (!line) continue
      if ((++parsed & 0xff) === 0) {
        await this.breathe()
        if (generation !== this.generation) return false
      }
      let event: { type?: string; data?: Record<string, unknown> }
      try { event = JSON.parse(line) } catch { continue }
      const extracted = messageText(event)
      if (extracted === undefined) continue
      if (title === '') title = extracted.text.replace(/\s+/g, ' ').slice(0, 90)
      const body = extracted.text.slice(0, SESSION_BODY_BYTES)
      const row: DocRow = { key: `session:${sessionId}:${extracted.id}`, body, kind: 'session', path: file.path, title: title || sessionId, sessionId, messageId: extracted.id, mtime: file.mtime }
      if (!this.addDoc(row)) return false
    }
    return true
  }

  /** Session logs to consider, newest first, minus archived ones by default. */
  private async sessionCandidates(): Promise<Array<{ path: string; mtime: number }>> {
    const files = await sessionFiles(this.sessionRoots())
    const archived = this.options.includeArchived === true ? new Set<string>() : await archivedSessionIds()
    const max = this.options.maxSessions > 0 ? this.options.maxSessions : Number.POSITIVE_INFINITY
    const out: Array<{ path: string; mtime: number }> = []
    for (const file of files) {
      if (out.length >= max) break
      if (archived.has(basename(dirname(file.path)))) continue
      out.push(file)
    }
    return out
  }

  sessionRoots(): string[] {
    if (this.options.sessionDirs !== undefined) return this.options.sessionDirs
    return [join(dshHome(), 'sessions')]
  }

  /**
   * Search file bodies and session messages. With `searchWorker` enabled the
   * query itself runs off the host thread; a failed or wedged worker falls back
   * to the in-process query so a result is still produced.
   * @param query - words or a phrase to find.
   * @param limit - maximum hits.
   * @returns matching documents ordered by relevance.
   */
  async search(query: string, limit: number): Promise<ContentHit[]> {
    if (this.db === null) return []
    if (!this.databaseIsCurrent()) {
      this.recoverExternal()
      return []
    }
    if (this.options.searchWorker !== true) return this.searchSync(query, limit)
    this.ensureWorker()
    if (this.worker === null) return this.searchSync(query, limit)
    const id = ++this.workerSeq
    const worker = this.worker
    const response = new Promise<ContentHit[]>((resolve, reject) => { this.pending.set(id, { resolve, reject }) })
    worker.postMessage({ id, query, limit })
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<ContentHit[]>((_resolve, reject) => {
      timer = setTimeout(() => { this.pending.delete(id); reject(new Error('content search worker timed out')) }, 5_000)
    })
    try {
      return await Promise.race([response, timeout])
    } catch {
      return this.searchSync(query, limit)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private searchSync(query: string, limit: number): ContentHit[] {
    if (this.db === null) return []
    try {
      return searchContent(this.db, query, limit)
    } catch (error) {
      this.state.error = messageOf(error)
      return []
    }
  }
}

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Archived session ids recorded by the Workspace registry; empty when absent. */
async function archivedSessionIds(): Promise<Set<string>> {
  try {
    const raw = await readFile(join(dshHome(), 'storages', 'workspace.json'), 'utf8')
    const parsed = JSON.parse(raw) as { global?: { archivedSessionIds?: unknown } }
    const ids = parsed.global?.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function messageText(event: { type?: string; data?: Record<string, unknown> }): { text: string; id: string } | undefined {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return undefined
  const data = event.data ?? {}
  if (event.type === 'user/message') {
    const source = (data.source ?? {}) as Record<string, unknown>
    if (source.kind === 'time-context') return undefined
  }
  const message = (data.message ?? {}) as Record<string, unknown>
  const content = event.type === 'user/message' ? data.content : message.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter((block): block is { type: string; text: string } => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (text === '') return undefined
  const id = event.type === 'user/message' ? String(data.id ?? '') : String(message.id ?? '')
  return { text, id: id || `seq-${String(data.seq ?? '')}` }
}

async function sessionFiles(roots: string[]): Promise<Array<{ path: string; mtime: number }>> {
  const out: Array<{ path: string; mtime: number }> = []
  const walk = async (root: string, depth: number): Promise<void> => {
    if (depth > 4) return
    let entries
    try { entries = await readdir(root, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(root, entry.name)
      if (entry.isDirectory()) { await walk(path, depth + 1); continue }
      if (!entry.isFile() || !entry.name.endsWith('.v4.jsonl.zstd')) continue
      try { out.push({ path, mtime: (await stat(path)).mtimeMs }) } catch { /* ignore */ }
    }
  }
  for (const root of roots) await walk(root, 0)
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

function contentSkipPath(path: string, excludes: string[]): boolean {
  const normalized = path.replace(/\\/g, '/')
  // The plugin's own session/config tree is never content.
  if (normalized === '/.dsh' || normalized.includes('/.dsh/')) return true
  if (excludes.length === 0) return false
  const lower = normalized.toLowerCase()
  const segments = lower.split('/')
  for (const raw of excludes) {
    const needle = raw.trim().toLowerCase()
    if (needle === '') continue
    if (needle.includes('/')) {
      if (lower.includes(needle)) return true
      continue
    }
    if (segments.includes(needle)) return true
  }
  return false
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
