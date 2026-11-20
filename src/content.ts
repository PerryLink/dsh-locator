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

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { cpus, homedir, loadavg } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import { scheduler } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { escapeLike, searchContent, type ContentSearchOptions, type ContentSearchResult } from './content-search.ts'
import { createSearchCache, type SearchCache } from './content-cache.ts'
import { attachmentRef, normalizeUrl, sessionEventRef, spillRef, urlRef } from './refs.ts'
import { documentFormat, extractDocumentFromBuffer, type DocumentFormat } from './extract.ts'
import { estimateSymbolTokens, extractSymbols, isGeneratedSymbolPath, languageForPath, looksGeneratedSource, type CodeSymbol } from './symbols.ts'
import type { DumpPage, LocatorRuntime } from './runtime.ts'

export type { CodeSymbol, SymbolKind } from './symbols.ts'

const SCHEMA_VERSION = 3

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

/** Default cap on one document handed to the extractor (8 MiB). */
const DOCUMENT_EXTRACT_MAX_BYTES = 8 * 1024 * 1024

/** Default cap on one code file that contributes symbols to the repo map. */
const SYMBOL_MAX_FILE_BYTES = 512 * 1024

/** Default symbols stored per file; generated/vendored code is skipped entirely. */
const SYMBOLS_PER_FILE = 500

/** Entries fetched per engine dump page while walking the file index. */
const DUMP_PAGE = 2_000

/** Default cap on one session log read for indexing (64 MiB). */
const SESSION_MAX_BYTES = 64 * 1024 * 1024

/** Decoded characters read from a truncated session log before the head is cut. */
const SESSION_HEAD_CHARS = 32 * 1024 * 1024

/** One build transaction covers this many write operations before commit. */
const BATCH_OPS = 250

/** A generation fast path still sweeps the whole file index this often (deletions). */
const DEFAULT_FULL_SWEEP_INTERVAL_MS = 30 * 60_000

/** Files modified up to this long before a refresh start are re-examined. */
const SWEEP_MTIME_MARGIN_MS = 2 * 60_000

/** Headroom eviction leaves free: 5% of the body budget. */
const EVICT_HEADROOM_RATIO = 0.05

/** Quarantined content databases older than this are deleted. */
const CORRUPT_RETENTION_MS = 7 * 24 * 60 * 60_000
const CORRUPT_MAX_ARCHIVES = 2

/** Concatenated Zstandard frame magic (LE) used by DSH session logs. */
const ZSTD_MAGIC = 0xfd2fb528

/** Deadline for one document extraction in the extractor worker. */
const DOCUMENT_EXTRACT_TIMEOUT_MS = 5_000

/** In-memory hash cache for extracted document bodies. */
const EXTRACT_CACHE_ENTRIES = 64
const EXTRACT_CACHE_CHARS = 16 * 1024 * 1024

/** Repo map: candidate paths fetched before the token budget is applied. */
const REPO_MAP_CANDIDATE_LIMIT = 2_000
/** Repo map: candidate paths whose symbol rows are fetched per SQL statement. */
const REPO_MAP_FETCH_BATCH = 100
/** Repo map: hard cap on symbol rows fetched for those candidate paths. */
const REPO_MAP_ROW_LIMIT = 50_000
/** Repo map: hard cap on characters read out of the symbol table. */
const REPO_MAP_CHAR_LIMIT = 16 * 1024 * 1024

export interface ContentHit {
  kind: 'file' | 'session'
  path: string
  title: string
  snippet: string
  sessionId?: string
  messageId?: string
  /** Exact `data-chat-node-key` of the rendered row, when the host has one. */
  nodeKey?: string
  /** 1-based line of the first match inside the stored body, for file hits. */
  line?: number
  /** Citable evidence ref for this hit (session URI or ref://file). */
  ref?: string
  /**
   * Extracted document format (`pdf`, `docx`, `xlsx`, `pptx`, `epub`) for file
   * hits whose body came from a document. Plain text files keep it absent so
   * existing consumers see no new field.
   */
  format?: string
  score: number
}

/** Which half of the content build a progress record belongs to. */
export type ContentProgressPhase = 'files' | 'sessions'

/**
 * Live progress for the content build. It only exists while `building` is
 * true, so the status endpoint, the Web panel and `locator_status` can show
 * what a long first build is doing instead of a bare boolean.
 */
export interface ContentProgress {
  phase: ContentProgressPhase
  /** Entries examined: engine entries for files, session logs for sessions. */
  scanned: number
  /** Entries stored by this phase: indexed files or indexed session logs. */
  indexed: number
  /** Known total for this phase; absent when it is not known yet. */
  total?: number
  /** Most recently examined path, for a live "current item" hint. */
  path?: string
  /** Epoch milliseconds when this phase started. */
  startedAt: number
}

/** Distinct evidence-ref identities stored in the content index, grouped by kind. */
export interface RefKindCount {
  total: number
  byKind: Record<string, number>
}

export interface ContentState {
  building: boolean
  files: number
  sessions: number
  messages: number
  truncated: boolean
  error: string
  /**
   * Non-fatal problems from the last build/refresh: unreadable session logs,
   * a quarantined database, and so on. Empty when everything was read.
   */
  warnings: string[]
  updatedAt: number
  /** Live build progress; absent when no build is running. */
  progress?: ContentProgress
  /** Both numeric content caps are explicitly unlimited. */
  fullIndex?: boolean
  /** Assistant reasoning/thinking blocks are included in session docs. */
  reasoningIndex?: boolean
  /** Tool-result text is indexed as its own session documents. */
  toolResultsIndex?: boolean
  /** Distinct stored evidence refs grouped by kind; absent before the database opens. */
  refs?: RefKindCount
}

/** Body-budget coverage of the file index, for `ContentIndex.diagnostics`. */
export interface ContentCoverage {
  /** File documents currently stored. */
  indexedFiles: number
  /** Indexable file entries seen by the last full sweep; null before one ran. */
  candidateFiles: number | null
  /** indexedFiles / candidateFiles, 0..1; null while candidateFiles is unknown. */
  ratio: number | null
  /** Stored body bytes. */
  bodyBytes: number
  /** Configured body budget; 0 means unlimited. */
  budgetBytes: number
  /** Configured document-count budget; 0 means unlimited. */
  fileBudget: number
  /** The last build dropped documents because of a budget or cap. */
  truncated: boolean
  /** Documents evicted to make room since this instance opened the database. */
  evictedDocs: number
  sessions: number
  messages: number
}

/**
 * Cheap, read-only observability payload for `locator_status` and the HTTP
 * status route. Kept out of {@link ContentState} so the tool output schemas
 * that predate it (and validate `status()` strictly) keep passing.
 */
export interface ContentDiagnostics {
  coverage: ContentCoverage
  dbBytes: number
  walBytes: number
  /** Configured content.db budget; 0 means unlimited. */
  dbBudgetBytes: number
  dbOverBudget: boolean
  /** Epoch ms of the last successful FTS optimize, 0 when never run. */
  ftsOptimizedAt: number
  lastRefreshMs: number
  lastRefreshMode: 'full' | 'incremental' | 'fast' | 'deferred' | ''
  engineGeneration: number | null
  symbolsPerFile: number
  /** Document extraction runs in a worker thread (false: in-process fallback). */
  extractWorker: boolean
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
  /** Index assistant reasoning blocks as part of the message body. */
  includeReasoning?: boolean
  /** Index `tool/result` text as its own session document (opt-in). */
  includeToolResults?: boolean
  /**
   * Extract bodies from PDF/Office/EPUB documents too (default true). Off keeps
   * only the plain-text path, for embedders that want the old behavior.
   */
  extractDocuments?: boolean
  /** Largest document handed to the extractor; 0 means unlimited (default 20 MiB). */
  extractMaxBytes?: number
  /**
   * Attach the extracted document format to file hits (default false). Only
   * enable this once every tool that forwards content hits declares a `format`
   * field: the host rejects undeclared tool-output properties. `docFormat()`
   * and `formatsFor()` expose the same data without touching hits.
   */
  attachHitFormats?: boolean
  /** Index code symbols for the outline/symbol/repo-map data layer (default true). */
  indexSymbols?: boolean
  /** Largest code file considered for symbol extraction (default 512 KiB). */
  symbolMaxBytes?: number
  /**
   * Optional notIndexed hook: return false to skip a path before any bytes are
   * read (the plugin wires this to the Scope layer). Applies to documents,
   * text bodies and symbol extraction, and is re-checked on backfills.
   */
  isIndexable?: (path: string) => boolean
  /**
   * Optional OCR fallback for a PDF with no extractable text layer (a scan).
   * Returns the recognized text, or undefined to leave the document out. The
   * plugin wires this to `runOcrCommand` when the operator configures one.
   */
  ocr?: (path: string, format: string) => Promise<string | undefined>
  /**
   * Run content queries in a worker thread so a slow search never blocks the
   * DSH host event loop. Off by default so direct embedders and tests stay
   * single-threaded.
   */
  searchWorker?: boolean
  /**
   * How long one worker query may run before it is reported as
   * `content-search-timeout`. The query is never re-run on the host thread.
   */
  searchWorkerTimeoutMs?: number
  /**
   * Test seam: build the search worker instead of spawning the compiled one.
   * Production never sets it.
   */
  searchWorkerFactory?: (workerPath: string) => Worker
  /** Number of parallel content-query workers (default 2; at most 4). */
  searchWorkers?: number
  /**
   * Evict the oldest documents when the body budget is full instead of
   * freezing the index (default false for direct embedders; the plugin turns
   * it on from `contentEvict`).
   */
  evict?: boolean
  /** Hard budget for content.db in bytes; 0 means unlimited. */
  maxDbBytes?: number
  /** Symbols stored per code file (default 500). */
  symbolsPerFile?: number
  /** Let the query layer skip bm25 rank ordering for wide result sets. */
  rankAdaptive?: boolean
  /** Content search result cache entries; 0 disables caching. */
  queryCacheSize?: number
  /** Content search result cache TTL in ms. */
  queryCacheTtlMs?: number
  /** Largest session log read for indexing; larger logs index their head only. */
  sessionMaxBytes?: number
  /** Throttle builds when the machine is loaded or on battery. */
  adaptiveRefresh?: boolean
  /** Deadline for one extraction in the extractor worker. */
  extractTimeoutMs?: number
  /** Override the periodic full file-index sweep interval (tests). */
  fullSweepIntervalMs?: number
}

/** One symbol search hit from the additive `symbols` table. */
export interface SymbolMatch {
  path: string
  /** 1-based declaration line. */
  line: number
  kind: string
  name: string
  language: string
  /** Enclosing type/namespace, when the extractor found one. */
  scope?: string
}

/** One file of a {@link ContentIndex.repoMap} result. */
export interface RepoMapFile {
  path: string
  symbols: CodeSymbol[]
}

interface DocRow {
  key: string
  body: string
  kind: 'file' | 'session'
  path: string
  title: string
  sessionId: string | null
  messageId: string | null
  nodeKey: string | null
  mtime: number
  /** Extracted document format; absent/null for plain-text bodies. */
  format?: string | null
  /** Symbols extracted from a text body, written after the body is stored. */
  symbols?: CodeSymbol[]
}

/**
 * One dump page as the engine sends it: the generation fast path reads the
 * optional fields newer runtimes forward, and older fakes simply omit them.
 */
type DumpPageView = DumpPage & { unchanged?: boolean; generation?: number }

/** Search options plus the non-serializable extras the host layer adds. */
type CoreSearchOptions = ContentSearchOptions & { signal?: AbortSignal; rankAdaptive?: boolean }

/** One search reply from a worker. */
type WorkerReply =
  | { ok: true; result: ContentSearchResult }
  | { ok: false; error: string; result?: ContentSearchResult }

/** One pooled search worker plus the requests it is running. */
interface WorkerSlot {
  worker: Worker
  pending: Map<number, (reply: WorkerReply) => void>
  /** Shared cancellation slot read by the worker between scan steps. */
  cancel: Int32Array | null
}

/** Reply from the extractor worker. */
type ExtractReply =
  | { ok: true; format: DocumentFormat; text: string; pages?: number; warnings: string[] }
  | { ok: false; warnings: string[] }

/** One decoded document body in the in-memory extraction cache. */
interface ExtractCacheEntry {
  /** Extracted text; null is a cached "nothing extractable" answer. */
  text: string | null
  format: DocumentFormat
  pages?: number
}

/** One indexed session log as persisted in the sources table. */
interface SessionSourceRow {
  path: string
  mtime: number
  cwd: string | null
  byteLen: number | null
  lastLine: number | null
  title: string | null
  capped: number
}

export class ContentIndex {
  private db: DatabaseSync | null = null
  private readonly state: ContentState = { building: false, files: 0, sessions: 0, messages: 0, truncated: false, error: '', warnings: [], updatedAt: 0 }
  private generation = 0
  private totalBytes = 0
  private sliceDeadline = 0
  /** Search workers; each owns its own read-only database connection. */
  private readonly workerPool: WorkerSlot[] = []
  private lockHeld = false
  private readonly lockToken = randomUUID()
  private workerSeq = 0
  private pendingStart = false
  private progress: ContentProgress | null = null
  private dbIdentity: { dev: number; ino: number } | null = null
  /** Session id → indexed session log path, for session-scoped content search. */
  private readonly sessionPaths = new Map<string, string>()
  /** Archived session ids, excluded from queries unless asked for. */
  private archivedSessions = new Set<string>()
  /** Session id → the session header's cwd, for caller/workspace authorization. */
  private readonly sessionCwds = new Map<string, string>()
  /** A legacy database gained `sources.cwd`; rebuild session docs to fill it. */
  private needsSessionBackfill = false
  /** A database predating the additive `symbols` table needs a one-time fill. */
  private needsSymbolBackfill = false
  /** Queued write operations since the last batch commit. */
  private inBatch = false
  private batchOps = 0
  /** A full build created the symbols table without its indexes; create them at the end. */
  private symbolIndexesPending = false
  /** Fresh full build: symbols indexes are created after the insert pass, so per-file deletes must wait. */
  private symbolsBulk = false
  private readonly symbolsBulkPurge = new Set<string>()
  /** Persisted counters kept in content_meta so caps checks stay O(1). */
  private fileDocs = 0
  private oversizedDocs = 0
  private countersLoaded = false
  /** Indexable file entries seen by the last full sweep (coverage denominator). */
  private candidateFiles: number | null = null
  /** Documents evicted from the body budget since this instance opened. */
  private evictedDocs = 0
  private dbBytes = 0
  private walBytes = 0
  private ftsOptimizedAt = 0
  private lastRefreshMs = 0
  private lastRefreshMode: 'full' | 'incremental' | 'fast' | 'deferred' | '' = ''
  /** File-index generation observed while walking the last dump. */
  private engineGeneration: number | null = null
  /** Wall clock at the start of the current build. */
  private buildStartedAt = 0
  /** Cached adaptive-throttle verdict (sysfs reads are not free). */
  private machineSample: { at: number; busy: boolean } = { at: 0, busy: false }
  /** Single reusable extractor worker plus its pending requests. */
  private extractWorker: Worker | null = null
  private extractSeq = 0
  private readonly extractPending = new Map<number, (reply: ExtractReply) => void>()
  /** Decoded document bodies keyed by file sha256, bounded by characters. */
  private readonly extractCache = new Map<string, ExtractCacheEntry>()
  private extractCacheChars = 0
  /** Lazily created query-result cache (see content-cache.ts). */
  private searchCache: SearchCache | null = null

  constructor(private readonly rt: LocatorRuntime, private readonly options: ContentOptions) {}

  status(): ContentState {
    if (this.db !== null && !this.state.building && !this.databaseIsCurrent()) this.recoverExternal()
    const progress = this.progress
    return {
      ...this.state,
      warnings: [...this.state.warnings],
      building: this.state.building || this.pendingStart,
      ...(progress === null ? {} : { progress: { ...progress } }),
      fullIndex: this.options.maxTotalBytes === 0 && this.options.maxFiles === 0,
      reasoningIndex: this.options.includeReasoning === true,
      toolResultsIndex: this.options.includeToolResults === true,
      ...(this.db === null ? {} : { refs: this.refsByKind() }),
    }
  }

  /**
   * Cheap observability payload for status routes and tools: budget coverage,
   * database size and generation state. Synchronous and O(1) apart from two
   * stats, and safe to call while a build is running.
   */
  diagnostics(): ContentDiagnostics {
    const budget = this.options.maxTotalBytes ?? 0
    const dbBudget = this.options.maxDbBytes ?? 0
    return {
      coverage: {
        indexedFiles: this.fileDocs,
        candidateFiles: this.candidateFiles,
        ratio: this.candidateFiles !== null && this.candidateFiles > 0
          ? Math.min(1, this.fileDocs / this.candidateFiles)
          : null,
        bodyBytes: Math.round(this.totalBytes),
        budgetBytes: budget,
        fileBudget: this.options.maxFiles,
        truncated: this.state.truncated,
        evictedDocs: this.evictedDocs,
        sessions: this.state.sessions,
        messages: this.state.messages,
      },
      dbBytes: this.dbBytes,
      walBytes: this.walBytes,
      dbBudgetBytes: dbBudget,
      dbOverBudget: dbBudget > 0 && this.dbSizeBytes() > dbBudget,
      ftsOptimizedAt: this.ftsOptimizedAt,
      lastRefreshMs: this.lastRefreshMs,
      lastRefreshMode: this.lastRefreshMode,
      engineGeneration: this.engineGeneration,
      symbolsPerFile: this.symbolsPerFile(),
      extractWorker: this.extractWorkerAvailable(),
    }
  }

  /** Current on-disk content.db size (an open handle keeps counting its file). */
  private dbSizeBytes(): number {
    try { return statSync(join(this.options.stateDir, 'content.db')).size } catch { return 0 }
  }

  /** Refresh the cached database and WAL byte counts. */
  private measureDatabase(): void {
    this.dbBytes = this.dbSizeBytes()
    try { this.walBytes = statSync(join(this.options.stateDir, 'content.db-wal')).size } catch { this.walBytes = 0 }
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
    this.rollbackBatch()
    this.db?.close()
    this.db = null
    this.state.building = false
    this.stopWorker()
    this.stopExtractWorker()
    this.invalidateSearchCache()
    this.releaseLock()
    this.pendingStart = false
    this.progress = null
    this.dbIdentity = null
    this.sessionPaths.clear()
    this.sessionCwds.clear()
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
    this.state.warnings = []
    this.progress = null
    this.buildStartedAt = Date.now()
    this.lastRefreshMode = mode
    this.invalidateSearchCache()
    const run = mode === 'full' ? this.full(generation) : this.incremental(generation)
    void run.catch(error => {
      if (generation !== this.generation) return
      this.state.error = messageOf(error)
      this.state.building = false
      this.progress = null
    }).finally(() => {
      this.rollbackBatch()
      this.releaseLock()
    })
  }

  private async full(generation: number): Promise<void> {
    this.lastRefreshMode = 'full'
    this.open(true)
    this.totalBytes = 0
    this.engineGeneration = null
    this.candidateFiles = null
    this.beginBatch()
    await this.indexSessions(generation)
    if (generation !== this.generation) return
    this.needsSessionBackfill = false
    await this.indexFiles(generation)
    if (generation !== this.generation) return
    // A full build indexed symbols for every file; no backfill is pending.
    this.needsSymbolBackfill = false
    this.commitBatch()
    // Symbols are inserted without their indexes during the pass; create them
    // now that the table is complete (P0-13).
    this.ensureSymbolIndexes()
    await this.optimizeFts()
    if (generation !== this.generation) return
    this.finish()
  }

  private async incremental(generation: number): Promise<void> {
    try {
      this.open(false)
      const stored = (this.db!.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0
      if (Number(stored) !== SCHEMA_VERSION) return await this.full(generation)
      // An over-budget database is rebuilt at idle, at most once per six hours:
      // if the content itself is that large a rebuild cannot help, and a rebuild
      // loop on every refresh would be far worse than a large file.
      const dbBudget = this.options.maxDbBytes ?? 0
      if (dbBudget > 0) {
        this.measureDatabase()
        if (this.dbBytes > dbBudget) {
          const rebuiltAt = this.readFlag('db_budget_rebuilt_at') ?? 0
          if (Date.now() - rebuiltAt > 6 * 60 * 60_000) return await this.full(generation)
          this.addWarning('content-db-over-budget')
        }
      }
      if (this.needsSessionBackfill) {
        // Upgrading an existing database added `sources.cwd`; session docs must
        // be re-read once so the authorization rule has a cwd for every log.
        this.needsSessionBackfill = false
        this.beginBatch()
        this.clearSessions()
        await this.indexSessions(generation)
        if (generation !== this.generation) return
        await this.syncSymbols(generation)
        if (generation !== this.generation) return
        this.finish()
        return
      }
      // A database whose last build never finished (crash, update, forced
      // reload) has a stale byte counter; rebuild instead of trusting it.
      if (this.readFlag('complete') !== 1) return await this.full(generation)
      // The reasoning flag is absent in databases built before 0.11.2; default
      // to "not indexed" without forcing a rebuild. Turning reasoning on (or
      // later off) rebuilds sessions so old rows cannot keep stale thinking.
      const storedReasoning = this.readFlag('reasoning')
      const wantReasoning = this.options.includeReasoning === true ? 1 : 0
      const storedToolResults = this.readFlag('toolResults') ?? 0
      const wantToolResults = this.options.includeToolResults === true ? 1 : 0
      // Changing reasoning/tool-result participation only invalidates session
      // rows. Keep the file index instead of dropping/rebuilding 185k files.
      this.totalBytes = this.readTotalBytes()
      if ((storedReasoning ?? 0) !== wantReasoning || storedToolResults !== wantToolResults) {
        this.beginBatch()
        this.clearSessions()
        await this.indexSessions(generation)
        if (generation !== this.generation) return
        await this.syncSymbols(generation)
        if (generation !== this.generation) return
        this.finish()
        return
      }
      // Symbols are additive and can be toggled without dropping file bodies;
      // a database built before the table existed needs a one-time fill.
      await this.syncSymbols(generation)
      if (generation !== this.generation) return
      // A smaller cap must be enforced against rows written under the previous
      // larger budget; incremental refresh only adds, it never trims.
      if (!this.capsSatisfied()) return await this.full(generation)
      this.beginBatch()
      await this.refreshFiles(generation)
      if (generation !== this.generation) return
      await this.refreshSessions(generation)
      if (generation !== this.generation) return
      this.finish()
    } catch (error) {
      if (generation !== this.generation) return
      // A background engine re-scan (periodic fallback rebuild or
      // locator_rebuild) swaps the index and moves the dump cursor under us.
      // That is transient: keep the database and let the next refresh retry
      // instead of dropping it and re-reading every indexed file.
      if (isEngineRescanError(error)) {
        this.state.building = false
        this.progress = null
        this.addWarning('content-refresh-deferred')
        return
      }
      // A corrupt or outdated database must not disable content search for the
      // rest of the session: rebuild it from scratch instead.
      this.rollbackBatch()
      this.db?.close()
      this.db = null
      await this.full(generation)
    }
  }

  private open(fresh: boolean): void {
    // A previous failed pass may have left a transaction open on a handle that
    // is about to be replaced; never begin a build with a stale batch.
    this.rollbackBatch()
    const existedDir = existsSync(this.options.stateDir)
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 })
    if (!existedDir) {
      try { chmodSync(this.options.stateDir, 0o700) } catch { /* Windows or a read-only profile */ }
    }
    this.cleanupCorruptArchives()
    const dbPath = join(this.options.stateDir, 'content.db')
    const existed = existsSync(dbPath)
    if (existed) {
      const verdict = this.classifyDatabase(dbPath)
      if (verdict === 'foreign') {
        throw new Error(`content.db is not a dsh-locator database, refusing to touch it: ${dbPath}`)
      }
      if (verdict !== 'ok') {
        // A corrupt, empty or older-schema database must not disable content
        // search for the rest of the session. Keep the bad file for diagnosis
        // (rename, never delete bytes we did not create) and rebuild fresh.
        // During an incremental open this throws so the caller falls back to a
        // full rebuild; a full open simply continues with a clean file.
        this.quarantineDatabase(dbPath, verdict)
        if (!fresh) throw new Error('content database is incompatible; rebuilding')
      }
    }
    let oldFileRemained = false
    if (fresh) {
      // A full rebuild throws every row away. Dropping the FTS tables in place
      // on a multi-GB database blocks the host for about a second, so recreate
      // the file instead: the workers are stopped and the sidecars go with it.
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
      this.db.exec('DROP TABLE IF EXISTS symbols')
      this.db.exec('DROP TABLE IF EXISTS refs')
      this.db.exec('DROP TABLE IF EXISTS refs_meta')
    }
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
      body, kind UNINDEXED, path UNINDEXED, title UNINDEXED,
      session_id UNINDEXED, message_id UNINDEXED, tokenize = 'trigram'
    )`)
    this.db.exec('CREATE TABLE IF NOT EXISTS docs_meta (rowid INTEGER PRIMARY KEY, doc_key TEXT UNIQUE, path TEXT, mtime INTEGER, kind TEXT, node_key TEXT)')
    this.ensureDocsMetaFormatColumn()
    this.db.exec('CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, mtime INTEGER)')
    if (this.ensureSourcesCwdColumn()) this.needsSessionBackfill = true
    this.ensureSessionColumns()
    if (this.ensureRefsTables()) this.needsSessionBackfill = true
    if (this.ensureSymbolsTables()) this.needsSymbolBackfill = true
    if (fresh) {
      // A full build inserts every symbol; its indexes are created afterwards so
      // the insert pass does not pay index maintenance per row. There is also
      // nothing to delete yet, and DELETE without an index is a full table scan
      // (measured ~22 ms per file on a 700 k-row table), so per-file deletes are
      // deferred until the indexes exist.
      this.symbolIndexesPending = true
      this.symbolsBulk = true
      this.symbolsBulkPurge.clear()
    } else {
      this.ensureSymbolIndexes()
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS docs_meta_path ON docs_meta(path)')
    if (fresh) {
      this.db.exec('DROP TABLE IF EXISTS content_meta')
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS content_meta (key TEXT PRIMARY KEY, value INTEGER)')
    if (fresh) {
      this.db.exec("INSERT OR REPLACE INTO content_meta (key, value) VALUES ('total_bytes', 0)")
      this.db.exec("INSERT OR REPLACE INTO content_meta (key, value) VALUES ('complete', 0)")
      this.fileDocs = 0
      this.oversizedDocs = 0
      this.countersLoaded = true
      this.candidateFiles = null
      this.evictedDocs = 0
      this.ftsOptimizedAt = 0
      this.engineGeneration = null
    }
    if (fresh) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    if (!fresh) this.loadPersistedCounters()
    this.measureDatabase()
    this.refreshSessionPaths()
  }

  /**
   * Load the O(1) caps counters persisted in content_meta. A database written
   * before they existed (or whose configured maxFileBytes changed) is recounted
   * once with a bounded scan; steady-state refreshes never scan the FTS table.
   */
  private loadPersistedCounters(): void {
    if (this.db === null) return
    try {
      const storedFiles = this.readFlag('file_count')
      const storedOversized = this.readFlag('oversized_count')
      const storedCap = this.readFlag('oversized_cap')
      if (storedFiles === undefined) this.fileDocs = Number((this.db.prepare("SELECT COUNT(*) AS n FROM docs_meta WHERE kind = 'file'").get() as { n: number }).n)
      else this.fileDocs = storedFiles
      const cap = this.options.maxFileBytes
      if (storedOversized === undefined || storedCap === undefined || storedCap !== cap) {
        this.oversizedDocs = cap > 0
          ? Number((this.db.prepare("SELECT COUNT(*) AS n FROM docs WHERE kind = 'file' AND length(body) > ?").get(cap) as { n: number }).n)
          : 0
      } else {
        this.oversizedDocs = storedOversized
      }
      this.candidateFiles = this.readFlag('candidate_files') ?? null
      this.ftsOptimizedAt = this.readFlag('fts_optimized_at') ?? 0
      this.engineGeneration = this.readFlag('engine_generation') ?? null
      this.countersLoaded = true
    } catch {
      // A pre-0.20 database may lack the additive columns/keys; recount lazily.
      this.countersLoaded = false
    }
  }

  /** Persist the counters that make the caps check O(1) on the next boot. */
  private savePersistedCounters(): void {
    try {
      this.writeFlag('file_count', this.fileDocs)
      this.writeFlag('oversized_count', this.oversizedDocs)
      this.writeFlag('oversized_cap', this.options.maxFileBytes)
      if (this.candidateFiles !== null) this.writeFlag('candidate_files', this.candidateFiles)
    } catch { /* the counters are an optimization; a failed write only costs a rescan */ }
  }

  /**
   * Delete quarantined database archives that are old (or exceed the retention
   * count) so a crash-corruption loop cannot fill the disk. Only files this
   * plugin created with its own quarantine naming are removed.
   */
  private cleanupCorruptArchives(): void {
    try {
      const prefix = 'content.db.corrupt-'
      const archives = readdirSync(this.options.stateDir)
        .filter(name => name.startsWith(prefix))
        .sort()
      if (archives.length === 0) return
      const now = Date.now()
      for (let index = 0; index < archives.length; index++) {
        const name = archives[index] ?? ''
        const keep = archives.length - index <= CORRUPT_MAX_ARCHIVES
        let fresh = false
        try { fresh = now - statSync(join(this.options.stateDir, name)).mtimeMs < CORRUPT_RETENTION_MS } catch { fresh = false }
        if (keep && fresh) continue
        try { rmSync(join(this.options.stateDir, name), { force: true }) } catch { /* keep the archive on failure */ }
      }
    } catch { /* best effort: never fail an open because cleanup failed */ }
  }

  /**
   * Decide what an existing `content.db` is before touching it:
   * - `foreign`: no dsh-locator table at all — refuse to modify it.
   * - `corrupt`: zero bytes, unreadable, or not a SQLite database.
   * - `incompatible`: has our tables but a different schema version/shape.
   * - `ok`: safe to reuse.
   */
  private classifyDatabase(path: string): 'ok' | 'foreign' | 'corrupt' | 'incompatible' {
    let size = 0
    try { size = statSync(path).size } catch { return 'corrupt' }
    if (size === 0) return 'corrupt'
    let probe: DatabaseSync | undefined
    try {
      probe = new DatabaseSync(path, { readOnly: true })
      const names = new Set(
        (probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: string }>)
          .map(row => row.name)
          .filter((name): name is string => typeof name === 'string'),
      )
      const owned = ['docs', 'docs_meta', 'sources', 'content_meta']
      if (!owned.some(name => names.has(name))) return 'foreign'
      if (!names.has('docs') || !names.has('docs_meta') || !names.has('sources') || !names.has('content_meta')) return 'incompatible'
      const version = (probe.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0
      if (Number(version) !== SCHEMA_VERSION) return 'incompatible'
      return 'ok'
    } catch {
      return 'corrupt'
    } finally {
      try { probe?.close() } catch { /* ignore */ }
    }
  }

  /**
   * Move a broken/outdated database aside instead of destroying it. The
   * timestamped name keeps the bytes around for inspection; if the rename
   * fails (another process still holds it on Windows) a fresh file is still
   * created so content search recovers.
   */
  private quarantineDatabase(dbPath: string, verdict: 'corrupt' | 'incompatible'): void {
    this.stopWorker()
    try { this.db?.close() } catch { /* ignore */ }
    this.db = null
    const target = `${dbPath}.corrupt-${Date.now()}`
    try {
      renameSync(dbPath, target)
      this.addWarning(verdict === 'corrupt' ? 'content-db-corrupt' : 'content-db-incompatible')
    } catch {
      try { rmSync(dbPath, { force: true }) } catch { /* ignore */ }
      this.addWarning(verdict === 'corrupt' ? 'content-db-corrupt' : 'content-db-incompatible')
    }
    for (const suffix of ['-wal', '-shm']) {
      try { rmSync(dbPath + suffix, { force: true }) } catch { /* ignore */ }
    }
  }

  /** Record one non-fatal build warning (deduplicated, bounded). */
  private addWarning(warning: string): void {
    if (this.state.warnings.includes(warning)) return
    if (this.state.warnings.length >= 20) return
    this.state.warnings.push(warning)
  }

  /** Terminate every search worker and fail the requests waiting on them. */
  private stopWorker(): void {
    const slots = this.workerPool.splice(0)
    for (const slot of slots) {
      for (const resolve of slot.pending.values()) resolve({ ok: false, error: 'content-search-worker-failed' })
      slot.pending.clear()
      void slot.worker.terminate().catch(() => undefined)
    }
  }

  /** Effective search worker count: default 2, clamped to 1..4. */
  private searchWorkerCount(): number {
    const configured = this.options.searchWorkers
    const size = configured !== undefined && Number.isFinite(configured) ? Math.trunc(configured) : 2
    return Math.max(1, Math.min(4, size))
  }

  /**
   * Pick the least busy worker, creating workers up to the configured pool size.
   * @returns null when workers are disabled or cannot be spawned at all; that is
   *          the only case in which an in-process query is allowed.
   */
  private acquireWorker(): WorkerSlot | null {
    if (this.options.searchWorker !== true) return null
    // In a TypeScript test run the compiled worker does not exist next to the
    // source; answer queries in-process instead (budgeted, see searchSync).
    let workerPath: string
    try { workerPath = fileURLToPath(new URL('./content-search-worker.js', import.meta.url)) } catch { return null }
    const factory = this.options.searchWorkerFactory
    if (factory === undefined && !existsSync(workerPath)) return null
    while (this.workerPool.length < this.searchWorkerCount()) {
      const slot = this.createWorkerSlot(workerPath, factory)
      if (slot === null) break
      this.workerPool.push(slot)
    }
    if (this.workerPool.length === 0) return null
    let best = this.workerPool[0] ?? null
    for (const slot of this.workerPool) {
      if (best === null || slot.pending.size < best.pending.size) best = slot
    }
    return best
  }

  /**
   * Create one worker connection. Real workers get a shared cancellation
   * buffer: a message alone cannot interrupt a synchronous SQLite call, but the
   * worker polls the buffer between scan steps (impl-content-query protocol).
   */
  private createWorkerSlot(workerPath: string, factory: ((workerPath: string) => Worker) | undefined): WorkerSlot | null {
    try {
      const cancelBuffer = factory === undefined ? new SharedArrayBuffer(4) : null
      const worker = factory !== undefined
        ? factory(workerPath)
        : new Worker(workerPath, {
            workerData: {
              dbPath: join(this.options.stateDir, 'content.db'),
              ...(cancelBuffer === null ? {} : { cancelBuffer }),
            },
          })
      const slot: WorkerSlot = {
        worker,
        pending: new Map(),
        cancel: cancelBuffer === null ? null : new Int32Array(cancelBuffer),
      }
      worker.on('message', (message: unknown) => { this.onWorkerReply(slot, message) })
      const fail = (): void => { this.dropWorkerSlot(slot, 'content-search-worker-failed') }
      worker.on('error', fail)
      worker.on('exit', fail)
      try { worker.unref() } catch { /* test fakes may not implement unref */ }
      return slot
    } catch {
      return null
    }
  }

  /** Remove one dead/timed-out worker and fail everything waiting on it. */
  private dropWorkerSlot(slot: WorkerSlot, error: string): void {
    const index = this.workerPool.indexOf(slot)
    if (index >= 0) this.workerPool.splice(index, 1)
    for (const resolve of slot.pending.values()) resolve({ ok: false, error })
    slot.pending.clear()
    void slot.worker.terminate().catch(() => undefined)
  }

  /**
   * Resolve one worker reply. A malformed reply is reported as a protocol
   * error; the query is never retried on the host thread.
   */
  private onWorkerReply(slot: WorkerSlot, message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const record = message as { id?: unknown; ok?: unknown; error?: unknown; result?: unknown }
    if (typeof record.id !== 'number') return
    const resolve = slot.pending.get(record.id)
    if (resolve === undefined) return
    slot.pending.delete(record.id)
    if (record.ok === true && isContentSearchResult(record.result)) {
      resolve({ ok: true, result: record.result })
      return
    }
    if (record.ok === false && typeof record.error === 'string') {
      resolve({ ok: false, error: record.error, ...(isContentSearchResult(record.result) ? { result: record.result } : {}) })
      return
    }
    resolve({ ok: false, error: 'content-search-worker-protocol-error' })
  }

  /** Ask one worker to abandon a request cooperatively. */
  private cancelWorkerRequest(slot: WorkerSlot, id: number): void {
    if (slot.cancel !== null) {
      try { Atomics.store(slot.cancel, 0, id) } catch { /* a dying worker owns no memory */ }
    }
    try { slot.worker.postMessage({ id, method: 'cancel' }) } catch { /* worker already gone */ }
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
    this.sessionPaths.clear()
    this.sessionCwds.clear()
    this.state.updatedAt = 0
    this.state.error = ''
    this.state.truncated = false
    this.state.files = 0
    this.state.sessions = 0
    this.state.messages = 0
    this.progress = null
    this.boot()
  }

  /** Whether the engine is re-scanning, which can move its dump cursor. */
  private engineRescanning(): boolean {
    const scanning = (this.rt as { status?: { scanning?: unknown } }).status?.scanning
    return scanning !== undefined && scanning !== null
  }

  /** Remove all session documents, keeping file documents and their bytes. */
  private clearSessions(): void {
    const row = this.db!.prepare(`SELECT COALESCE(SUM(length(d.body)), 0) AS n
      FROM docs_meta m LEFT JOIN docs d ON d.rowid = m.rowid WHERE m.kind = 'session'`).get() as { n?: number } | undefined
    this.db!.exec("DELETE FROM docs WHERE rowid IN (SELECT rowid FROM docs_meta WHERE kind = 'session')")
    this.db!.exec("DELETE FROM docs_meta WHERE kind = 'session'")
    this.db!.exec('DELETE FROM sources')
    this.db!.exec('DELETE FROM refs')
    this.db!.exec('DELETE FROM refs_meta')
    this.totalBytes = Math.max(0, this.totalBytes - Number(row?.n ?? 0))
    this.batchTick()
  }

  /**
   * Whether the stored rows already respect the configured file/body caps.
   * Steady-state checks read the persisted counters (O(1)); only a database
   * written before the counters existed pays one scan.
   */
  private capsSatisfied(): boolean {
    if (!this.countersLoaded) this.loadPersistedCounters()
    const maxTotal = this.options.maxTotalBytes ?? 0
    if (maxTotal > 0 && this.totalBytes > maxTotal) return false
    if (this.options.maxFiles > 0 && this.fileDocs > this.options.maxFiles) return false
    if (this.options.maxFileBytes > 0 && this.oversizedDocs > 0) return false
    return true
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
    // Adaptive refresh keeps a saturated machine responsive by stretching the
    // gap between slices; correctness never depends on it.
    if (this.options.adaptiveRefresh === true && this.machineBusy()) {
      await new Promise<void>(resolve => { setTimeout(resolve, 40) })
    }
  }

  /**
   * Whether the machine looks loaded enough that a background content build
   * should slow down: load per CPU, I/O or CPU pressure, or running on battery.
   * Sampled at most once every five seconds; any read failure means "not busy".
   */
  private machineBusy(): boolean {
    const now = Date.now()
    if (now - this.machineSample.at < 5_000) return this.machineSample.busy
    const busy = adaptivePressure({
      loadavg: readTextFile('/proc/loadavg') ?? loadavg().join(' '),
      cpuCount: cpus().length,
      ioPressure: readTextFile('/proc/pressure/io'),
      cpuPressure: readTextFile('/proc/pressure/cpu'),
      batteryStatus: firstBatteryStatus(),
    }).busy
    this.machineSample = { at: now, busy }
    return busy
  }

  /** True when a session log has been quiet long enough to be read safely. */
  private settled(mtime: number): boolean {
    const delay = this.options.activeSessionDelayMs ?? 0
    return delay <= 0 || Date.now() - mtime >= delay
  }

  /** Start one build phase; `total` becomes the progress denominator when known. */
  private beginPhase(phase: ContentProgressPhase, total?: number): void {
    this.progress = { phase, scanned: 0, indexed: 0, startedAt: Date.now(), ...(total === undefined ? {} : { total }) }
  }

  /** Forget live progress once a build finishes, fails or is abandoned. */
  private clearProgress(): void {
    this.progress = null
  }

  /** Count one examined entry and keep its path for the "current item" hint. */
  private scanEntry(path: string): void {
    const progress = this.progress
    if (progress === null) return
    progress.scanned++
    progress.path = path
  }

  /** Count one entry that produced a stored row. */
  private countIndexed(amount = 1): void {
    if (this.progress !== null) this.progress.indexed += amount
  }

  /** Total engine entries, used as the files-phase progress denominator. */
  private async engineEntries(): Promise<number | undefined> {
    const cached = (this.rt as { status?: { engine?: { entries?: unknown } } }).status?.engine?.entries
    if (typeof cached === 'number' && cached > 0) return cached
    const engineStatus = (this.rt as { engineStatus?: () => Promise<{ entries?: unknown } | undefined> }).engineStatus
    if (typeof engineStatus !== 'function') return undefined
    try {
      const status = await engineStatus.call(this.rt)
      const entries = status?.entries
      return typeof entries === 'number' && entries > 0 ? entries : undefined
    } catch {
      return undefined
    }
  }

  /** FTS optimize: above this body size the merge runs in bounded chunks. */
  private static readonly FTS_CHUNKED_OPTIMIZE_BYTES = 64 * 1024 * 1024
  /** Bounded merge rounds for a large corpus (each round yields to the host). */
  private static readonly FTS_MERGE_ROUNDS = 8

  /**
   * Merge the FTS5 segments after a full rebuild ("FTS optimize"): rank and
   * scan paths are materially faster once the segment count is low. A single
   * optimize on a multi-GB corpus can block the host for tens of seconds, so
   * large databases get bounded merge rounds with an event-loop yield between
   * them; small databases take the one-shot optimize.
   */
  private async optimizeFts(): Promise<void> {
    if (this.db === null) return
    try {
      if (this.totalBytes <= ContentIndex.FTS_CHUNKED_OPTIMIZE_BYTES) {
        this.db.exec("INSERT INTO docs(docs) VALUES('optimize')")
        this.ftsOptimizedAt = Date.now()
        return
      }
      for (let round = 0; round < ContentIndex.FTS_MERGE_ROUNDS; round++) {
        this.db.exec("INSERT INTO docs(docs) VALUES('merge=4,32')")
        this.ftsOptimizedAt = Date.now()
        await new Promise<void>(resolve => { setImmediate(resolve) })
      }
    } catch { /* an optimize failure only leaves the previous segment layout */ }
  }

  /** Stop the extractor worker and fail its pending requests. */
  private stopExtractWorker(): void {
    const worker = this.extractWorker
    this.extractWorker = null
    for (const resolve of this.extractPending.values()) resolve({ ok: false, warnings: ['content-extract-worker-failed'] })
    this.extractPending.clear()
    if (worker !== null) void worker.terminate().catch(() => undefined)
  }

  /** Drop cached query results after the database changed. */
  private invalidateSearchCache(): void {
    this.searchCache?.close()
    this.searchCache = null
  }

  private finish(): void {
    this.commitBatch()
    if (this.symbolIndexesPending) this.ensureSymbolIndexes()
    this.clearProgress()
    const counts = this.db!.prepare("SELECT kind, COUNT(*) AS n FROM docs_meta GROUP BY kind").all() as Array<{ kind: string; n: number }>
    this.state.files = Number(counts.find(row => row.kind === 'file')?.n ?? 0)
    this.state.messages = Number(counts.find(row => row.kind === 'session')?.n ?? 0)
    this.state.sessions = Number((this.db!.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n)
    this.state.building = false
    this.state.updatedAt = Date.now()
    this.lastRefreshMs = this.buildStartedAt > 0 ? Date.now() - this.buildStartedAt : 0
    this.writeTotalBytes()
    this.writeFlag('complete', 1)
    this.writeFlag('reasoning', this.options.includeReasoning === true ? 1 : 0)
    this.writeFlag('toolResults', this.options.includeToolResults === true ? 1 : 0)
    this.writeFlag('symbols', this.indexSymbolsEnabled() ? 1 : 0)
    this.writeFlag('symbols_per_file', this.symbolsPerFile())
    this.writeFlag('fts_optimized_at', this.ftsOptimizedAt)
    if (this.engineGeneration !== null) this.writeFlag('engine_generation', this.engineGeneration)
    this.savePersistedCounters()
    this.refreshSessionPaths()
    // Fold the WAL back into the main file: it releases disk after a full
    // rebuild and makes the measured database size the durable one.
    try { this.db!.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* readers may hold the WAL briefly */ }
    this.measureDatabase()
    const dbBudget = this.options.maxDbBytes ?? 0
    if (dbBudget > 0 && this.dbBytes > dbBudget) {
      this.addWarning('content-db-over-budget')
      // Remember when the budget was last exceeded so the idle rebuild runs at
      // most once per six hours instead of on every refresh.
      try { this.writeFlag('db_budget_rebuilt_at', Date.now()) } catch { /* flag only gates rebuilds */ }
    }
  }

  /**
   * Rebuild the session id → session log path map from the persisted sources.
   * Runs after `open()` and after every build/refresh, so session-scoped
   * searches work against an existing database before the first refresh ends.
   */
  private refreshSessionPaths(): void {
    this.sessionPaths.clear()
    if (this.db === null) return
    try {
      const rows = this.db.prepare('SELECT path, cwd FROM sources').all() as Array<{ path?: string; cwd?: string | null }>
      for (const row of rows) {
        const path = row.path
        if (typeof path !== 'string' || path === '') continue
        const sessionId = basename(dirname(path))
        if (sessionId !== '') this.sessionPaths.set(sessionId, path)
        if (sessionId !== '' && typeof row.cwd === 'string' && row.cwd !== '') this.sessionCwds.set(sessionId, row.cwd)
      }
    } catch {
      // A database from an older schema cannot answer session-scoped queries
      // until its next rebuild; leave the map empty instead of failing boot.
    }
  }

  private addDoc(row: DocRow): boolean {
    const cap = this.options.maxTotalBytes ?? 0
    // Replacing an existing document frees its old body first: an unchanged
    // file rewritten at refresh time must not be rejected because its stale
    // copy still occupies the budget.
    const previous = this.storedBytes(row.key)
    if (cap > 0 && this.totalBytes - previous + row.body.length > cap) {
      if (!this.evictForBudget(cap, previous, row.body.length, row.key)) {
        this.state.truncated = true
        return false
      }
    }
    this.deleteDoc(row.key)
    const meta = this.db!.prepare('INSERT INTO docs_meta (doc_key, path, mtime, kind, node_key, format) VALUES (?, ?, ?, ?, ?, ?)').run(row.key, row.path, row.mtime, row.kind, row.nodeKey, row.format ?? null)
    const rowid = meta.lastInsertRowid
    this.db!.prepare('INSERT INTO docs (rowid, body, kind, path, title, session_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(rowid, row.body, row.kind, row.path, row.title, row.sessionId, row.messageId)
    this.totalBytes += row.body.length
    if (row.kind === 'file') {
      this.fileDocs++
      if (this.options.maxFileBytes > 0 && row.body.length > this.options.maxFileBytes) this.oversizedDocs++
    }
    // Symbols follow the body: a file rejected by the body budget stays out of
    // the outline too, so every repo-map entry is also a searchable document.
    if (row.symbols !== undefined) this.writeSymbols(row.path, row.symbols)
    this.batchTick()
    return true
  }

  /**
   * Evict the oldest documents until a new body fits the budget, leaving a
   * small headroom so the next document does not immediately evict again.
   * Returns false when eviction is disabled or even an empty table cannot fit
   * the incoming body; the caller then reports truncation.
   */
  private evictForBudget(cap: number, previous: number, incoming: number, incomingKey: string): boolean {
    if (this.options.evict !== true) return false
    // Leave a small headroom so the next document does not immediately evict
    // again; the reserve is a fraction of the budget, never of one document.
    const reserve = Math.max(1, Math.ceil(cap * EVICT_HEADROOM_RATIO))
    const target = Math.max(0, cap - reserve)
    const victims = this.db!.prepare(`SELECT m.rowid AS rowid, m.doc_key AS docKey, m.path AS path, m.kind AS kind, length(d.body) AS n
      FROM docs_meta m JOIN docs d ON d.rowid = m.rowid
      WHERE m.doc_key != ? ORDER BY m.mtime ASC, m.rowid ASC LIMIT 64`)
    let guard = 0
    while (this.totalBytes - previous + incoming > target && guard++ < 1_000) {
      const rows = victims.all(incomingKey) as Array<{ rowid?: number; docKey?: string; path?: string; kind?: string; n?: number }>
      if (rows.length === 0) break
      for (const row of rows) {
        this.removeDocRow(Number(row.rowid ?? 0), String(row.kind ?? ''), String(row.path ?? ''), Number(row.n ?? 0))
        this.evictedDocs++
        if (this.totalBytes - previous + incoming <= target) break
      }
    }
    return this.totalBytes - previous + incoming <= cap
  }

  /** Delete one stored document row and adjust every derived counter. */
  private removeDocRow(rowid: number, kind: string, path: string, bodyBytes: number): void {
    if (rowid === 0) return
    this.db!.prepare('DELETE FROM docs WHERE rowid = ?').run(rowid)
    this.db!.prepare('DELETE FROM docs_meta WHERE rowid = ?').run(rowid)
    this.totalBytes = Math.max(0, this.totalBytes - bodyBytes)
    if (kind === 'file') {
      this.fileDocs = Math.max(0, this.fileDocs - 1)
      if (this.oversizedDocs > 0 && this.options.maxFileBytes > 0 && bodyBytes > this.options.maxFileBytes) this.oversizedDocs--
      if (path !== '') this.deleteSymbols(path)
    }
  }

  /** Body bytes stored for one document key (0 when it is not indexed). */
  private storedBytes(key: string): number {
    const row = this.db!.prepare(`SELECT COALESCE(length(d.body), 0) AS n
      FROM docs_meta m JOIN docs d ON d.rowid = m.rowid WHERE m.doc_key = ?`).get(key) as { n?: number } | undefined
    return Number(row?.n ?? 0)
  }

  private deleteDoc(key: string): void {
    const row = this.db!.prepare(`SELECT m.rowid AS rowid, m.kind AS kind, m.path AS path, length(d.body) AS n
      FROM docs_meta m JOIN docs d ON d.rowid = m.rowid WHERE m.doc_key = ?`).get(key) as { rowid?: number; kind?: string; path?: string; n?: number } | undefined
    if (row === undefined) return
    this.removeDocRow(Number(row.rowid ?? 0), String(row.kind ?? ''), String(row.path ?? ''), Number(row.n ?? 0))
    this.batchTick()
  }

  private deletePath(path: string): void {
    // Session logs own their refs: deleting the path removes its occurrences.
    const sessionId = basename(dirname(path))
    if (basename(path).startsWith('session.v4.')) {
      try {
        this.db!.prepare('DELETE FROM refs WHERE session_id = ?').run(sessionId)
      } catch { /* older/foreign databases keep refs best-effort */ }
    }
    try {
      this.db!.prepare('DELETE FROM refs_meta WHERE path = ?').run(path)
    } catch { /* ignore */ }
    const rows = this.db!.prepare(`SELECT m.rowid AS rowid, m.kind AS kind, length(d.body) AS n
      FROM docs_meta m JOIN docs d ON d.rowid = m.rowid WHERE m.path = ?`).all(path) as Array<{ rowid?: number; kind?: string; n?: number }>
    for (const row of rows) {
      this.removeDocRow(Number(row.rowid ?? 0), String(row.kind ?? ''), path, Number(row.n ?? 0))
    }
    this.batchTick()
  }

  /**
   * Dump one page of the engine index, forwarding the generation/modification
   * filters an engine that supports them understands. Runtime versions without
   * the optional third parameter are called with two arguments only.
   */
  private async dumpPage(
    after: number,
    limit: number,
    options?: { since?: number; mtimeFrom?: number },
  ): Promise<DumpPageView> {
    const dump = this.rt.dump as (
      after: number,
      limit: number,
      options?: { since?: number; mtimeFrom?: number },
    ) => Promise<DumpPageView>
    return options === undefined ? await dump.call(this.rt, after, limit) : await dump.call(this.rt, after, limit, options)
  }

  /** Remember the lowest engine generation observed across dump pages. */
  private observeGeneration(page: DumpPageView): void {
    const generation = page.generation
    if (typeof generation !== 'number' || !Number.isFinite(generation)) return
    if (this.engineGeneration === null || generation < this.engineGeneration) this.engineGeneration = generation
  }

  /** Whether a dump page proves the engine supports generation/modification filters. */
  private generationSupported(page: DumpPageView, stored: number): boolean {
    const generation = page.generation
    return typeof generation === 'number' && Number.isFinite(generation) && generation >= stored
  }

  /** Stored mtime for one file document key, undefined when not indexed. */
  private storedMtime(key: string): number | undefined {
    const row = this.db!.prepare('SELECT mtime FROM docs_meta WHERE doc_key = ?').get(key) as { mtime?: number } | undefined
    return row?.mtime === undefined ? undefined : Number(row.mtime)
  }

  /** Index every file document from scratch (a full content rebuild). */
  private async indexFiles(generation: number): Promise<void> {
    let after = 0
    let stored = 0
    let scanned = 0
    let candidates = 0
    let stopStoring = false
    const total = await this.engineEntries()
    if (generation !== this.generation) return
    this.beginPhase('files', total)
    for (;;) {
      if (generation !== this.generation) return
      if (this.engineRescanning()) throw new Error('engine re-scan started during content build')
      const page = await this.dumpPage(after, DUMP_PAGE)
      this.observeGeneration(page)
      for (const entry of page.entries) {
        if ((++scanned & 0xff) === 0) await this.breathe()
        if (generation !== this.generation) return
        this.scanEntry(entry.path)
        if (entry.dir || entry.size <= 0 || contentSkipPath(entry.path, this.options.excludes ?? [])) continue
        if (!this.entryIsIndexable(entry.path, entry.name, entry.size)) continue
        candidates++
        if (stopStoring) continue
        if (this.options.maxFiles > 0 && stored >= this.options.maxFiles) { this.state.truncated = true; continue }
        const row = await this.readFileDoc(entry.path, entry.name, entry.mtime)
        if (row === null) continue
        stored++
        if (!this.addDoc(row)) { this.state.truncated = true; stopStoring = true; continue }
        this.countIndexed()
        await this.breathe()
      }
      after = page.next
      if (page.done || page.entries.length === 0) break
    }
    // The full build walked every record, so its candidate count is exact: it
    // is the coverage denominator until the next full sweep.
    this.candidateFiles = candidates
    if (this.engineGeneration !== null) {
      this.writeFlag('engine_sweep_at', Date.now())
      this.writeFlag('engine_floor_at', this.buildStartedAt - SWEEP_MTIME_MARGIN_MS)
    }
  }

  /**
   * Refresh the file index. A stored engine generation lets an unchanged
   * refresh end without dumping the whole index (P0-7); otherwise a periodic
   * full sweep catches deletions and renames, which a generation diff cannot.
   */
  private async refreshFiles(generation: number): Promise<void> {
    // Start a fresh observation window: the persisted generation is the
    // baseline to compare against, not a value this walk should keep as its min.
    this.engineGeneration = null
    const stored = this.readFlag('engine_generation')
    const floor = this.readFlag('engine_floor_at')
    const sweepAt = this.readFlag('engine_sweep_at') ?? 0
    const due = stored === undefined || stored <= 0 || floor === undefined || floor <= 0
      || Date.now() - sweepAt > this.fullSweepIntervalMs()
    if (due) {
      // When the machine is loaded, defer the expensive full sweep if the cheap
      // generation probe can prove nothing changed; changes still get indexed.
      if (this.options.adaptiveRefresh === true && this.machineBusy() && stored !== undefined && floor !== undefined) {
        const startedAt = Date.now()
        const page = await this.dumpPage(0, DUMP_PAGE, { since: stored, mtimeFrom: floor })
        if (generation !== this.generation) return
        if (page.unchanged === true) {
          this.observeGeneration(page)
          this.lastRefreshMode = 'deferred'
          this.addWarning('content-refresh-throttled')
          return
        }
        if (this.generationSupported(page, stored)) {
          await this.incrementalFileRefresh(generation, page, startedAt, floor)
          this.lastRefreshMode = 'deferred'
          this.addWarning('content-refresh-throttled')
          return
        }
      }
      await this.fullFileSweep(generation)
      return
    }
    const startedAt = Date.now()
    const page = await this.dumpPage(0, DUMP_PAGE, { since: stored!, mtimeFrom: floor! })
    if (generation !== this.generation) return
    if (page.unchanged === true) {
      this.observeGeneration(page)
      this.lastRefreshMode = 'fast'
      return
    }
    if (!this.generationSupported(page, stored!)) {
      await this.fullFileSweep(generation)
      return
    }
    await this.incrementalFileRefresh(generation, page, startedAt, floor!)
  }

  /**
   * Index only the entries the engine reports as modified (P0-7). Deletions and
   * renames are intentionally not handled here: the periodic full sweep owns
   * them.
   */
  private async incrementalFileRefresh(
    generation: number,
    first: DumpPageView,
    startedAt: number,
    floor: number,
  ): Promise<void> {
    const deferred: Array<{ path: string; name: string; mtime: number; size: number }> = []
    let page = first
    let scanned = 0
    const pageMtime = Math.max(0, floor)
    for (;;) {
      if (generation !== this.generation) return
      if (this.engineRescanning()) throw new Error('engine re-scan started during content build')
      this.observeGeneration(page)
      for (const entry of page.entries) {
        if ((++scanned & 0xff) === 0) await this.breathe()
        if (generation !== this.generation) return
        this.scanEntry(entry.path)
        if (entry.dir || entry.size <= 0 || contentSkipPath(entry.path, this.options.excludes ?? [])) continue
        if (!this.entryIsIndexable(entry.path, entry.name, entry.size)) continue
        const key = `file:${entry.path}`
        const existing = this.storedMtime(key)
        if (existing === entry.mtime) continue
        if (existing === undefined && this.options.maxFiles > 0 && this.fileDocs >= this.options.maxFiles) {
          this.state.truncated = true
          continue
        }
        if (this.options.evict !== true && this.wouldExceed(entry.size, key)) {
          deferred.push({ path: entry.path, name: entry.name, mtime: entry.mtime, size: entry.size })
          continue
        }
        const row = await this.readFileDoc(entry.path, entry.name, entry.mtime)
        if (row === null) continue
        if (!this.addDoc(row)) {
          deferred.push({ path: entry.path, name: entry.name, mtime: entry.mtime, size: entry.size })
          continue
        }
        this.countIndexed()
        await this.breathe()
      }
      if (page.done || page.entries.length === 0) break
      page = await this.dumpPage(page.next, DUMP_PAGE, { mtimeFrom: pageMtime })
    }
    for (const entry of deferred) {
      if (generation !== this.generation) return
      if (this.options.evict !== true && this.wouldExceed(entry.size, `file:${entry.path}`)) { this.state.truncated = true; continue }
      const row = await this.readFileDoc(entry.path, entry.name, entry.mtime)
      if (row === null) continue
      if (!this.addDoc(row)) { this.state.truncated = true; continue }
      this.countIndexed()
      await this.breathe()
    }
    // The dump started at `startedAt`; a file touched while the refresh ran may
    // have been written after its page, so the next floor stays safely behind.
    this.writeFlag('engine_floor_at', startedAt - SWEEP_MTIME_MARGIN_MS)
    if (this.engineGeneration !== null) this.writeFlag('engine_generation', this.engineGeneration)
  }

  /**
   * Compare the whole engine index against docs_meta: re-read changed files and
   * remove documents whose files disappeared. Records the generation and sweep
   * timestamps the fast path later relies on.
   */
  private async fullFileSweep(generation: number): Promise<void> {
    const sweepStartedAt = Date.now()
    const meta = new Map<string, number>()
    for (const row of this.db!.prepare("SELECT doc_key, mtime FROM docs_meta WHERE kind = 'file'").all() as Array<{ doc_key: string; mtime: number }>) meta.set(row.doc_key, row.mtime)
    const seen = new Set<string>()
    const deferred: Array<{ path: string; name: string; mtime: number; size: number }> = []
    let after = 0
    // `maxFiles` counts documents that are actually stored. A file whose read
    // failed is not stored, so it must not consume a slot: counting it here used
    // to stop the loop early (and the deletion pass then removed every trailing
    // document that was never reached). `indexed` only moves on success.
    let indexed = 0
    let scanned = 0
    let candidates = 0
    let capped = false
    const total = await this.engineEntries()
    if (generation !== this.generation) return
    this.beginPhase('files', total)
    for (;;) {
      if (generation !== this.generation) return
      if (this.engineRescanning()) throw new Error('engine re-scan started during content build')
      const page = await this.dumpPage(after, DUMP_PAGE)
      this.observeGeneration(page)
      for (const entry of page.entries) {
        if ((++scanned & 0xff) === 0) await this.breathe()
        if (generation !== this.generation) return
        this.scanEntry(entry.path)
        if (entry.dir || entry.size <= 0 || contentSkipPath(entry.path, this.options.excludes ?? [])) continue
        if (!this.entryIsIndexable(entry.path, entry.name, entry.size)) continue
        candidates++
        if (this.options.maxFiles > 0 && indexed >= this.options.maxFiles) {
          // Keep walking (cheap, no reads) so deletions are still detected and
          // the coverage denominator stays exact.
          capped = true
          continue
        }
        const key = `file:${entry.path}`
        seen.add(key)
        if (meta.get(key) === entry.mtime) {
          // Unchanged and already stored: it still occupies one of the slots.
          indexed++
          this.countIndexed()
          continue
        }
        // With eviction enabled the budget check is advisory: addDoc evicts the
        // oldest documents to fit instead of deferring the new one.
        if (this.options.evict !== true && this.wouldExceed(entry.size, key)) {
          deferred.push({ path: entry.path, name: entry.name, mtime: entry.mtime, size: entry.size })
          continue
        }
        // Read first, replace only on success. A transient read failure must
        // keep the document indexed by the previous refresh, not delete it.
        const row = await this.readFileDoc(entry.path, entry.name, entry.mtime)
        if (row === null) continue
        if (!this.addDoc(row)) {
          deferred.push({ path: entry.path, name: entry.name, mtime: entry.mtime, size: entry.size })
          continue
        }
        indexed++
        this.countIndexed()
        await this.breathe()
      }
      after = page.next
      if (page.done || page.entries.length === 0) break
    }
    if (capped) this.state.truncated = true
    // Removing rows for files that disappeared frees budget before the deferred
    // files are retried; otherwise a stale large entry would block new ones.
    for (const key of meta.keys()) {
      if (seen.has(key)) continue
      this.deleteDoc(key)
      const deletedPath = docKeyPath(key)
      if (deletedPath !== null) this.deleteSymbols(deletedPath)
    }
    for (const entry of deferred) {
      if (generation !== this.generation) return
      if (this.options.evict !== true && this.wouldExceed(entry.size, `file:${entry.path}`)) { this.state.truncated = true; continue }
      const row = await this.readFileDoc(entry.path, entry.name, entry.mtime)
      if (row === null) continue
      if (!this.addDoc(row)) { this.state.truncated = true; continue }
      this.countIndexed()
      await this.breathe()
    }
    this.candidateFiles = candidates
    if (this.engineGeneration !== null) {
      this.writeFlag('engine_sweep_at', Date.now())
      this.writeFlag('engine_floor_at', sweepStartedAt - SWEEP_MTIME_MARGIN_MS)
      this.writeFlag('engine_generation', this.engineGeneration)
    }
  }

  /** Would storing a file of this size overflow the configured body budget? */
  private wouldExceed(size: number, docKey?: string): boolean {
    const cap = this.options.maxTotalBytes ?? 0
    if (cap <= 0) return false
    const previous = docKey === undefined ? 0 : this.storedBytes(docKey)
    return this.totalBytes - previous + Math.min(size, this.options.maxFileBytes) > cap
  }

  private async readFileDoc(path: string, name: string, mtime: number): Promise<DocRow | null> {
    if (documentFormat(name) !== null) return await this.readDocumentDoc(path, name, mtime)
    let buffer: Buffer
    try { buffer = await readFile(path) } catch { return null }
    if (buffer.includes(0)) return null
    const text = buffer.toString('utf8')
    const body = text.slice(0, this.options.maxFileBytes)
    const symbols = this.collectFileSymbols(path, text, buffer.length)
    return {
      key: `file:${path}`,
      body,
      kind: 'file',
      path,
      title: name,
      sessionId: null,
      messageId: null,
      nodeKey: null,
      mtime,
      format: null,
      ...(symbols === undefined ? {} : { symbols }),
    }
  }

  /** Extract one document body; its format is recorded additively in docs_meta. */
  private async readDocumentDoc(path: string, name: string, mtime: number): Promise<DocRow | null> {
    const format = documentFormat(name)
    if (format === null || !this.extractDocumentsEnabled()) return null
    const textCap = Math.max(1, this.options.maxFileBytes)
    let data: Buffer
    try { data = await readFile(path) } catch { return null }
    // Extracted bodies are cached by content hash, so a touch (rewritten mtime,
    // identical bytes) reuses the parse instead of re-reading the document.
    const hash = createHash('sha256').update(data).digest('hex')
    const cached = this.touchExtractCache(hash)
    if (cached !== undefined) {
      if (cached.text === null) return null
      const body = cached.text.slice(0, textCap)
      if (body.trim() === '') return null
      return { key: `file:${path}`, body, kind: 'file', path, title: name, sessionId: null, messageId: null, nodeKey: null, mtime, format: cached.format }
    }
    const extracted = await this.extractDocumentBody(path, data, textCap)
    for (const warning of extracted.warnings) this.addWarning(warning)
    // A worker crash/timeout is transient; caching "nothing extractable" for it
    // would keep the document out of the index for the rest of the process.
    const transient = extracted.warnings.some(warning => warning === 'content-extract-worker-failed'
      || warning === 'content-extract-timeout' || warning === 'document-extract-timeout')
    if (!extracted.ok) {
      // A scanned PDF has no text layer: let the optional OCR hook supply one.
      const ocr = this.options.ocr
      if (format !== 'pdf' || ocr === undefined) {
        if (!transient) this.storeExtractCache(hash, { text: null, format })
        return null
      }
      let recognized: string | undefined
      try { recognized = await ocr(path, format) } catch { recognized = undefined }
      if (recognized === undefined || recognized.trim() === '') {
        if (!transient) this.storeExtractCache(hash, { text: null, format })
        return null
      }
      this.storeExtractCache(hash, { text: recognized.slice(0, textCap), format })
      return { key: `file:${path}`, body: recognized.slice(0, textCap), kind: 'file', path, title: name, sessionId: null, messageId: null, nodeKey: null, mtime, format }
    }
    const body = extracted.text.slice(0, textCap)
    if (body.trim() === '') {
      this.storeExtractCache(hash, { text: null, format })
      return null
    }
    this.storeExtractCache(hash, { text: extracted.text, format, ...(extracted.pages === undefined ? {} : { pages: extracted.pages }) })
    return { key: `file:${path}`, body, kind: 'file', path, title: name, sessionId: null, messageId: null, nodeKey: null, mtime, format: extracted.format }
  }

  /**
   * Extract one document body, in the extractor worker when it exists and
   * in-process otherwise (direct embedders and test runs).
   */
  private async extractDocumentBody(path: string, data: Buffer, maxChars: number): Promise<ExtractReply> {
    if (this.extractWorkerAvailable() && this.ensureExtractWorker()) {
      const reply = await this.extractInWorker(path, data, maxChars)
      if (reply.ok) return reply
      // A worker failure is never retried on the host thread (same rule as the
      // search worker); the document is simply left out with its warning.
      return reply
    }
    return await this.extractInProcess(path, data, maxChars)
  }

  /** In-process extraction, used when no compiled worker is available. */
  private async extractInProcess(path: string, data: Buffer, maxChars: number): Promise<ExtractReply> {
    const warnings: string[] = []
    const extracted = await extractDocumentFromBuffer(path, data, {
      maxBytes: this.documentMaxBytes(),
      maxChars,
      maxMs: this.extractTimeoutMs(),
      onWarning: warning => { if (warnings.length < 20) warnings.push(warning) },
    })
    if (extracted === null) return { ok: false, warnings }
    return { ok: true, format: extracted.format, text: extracted.text, ...(extracted.pages === undefined ? {} : { pages: extracted.pages }), warnings }
  }

  /**
   * Lazily create the extractor worker. It is capped at 512 MB old-gen heap,
   * matching the resource envelope the extraction path is designed for.
   * @returns the worker, or null when it cannot be created.
   */
  private ensureExtractWorker(): Worker | null {
    if (this.extractWorker !== null) return this.extractWorker
    let workerPath: string
    try { workerPath = fileURLToPath(new URL('./extract-worker.js', import.meta.url)) } catch { return null }
    if (!existsSync(workerPath)) return null
    try {
      const worker = new Worker(workerPath, { resourceLimits: { maxOldGenerationSizeMb: 512 } })
      const fail = (): void => {
        if (this.extractWorker === worker) this.extractWorker = null
        for (const resolve of this.extractPending.values()) resolve({ ok: false, warnings: ['content-extract-worker-failed'] })
        this.extractPending.clear()
      }
      worker.on('message', (message: unknown) => { this.onExtractMessage(message) })
      worker.on('error', fail)
      worker.on('exit', fail)
      worker.unref()
      this.extractWorker = worker
      return worker
    } catch {
      this.extractWorker = null
      return null
    }
  }

  /** Resolve one extractor reply; malformed replies count as failed extraction. */
  private onExtractMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const record = message as { id?: unknown; ok?: unknown; warnings?: unknown; result?: unknown }
    if (typeof record.id !== 'number') return
    const resolve = this.extractPending.get(record.id)
    if (resolve === undefined) return
    this.extractPending.delete(record.id)
    const warnings = Array.isArray(record.warnings) ? record.warnings.filter((warning): warning is string => typeof warning === 'string') : []
    if (record.ok !== true) {
      resolve({ ok: false, warnings })
      return
    }
    const result = record.result as { format?: unknown; text?: unknown; pages?: unknown } | undefined
    if (typeof result?.format !== 'string' || typeof result.text !== 'string') {
      resolve({ ok: false, warnings })
      return
    }
    const format = documentFormat('x.' + result.format)
    if (format === null) { resolve({ ok: false, warnings }); return }
    resolve({ ok: true, format, text: result.text, ...(typeof result.pages === 'number' ? { pages: result.pages } : {}), warnings })
  }

  /** Run one extraction on the worker with a hard deadline. */
  private async extractInWorker(path: string, data: Buffer, maxChars: number): Promise<ExtractReply> {
    const worker = this.ensureExtractWorker()
    if (worker === null) return await this.extractInProcess(path, data, maxChars)
    const id = ++this.extractSeq
    const timeoutMs = this.extractTimeoutMs()
    return await new Promise<ExtractReply>(resolve => {
      const timer = setTimeout(() => {
        if (!this.extractPending.delete(id)) return
        // A wedged extraction is thrown away; the document is left out instead
        // of blocking the content build (and the next request gets a new worker).
        if (this.extractWorker === worker) {
          this.extractWorker = null
          void worker.terminate().catch(() => undefined)
        }
        resolve({ ok: false, warnings: ['content-extract-timeout'] })
      }, timeoutMs + 1_000)
      this.extractPending.set(id, reply => { clearTimeout(timer); resolve(reply) })
      try {
        // Copy so the read buffer can be detached into the worker's heap.
        const payload = new Uint8Array(data)
        worker.postMessage({ id, path, data: payload, maxBytes: this.documentMaxBytes(), maxChars, maxMs: timeoutMs })
      } catch {
        if (this.extractPending.delete(id)) { clearTimeout(timer); resolve({ ok: false, warnings: ['content-extract-worker-failed'] }) }
      }
    })
  }

  /** Return the cached extraction for one hash and refresh its LRU position. */
  private touchExtractCache(hash: string): ExtractCacheEntry | undefined {
    const entry = this.extractCache.get(hash)
    if (entry === undefined) return undefined
    this.extractCache.delete(hash)
    this.extractCache.set(hash, entry)
    return entry
  }

  /** Store one extraction answer under its content hash, bounded LRU. */
  private storeExtractCache(hash: string, entry: ExtractCacheEntry): void {
    const chars = entry.text?.length ?? 0
    // One huge body must not evict every other cached answer.
    if (chars > EXTRACT_CACHE_CHARS / 2) return
    const previous = this.extractCache.get(hash)
    if (previous !== undefined) {
      this.extractCacheChars -= previous.text?.length ?? 0
      this.extractCache.delete(hash)
    }
    this.extractCache.set(hash, entry)
    this.extractCacheChars += chars
    while (this.extractCache.size > EXTRACT_CACHE_ENTRIES || this.extractCacheChars > EXTRACT_CACHE_CHARS) {
      const oldest = this.extractCache.keys().next().value
      if (oldest === undefined) break
      const evicted = this.extractCache.get(oldest)
      this.extractCache.delete(oldest)
      this.extractCacheChars -= evicted?.text?.length ?? 0
    }
  }

  /**
   * Whether one dump entry belongs in this build. Document extraction has its
   * own byte cap: a normal PDF or deck is larger than the text-file limit.
   */
  private entryIsIndexable(path: string, name: string, size: number): boolean {
    if (this.options.isIndexable?.(path) === false) return false
    if (documentFormat(name) !== null) {
      if (!this.extractDocumentsEnabled()) return false
      if (size > this.documentMaxBytes()) {
        this.addWarning('content-document-too-large')
        return false
      }
      return true
    }
    if (size > this.options.maxFileBytes) return false
    return TEXT_EXTENSIONS.has(extname(name).toLowerCase())
  }

  private async indexSessions(generation: number): Promise<void> {
    const files = (await this.sessionCandidates()).filter(file => this.settled(file.mtime))
    this.beginPhase('sessions', files.length)
    for (const file of files) {
      if (generation !== this.generation) return
      this.scanEntry(file.path)
      const indexed = await this.refreshSessionFile(file, generation, undefined)
      if (indexed) this.countIndexed()
      await this.breathe()
    }
  }

  private async refreshSessions(generation: number): Promise<void> {
    const known = this.readSessionSources()
    const files = await this.sessionCandidates()
    this.beginPhase('sessions', files.length)
    const present = new Set<string>()
    for (const file of files) {
      if (generation !== this.generation) return
      this.scanEntry(file.path)
      present.add(file.path)
      // The session being written right now is left for a later refresh: keep
      // its existing rows instead of re-reading the whole growing log.
      if (!this.settled(file.mtime)) continue
      const previous = known.get(file.path)
      if (previous !== undefined && previous.mtime === file.mtime) continue
      const indexed = await this.refreshSessionFile(file, generation, previous)
      if (indexed) this.countIndexed()
      await this.breathe()
    }
    for (const path of known.keys()) {
      if (present.has(path)) continue
      this.deletePath(path)
      this.db!.prepare('DELETE FROM sources WHERE path = ?').run(path)
      this.batchTick()
    }
  }

  /** Load every indexed session log's source row (path, mtime, tail state). */
  private readSessionSources(): Map<string, SessionSourceRow> {
    const known = new Map<string, SessionSourceRow>()
    try {
      const rows = this.db!.prepare(`SELECT path, mtime, cwd, byte_len AS byteLen, last_line AS lastLine, title, capped FROM sources`).all() as Array<{
        path?: string; mtime?: number; cwd?: string | null; byteLen?: number | null; lastLine?: number | null; title?: string | null; capped?: number | null
      }>
      for (const row of rows) {
        if (typeof row.path !== 'string' || row.path === '') continue
        known.set(row.path, {
          path: row.path,
          mtime: Number(row.mtime ?? 0),
          cwd: typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null,
          byteLen: typeof row.byteLen === 'number' ? Number(row.byteLen) : null,
          lastLine: typeof row.lastLine === 'number' ? Number(row.lastLine) : null,
          title: typeof row.title === 'string' ? row.title : null,
          capped: Number(row.capped ?? 0),
        })
      }
    } catch { /* a pre-0.20 schema is upgraded by ensureSessionColumns before this */ }
    return known
  }

  /**
   * Refresh one session log: append only the new Zstandard frames when the log
   * grew and the tail starts with a frame magic (P1 streaming/tail refresh),
   * otherwise re-read the whole log (or its head when it exceeds the cap).
   * @returns true when rows were written and the caller should count progress.
   */
  private async refreshSessionFile(
    file: { path: string; mtime: number },
    generation: number,
    known: SessionSourceRow | undefined,
  ): Promise<boolean> {
    if (generation !== this.generation) return false
    let size: number
    try { size = (await stat(file.path)).size } catch { return false }
    const maxBytes = this.sessionMaxBytes()
    // A log already indexed as a capped head stays capped: re-reading it only
    // re-parses the same head, and its tail is beyond the configured budget.
    if (known !== undefined && known.capped === 1) {
      this.sessionPaths.set(basename(dirname(file.path)), file.path)
      return false
    }
    if (
      known !== undefined
      && known.byteLen !== null && known.lastLine !== null
      && known.byteLen >= 0 && size > known.byteLen
      && size - known.byteLen >= 4
      && this.options.includeToolResults !== true
    ) {
      const delta = await this.readSessionDelta(file, known.byteLen)
      if (delta !== null) {
        const state: SessionIndexState = {
          nextLine: known.lastLine,
          title: known.title ?? '',
          headerCwd: known.cwd,
          callNames: new Map(),
          append: true,
        }
        const indexed = await this.indexSessionLines(file, state, delta.lines, generation, delta.state)
        if (!indexed.ok) {
          this.addWarning('content-session-log-unreadable')
          return false
        }
        // Advance the stored byte offset only past the frames actually decoded;
        // a truncated tail (a frame still being written) is read next time.
        this.writeSessionSource(file, indexed.cwd, delta.completeBytes, indexed.lastLine, indexed.title, delta.truncated ? 1 : 0)
        if (delta.truncated) this.addWarning('content-session-truncated')
        return true
      }
    }
    // Full read (or head of an oversized log). Decode before touching old rows:
    // a transient failure keeps the previous documents and retries next refresh.
    const oversized = maxBytes > 0 && size > maxBytes
    const readEnd = oversized ? Math.min(size, maxBytes) : size
    const decode = await this.openSessionDecode(file, 0, readEnd, oversized ? SESSION_HEAD_CHARS : Number.POSITIVE_INFINITY)
    if (decode === null) {
      this.addWarning('content-session-log-unreadable')
      return false
    }
    this.deletePath(file.path)
    const state: SessionIndexState = { nextLine: 0, title: '', headerCwd: null, callNames: new Map(), append: false }
    const indexed = await this.indexSessionLines(file, state, decode.lines, generation, decode.state)
    if (!indexed.ok) {
      // The previous rows were already replaced by this partial read; drop the
      // tail state so the next refresh re-reads the whole log from scratch.
      try { this.db!.prepare('DELETE FROM sources WHERE path = ?').run(file.path) } catch { /* retry via a full read anyway */ }
      this.addWarning('content-session-log-unreadable')
      return false
    }
    this.writeSessionSource(file, indexed.cwd, decode.completeBytes, indexed.lastLine, indexed.title, oversized ? 1 : 0)
    if (oversized) this.addWarning('content-session-truncated')
    return true
  }

  /**
   * Decode and index only the appended tail of one session log. Returns null
   * when the tail does not start with a Zstandard frame (rewritten file) or the
   * first decoded line is not a fresh JSONL document (partial line), in which
   * case the caller re-reads the whole log.
   */
  private async readSessionDelta(
    file: { path: string; mtime: number },
    from: number,
  ): Promise<{ lines: AsyncGenerator<string>; completeBytes: number; truncated: boolean; state: { truncated: boolean; failed: boolean } } | null> {
    const maxBytes = this.sessionMaxBytes()
    let size: number
    try { size = (await stat(file.path)).size } catch { return null }
    if (size <= from) return null
    let magic: number
    try {
      const header = await readFileRegion(file.path, from, from + 4)
      if (header.length < 4) return null
      magic = header.readUInt32LE(0)
    } catch { return null }
    if (magic !== ZSTD_MAGIC) return null
    const readEnd = maxBytes > 0 ? Math.min(size, from + maxBytes) : size
    const decoded = await this.openSessionDecode(file, from, readEnd, Number.POSITIVE_INFINITY)
    if (decoded === null) return null
    // A frame boundary should also be a line boundary; verify the first line is
    // a JSON object before trusting the append (otherwise fall back to full).
    const iterator = decoded.lines
    let first: IteratorResult<string>
    try { first = await iterator.next() } catch { return null }
    if (decoded.state.failed) return null
    if (!first.done && !first.value.startsWith('{')) return null
    const lines = (async function* (): AsyncGenerator<string> {
      if (!first.done) yield first.value
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        yield next.value
      }
    })()
    return { lines, completeBytes: decoded.completeBytes, truncated: decoded.state.truncated, state: decoded.state }
  }

  /** Persist one session log's source row, including its incremental tail state. */
  private writeSessionSource(
    file: { path: string; mtime: number },
    cwd: string | null,
    byteLen: number,
    lastLine: number,
    title: string,
    capped: number,
  ): void {
    if (this.db === null) return
    try {
      this.db.prepare(`INSERT OR REPLACE INTO sources (path, mtime, cwd, byte_len, last_line, title, capped)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(file.path, file.mtime, cwd, Math.max(0, Math.round(byteLen)), lastLine, title.slice(0, 200), capped)
    } catch {
      try { this.db.prepare('INSERT OR REPLACE INTO sources (path, mtime, cwd) VALUES (?, ?, ?)').run(file.path, file.mtime, cwd) } catch { /* additive tail state */ }
    }
    this.batchTick()
  }

  /**
   * Index decoded session lines in order. In append mode existing rows stay and
   * only new messages/refs are written.
   * @returns success plus the tail state the caller persists in sources.
   */
  private async indexSessionLines(
    file: { path: string; mtime: number },
    state: SessionIndexState,
    lines: AsyncIterable<string>,
    generation: number,
    decodeState?: { failed: boolean },
  ): Promise<{ ok: boolean; cwd: string | null; lastLine: number; title: string }> {
    if (generation !== this.generation) return { ok: false, cwd: state.headerCwd, lastLine: state.nextLine, title: state.title }
    const sessionId = basename(dirname(file.path))
    this.sessionPaths.set(sessionId, file.path)
    const callNames = state.callNames
    let headerCwd = state.headerCwd
    let title = state.title
    let parsed = 0
    const evidence: EvidenceRefRow[] = []
    for await (const rawLine of lines) {
      const lineIndex = state.nextLine++
      const line = rawLine.replace(/\r$/, '')
      if (line === '') continue
      if ((++parsed & 0xff) === 0) {
        await this.breathe()
        if (generation !== this.generation) return { ok: false, cwd: headerCwd, lastLine: state.nextLine, title }
      }
      let event: { type?: string; data?: Record<string, unknown> }
      try { event = JSON.parse(line) } catch { continue }
      // Data events are one line each after the header: their sequence is the
      // physical line ordinal minus that header line.
      const eventSeq = Math.max(0, lineIndex - 1)
      const eventData = event.data ?? {}
      const rawMessage = (eventData.message ?? {}) as Record<string, unknown>
      const refMessageId = String(eventData.id ?? rawMessage.id ?? rawMessage.toolCallId ?? `event-${eventSeq}`)
      if (event.type === 'session') {
        // The first physical line is the session header (not a data envelope):
        // it carries the immutable cwd that authorizes cross-session reads.
        const header = event as { cwd?: unknown }
        if (typeof header.cwd === 'string' && header.cwd !== '') {
          headerCwd = header.cwd
          this.sessionCwds.set(sessionId, header.cwd)
        }
        continue
      }
      const extracted = messageText(event, this.options.includeReasoning === true)
      // Evidence refs are extracted in the same pass as documents; they do not
      // depend on the tool-result indexing flag (URL/spill/attachment metadata
      // lives in the event envelope, not in the FTS body).
      evidence.push(...extractEvidenceRefs(event, sessionId, extracted?.id ?? refMessageId, eventSeq))
      if (extracted !== undefined) {
        evidence.push({
          refKey: sessionEventRef({ sessionId, seq: eventSeq }), kind: 'session-event', target: sessionId,
          sha256: null, sessionId, messageId: extracted.id, seq: eventSeq, origin: 'session',
          title: extracted.titleText.replace(/\s+/g, ' ').slice(0, 120) || null, bytes: null, meta: null,
        })
        if (title === '') title = extracted.titleText.replace(/\s+/g, ' ').slice(0, 90)
        const body = extracted.text.slice(0, SESSION_BODY_BYTES)
        const row: DocRow = { key: `session:${sessionId}:${extracted.id}`, body, kind: 'session', path: file.path, title: title || sessionId, sessionId, messageId: extracted.id, nodeKey: extracted.nodeKey, mtime: file.mtime }
        if (!this.addDoc(row)) return { ok: false, cwd: headerCwd, lastLine: state.nextLine, title }
        continue
      }
      if (this.options.includeToolResults === true) {
        // Tool results are their own documents: they can be long, and pairing
        // them with the assistant message would let a huge result evict the
        // answer from the 8KB body cap. The title carries the tool name from
        // the matching tool/call event.
        if (event.type === 'tool/call') {
          const callId = String((event.data ?? {}).callId ?? '')
          const name = (event.data ?? {}).name
          if (callId !== '' && typeof name === 'string' && name !== '') callNames.set(callId, name)
          continue
        }
        if (event.type !== 'tool/result') continue
        const data = event.data ?? {}
        const message = (data.message ?? {}) as Record<string, unknown>
        const callId = String(message.toolCallId ?? '')
        const content = message.content
        if (!Array.isArray(content)) continue
        const body = content
          .filter((block): block is { type: string; text: string } =>
            typeof block === 'object' && block !== null
              && (block as { type?: unknown }).type === 'text'
              && typeof (block as { text?: unknown }).text === 'string')
          .map(block => block.text).join('\n').trim().slice(0, SESSION_BODY_BYTES)
        if (body === '') continue
        const id = callId !== '' ? callId : `tool-seq-${String(data.seq ?? parsed)}`
        const toolName = callNames.get(callId) ?? 'tool result'
        const row: DocRow = { key: `session:${sessionId}:tool-${id}`, body, kind: 'session', path: file.path, title: toolName, sessionId, messageId: id, nodeKey: null, mtime: file.mtime }
        if (!this.addDoc(row)) return { ok: false, cwd: headerCwd, lastLine: state.nextLine, title }
      }
    }
    // A frame that failed to decompress means the tail state cannot be trusted:
    // report failure so the caller keeps its previous sources row and retries.
    if (decodeState?.failed === true) return { ok: false, cwd: headerCwd, lastLine: state.nextLine, title }
    this.replaceSessionRefs(sessionId, file.path, file.mtime, evidence, state.append)
    return { ok: true, cwd: headerCwd, lastLine: state.nextLine, title }
  }

  /**
   * Open one region of a session log and decode its complete Zstandard frames
   * lazily, one frame at a time, so a 45 MB plaintext log never has to exist as
   * a single string (P1 streaming decode).
   * @returns the line generator plus the compressed offset after the last
   *          complete frame, or null when the region is unreadable/corrupt.
   */
  private async openSessionDecode(
    file: { path: string; mtime: number },
    from: number,
    end: number,
    charBudget: number,
  ): Promise<{ lines: AsyncGenerator<string>; completeBytes: number; state: { truncated: boolean; failed: boolean } } | null> {
    let region: Buffer
    try { region = await readFileRegion(file.path, from, end) } catch { return null }
    let scan: ZstdFrameScan
    try { scan = scanZstdFrames(region) } catch { return null }
    const completeBytes = from + (scan.tornStart ?? region.length)
    const state = { truncated: false, failed: false }
    const decodeLines = async function* (): AsyncGenerator<string> {
      let carry = ''
      let consumed = 0
      for (const frame of scan.frames) {
        let text: string
        try { text = (await zstdDecompressAsync(region.subarray(frame.start, frame.end))).toString('utf8') } catch {
          // A frame that scans structurally but fails to decompress must not
          // advance the persisted byte offset: the caller keeps the old state
          // and retries the same tail on the next refresh.
          state.failed = true
          return
        }
        const value = carry + text
        let index = 0
        for (;;) {
          const newline = value.indexOf('\n', index)
          if (newline === -1) { carry = value.slice(index); break }
          const line = value.slice(index, newline)
          index = newline + 1
          consumed += line.length
          if (consumed > charBudget) { state.truncated = true; return }
          yield line
        }
      }
      // A final frame without a trailing newline still holds one document.
      if (carry !== '') {
        consumed += carry.length
        if (consumed > charBudget) state.truncated = true
        else yield carry
      }
    }
    return { lines: decodeLines(), completeBytes, state }
  }

  /**
   * Session logs to consider, newest first. Archived logs are indexed too:
   * they are excluded from queries (see {@link searchDetailed}) unless the
   * caller or the configuration asks for them, so toggling archived search
   * needs no rebuild.
   */
  private async sessionCandidates(): Promise<Array<{ path: string; mtime: number }>> {
    const files = await sessionFiles(this.sessionRoots())
    const archived = this.options.includeArchived === true ? new Set<string>() : await archivedSessionIds()
    this.archivedSessions = archived
    const max = this.options.maxSessions > 0 ? this.options.maxSessions : Number.POSITIVE_INFINITY
    const out: Array<{ path: string; mtime: number }> = []
    for (const file of files) {
      if (out.length >= max) break
      out.push(file)
    }
    return out
  }

  /** Create the additive `refs`/`refs_meta` tables; true when they were missing. */
  private ensureRefsTables(): boolean {
    if (this.db === null) return false
    try {
      const names = new Set(
        (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('refs','refs_meta')").all() as Array<{ name?: string }>)
          .map(row => row.name)
          .filter((name): name is string => typeof name === 'string'),
      )
      if (names.has('refs') && names.has('refs_meta')) return false
      this.db.exec(`CREATE TABLE IF NOT EXISTS refs (
        ref_key TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, sha256 TEXT,
        session_id TEXT NOT NULL, message_id TEXT NOT NULL, seq INTEGER,
        origin TEXT NOT NULL, title TEXT, bytes INTEGER, meta TEXT,
        log_mtime INTEGER, indexed_at INTEGER NOT NULL
      )`)
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS refs_occ ON refs(ref_key, session_id, message_id)')
      this.db.exec('CREATE INDEX IF NOT EXISTS refs_key ON refs(ref_key)')
      this.db.exec('CREATE INDEX IF NOT EXISTS refs_msg ON refs(session_id, message_id)')
      this.db.exec('CREATE TABLE IF NOT EXISTS refs_meta (path TEXT PRIMARY KEY, log_mtime INTEGER, count INTEGER)')
      return true
    } catch {
      return false
    }
  }

  /** Replace one session log's ref occurrences after re-reading it. */
  private replaceSessionRefs(sessionId: string, path: string, mtime: number, rows: EvidenceRefRow[], append = false): void {
    if (this.db === null) return
    try {
      // A full re-read owns every occurrence of the log; an append pass only
      // adds the new rows and keeps the occurrences indexed earlier.
      if (!append) this.db.prepare('DELETE FROM refs WHERE session_id = ?').run(sessionId)
      const insert = this.db.prepare(`INSERT OR IGNORE INTO refs
        (ref_key, kind, target, sha256, session_id, message_id, seq, origin, title, bytes, meta, log_mtime, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      const now = Date.now()
      for (const row of rows) {
        insert.run(row.refKey, row.kind, row.target, row.sha256, row.sessionId, row.messageId, row.seq, row.origin, row.title, row.bytes, row.meta, mtime, now)
      }
      const count = Number((this.db.prepare('SELECT COUNT(*) AS n FROM refs WHERE session_id = ?').get(sessionId) as { n?: number } | undefined)?.n ?? rows.length)
      this.db.prepare('INSERT OR REPLACE INTO refs_meta (path, log_mtime, count) VALUES (?, ?, ?)').run(path, mtime, count)
      this.batchTick()
    } catch { /* refs are additive evidence; never fail a content build for them */ }
  }

  /** Add the additive `sources.cwd` column without bumping the schema version. */
  private ensureSourcesCwdColumn(): boolean {
    if (this.db === null) return false
    try {
      const columns = this.db.prepare('PRAGMA table_info(sources)').all() as Array<{ name?: string }>
      if (columns.some(column => column.name === 'cwd')) return false
      this.db.exec('ALTER TABLE sources ADD COLUMN cwd TEXT')
      return true
    } catch {
      // An older/foreign database keeps path-only behavior.
      return false
    }
  }

  /** Add the additive docs_meta.format column without bumping the schema version. */
  private ensureDocsMetaFormatColumn(): boolean {
    if (this.db === null) return false
    try {
      const columns = this.db.prepare('PRAGMA table_info(docs_meta)').all() as Array<{ name?: string }>
      if (columns.some(column => column.name === 'format')) return false
      this.db.exec('ALTER TABLE docs_meta ADD COLUMN format TEXT')
      return true
    } catch {
      // An older/foreign database keeps format-less hits.
      return false
    }
  }

  /** Create the additive symbols table; true when it was missing. */
  private ensureSymbolsTables(): boolean {
    if (this.db === null) return false
    try {
      const names = new Set(
        (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('symbols')").all() as Array<{ name?: string }>)
          .map(row => row.name)
          .filter((name): name is string => typeof name === 'string'),
      )
      const created = !names.has('symbols')
      this.db.exec('CREATE TABLE IF NOT EXISTS symbols (path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, language TEXT, scope TEXT)')
      return created
    } catch {
      return false
    }
  }

  /**
   * Create the symbols indexes after a full insert pass (or when an existing
   * database is missing them, e.g. a build interrupted before this step).
   */
  private ensureSymbolIndexes(): void {
    if (this.db === null) return
    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path)')
      this.db.exec('CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name)')
      this.symbolIndexesPending = false
      if (this.symbolsBulk) {
        // Apply the deletions deferred during the fresh insert pass now that
        // symbols_path exists (normally empty; eviction during a full build is
        // the only producer).
        const purge = this.db.prepare('DELETE FROM symbols WHERE path = ?')
        for (const path of this.symbolsBulkPurge) purge.run(path)
        this.symbolsBulkPurge.clear()
        this.symbolsBulk = false
      }
    } catch { /* additive data layer: a failed index only slows lookups */ }
  }

  /**
   * Add the additive session-log columns used by streaming/tail refreshes
   * (sources.byte_len, last_line, title, capped) without bumping the schema
   * version. Rows from an older database keep NULL and are re-read in full.
   */
  private ensureSessionColumns(): void {
    if (this.db === null) return
    try {
      const columns = new Set((this.db.prepare('PRAGMA table_info(sources)').all() as Array<{ name?: string }>)
        .map(column => column.name)
        .filter((name): name is string => typeof name === 'string'))
      const additive: Array<[string, string]> = [
        ['byte_len', 'INTEGER'],
        ['last_line', 'INTEGER'],
        ['title', 'TEXT'],
        ['capped', 'INTEGER'],
      ]
      for (const [name, type] of additive) {
        if (columns.has(name)) continue
        this.db.exec(`ALTER TABLE sources ADD COLUMN ${name} ${type}`)
      }
    } catch { /* an older/foreign database keeps the path/mtime behavior */ }
  }

  /** Open a build transaction; nested calls are ignored. */
  private beginBatch(): void {
    if (this.inBatch || this.db === null) return
    try {
      this.db.exec('BEGIN')
      this.inBatch = true
      this.batchOps = 0
    } catch { this.inBatch = false }
  }

  /** Count one queued write; commit and start a new transaction at the limit. */
  private batchTick(): void {
    if (!this.inBatch) return
    this.batchOps++
    if (this.batchOps < BATCH_OPS) return
    this.commitBatch()
    this.beginBatch()
  }

  /** Commit the open batch (no-op when none is open). */
  private commitBatch(): void {
    if (!this.inBatch || this.db === null) return
    this.inBatch = false
    this.batchOps = 0
    try { this.db.exec('COMMIT') } catch { try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ } }
  }

  /** Roll back an aborted build so no partial transaction survives it. */
  private rollbackBatch(): void {
    if (!this.inBatch) return
    this.inBatch = false
    this.batchOps = 0
    const db = this.db
    if (db === null) return
    try { db.exec('ROLLBACK') } catch { /* the handle may already be closed */ }
  }

  /** Effective symbols stored per file; 0/absent means the 500 default. */
  private symbolsPerFile(): number {
    const configured = this.options.symbolsPerFile
    return configured !== undefined && configured > 0 ? Math.min(2_000, Math.trunc(configured)) : SYMBOLS_PER_FILE
  }

  /** Full-sweep interval for the generation fast path. */
  private fullSweepIntervalMs(): number {
    const configured = this.options.fullSweepIntervalMs
    return configured !== undefined && configured > 0 ? configured : DEFAULT_FULL_SWEEP_INTERVAL_MS
  }

  /** Effective session-log read cap; 0 means unlimited. */
  private sessionMaxBytes(): number {
    const configured = this.options.sessionMaxBytes
    return configured === undefined || configured < 0 ? SESSION_MAX_BYTES : configured
  }

  /** Effective extraction worker deadline. */
  private extractTimeoutMs(): number {
    const configured = this.options.extractTimeoutMs
    return configured !== undefined && configured > 0 ? configured : DOCUMENT_EXTRACT_TIMEOUT_MS
  }

  /** Document extraction is on unless an embedder explicitly opted out. */
  private extractDocumentsEnabled(): boolean {
    return this.options.extractDocuments !== false
  }

  /** Effective document byte cap; 0/absent means the 20 MiB default. */
  private documentMaxBytes(): number {
    const configured = this.options.extractMaxBytes
    return configured !== undefined && configured > 0 ? configured : DOCUMENT_EXTRACT_MAX_BYTES
  }

  /** Symbol indexing is on unless an embedder explicitly opted out. */
  private indexSymbolsEnabled(): boolean {
    return this.options.indexSymbols !== false
  }

  /** Effective symbol source-file byte cap; 0/absent means the 512 KiB default. */
  private symbolMaxBytes(): number {
    const configured = this.options.symbolMaxBytes
    return configured !== undefined && configured > 0 ? configured : SYMBOL_MAX_FILE_BYTES
  }

  /** Symbols for one code file, or undefined when it is not symbol-indexed. */
  private collectFileSymbols(path: string, text: string, byteLength: number): CodeSymbol[] | undefined {
    if (!this.indexSymbolsEnabled() || byteLength > this.symbolMaxBytes()) return undefined
    // Generated/vendored code contributes thousands of low-value rows (cargo
    // registry, protobuf, bundles); never feed it to the symbol table.
    if (isGeneratedSymbolPath(path)) return undefined
    const language = languageForPath(path)
    if (language === null) return undefined
    if (looksGeneratedSource(text, language)) return undefined
    const symbols = extractSymbols(text, language, { maxSymbols: this.symbolsPerFile() })
    return symbols.length === 0 ? undefined : symbols
  }

  /** Whether the compiled extractor worker exists next to this module. */
  private extractWorkerAvailable(): boolean {
    if (process.env.VITEST === 'true') return false
    try { return existsSync(fileURLToPath(new URL('./extract-worker.js', import.meta.url))) } catch { return false }
  }

  /** Extract and store symbols for one file while its text is in hand. */
  private writeFileSymbols(path: string, text: string, byteLength: number): void {
    const symbols = this.collectFileSymbols(path, text, byteLength)
    if (symbols !== undefined) this.writeSymbols(path, symbols)
  }

  /** Replace every stored symbol of one file (additive table; failures ignored). */
  private writeSymbols(path: string, symbols: readonly CodeSymbol[]): void {
    if (this.db === null) return
    try {
      if (!this.symbolsBulk) this.db.prepare('DELETE FROM symbols WHERE path = ?').run(path)
      if (symbols.length === 0) return
      const insert = this.db.prepare('INSERT INTO symbols (path, name, kind, line, language, scope) VALUES (?, ?, ?, ?, ?, ?)')
      for (const symbol of symbols) insert.run(path, symbol.name, symbol.kind, symbol.line, symbol.language, symbol.scope ?? null)
    } catch { /* symbols are additive evidence; never fail a content build for them */ }
  }

  /** Remove every stored symbol of one deleted file. */
  private deleteSymbols(path: string): void {
    if (this.db === null || path === '') return
    if (this.symbolsBulk) { this.symbolsBulkPurge.add(path); return }
    try { this.db.prepare('DELETE FROM symbols WHERE path = ?').run(path) } catch { /* additive table only */ }
  }

  /** Drop every stored symbol after symbol indexing is turned off. */
  private clearSymbols(): void {
    if (this.db === null) return
    try { this.db.exec('DELETE FROM symbols') } catch { /* additive table only */ }
  }

  /**
   * Apply the symbol-index toggle and run the one-time fill when this database
   * predates the additive table (or symbols were off when it was last built).
   * Called on every incremental path, including the branches that end early,
   * so a finish() can never record symbols=1 without the fill having run.
   */
  private async syncSymbols(generation: number): Promise<void> {
    const wantSymbols = this.indexSymbolsEnabled() ? 1 : 0
    const storedSymbols = this.readFlag('symbols') ?? 0
    const wantCap = this.symbolsPerFile()
    const storedCap = this.readFlag('symbols_per_file')
    if (wantSymbols === 1 && storedSymbols !== 1) this.needsSymbolBackfill = true
    // A smaller per-file cap (0.20 slims 2000 rows/file down to 500) or the new
    // generated-code exclusion has to be applied to rows written under the old
    // rules, otherwise an upgraded database keeps most of its symbol weight.
    if (wantSymbols === 1 && storedSymbols === 1 && storedCap !== wantCap) {
      this.clearSymbols()
      this.needsSymbolBackfill = true
    }
    if (wantSymbols === 0 && storedSymbols === 1) {
      this.clearSymbols()
      this.writeFlag('symbols', 0)
    }
    if (!this.needsSymbolBackfill) return
    this.needsSymbolBackfill = false
    await this.backfillSymbols(generation)
  }

  /**
   * One-time fill of the symbol table from the bodies already stored in the
   * database: a database that predates the additive table (or one whose symbol
   * rules changed) never has to walk the disk again. Bodies are paged so a
   * 1 GB corpus is never loaded at once.
   */
  private async backfillSymbols(generation: number): Promise<void> {
    if (this.db === null || !this.indexSymbolsEnabled()) return
    const byteLimit = this.symbolMaxBytes()
    let total = 0
    try {
      total = Number((this.db.prepare("SELECT COUNT(*) AS n FROM docs_meta WHERE kind = 'file'").get() as { n: number }).n)
    } catch { return }
    this.beginPhase('files', total)
    this.beginBatch()
    let after = 0
    for (;;) {
      if (generation !== this.generation) return
      let rows: Array<{ rowid?: number; path?: string; body?: string; chars?: number }>
      try {
        rows = this.db.prepare(`SELECT m.rowid AS rowid, m.path AS path, d.body AS body, length(d.body) AS chars
          FROM docs_meta m JOIN docs d ON d.rowid = m.rowid
          WHERE m.kind = 'file' AND m.rowid > ? ORDER BY m.rowid LIMIT 25`).all(after) as typeof rows
      } catch { return }
      if (rows.length === 0) break
      for (const row of rows) {
        if (generation !== this.generation) return
        const rowid = Number(row.rowid ?? 0)
        if (rowid > after) after = rowid
        const path = row.path
        const body = row.body
        if (typeof path !== 'string' || path === '' || typeof body !== 'string') continue
        this.scanEntry(path)
        if (languageForPath(path) === null) continue
        if (this.options.isIndexable?.(path) === false) continue
        const chars = typeof row.chars === 'number' ? Number(row.chars) : body.length
        if (chars <= 0) continue
        this.writeFileSymbols(path, body, Math.min(chars, byteLimit + 1))
        this.batchTick()
        await this.breathe()
      }
    }
    this.commitBatch()
  }

  /**
   * Every stored spelling one indexed path may have: exactly as given, its
   * canonical real path, and the configured root's raw spelling. The engine
   * indexes files in the spelling of the configured root, which is not always
   * the real path (macOS `/var` → `/private/var`, a Windows short name, an
   * operator-configured symlink), while tools authorize and report canonical
   * paths. Symbols and docs_meta lookups accept any spelling, so a caller can
   * pass either one and databases written before this resolution stay readable.
   */
  private pathSpellings(path: string): string[] {
    const spellings: string[] = []
    const add = (value: string | undefined): void => {
      if (typeof value !== 'string' || value === '') return
      if (!spellings.includes(value)) spellings.push(value)
    }
    add(path)
    const canonical = canonicalFsPath(path)
    add(canonical)
    const rawRoots = (this.rt as { roots?: unknown }).roots
    if (!Array.isArray(rawRoots)) return spellings
    for (const rawRoot of rawRoots) {
      if (typeof rawRoot !== 'string' || rawRoot === '') continue
      const canonicalRoot = canonicalFsPath(rawRoot)
      if (canonicalRoot === canonical) {
        add(rawRoot)
        continue
      }
      if (!pathUnderRoot(canonicalRoot, canonical)) continue
      const suffix = canonical.slice(canonicalRoot.length).replace(/^[\\/]+/, '')
      add(suffix === '' ? rawRoot : join(rawRoot, suffix))
    }
    return spellings
  }

  /** A `column IN (…)` fragment and its values covering every spelling of one path. */
  private pathMatch(column: string, path: string): { sql: string; values: string[] } {
    const spellings = this.pathSpellings(path)
    // An empty path has no spelling; `= NULL` is valid SQL and matches nothing.
    if (spellings.length === 0) return { sql: column + ' = NULL', values: [] }
    return { sql: column + ' IN (' + spellings.map(() => '?').join(', ') + ')', values: spellings }
  }

  /**
   * Indexed document format for one file (pdf, docx, ...); undefined for plain
   * text, unknown paths and databases built before extraction existed.
   */
  docFormat(path: string): string | undefined {
    if (this.db === null || path === '') return undefined
    try {
      const match = this.pathMatch('path', path)
      const row = this.db.prepare('SELECT format FROM docs_meta WHERE ' + match.sql + ' AND format IS NOT NULL LIMIT 1').get(...match.values) as { format?: string | null } | undefined
      return typeof row?.format === 'string' && row.format !== '' ? row.format : undefined
    } catch { return undefined }
  }

  /**
   * Every symbol stored for one path, in line order.
   * @param path - absolute file path as stored by the file index, or any other
   *   spelling of it (canonical real path / configured-root path).
   * @returns symbols for the file; empty when it was not symbol-indexed.
   */
  outline(path: string): CodeSymbol[] {
    if (this.db === null || path === '') return []
    try {
      const match = this.pathMatch('path', path)
      const rows = this.db.prepare('SELECT DISTINCT name, kind, line, language, scope FROM symbols WHERE ' + match.sql + ' ORDER BY line, name').all(...match.values) as SymbolRow[]
      return toSymbols(rows)
    } catch { return [] }
  }

  /**
   * Find symbols by name. Exact matches rank before prefix matches, then
   * substring matches.
   * @param name - symbol name or fragment.
   * @param limit - maximum rows (default 50, at most 200).
   * @returns path/line/kind/name rows across indexed files.
   */
  findSymbols(name: string, limit = 50): SymbolMatch[] {
    if (this.db === null) return []
    const query = name.trim()
    if (query === '') return []
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)))
    try {
      const matches: SymbolMatch[] = []
      const seen = new Set<string>()
      const collect = (rows: Array<SymbolRow & { path?: string }>): void => {
        for (const row of rows) {
          const path = row.path
          if (typeof path !== 'string' || path === '') continue
          const symbol = toSymbols([row])[0]
          if (symbol === undefined) continue
          const key = path + '\u0000' + String(symbol.line) + '\u0000' + symbol.name
          if (seen.has(key)) continue
          seen.add(key)
          matches.push({
            path,
            line: symbol.line,
            kind: symbol.kind,
            name: symbol.name,
            language: symbol.language,
            ...(symbol.scope === undefined ? {} : { scope: symbol.scope }),
          })
          if (matches.length >= bounded) return
        }
      }
      // Exact and prefix matches use the name index: both are O(log n) and
      // cover the common cases (an agent usually names a symbol exactly).
      collect(this.db.prepare('SELECT path, name, kind, line, language, scope FROM symbols WHERE name = ? ORDER BY path, line LIMIT ?')
        .all(query, bounded) as Array<SymbolRow & { path?: string }>)
      if (matches.length < bounded) {
        const upper = query + '\uFFFF'
        collect(this.db.prepare('SELECT path, name, kind, line, language, scope FROM symbols WHERE name > ? AND name < ? ORDER BY name, path, line LIMIT ?')
          .all(query, upper, bounded - matches.length) as Array<SymbolRow & { path?: string }>)
      }
      if (matches.length < bounded) {
        // Substring fallback: a covering scan of the name index returns rowids
        // without touching the wide table, then only the surviving rows are
        // fetched. LIMIT keeps common fragments cheap; a rare fragment still
        // scans the covering index once (no 3.4M-row wide-table scan).
        const escaped = escapeLike(query)
        const candidateLimit = Math.max(bounded * 4, 200)
        const covering = this.db.prepare("SELECT rowid FROM symbols WHERE name LIKE ? ESCAPE '\\' LIMIT ?")
          .all('%' + escaped + '%', candidateLimit) as Array<{ rowid?: number }>
        const rowids: number[] = []
        for (const row of covering) {
          const rowid = Number(row.rowid ?? 0)
          if (rowid > 0) rowids.push(rowid)
        }
        if (rowids.length > 0) {
          const placeholders = rowids.map(() => '?').join(', ')
          const rows = this.db.prepare('SELECT path, name, kind, line, language, scope FROM symbols WHERE rowid IN (' + placeholders + ')')
            .all(...rowids) as Array<SymbolRow & { path?: string }>
          rows.sort((left, right) => {
            const nameOrder = String(left.name ?? '').localeCompare(String(right.name ?? ''))
            if (nameOrder !== 0) return nameOrder
            const pathOrder = String(left.path ?? '').localeCompare(String(right.path ?? ''))
            if (pathOrder !== 0) return pathOrder
            return Number(left.line ?? 0) - Number(right.line ?? 0)
          })
          collect(rows)
        }
      }
      return matches
    } catch { return [] }
  }

  /**
   * Compact repository map for agent context: files ranked by symbol count,
   * cut to a token budget that is estimated as characters / 4. A file is
   * included whole; a file that does not fit is skipped so smaller lower-ranked
   * files can still make it.
   * @param roots - directory prefixes to include; empty means every indexed file.
   * @param tokenBudget - approximate token budget; non-positive returns nothing.
   * @returns included files with their symbols, most structural first.
   */
  repoMap(roots: readonly string[], tokenBudget: number): RepoMapFile[] {
    if (this.db === null) return []
    const budget = Math.trunc(tokenBudget)
    if (!Number.isFinite(budget) || budget <= 0) return []
    // Rank files by symbol count in SQL first (P0-11): the old path loaded the
    // whole 3.4M-row symbols table into JS (peaked near 3 GB and 18 s). The
    // aggregate is an index-only scan and the row fetch is capped, so the
    // repository map stays bounded in both memory and time.
    let counts: Array<{ path: string; n: number }>
    try { counts = this.symbolPathCounts(this.rootSpellings(roots)) } catch { return [] }
    if (counts.length === 0) return []
    counts.sort((left, right) => right.n - left.n || left.path.localeCompare(right.path))
    const candidates = counts.slice(0, REPO_MAP_CANDIDATE_LIMIT)
    const byPath = new Map<string, CodeSymbol[]>()
    let rowsFetched = 0
    let charsRead = 0
    for (let start = 0; start < candidates.length; start += REPO_MAP_FETCH_BATCH) {
      const batch = candidates.slice(start, start + REPO_MAP_FETCH_BATCH)
      if (batch.length === 0) break
      const placeholders = batch.map(() => '?').join(', ')
      let rows: Array<SymbolRow & { path?: string }>
      try {
        rows = this.db.prepare('SELECT path, name, kind, line, language, scope FROM symbols WHERE path IN (' + placeholders + ') ORDER BY path, line')
          .all(...batch.map(candidate => candidate.path)) as Array<SymbolRow & { path?: string }>
      } catch { break }
      for (const row of rows) {
        const path = row.path
        if (typeof path !== 'string' || path === '') continue
        rowsFetched++
        charsRead += path.length + 24
          + (typeof row.name === 'string' ? row.name.length : 0)
          + (typeof row.kind === 'string' ? row.kind.length : 0)
          + (typeof row.scope === 'string' ? row.scope.length : 0)
        if (rowsFetched > REPO_MAP_ROW_LIMIT || charsRead > REPO_MAP_CHAR_LIMIT) break
        const symbol = toSymbols([row])[0]
        if (symbol === undefined) continue
        const symbols = byPath.get(path)
        if (symbols === undefined) byPath.set(path, [symbol])
        else symbols.push(symbol)
      }
      if (rowsFetched > REPO_MAP_ROW_LIMIT || charsRead > REPO_MAP_CHAR_LIMIT) break
    }
    const ranked = [...byPath.entries()].map(([path, symbols]) => ({ path, symbols, tokens: estimateSymbolTokens(path, symbols) }))
    ranked.sort((left, right) => right.symbols.length - left.symbols.length || left.path.localeCompare(right.path))
    const included: RepoMapFile[] = []
    let used = 0
    for (const candidate of ranked) {
      if (used + candidate.tokens > budget) continue
      included.push({ path: candidate.path, symbols: candidate.symbols })
      used += candidate.tokens
    }
    return included
  }

  /**
   * Every stored spelling one requested root may have: exactly as given and its
   * canonical real path (a symlinked temp dir or Windows short name differs).
   */
  private rootSpellings(roots: readonly string[]): string[] {
    const spellings: string[] = []
    const add = (value: string | undefined): void => {
      if (typeof value === 'string' && value !== '' && !spellings.includes(value)) spellings.push(value)
    }
    const rawConfigured = (this.rt as { roots?: unknown }).roots
    const configured = Array.isArray(rawConfigured)
      ? rawConfigured.filter((root): root is string => typeof root === 'string' && root !== '')
      : []
    for (const root of roots) {
      if (typeof root !== 'string' || root === '') continue
      add(root)
      const canonical = canonicalFsPath(root)
      add(canonical)
      // The engine indexes files under the configured-root spelling. When a
      // caller asks by the real path of a symlinked root, add the configured
      // spellings whose real path is that same root.
      for (const configuredRoot of configured) {
        if (canonicalFsPath(configuredRoot) === canonical) add(configuredRoot)
      }
    }
    return spellings
  }

  /**
   * Symbol count per file path, restricted to the requested roots, ranked in
   * SQL and cut to the repo-map candidate limit. Runs as one index-only
   * aggregate per root spelling instead of loading every symbol row.
   */
  private symbolPathCounts(spellings: readonly string[]): Array<{ path: string; n: number }> {
    if (this.db === null) return []
    const counts = new Map<string, number>()
    const record = (row: { path?: string; n?: number }): void => {
      if (typeof row.path !== 'string' || row.path === '') return
      const n = Number(row.n ?? 0)
      if (!Number.isFinite(n) || n <= 0) return
      const previous = counts.get(row.path)
      if (previous === undefined || n > previous) counts.set(row.path, n)
    }
    if (spellings.length === 0) {
      const rows = this.db.prepare('SELECT path, COUNT(*) AS n FROM symbols GROUP BY path ORDER BY n DESC, path ASC LIMIT ?')
        .all(REPO_MAP_CANDIDATE_LIMIT) as Array<{ path?: string; n?: number }>
      for (const row of rows) record(row)
    } else {
      // A path belongs to a root when it is the root itself or starts with the
      // root followed by the platform separator; the second range excludes a
      // sibling directory whose name merely shares the prefix ("/a" vs "/ab").
      const range = this.db.prepare('SELECT path, COUNT(*) AS n FROM symbols WHERE path >= ? AND path < ? GROUP BY path ORDER BY n DESC LIMIT ?')
      const equals = this.db.prepare('SELECT path, COUNT(*) AS n FROM symbols WHERE path = ? GROUP BY path LIMIT ?')
      for (const spelling of spellings) {
        const separator = WINDOWS_PATHS ? '\\' : '/'
        const lower = spelling.endsWith(separator) ? spelling : spelling + separator
        for (const row of range.all(lower, lower + '\uFFFF', REPO_MAP_CANDIDATE_LIMIT) as Array<{ path?: string; n?: number }>) record(row)
        for (const row of equals.all(spelling, 1) as Array<{ path?: string; n?: number }>) record(row)
      }
    }
    return [...counts.entries()].map(([path, n]) => ({ path, n }))
  }

  /**
   * Stored document formats for the given file paths (only extracted
   * documents have one). Unlike hit enrichment this is safe to call before a
   * tool schema declares the field.
   * @param paths - candidate file paths.
   * @returns path to format map; plain text and unknown paths are absent.
   */
  formatsFor(paths: readonly string[]): Map<string, string> {
    const formats = new Map<string, string>()
    if (this.db === null) return formats
    const unique = [...new Set(paths.filter(path => path !== ''))]
    if (unique.length === 0) return formats
    // Query every spelling of each requested path and answer under the caller's
    // own spelling too, so `formatsFor([canonical]).get(canonical)` works even
    // when the row was stored with the configured-root spelling.
    const callerBySpelling = new Map<string, string>()
    const spellings: string[] = []
    for (const path of unique) {
      for (const spelling of this.pathSpellings(path)) {
        if (!spellings.includes(spelling)) spellings.push(spelling)
        if (!callerBySpelling.has(spelling)) callerBySpelling.set(spelling, path)
      }
    }
    try {
      const placeholders = spellings.map(() => '?').join(', ')
      const rows = this.db.prepare('SELECT path, format FROM docs_meta WHERE path IN (' + placeholders + ') AND format IS NOT NULL').all(...spellings) as Array<{ path?: string; format?: string | null }>
      for (const row of rows) {
        if (typeof row.path !== 'string' || row.path === '' || typeof row.format !== 'string' || row.format === '') continue
        formats.set(row.path, row.format)
        const callerPath = callerBySpelling.get(row.path)
        if (callerPath !== undefined) formats.set(callerPath, row.format)
      }
    } catch { /* older databases keep an empty map */ }
    return formats
  }

  /** Attach formats only when the caller opted in (tool schemas must declare it). */
  private enrichHitFormats(result: ContentSearchResult): ContentSearchResult {
    if (this.options.attachHitFormats !== true) return result
    if (this.db === null || result.hits.length === 0) return result
    const formats = this.formatsFor(result.hits.filter(hit => hit.kind === 'file').map(hit => hit.path))
    if (formats.size === 0) return result
    return {
      ...result,
      hits: result.hits.map(hit => {
        if (hit.kind !== 'file') return hit
        const format = formats.get(hit.path)
        return format === undefined ? hit : { ...hit, format }
      }),
    }
  }

  /** The session header's cwd for one indexed session, when known. */
  sessionCwd(sessionId: string): string | undefined {
    return this.sessionCwds.get(sessionId)
  }

  /**
   * Session ids the caller may read: its own session plus sessions whose
   * header cwd equals the caller cwd (the same rule as DSH's
   * `tool-session-query` workspace authorization).
   * @param callerCwd - caller session cwd (immutable header value).
   * @param callerSessionId - caller session id.
   * @returns allowed session ids; empty when the caller has no identity.
   */
  authorizedSessionIds(callerCwd: string | undefined, callerSessionId: string | undefined): Set<string> {
    const allowed = new Set<string>()
    if (callerSessionId !== undefined && callerSessionId !== '') allowed.add(callerSessionId)
    // Ref resolution (locator_resolve/cite) can run before any content search
    // started the lazy build. Open the existing database path map first so the
    // workspace rule does not degrade to "own session only" on a cold start.
    if (this.db === null && this.sessionCwds.size === 0) {
      try { this.open(false) } catch { /* incompatible/foreign DB keeps own-session only */ }
    }
    if (callerCwd === undefined || callerCwd === '') return allowed
    for (const [sessionId, cwd] of this.sessionCwds) {
      if (cwd === callerCwd) allowed.add(sessionId)
    }
    return allowed
  }

  /**
   * The mtime the index stored for one document (file or session message).
   * File paths are matched under every spelling of the path, so a caller that
   * authorized a canonical path still finds a row stored with the
   * configured-root spelling.
   */
  indexedMtime(kind: 'file' | 'session', path: string, messageId?: string): number | undefined {
    if (this.db === null) return undefined
    if (kind === 'session' && (messageId === undefined || messageId === '')) return undefined
    const messageKey = messageId ?? ''
    try {
      let row: { mtime?: number } | undefined
      if (kind === 'file') {
        const match = this.pathMatch('path', path)
        row = this.db.prepare('SELECT mtime FROM docs_meta WHERE kind = ? AND ' + match.sql + ' LIMIT 1').get(kind, ...match.values) as { mtime?: number } | undefined
      } else {
        row = this.db.prepare(`SELECT m.mtime AS mtime FROM docs_meta m JOIN docs d ON d.rowid = m.rowid
            WHERE m.kind = 'session' AND d.session_id = ? AND d.message_id = ? LIMIT 1`).get(basename(dirname(path)), messageKey) as { mtime?: number } | undefined
      }
      return row?.mtime === undefined ? undefined : Number(row.mtime)
    } catch {
      return undefined
    }
  }

  /** The stored (≤8KB) body for one indexed session message. */
  sessionBody(sessionId: string, messageId: string): string | undefined {
    if (this.db === null) return undefined
    try {
      const row = this.db.prepare('SELECT body FROM docs WHERE kind = ? AND session_id = ? AND message_id = ? LIMIT 1').get('session', sessionId, messageId) as { body?: string } | undefined
      return typeof row?.body === 'string' ? row.body : undefined
    } catch {
      return undefined
    }
  }

  /** One stored evidence-ref occurrence. */
  refsForMessage(sessionId: string, messageId: string): StoredRefRow[] {
    if (this.db === null) return []
    try {
      return this.db.prepare(`SELECT ref_key AS refKey, kind, target, sha256, session_id AS sessionId,
          message_id AS messageId, seq, origin, title, bytes, meta, log_mtime AS logMtime, indexed_at AS indexedAt
        FROM refs WHERE session_id = ? AND message_id = ? ORDER BY seq, kind`).all(sessionId, messageId) as unknown as StoredRefRow[]
    } catch { return [] }
  }

  /** All authorized-agnostic occurrences of one ref key (bounded). */
  refsFor(refKey: string, limit = 50): StoredRefRow[] {
    if (this.db === null) return []
    try {
      return this.db.prepare(`SELECT ref_key AS refKey, kind, target, sha256, session_id AS sessionId,
          message_id AS messageId, seq, origin, title, bytes, meta, log_mtime AS logMtime, indexed_at AS indexedAt
        FROM refs WHERE ref_key = ? ORDER BY indexed_at DESC LIMIT ?`).all(refKey, Math.max(1, Math.min(200, limit))) as unknown as StoredRefRow[]
    } catch { return [] }
  }

  /** Occurrence counts for the status tool. */
  refCount(): { refs: number; occurrences: number } {
    if (this.db === null) return { refs: 0, occurrences: 0 }
    try {
      const row = this.db.prepare('SELECT COUNT(DISTINCT ref_key) AS refs, COUNT(*) AS occurrences FROM refs').get() as { refs?: number; occurrences?: number } | undefined
      return { refs: Number(row?.refs ?? 0), occurrences: Number(row?.occurrences ?? 0) }
    } catch { return { refs: 0, occurrences: 0 } }
  }

  /**
   * Distinct evidence refs grouped by kind, for `locator_status`. One GROUP BY
   * keeps the status call cheap; a database without the additive tables reports
   * zeros instead of failing.
   * @returns total distinct refs plus one count per ref kind.
   */
  refsByKind(): RefKindCount {
    if (this.db === null) return { total: 0, byKind: {} }
    try {
      const rows = this.db.prepare('SELECT kind, COUNT(DISTINCT ref_key) AS n FROM refs GROUP BY kind').all() as Array<{ kind?: string; n?: number }>
      const byKind: Record<string, number> = {}
      let total = 0
      for (const row of rows) {
        if (typeof row.kind !== 'string' || row.kind === '') continue
        const count = Number(row.n ?? 0)
        if (!Number.isFinite(count) || count <= 0) continue
        byKind[row.kind] = count
        total += count
      }
      return { total, byKind }
    } catch { return { total: 0, byKind: {} } }
  }

  /**
   * Persist the lazy "missing" marker for one ref across all its occurrences.
   * Only the first miss writes; later resolves read the stored meta instead of
   * re-statting the spill file / attachment store.
   * @param refKey - complete ref string of the missing target.
   * @returns true when this call wrote a new marker, false when it was cached.
   */
  markRefMissing(refKey: string): boolean {
    if (this.db === null || refKey === '') return false
    try {
      const rows = this.db.prepare('SELECT rowid AS rowid, meta AS meta FROM refs WHERE ref_key = ?').all(refKey) as Array<{ rowid: number; meta: string | null }>
      if (rows.length === 0) return false
      const update = this.db.prepare('UPDATE refs SET meta = ? WHERE rowid = ?')
      let marked = false
      for (const row of rows) {
        if (refMetaMissing(row.meta)) continue
        update.run(markRefMeta(row.meta), row.rowid)
        marked = true
      }
      return marked
    } catch { return false }
  }

  /**
   * Merge one JSON patch into every occurrence's refs.meta (bounded, additive).
   * Used by URL-ref freshness (ETag / Last-Modified / body sha256) so a later
   * resolve can issue a conditional request. A patch field overwrites a stale
   * field of the same name; the lazy missing marker is always preserved. A
   * patch that cannot fit the bounded column is skipped for that occurrence
   * instead of being truncated into invalid JSON.
   * @param refKey - complete ref string whose occurrences are updated.
   * @param patch - JSON-safe fields to store (nested objects are allowed).
   * @returns true when at least one occurrence was updated.
   */
  setRefMeta(refKey: string, patch: Record<string, unknown>): boolean {
    if (this.db === null || refKey === '') return false
    const entries = Object.entries(patch)
    if (entries.length === 0) return false
    try {
      const rows = this.db.prepare('SELECT rowid AS rowid, meta AS meta FROM refs WHERE ref_key = ?').all(refKey) as Array<{ rowid: number; meta: string | null }>
      if (rows.length === 0) return false
      const update = this.db.prepare('UPDATE refs SET meta = ? WHERE rowid = ?')
      let written = false
      for (const row of rows) {
        const merged = mergeRefMeta(row.meta, entries)
        if (merged === null) continue
        update.run(merged, row.rowid)
        written = true
      }
      return written
    } catch { return false }
  }

  /**
   * Stored session-event refs for one page of indexed message ids, used by
   * `locator_find` to attach the event seq/ref to session hits.
   * @param sessionId - owning session.
   * @param messageIds - message ids from the current hit page.
   * @returns message id → { seq, ref }; ids without a stored event are absent.
   */
  sessionEventRefs(sessionId: string, messageIds: readonly string[]): Map<string, { seq: number; ref: string }> {
    const out = new Map<string, { seq: number; ref: string }>()
    if (this.db === null || sessionId === '') return out
    const unique = [...new Set(messageIds.filter(id => id !== ''))]
    if (unique.length === 0) return out
    try {
      const placeholders = unique.map(() => '?').join(', ')
      const rows = this.db.prepare(`SELECT message_id AS messageId, ref_key AS refKey, seq AS seq
        FROM refs WHERE session_id = ? AND kind = 'session-event' AND message_id IN (${placeholders})
        ORDER BY seq`).all(sessionId, ...unique) as Array<{ messageId?: string; refKey?: string; seq?: number }>
      for (const row of rows) {
        if (typeof row.messageId !== 'string' || typeof row.refKey !== 'string' || typeof row.seq !== 'number') continue
        if (!out.has(row.messageId)) out.set(row.messageId, { seq: row.seq, ref: row.refKey })
      }
    } catch { /* older/foreign databases keep hits without event refs */ }
    return out
  }

  /**
   * Read one event by sequence from the local session log, for refs resolution.
   * The header is the first physical line, so event `seq` is line `seq + 1`.
   * @param sessionId - session id.
   * @param seq - event sequence.
   * @param maxChars - cap on the returned JSON line.
   * @returns the raw event line, or undefined when the session/log is unavailable.
   */
  async sessionEventBody(sessionId: string, seq: number, maxChars = 16 * 1024): Promise<string | undefined> {
    if (!Number.isInteger(seq) || seq < 0) return undefined
    const path = this.sessionPaths.get(sessionId)
    if (path === undefined) return undefined
    try {
      const size = (await stat(path)).size
      const decoded = await this.openSessionDecode({ path, mtime: 0 }, 0, size, Number.POSITIVE_INFINITY)
      if (decoded === null) return undefined
      let lineIndex = 0
      for await (const line of decoded.lines) {
        // Physical line 0 is the header; event seq N lives on line N + 1.
        if (lineIndex++ === seq + 1) {
          if (line === '') return undefined
          return line.slice(0, Math.max(128, maxChars))
        }
      }
      return undefined
    } catch { return undefined }
  }

  /** The mtime recorded for one session log in `sources`. */
  sessionIndexedMtime(sessionId: string): number | undefined {
    if (this.db === null) return undefined
    try {
      const row = this.db.prepare('SELECT mtime FROM sources WHERE path = ?').get(this.sessionPaths.get(sessionId) ?? '') as { mtime?: number } | undefined
      return row?.mtime === undefined ? undefined : Number(row.mtime)
    } catch {
      return undefined
    }
  }

  sessionRoots(): string[] {
    if (this.options.sessionDirs !== undefined) return this.options.sessionDirs
    return [join(dshHome(), 'sessions')]
  }

  /**
   * Search file bodies and session messages. With `searchWorker` enabled the
   * query itself runs off the host thread.
   *
   * A worker timeout, crash or malformed reply is a hard error result: the
   * same query is never re-run on the host thread, where a heavy query (for
   * example a whole-word scan) would stall the DSH event loop. Only when the
   * worker cannot be created at all does the query run in-process, and that
   * fallback is budgeted (bounded counts).
   *
   * The two-argument form returns the hit array (legacy callers). The
   * three-argument form returns hits plus count, warnings and an error code,
   * and understands the advanced match options.
   * @param query - words or a phrase to find.
   * @param limit - maximum hits.
   * @param options - match mode, case/whole-word flags, session scope, count mode.
   * @returns matching documents ordered by relevance.
   */
  async search(query: string, limit: number): Promise<ContentHit[]>
  async search(query: string, limit: number, options: ContentSearchOptions, searchOptions?: { signal?: AbortSignal }): Promise<ContentSearchResult>
  async search(query: string, limit: number, options?: CoreSearchOptions, searchOptions?: { signal?: AbortSignal }): Promise<ContentHit[] | ContentSearchResult> {
    const signal = searchOptions?.signal ?? options?.signal
    const result = await this.searchDetailed(query, limit, options ?? {}, signal)
    return options === undefined ? result.hits : result
  }

  private async searchDetailed(query: string, limit: number, options: CoreSearchOptions, signal: AbortSignal | undefined): Promise<ContentSearchResult> {
    if (signal?.aborted === true) throw abortError()
    const resolvedOptions = this.resolveSession(options)
    const extraWarnings: string[] = []
    let resolved: CoreSearchOptions
    if (resolvedOptions === null) {
      // The caller's session is not indexed yet (active sessions are indexed
      // only after they settle). `locator_find` workspace scope asks for file
      // hits to keep working in that window instead of returning nothing.
      if (options.sessionUnavailable !== 'files-only') return emptySearchResult(['unknown-session'])
      const fallback: CoreSearchOptions = { ...options, sessionPath: null, excludeSessions: true }
      delete fallback.sessionId
      resolved = fallback
      extraWarnings.push('unknown-session')
    } else {
      resolved = resolvedOptions
    }
    const withWarnings = (result: ContentSearchResult): ContentSearchResult => extraWarnings.length === 0
      ? result
      : { ...result, warnings: [...new Set([...extraWarnings, ...result.warnings])] }
    const includeArchived = options.includeArchived === true || this.options.includeArchived === true
    if (!includeArchived && this.archivedSessions.size > 0) {
      resolved = { ...resolved, excludeArchivedSessions: [...this.archivedSessions] }
    }
    if (this.db === null) return withWarnings(emptySearchResult())
    if (!this.databaseIsCurrent()) {
      this.recoverExternal()
      return withWarnings(emptySearchResult())
    }
    // P0-6: exactly one adaptive-rank policy decision, forwarded to the query
    // layer (worker or in-process); the query layer owns the threshold.
    const effective: CoreSearchOptions = { ...resolved, rankAdaptive: this.options.rankAdaptive !== false }
    const execute = async (): Promise<ContentSearchResult> => withWarnings(this.enrichHitFormats(await this.runSearch(query, limit, effective, signal)))
    const cache = this.ensureSearchCache()
    if (cache === null) return await execute()
    const key = searchCacheKey(query, limit, effective)
    if (signal !== undefined) {
      // A cancellable request must not join a cache flight owned by someone
      // else (or poison the cache with its AbortError rejection).
      const cached = cache.get<ContentSearchResult>(key)
      if (cached !== undefined) return cached
      const result = await execute()
      cache.set(key, result)
      return result
    }
    return await cache.run(key, execute)
  }

  /** Run one query in the worker pool, or in-process when workers are absent. */
  private async runSearch(query: string, limit: number, options: CoreSearchOptions, signal: AbortSignal | undefined): Promise<ContentSearchResult> {
    // Direct embedders run in-process by design (searchWorker is off).
    if (this.options.searchWorker !== true) return this.searchSync(query, limit, options, false, signal)
    const slot = this.acquireWorker()
    if (slot === null) {
      // The worker could not be created at all: the one allowed sync path.
      return this.searchSync(query, limit, options, true, signal)
    }
    return await this.searchOnWorker(slot, query, limit, options, signal)
  }

  /**
   * Run one query on a pooled worker. A timeout terminates that worker; an
   * abort rejects with a DOMException AbortError after asking the worker to
   * stop cooperatively.
   */
  private async searchOnWorker(
    slot: WorkerSlot,
    query: string,
    limit: number,
    options: CoreSearchOptions,
    signal: AbortSignal | undefined,
  ): Promise<ContentSearchResult> {
    const id = ++this.workerSeq
    const timeoutMs = Math.max(1, this.options.searchWorkerTimeoutMs ?? WORKER_TIMEOUT_MS)
    const serializable = workerSearchOptions(options)
    return await new Promise<ContentSearchResult>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const onAbort = (): void => {
        finish(() => {
          this.cancelWorkerRequest(slot, id)
          reject(abortError())
        })
      }
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        slot.pending.delete(id)
        cleanup()
        callback()
      }
      slot.pending.set(id, reply => {
        finish(() => {
          if (reply.ok) resolve(reply.result)
          else resolve(reply.result ?? workerFailureResult(reply.error))
        })
      })
      timer = setTimeout(() => {
        finish(() => {
          // A wedged worker is thrown away; the next query gets a fresh one and
          // the current query is reported as timed out, never re-run here.
          this.dropWorkerSlot(slot, 'content-search-timeout')
          resolve(workerFailureResult('content-search-timeout'))
        })
      }, timeoutMs)
      timer.unref()
      if (signal !== undefined) {
        if (signal.aborted) {
          this.cancelWorkerRequest(slot, id)
          slot.pending.delete(id)
          cleanup()
          reject(abortError())
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      try {
        slot.worker.postMessage({ id, method: 'search', params: { query, limit, options: serializable } })
      } catch {
        finish(() => resolve(workerFailureResult('content-search-worker-failed')))
      }
    })
  }

  /** Lazily create the query cache (content-cache.ts). */
  private ensureSearchCache(): SearchCache | null {
    const size = this.options.queryCacheSize ?? 0
    if (size <= 0) return null
    if (this.searchCache === null) {
      this.searchCache = createSearchCache({
        size: Math.trunc(size),
        ttlMs: this.options.queryCacheTtlMs ?? 60_000,
      })
    }
    return this.searchCache
  }

  /** Map a request's sessionId onto the indexed session log path. */
  private resolveSession(options: ContentSearchOptions): ContentSearchOptions | null {
    if (options.sessionPath !== undefined && options.sessionPath !== null) return options
    if (options.sessionId === undefined || options.sessionId === '') return { ...options, sessionPath: null }
    const path = this.sessionPaths.get(options.sessionId)
    if (path === undefined) return null
    return { ...options, sessionPath: path }
  }

  /**
   * In-process query path. When `degraded` is set (worker creation failed) the
   * options are tightened so this rare path cannot spend an unbounded amount of
   * host-thread time counting matches.
   */
  private searchSync(query: string, limit: number, options: ContentSearchOptions, degraded: boolean, signal: AbortSignal | undefined): ContentSearchResult {
    // Read through a function so control-flow narrowing cannot assume the
    // signal stays un-aborted while the synchronous query runs.
    const isAborted = (): boolean => signal !== undefined && signal.aborted
    if (isAborted()) throw abortError()
    if (this.db === null) return emptySearchResult()
    const effective = degraded ? budgetedSearchOptions(options) : options
    try {
      const result = searchContent(this.db, query, limit, effective)
      // The in-process call cannot be interrupted mid-query; at least never
      // return a result to a caller that already went away.
      if (isAborted()) throw abortError()
      if (!degraded) return result
      return { ...result, warnings: [...new Set(['content-search-in-process', ...result.warnings])] }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      this.state.error = messageOf(error)
      return emptySearchResult()
    }
  }
}

/** DOMException thrown when a caller aborts one content search. */
function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

/** Deterministic cache key for one search: query, limit and normalized options. */
function searchCacheKey(query: string, limit: number, options: ContentSearchOptions): string {
  const entries: Array<[string, unknown]> = []
  const record = options as Record<string, unknown>
  for (const key of Object.keys(record).sort()) {
    if (key === 'signal' || key === 'isCancelled' || key === 'degrade' || key === 'scanBudget') continue
    entries.push([key, record[key]])
  }
  return JSON.stringify([query, limit, entries])
}

/** A structured-cloneable copy of search options (drop hooks/abort handles). */
function workerSearchOptions(options: CoreSearchOptions): ContentSearchOptions {
  const copy: Record<string, unknown> = { ...(options as Record<string, unknown>) }
  delete copy.signal
  delete copy.isCancelled
  delete copy.degrade
  delete copy.scanBudget
  return copy as ContentSearchOptions
}

/** Default deadline for one worker query. */
const WORKER_TIMEOUT_MS = 5_000
/** Counting cap used by the rare in-process fallback. */
const IN_PROCESS_COUNT_LIMIT = 200

/** Tighten a query for the in-process fallback: bounded counting only. */
function budgetedSearchOptions(options: ContentSearchOptions): ContentSearchOptions {
  return {
    ...options,
    count: options.count === 'none' ? 'none' : 'bounded',
    countLimit: Math.min(options.countLimit ?? IN_PROCESS_COUNT_LIMIT, IN_PROCESS_COUNT_LIMIT),
  }
}

/** Whether a value looks like a complete worker search result. */
function isContentSearchResult(value: unknown): value is ContentSearchResult {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.hits) || !Array.isArray(record.warnings)) return false
  const count = record.count
  if (typeof count !== 'object' || count === null) return false
  const kind = (count as { kind?: unknown }).kind
  return kind === 'exact' || kind === 'bounded' || kind === 'unknown'
}

/** Result for a failed worker query; carries an explicit error code. */
function workerFailureResult(error: string): ContentSearchResult {
  return { hits: [], count: { value: 0, kind: 'unknown' }, warnings: [error], error }
}

/** Result used when a content query could not run at all. */
function emptySearchResult(warnings: string[] = []): ContentSearchResult {
  return { hits: [], count: { value: 0, kind: 'unknown' }, warnings }
}

/** Mutable per-log state carried across a streaming (or delta) index pass. */
interface SessionIndexState {
  /** Next physical line ordinal: the header is line 0, events start at 1. */
  nextLine: number
  /** Session title seeded from the first indexed message. */
  title: string
  /** Header cwd seen in this pass (null when only a tail was read). */
  headerCwd: string | null
  /** tool/result call-id → tool name, for a log read in one pass. */
  callNames: Map<string, string>
  /** Existing rows stay; only new messages/refs are appended. */
  append: boolean
}

/** Byte range of one structurally complete Zstandard frame. */
interface ZstdFrameRange {
  start: number
  end: number
}

/** Structural scan of a concatenated Zstandard stream. */
interface ZstdFrameScan {
  frames: ZstdFrameRange[]
  /** Start of an incomplete final frame, when the region ends inside one. */
  tornStart?: number
}

/**
 * Locate complete Zstandard frames without decompressing their blocks. DSH
 * session logs are append-only concatenated frames, so this is what makes a
 * tail refresh possible: only complete frames may be decoded and only their
 * end offset may be persisted.
 */
function scanZstdFrames(buffer: Buffer): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid zstd frame magic')
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error('reserved zstd frame-header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('reserved zstd block type')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** Read one byte range of a file without loading the rest of it. */
async function readFileRegion(path: string, start: number, end: number): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0)
  const handle = await open(path, 'r')
  try {
    const length = end - start
    const buffer = Buffer.allocUnsafe(length)
    let filled = 0
    while (filled < length) {
      const result = await handle.read(buffer, filled, length - filled, start + filled)
      if (result.bytesRead <= 0) break
      filled += result.bytesRead
    }
    return filled === length ? buffer : buffer.subarray(0, filled)
  } finally {
    await handle.close()
  }
}

/** Read one small text file; undefined on any error (non-Linux hosts). */
function readTextFile(path: string): string | undefined {
  try { return readFileSync(path, 'utf8').trim() } catch { return undefined }
}

/** Status of the first battery reported by sysfs, when the host has one. */
function firstBatteryStatus(): string | undefined {
  try {
    const entries = readdirSync('/sys/class/power_supply')
    for (const entry of entries) {
      if (!entry.startsWith('BAT')) continue
      const status = readTextFile('/sys/class/power_supply/' + entry + '/status')
      if (status !== undefined) return status
    }
  } catch { /* no sysfs battery: a desktop or a non-Linux host */ }
  return undefined
}

/** Pressure thresholds above which a background build slows down. */
const LOAD_PER_CPU_BUSY = 0.9
const IO_PRESSURE_BUSY = 30
const CPU_PRESSURE_BUSY = 60

/**
 * Decide whether background content work should throttle. Pure so the policy
 * can be tested without touching /proc or /sys.
 * @param input - sampled loadavg, CPU count, PSI files and battery status.
 * @returns the verdict plus the reason codes that triggered it.
 */
export function adaptivePressure(input: {
  loadavg?: string | undefined
  cpuCount: number
  ioPressure?: string | undefined
  cpuPressure?: string | undefined
  batteryStatus?: string | undefined
}): { busy: boolean; reasons: string[] } {
  const reasons: string[] = []
  const load = Number((input.loadavg ?? '').split(' ')[0] ?? '')
  if (Number.isFinite(load) && input.cpuCount > 0 && load / input.cpuCount >= LOAD_PER_CPU_BUSY) reasons.push('load')
  const io = pressureAvg60(input.ioPressure)
  if (io !== null && io >= IO_PRESSURE_BUSY) reasons.push('io-pressure')
  const cpu = pressureAvg60(input.cpuPressure)
  if (cpu !== null && cpu >= CPU_PRESSURE_BUSY) reasons.push('cpu-pressure')
  if ((input.batteryStatus ?? '').toLowerCase() === 'discharging') reasons.push('battery')
  return { busy: reasons.length > 0, reasons }
}

/** The avg60 percentage from one PSI file, or null when absent/unparseable. */
function pressureAvg60(text: string | undefined): number | null {
  if (text === undefined || text === '') return null
  const match = /(?:^|\n)some\b.*?avg60=([0-9.]+)/.exec(text)
  if (match?.[1] === undefined) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
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

/** Conversation node key format used by the host DOM (`${kind.length}:${kind}${id}`). */
function conversationNodeKey(kind: string, id: string): string {
  return `${kind.length}:${kind}${id}`
}

/** One evidence ref occurrence extracted from a session log event. */
export interface EvidenceRefRow {
  refKey: string
  kind: 'url' | 'session-event' | 'spill' | 'attachment'
  target: string
  sha256: string | null
  sessionId: string
  messageId: string
  seq: number | null
  origin: 'web_search' | 'web_fetch' | 'spill' | 'attachment' | 'session'
  title: string | null
  bytes: number | null
  meta: string | null
}

/** One persisted evidence-ref occurrence as stored in `refs`. */
export interface StoredRefRow {
  refKey: string
  kind: 'url' | 'session-event' | 'spill' | 'attachment'
  target: string
  sha256: string | null
  sessionId: string
  messageId: string
  seq: number | null
  origin: string
  title: string | null
  bytes: number | null
  meta: string | null
  logMtime: number | null
  indexedAt: number
}

/** The normalized URL plus its identity hash. */
function urlIdentity(raw: string): { ref: string; target: string; sha256: string } {
  const ref = urlRef(raw)
  const target = normalizeUrl(raw)
  return { ref, target, sha256: createHash('sha256').update(target).digest('hex') }
}

/** Longest `refs.meta` JSON string this release writes. */
const REF_META_LIMIT = 400

/** Bounded JSON metadata column for one ref. */
function refMeta(value: Record<string, unknown>): string {
  const text = JSON.stringify(value)
  return text.length > REF_META_LIMIT ? `${text.slice(0, REF_META_LIMIT - 3)}...` : text
}

/** Whether a stored ref meta JSON already carries the lazy missing marker. */
function refMetaMissing(meta: string | null): boolean {
  if (meta === null || meta === '') return false
  try {
    const parsed: unknown = JSON.parse(meta)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && (parsed as { missing?: unknown }).missing === true
  } catch {
    return false
  }
}

/**
 * Merge the lazy missing marker into one ref's stored meta JSON. The marker is
 * written first and optional metadata is dropped as needed, so a bounded column
 * never truncates it into unparseable JSON.
 */
function markRefMeta(previous: string | null): string {
  const extras = new Map<string, unknown>()
  if (previous !== null) {
    try {
      const parsed: unknown = JSON.parse(previous)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (key !== 'missing' && key !== 'missingAt') extras.set(key, value)
        }
      }
    } catch { /* only the marker survives */ }
  }
  const entries = [...extras.entries()]
  for (let keep = entries.length; keep >= 0; keep--) {
    const text = JSON.stringify({ missing: true, missingAt: Date.now(), ...Object.fromEntries(entries.slice(0, keep)) })
    if (text.length <= REF_META_LIMIT) return text
  }
  return JSON.stringify({ missing: true, missingAt: Date.now() })
}

/** One raw symbol row as stored in the additive symbols table. */
interface SymbolRow {
  name?: string
  kind?: string
  line?: number
  language?: string
  scope?: string | null
}

/** Map raw symbol rows to CodeSymbol values, dropping malformed rows. */
function toSymbols(rows: readonly SymbolRow[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = []
  for (const row of rows) {
    if (typeof row.name !== 'string' || row.name === '' || typeof row.kind !== 'string' || typeof row.line !== 'number') continue
    const symbol: CodeSymbol = { name: row.name, kind: row.kind as CodeSymbol['kind'], line: row.line, language: typeof row.language === 'string' ? row.language : '' }
    if (typeof row.scope === 'string' && row.scope !== '') symbol.scope = row.scope
    symbols.push(symbol)
  }
  return symbols
}

/** Path stored behind a file document key ("file:<path>"), or null. */
function docKeyPath(key: string): string | null {
  return key.startsWith('file:') ? key.slice(5) : null
}

const WINDOWS_PATHS = process.platform === 'win32'

/**
 * Canonical real path so every comparison uses one spelling: a symlinked
 * temporary directory (`/var` → `/private/var` on macOS), a Windows short
 * name (`RUNNER~1`) or a differently-cased drive path cannot make the same
 * file look like two different files. A missing target (deleted file, dangling
 * symlink) falls back to a lexical `resolve`, which keeps lookups usable
 * without inventing a match.
 */
function canonicalFsPath(path: string): string {
  if (typeof path !== 'string' || path === '') return ''
  try { return realpathSync.native(path) } catch { /* missing target: compare lexically */ }
  try { return resolve(path) } catch { return path }
}

/** Slash-normalized path for comparison; Windows folds case like the filesystem. */
function comparablePath(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed
  const normalized = trimmed === '' ? '/' : trimmed
  return WINDOWS_PATHS ? normalized.toLowerCase() : normalized
}

/** Whether `target` is `root` itself or lives below it (filesystem comparison rules). */
function pathUnderRoot(root: string, target: string): boolean {
  const normalizedRoot = comparablePath(root)
  if (normalizedRoot === '') return false
  const normalizedTarget = comparablePath(target)
  if (normalizedTarget === normalizedRoot) return true
  if (normalizedRoot === '/') return normalizedTarget.startsWith('/')
  return normalizedTarget.startsWith(normalizedRoot + '/')
}

/**
 * Merge a JSON patch into one bounded refs.meta value. The lazy missing marker
 * is always preserved, patch fields rank before older extras when the column
 * limit forces something out, and null means "does not fit; leave the row
 * alone" so the column never holds unparseable truncated JSON.
 */
function mergeRefMeta(previous: string | null, entries: ReadonlyArray<readonly [string, unknown]>): string | null {
  const marker = new Map<string, unknown>()
  const older = new Map<string, unknown>()
  if (previous !== null && previous !== '') {
    try {
      const parsed: unknown = JSON.parse(previous)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (key === 'missing' || key === 'missingAt') marker.set(key, value)
          else older.set(key, value)
        }
      }
    } catch { /* unreadable metadata gives way to the patch */ }
  }
  const patched: Array<readonly [string, unknown]> = []
  for (const [key, value] of entries) {
    if (key === 'missing' || key === 'missingAt') continue
    older.delete(key)
    patched.push([key, value])
  }
  const previousExtras = [...older.entries()]
  for (let keep = previousExtras.length; keep >= 0; keep--) {
    const merged: Record<string, unknown> = {}
    for (const [key, value] of marker) merged[key] = value
    for (const [key, value] of patched) merged[key] = value
    for (const [key, value] of previousExtras.slice(0, keep)) merged[key] = value
    const text = JSON.stringify(merged)
    if (text.length <= REF_META_LIMIT) return text
  }
  return null
}

/**
 * Extract the non-session-event evidence refs carried by one session log event:
 * `web_search`/`web_fetch` URLs (from `data.meta`), spill locators (from the
 * tool-result text notice) and attachment digests (from user message blocks).
 * Session-event refs are added by the caller for events that became documents.
 * @param event - parsed session event line.
 * @param sessionId - owning session.
 * @param messageId - message/call id the occurrence belongs to.
 * @param seq - event sequence (the line ordinal minus the header line).
 * @returns ref rows ready for `refs` (deduplication happens at insert time).
 */
export function extractEvidenceRefs(
  event: { type?: string; data?: Record<string, unknown> },
  sessionId: string,
  messageId: string,
  seq: number,
): EvidenceRefRow[] {
  const out: EvidenceRefRow[] = []
  const data = event.data ?? {}
  if (event.type === 'tool/result') {
    const message = (data.message ?? {}) as Record<string, unknown>
    const meta = (data.meta ?? {}) as Record<string, unknown>
    const sources = Array.isArray(meta.sources) ? meta.sources : []
    for (const source of sources) {
      if (typeof source !== 'object' || source === null) continue
      const record = source as Record<string, unknown>
      if (typeof record.url !== 'string' || record.url === '') continue
      const identity = urlIdentity(record.url)
      out.push({
        refKey: identity.ref, kind: 'url', target: identity.target, sha256: identity.sha256,
        sessionId, messageId, seq: null, origin: 'web_search',
        title: typeof record.title === 'string' ? record.title.slice(0, 200) : null,
        bytes: null,
        meta: refMeta({ snippet: typeof record.snippet === 'string' ? record.snippet.slice(0, 200) : undefined, publishedAt: record.publishedAt }),
      })
    }
    if (typeof meta.url === 'string' && meta.url !== '') {
      const identity = urlIdentity(meta.url)
      out.push({
        refKey: identity.ref, kind: 'url', target: identity.target, sha256: identity.sha256,
        sessionId, messageId, seq: null, origin: 'web_fetch',
        title: typeof meta.title === 'string' ? meta.title.slice(0, 200) : null,
        bytes: null,
        meta: refMeta({ statusCode: meta.statusCode, truncated: meta.truncated }),
      })
    }
    const content = message.content
    if (Array.isArray(content)) {
      const text = content
        .filter((block): block is { type: string; text: string } =>
          typeof block === 'object' && block !== null
            && (block as { type?: unknown }).type === 'text'
            && typeof (block as { text?: unknown }).text === 'string')
        .map(block => block.text)
        .join('\n')
      const locator = /Full formatted result stored at:\s*(\S+?)\.?\s*Use read/.exec(text)?.[1]
      if (locator !== undefined) {
        const bytes = Number(/Omitted (\d+) bytes/.exec(text)?.[1] ?? '')
        out.push({
          refKey: spillRef({ path: locator, sessionId, seq }), kind: 'spill', target: locator, sha256: null,
          sessionId, messageId, seq, origin: 'spill', title: null,
          bytes: Number.isFinite(bytes) ? bytes : null,
          meta: null,
        })
      }
    }
    return out
  }
  if (event.type === 'user/message' && Array.isArray(data.content)) {
    for (const block of data.content) {
      if (typeof block !== 'object' || block === null) continue
      const record = block as Record<string, unknown>
      if (record.type !== 'image' && record.type !== 'file') continue
      const attachment = (record.attachment ?? {}) as Record<string, unknown>
      const id = typeof attachment.attachmentId === 'string' ? attachment.attachmentId : ''
      const match = /^sha256:([0-9a-f]{64})$/.exec(id)
      if (match === null) continue
      const sha256 = match[1]!
      out.push({
        refKey: attachmentRef({ sha256 }), kind: 'attachment', target: sha256, sha256,
        sessionId, messageId, seq: null, origin: 'attachment',
        title: typeof attachment.name === 'string' ? attachment.name.slice(0, 200) : (typeof attachment.mediaType === 'string' ? attachment.mediaType : null),
        bytes: typeof attachment.bytes === 'number' ? attachment.bytes : null,
        meta: refMeta({ mediaType: attachment.mediaType, width: attachment.width, height: attachment.height }),
      })
    }
  }
  return out
}

function messageText(event: { type?: string; data?: Record<string, unknown> }, includeReasoning = false): { text: string; titleText: string; id: string; nodeKey: string | null } | undefined {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return undefined
  const data = event.data ?? {}
  if (event.type === 'user/message') {
    const source = (data.source ?? {}) as Record<string, unknown>
    if (source.kind === 'time-context') return undefined
  }
  const message = (data.message ?? {}) as Record<string, unknown>
  const content = event.type === 'user/message' ? data.content : message.content
  if (!Array.isArray(content)) return undefined
  const blocks = content.filter((block): block is { type: string; text: string } =>
    typeof block === 'object' && block !== null
      && typeof (block as { type?: unknown }).type === 'string'
      && typeof (block as { text?: unknown }).text === 'string')
  const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
  const reasoning = includeReasoning
    ? blocks.filter(block => block.type === 'reasoning' || block.type === 'thinking').map(block => block.text).join('\n').trim()
    : ''
  if (text === '' && reasoning === '') return undefined
  // Final answer first: the 8 KB body cap must not let a long reasoning trace
  // evict the answer itself. Reasoning follows for opt-in search only.
  const body = [text, reasoning].filter(part => part !== '').join('\n')
  const titleText = text !== '' ? text : reasoning
  const id = event.type === 'user/message' ? String(data.id ?? '') : String(message.id ?? '')
  const safeId = id || `seq-${String(data.seq ?? '')}`
  let nodeKey: string | null = null
  if (event.type === 'user/message' && id !== '') {
    nodeKey = conversationNodeKey('input-message', id)
  } else if (event.type === 'assistant/message') {
    const turn = Number(data.turn)
    const step = Number(data.step)
    if (Number.isInteger(turn) && Number.isInteger(step)) nodeKey = conversationNodeKey('assistant-step', `${turn}:${step}`)
  }
  return { text: body, titleText, id: safeId, nodeKey }
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

/**
 * Whether a refresh failed only because the engine started a new scan. The
 * engine dump cursor belongs to one snapshot generation, so a rebuild in flight
 * makes the current refresh unanswerable; the database itself is still valid.
 */
function isEngineRescanError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('engine re-scan started')
}
