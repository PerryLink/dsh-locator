/**
 * Combined search: one request for the three scopes the Web panel shows by
 * default — content (bodies and sessions), files and directories.
 *
 * The name index and the content index live in different stores, so this module
 * owns the orchestration and the merge rules as pure, injectable functions:
 * scope gating, the lazy-build guard for empty queries, per-group degradation,
 * match-option routing (content vs name engine), page counts and de-duplication
 * of a path that appears both as a body hit and a name hit.
 *
 * 0.20.0 (P0-9) moved evidence enrichment off the synchronous path: hit
 * freshness/permissions/hash are computed with async `stat` calls under a small
 * concurrency limit and a short TTL cache, so a 9p root no longer blocks the
 * host event loop. Hashes are capped per page (default 5, `combinedHashMaxHits`)
 * and skipped on slow/network filesystems. `compact` mode (P1) skips the
 * enrichment entirely and strips the evidence fields for keystroke requests.
 *
 * 0.20.2 adds three bounded paths on top:
 * - `evidenceLimit` (default 10, max 50): only the first N rows of the merged
 *   response (content → files → dirs) keep ref/hash/freshness/permissions, so a
 *   settled page no longer pays one stat per row; counts and truncation are
 *   unchanged.
 * - an empty-query fast path: a browse page returns name rows with refs but no
 *   freshness/hash, skipping ~100 stats for a query that selects everything.
 * - content freshness uses one batched mtime lookup (`contentIndexedMtimes`)
 *   instead of one synchronous SQL query per content hit.
 * @module dsh-locator/combined
 */

import { stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import type { ContentHit, ContentProgress, ContentState } from './content.ts'
import { checkContentQuery, decodeExtendedForNames } from './content-search.ts'
import type {
  ContentCount,
  ContentCountMode,
  ContentMatchMode,
  ContentSearchOptions,
  ContentSearchResult,
} from './content-search.ts'
import { encodeSessionRef, fileRef, freshnessFor, sha256File } from './refs.ts'
import type { RefFreshness, RefPermissions } from './refs.ts'
import type { SearchArgs, SearchHit, SearchResult } from './runtime.ts'
import type { OutputBudget } from './scope.ts'

/** Unicode code-point count (the content store's length unit for query terms). */
function codePoints(text: string): number {
  return Array.from(text).length
}

/**
 * Additive 0.20.2 flags on a content-store result. `shortQueryFallback` is
 * declared by content-search; `scopeFallback` is a plugin-side widening marker
 * (the content layer may also report one), so it is intersected locally to keep
 * this module compiling against either store declaration.
 */
type ContentSearchResultWidened = ContentSearchResult & {
  /** Set when the store had to widen the requested workspace scope. */
  scopeFallback?: string
}

/** Attach the citable ref to one content hit (session URI or path snapshot). */
function contentHitRef<T extends { kind: string; sessionId?: string; path?: string }>(hit: T): T {
  if (hit.kind === 'session' && typeof hit.sessionId === 'string' && hit.sessionId !== '') {
    return { ...hit, ref: encodeSessionRef(hit.sessionId) }
  }
  if (typeof hit.path === 'string' && hit.path !== '') return { ...hit, ref: fileRef({ path: hit.path }) }
  return hit
}

/** Attach the citable ref to one name hit. */
function nameHitRef(hit: SearchHit): SearchHit {
  return hit.dir ? hit : { ...hit, ref: fileRef({ path: hit.path, mtime: hit.mtime, size: hit.size }) }
}

/** One combined hit's additive evidence; every field is absent in compact mode. */
export interface CombinedHitEvidence {
  /** Freshness of the hit's snapshot against the current bytes. */
  freshness?: RefFreshness
  /** The caller may read this hit; visibility mirrors the hit's scope. */
  permissions?: RefPermissions
  /** sha256 of the file bytes when cheap to compute (small name hits). */
  hash?: string
}

/** One content hit enriched with evidence metadata. */
export type CombinedContentHit = ContentHit & { ref?: string } & CombinedHitEvidence

/** One name hit enriched with evidence metadata. */
export type CombinedNameHit = SearchHit & CombinedHitEvidence

/** Only files up to this size get a hash on a name hit (panel evidence detail). */
export const COMBINED_HASH_MAX_BYTES = 64 * 1024

/** Default cap on hashed files per response (config: combinedHashMaxHits). */
export const COMBINED_HASH_MAX_HITS = 5

/** Default parallel stat/hash enrichment limit (config: combinedEnrichConcurrency). */
export const COMBINED_ENRICH_CONCURRENCY = 8

/** Default freshness-cache lifetime; a longer window trades staleness for latency. */
export const COMBINED_ENRICH_CACHE_TTL_MS = 1_500

/** Evidence rows kept per response when the caller does not ask (0.20.2). */
export const COMBINED_EVIDENCE_LIMIT = 10

/** Hard cap for a caller-supplied evidence limit. */
export const COMBINED_EVIDENCE_LIMIT_MAX = 50

/** Optional per-call knobs; the HTTP layer fills them from config. */
export interface CombinedOptions {
  /** Parallel stat/hash enrichment limit (default {@link COMBINED_ENRICH_CONCURRENCY}). */
  enrichConcurrency?: number
  /** Maximum files hashed per response; 0 disables hashes (default {@link COMBINED_HASH_MAX_HITS}). */
  hashMaxHits?: number
  /** Largest file that may be hashed (default {@link COMBINED_HASH_MAX_BYTES}). */
  hashMaxBytes?: number
  /** Enrichment TTL cache lifetime in ms; 0 disables the cache (default 1500). */
  cacheTtlMs?: number
  /** Skip hashing one path (default: slow/network mounts, 9p included). */
  skipHash?: (path: string) => boolean
  /** Character budget for the whole response; 0/undefined keeps it unbudgeted. */
  budgetChars?: number
  /**
   * Allow 2-code-point queries into the content store when it runs the bounded
   * LIKE short-query fallback (config: contentShortQueryFallback, default true).
   */
  shortQueryFallback?: boolean
  /** Abort enrichment/queries when the HTTP client goes away. */
  signal?: AbortSignal
}

/**
 * Compare one hit snapshot (engine mtime/size) with the current stat. A page is
 * a preview, not a resolve, so the check is one stat per hit and never a read.
 * @param snapshot - engine-reported mtime, plus size for files.
 * @param current - current stat, or undefined when the path is gone.
 * @param observedAt - epoch ms of this observation.
 * @returns the additive freshness block.
 */
export function freshnessForHit(
  snapshot: { mtime: number; size?: number },
  current: { mtimeMs: number; size: number } | undefined,
  observedAt: number,
): RefFreshness {
  if (current === undefined) return { state: 'missing', observedAt }
  if (snapshot.size !== undefined && current.size !== snapshot.size) {
    return { state: 'stale', observedAt, mtime: Math.trunc(current.mtimeMs) }
  }
  return freshnessFor(snapshot.mtime, current.mtimeMs, observedAt)
}

/** Whether one runtime value looks like a lowercase sha256 hex digest. */
function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/** Bound one async mapper to a concurrency limit, preserving input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const width = Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 1))
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await run(items[index]!, index)
    }
  }
  const workers: Array<Promise<void>> = []
  for (let i = 0; i < Math.min(width, items.length); i++) workers.push(worker())
  await Promise.all(workers)
  return results
}

/** Filesystem types whose stat/read latency should not sit on the enrichment path. */
const NETWORK_FSTYPES = new Set([
  // WSL 9p/drvfs mounts of Windows drives, SMB/CIFS shares, NFS and network
  // FUSE filesystems: a stat is acceptable, a full read for sha256 is not.
  '9p', 'drvfs', 'cifs', 'smb3', 'smb', 'nfs', 'nfs4', 'afs', 'ceph', 'davfs',
  'glusterfs', 'fuse.sshfs', 'fuse.rclone', 'fuse.9p', 'vboxsf', 'virtiofs',
])

const MOUNT_CACHE_TTL_MS = 60_000
let mountCache: { at: number; prefixes: string[] } | undefined

/** Decode the octal escapes /proc/self/mounts uses for spaces and friends. */
function decodeMountPath(value: string): string {
  return value
    .replace(/\\040/g, ' ')
    .replace(/\\011/g, '\t')
    .replace(/\\012/g, '\n')
    .replace(/\\134/g, '\\')
}

/** Mount points whose filesystem is slow enough to skip hashing (Linux). */
function slowMountPrefixes(): string[] {
  if (mountCache !== undefined && Date.now() - mountCache.at < MOUNT_CACHE_TTL_MS) return mountCache.prefixes
  const prefixes: string[] = []
  if (process.platform === 'linux') {
    try {
      for (const line of readFileSync('/proc/self/mounts', 'utf8').split('\n')) {
        const parts = line.split(' ')
        if (parts.length < 3) continue
        const fstype = parts[2] ?? ''
        if (!NETWORK_FSTYPES.has(fstype)) continue
        const mountPoint = decodeMountPath(parts[1] ?? '').replace(/\/+$/, '')
        if (mountPoint !== '' && mountPoint !== '/') prefixes.push(mountPoint)
      }
    } catch {
      // A container without /proc simply gets no slow-mount hints.
    }
  }
  mountCache = { at: Date.now(), prefixes }
  return prefixes
}

/**
 * Whether hashing this path is likely expensive (9p/CIFS/NFS/sshfs mounts, UNC
 * shares). Freshness still needs one stat; only the byte-reading hash is skipped.
 * @param path - absolute path.
 * @returns true when the path lives on a slow/network filesystem.
 */
export function isSlowFilesystemPath(path: string): boolean {
  if (process.platform === 'win32') return /^\\\\[^\\]+\\/.test(path)
  if (process.platform === 'darwin') return path.startsWith('/Volumes/')
  const normalized = path.replace(/\\/g, '/')
  for (const prefix of slowMountPrefixes()) {
    if (normalized === prefix || normalized.startsWith(prefix + '/')) return true
  }
  return false
}

/** One cached stat snapshot for the freshness cache. */
interface CachedStat {
  at: number
  mtimeMs: number
  size: number
  isFile: boolean
}

const STAT_CACHE = new Map<string, CachedStat>()
const HASH_CACHE = new Map<string, { at: number; hash: string | null }>()
const ENRICH_CACHE_MAX_ENTRIES = 4096

/** Drop every cached enrichment observation (tests and a state-dir switch). */
export function resetCombinedEnrichCache(): void {
  STAT_CACHE.clear()
  HASH_CACHE.clear()
  mountCache = undefined
}

/** Read one cache entry, dropping it when it is older than the TTL. */
function cacheGet<T extends { at: number }>(map: Map<string, T>, key: string, ttlMs: number): T | undefined {
  if (ttlMs <= 0) return undefined
  const entry = map.get(key)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at >= ttlMs) {
    map.delete(key)
    return undefined
  }
  return entry
}

/** Insert one cache entry, keeping the map bounded (oldest insertion first). */
function cacheSet<T extends { at: number }>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value)
  if (map.size <= ENRICH_CACHE_MAX_ENTRIES) return
  for (const oldest of map.keys()) {
    map.delete(oldest)
    if (map.size <= ENRICH_CACHE_MAX_ENTRIES) break
  }
}

/** Current stat behind a short TTL cache; undefined when the path is gone. */
async function cachedStat(path: string, ttlMs: number): Promise<CachedStat | undefined> {
  const cached = cacheGet(STAT_CACHE, path, ttlMs)
  if (cached !== undefined) return cached
  let entry: CachedStat
  try {
    const info = await stat(path)
    entry = { at: Date.now(), mtimeMs: info.mtimeMs, size: info.size, isFile: info.isFile() }
  } catch {
    // Do cache a negative result: a missing page is common while files move.
    entry = { at: Date.now(), mtimeMs: 0, size: -1, isFile: false }
  }
  cacheSet(STAT_CACHE, path, entry)
  return entry
}

/** sha256 of one small file behind a TTL cache keyed by the stat identity. */
async function cachedHash(path: string, mtimeMs: number, size: number, maxBytes: number, ttlMs: number): Promise<string | undefined> {
  const key = path + '\u0000' + String(mtimeMs) + '\u0000' + String(size)
  const cached = cacheGet(HASH_CACHE, key, ttlMs)
  if (cached !== undefined) return cached.hash ?? undefined
  let hash: string | null = null
  if (size <= maxBytes) {
    const computed = await sha256File(path, maxBytes)
    if (computed !== null && isSha256(computed)) hash = computed
  }
  cacheSet(HASH_CACHE, key, { at: Date.now(), hash })
  return hash ?? undefined
}

/** Remove the evidence-rich fields from one hit (compact mode). */
function stripEvidence<T extends Record<string, unknown>>(hit: T): T {
  const { ref, hash, freshness, permissions, ...rest } = hit
  void ref
  void hash
  void freshness
  void permissions
  return rest as T
}

/** Mutable per-response enrichment state shared by the evidence phase. */
interface EnrichState {
  /** Hashes still allowed in this response (config.combinedHashMaxHits). */
  hashBudget: number
  /** One observation timestamp for every hit of the response. */
  observedAt: number
}

/** Enrich one page of name hits with freshness, permissions and an optional hash. */
async function enrichNameHits(hits: readonly SearchHit[], options: ResolvedCombinedOptions, state: EnrichState): Promise<CombinedNameHit[]> {
  return await mapLimit(hits, options.enrichConcurrency, async hit => {
    const permissions: RefPermissions = {
      read: 'allowed',
      visibility: 'roots',
      reason: hit.dir ? 'directory hit from the configured index roots' : 'name hit from the configured index roots',
    }
    const info = await cachedStat(hit.path, options.cacheTtlMs)
    const missing = info === undefined || info.size < 0
    const snapshot = hit.dir ? { mtime: hit.mtime } : { mtime: hit.mtime, size: hit.size }
    const freshness = freshnessForHit(
      snapshot,
      missing ? undefined : { mtimeMs: info.mtimeMs, size: info.size },
      state.observedAt,
    )
    if (hit.dir || missing || !info.isFile) return { ...hit, freshness, permissions }
    let hash: string | undefined
    // The check and the decrement are synchronous, so concurrent workers can
    // never overrun the per-response hash budget.
    if (state.hashBudget > 0 && info.size <= options.hashMaxBytes && !options.skipHash(hit.path)) {
      state.hashBudget -= 1
      hash = await cachedHash(hit.path, info.mtimeMs, info.size, options.hashMaxBytes, options.cacheTtlMs)
    }
    return { ...hit, freshness, permissions, ...(hash === undefined ? {} : { hash }) }
  })
}

/**
 * Enrich one page of content hits with permissions (always) and freshness when
 * the host supplies a content-index snapshot lookup; a hit that already carries
 * a hash (find/content field) passes it through unchanged.
 *
 * 0.20.2 resolves the stored mtime of every file hit with one batched lookup
 * (`contentIndexedMtimes`); only session hits still need one query per message
 * because a session log has one row per message. A store without the batch
 * method (older embedders, tests) keeps the per-hit path.
 */
async function enrichContentHits(
  hits: readonly (ContentHit & { ref?: string })[],
  deps: CombinedDeps,
  options: ResolvedCombinedOptions,
  state: EnrichState,
): Promise<CombinedContentHit[]> {
  const filePaths: string[] = []
  for (const hit of hits) {
    if (hit.kind !== 'session' && typeof hit.path === 'string' && hit.path !== '' && !filePaths.includes(hit.path)) {
      filePaths.push(hit.path)
    }
  }
  let batch: Map<string, number> | undefined
  if (filePaths.length > 0 && deps.contentIndexedMtimes !== undefined) {
    try { batch = deps.contentIndexedMtimes(filePaths) } catch { batch = undefined }
  }
  return await mapLimit(hits, options.enrichConcurrency, async hit => {
    const permissions: RefPermissions = hit.kind === 'session'
      ? { read: 'allowed', visibility: 'session', reason: 'session messages are scoped to the caller workspace' }
      : { read: 'allowed', visibility: 'roots', reason: 'content hit from the configured index roots' }
    let indexedAt: number | undefined
    if (hit.kind !== 'session' && batch !== undefined) indexedAt = batch.get(hit.path)
    else {
      try { indexedAt = deps.contentIndexedMtime?.(hit) } catch { indexedAt = undefined }
    }
    let freshness: RefFreshness = { state: 'unknown', observedAt: state.observedAt }
    if (indexedAt !== undefined) {
      const info = await cachedStat(hit.path, options.cacheTtlMs)
      const missing = info === undefined || info.size < 0
      freshness = missing ? { state: 'missing', observedAt: state.observedAt } : freshnessFor(indexedAt, info.mtimeMs, state.observedAt)
    }
    const existing = (hit as { hash?: unknown }).hash
    return {
      ...hit,
      freshness,
      permissions,
      ...(isSha256(existing) ? { hash: existing } : {}),
    }
  })
}

/**
 * Apply the per-response evidence policy (0.20.2):
 *
 * - compact requests keep the keystroke behavior: every evidence field is
 *   stripped and nothing is stat'ed;
 * - an empty query is a browse page: no stat/hash enrichment at all, but the
 *   cheap evidence refs stay attached;
 * - otherwise only the first `evidenceLimit` rows of the merged response (in
 *   content → files → dirs order) are enriched; later rows keep their wire shape
 *   minus ref/hash/freshness/permissions. Counts, paging and truncation are not
 *   touched.
 * @param response - response whose groups are enriched in place.
 * @param deps - stores used for the content-index mtime lookup.
 * @param options - resolved per-call knobs (compact flag lives on the request).
 * @param request - the normalized request.
 */
async function applyCombinedEvidence(
  response: CombinedResponse,
  deps: CombinedDeps,
  options: ResolvedCombinedOptions,
  request: CombinedRequest,
): Promise<void> {
  const stripAll = request.compact
  const emptyQuery = request.query.trim() === ''
  const rowsKept = stripAll || emptyQuery ? 0 : request.evidenceLimit
  const state: EnrichState = { hashBudget: options.hashMaxHits, observedAt: Date.now() }
  const plain = (hit: unknown): unknown => stripEvidence(hit as Record<string, unknown>)
  let remaining = rowsKept
  if (response.content !== undefined) {
    const group = response.content
    const keep = Math.min(remaining, group.hits.length)
    const enriched = keep > 0
      ? await enrichContentHits(group.hits.slice(0, keep), deps, options, state)
      : []
    remaining -= keep
    if (stripAll) {
      group.hits = group.hits.map(hit => plain(hit) as CombinedContentHit)
    } else if (!emptyQuery) {
      // An empty-query page never paid for evidence; its refs stay (cheap and
      // used by the panel's copy/cite actions).
      group.hits = [...enriched, ...group.hits.slice(keep).map(hit => plain(hit) as CombinedContentHit)]
    }
  }
  for (const group of [response.files, response.dirs]) {
    if (group === undefined) continue
    const keep = Math.min(remaining, group.hits.length)
    const enriched = keep > 0 ? await enrichNameHits(group.hits.slice(0, keep), options, state) : []
    remaining -= keep
    if (stripAll) {
      group.hits = group.hits.map(hit => plain(hit) as CombinedNameHit)
    } else if (!emptyQuery) {
      group.hits = [...enriched, ...group.hits.slice(keep).map(hit => plain(hit) as CombinedNameHit)]
    }
  }
}

/** Strip trailing separators from a root so prefix checks are unambiguous. */
function trimRoot(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

/** True when `path` is the prefix itself or a descendant of it. */
function pathUnderPrefix(path: string, prefix: string): boolean {
  const root = trimRoot(prefix)
  const candidate = trimRoot(path)
  return candidate === root || candidate.startsWith(root + '/') || candidate.startsWith(root + '\\')
}

/**
 * Accept a requested root prefix only when it lives under a configured root;
 * the panel sends one of `status.roots`, but the route is still a trust
 * boundary, so an arbitrary path must not narrow (or fake) the search.
 * @param prefix - requested prefix from the request body.
 * @param roots - configured roots.
 * @returns the trimmed prefix, or null when it is not authorized.
 */
export function authorizedRootPrefix(prefix: string | null, roots: readonly string[]): string | null {
  if (prefix === null || prefix === '') return null
  if (roots.length === 0) return trimRoot(prefix)
  for (const root of roots) if (pathUnderPrefix(prefix, root)) return trimRoot(prefix)
  return null
}

/** Which groups a combined request asked for; every scope is on by default. */
export interface CombinedScopes {
  content: boolean
  files: boolean
  dirs: boolean
}

/** A validated combined request with per-group limits already clamped. */
export interface CombinedRequest {
  query: string
  limit: number
  contentLimit: number
  /** Name-index offsets for load-more. */
  offset: number
  filesOffset: number
  dirsOffset: number
  /** Content-index offset for load-more. */
  contentOffset: number
  sort: string
  desc: boolean
  scopes: CombinedScopes
  /** How the query text is interpreted (`normal` by default). */
  matchMode: ContentMatchMode
  caseSensitive: boolean
  wholeWord: boolean
  /** Restrict the content group to one session (null means every document). */
  sessionId: string | null
  /** Restrict name/content hits to one configured root (panel root picker). */
  rootPrefix: string | null
  /** Include archived sessions in the content group (panel checkbox). */
  includeArchived: boolean
  /** How much counting work the groups may spend. */
  count: ContentCountMode
  countLimit: number
  /** Keystroke mode: skip evidence enrichment and strip ref/hash/freshness/permissions. */
  compact: boolean
  /** Rows whose evidence survives in a full response (default 10, max 50; 0 strips all). */
  evidenceLimit: number
}

/** One name-index group: files or directories. */
export interface NameGroup {
  /** Hits carry additive freshness/permissions/hash evidence fields (absent in compact). */
  hits: CombinedNameHit[]
  returned: number
  total: number
  truncated: boolean
  /** Rows dropped because the same path already appears in the content group. */
  deduped: number
  /** The name engine always returns an exact total. */
  count: ContentCount
  tookMs: number
  warnings?: string[]
  error?: string
}

/** The content group: body/session hits plus the index state at query time. */
export interface ContentGroup {
  /** Hits carry additive freshness/permissions evidence fields (absent in compact). */
  hits: CombinedContentHit[]
  returned: number
  /** True when the group was cut off by its page limit. */
  capped: boolean
  /** Exact or bounded match count; `unknown` when counting was skipped. */
  count: ContentCount
  warnings: string[]
  building: boolean
  files: number
  sessions: number
  messages: number
  truncated: boolean
  /** Live build progress while `building`; the panel shows the counters. */
  progress?: ContentProgress
  /** True when this page came from the bounded 2-character LIKE fallback (0.20.2). */
  shortQueryFallback?: boolean
  /** Set when the store had to widen a workspace scope (e.g. to all roots). */
  scopeFallback?: string
  /** Wall-clock time of the content lookup; 0 when it was skipped. */
  tookMs: number
  error?: string
}

/** Everything the panel needs from one combined search. */
export interface CombinedResponse {
  scopes: CombinedScopes
  /** False when the plugin runs with `contentIndex: false`. */
  contentEnabled: boolean
  content?: ContentGroup
  files?: NameGroup
  dirs?: NameGroup
  /** True when the response was produced in compact (evidence-free) mode. */
  compact?: boolean
  /** Character-budget report; present only when `budgetChars > 0`. */
  budget?: OutputBudget
  tookMs: number
}

/** Dependencies required to run a combined search; the HTTP layer supplies them. */
export interface CombinedDeps {
  search(args: SearchArgs): Promise<SearchResult>
  contentSearch?: (query: string, limit: number, options: ContentSearchOptions) => Promise<ContentSearchResult>
  contentStatus?: () => ContentState
  /**
   * Optional batched look-up of the content-index snapshot mtime for the file
   * paths of one page (0.20.2). One chunked `WHERE path IN (...)` replaces the
   * per-hit synchronous SQL; session hits still resolve through
   * {@link contentIndexedMtime} because a session log has one row per message.
   */
  contentIndexedMtimes?: (paths: readonly string[]) => Map<string, number>
  /**
   * Optional look-up of the content-index snapshot mtime for one hit. Supplying
   * it turns content-hit freshness from "unknown" into fresh/stale/missing; the
   * panel keeps working without it.
   */
  contentIndexedMtime?: (hit: ContentHit) => number | undefined
  ensure?: () => void
  maxResults: number
  /** Configured roots; a requested root prefix must live under one of them. */
  roots?: string[]
}

/** A {@link CombinedOptions} with every default resolved. */
interface ResolvedCombinedOptions {
  enrichConcurrency: number
  hashMaxHits: number
  hashMaxBytes: number
  cacheTtlMs: number
  skipHash: (path: string) => boolean
  budgetChars: number
  shortQueryFallback: boolean
  signal?: AbortSignal
}

/** Resolve the per-call knobs once per request. */
function resolveOptions(options: CombinedOptions): ResolvedCombinedOptions {
  const positiveInt = (value: number | undefined, fallback: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.max(0, Math.trunc(value))
  }
  return {
    enrichConcurrency: Math.max(1, positiveInt(options.enrichConcurrency, COMBINED_ENRICH_CONCURRENCY)),
    hashMaxHits: positiveInt(options.hashMaxHits, COMBINED_HASH_MAX_HITS),
    hashMaxBytes: positiveInt(options.hashMaxBytes, COMBINED_HASH_MAX_BYTES) || COMBINED_HASH_MAX_BYTES,
    cacheTtlMs: positiveInt(options.cacheTtlMs, COMBINED_ENRICH_CACHE_TTL_MS),
    skipHash: options.skipHash ?? isSlowFilesystemPath,
    budgetChars: positiveInt(options.budgetChars, 0),
    shortQueryFallback: options.shortQueryFallback !== false,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
}

/** Whether one error is the abort rejection of a cancelled store query. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ABORT_ERR'
}

/**
 * Read the three scope flags from a request body. Anything that is not an
 * explicit `false` counts as enabled, so a panel that only sends `{ content:
 * true }` still gets the name groups.
 * @param body - parsed request body.
 * @returns normalized scopes.
 */
export function readScopes(body: Record<string, unknown>): CombinedScopes {
  return {
    content: body.content !== false,
    files: body.files !== false,
    dirs: body.dirs !== false,
  }
}

/** Accept the compact spellings the panel/plan use: true, 1 and "1". */
function compactFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

/**
 * Validate and clamp a combined request body. The two pages have separate
 * limits: content hits are heavier (bodies/snippets) than name rows.
 * @param body - parsed request body.
 * @param maxResults - the plugin's hard per-page cap.
 * @returns a normalized request.
 */
export function readCombinedRequest(body: Record<string, unknown>, maxResults: number): CombinedRequest {
  const nameLimit = clamp(body.limit, 1, Math.max(1, maxResults), 50)
  const contentLimit = clamp(body.contentLimit, 1, 100, 30)
  return {
    query: typeof body.query === 'string' ? body.query : '',
    limit: nameLimit,
    contentLimit,
    offset: clamp(body.offset, 0, 1_000_000, 0),
    filesOffset: clamp(body.filesOffset ?? body.offset, 0, 1_000_000, 0),
    dirsOffset: clamp(body.dirsOffset ?? body.offset, 0, 1_000_000, 0),
    contentOffset: clamp(body.contentOffset, 0, 1_000_000, 0),
    sort: sortKey(body.sort),
    desc: body.desc === true,
    scopes: readScopes(body),
    matchMode: matchMode(body.matchMode),
    caseSensitive: body.caseSensitive === true,
    wholeWord: body.wholeWord === true,
    sessionId: typeof body.sessionId === 'string' && body.sessionId.trim() !== '' ? body.sessionId : null,
    rootPrefix: typeof body.root === 'string' && body.root.trim() !== '' ? body.root.trim() : null,
    includeArchived: body.includeArchived === true,
    count: countMode(body.count),
    countLimit: clamp(body.countLimit, 1, 5000, 1000),
    compact: compactFlag(body.compact),
    evidenceLimit: clamp(body.evidenceLimit, 0, COMBINED_EVIDENCE_LIMIT_MAX, COMBINED_EVIDENCE_LIMIT),
  }
}

/**
 * Drop name hits whose path is already present in the content group. Content
 * rows carry the snippet and the jump target, so one row per path is enough;
 * directories are never dropped.
 * @param contentHits - body/session hits from the content index.
 * @param nameHits - hits from the name index.
 * @returns the kept hits and how many were dropped.
 */
export function dedupeNameHits<T extends SearchHit>(
  contentHits: readonly ContentHit[],
  nameHits: readonly T[],
): { hits: T[], deduped: number } {
  const seen = new Set<string>()
  for (const hit of contentHits) seen.add(hit.path)
  if (seen.size === 0) return { hits: [...nameHits], deduped: 0 }
  const hits: T[] = []
  let deduped = 0
  for (const hit of nameHits) {
    if (!hit.dir && seen.has(hit.path)) {
      deduped++
      continue
    }
    hits.push(hit)
  }
  return { hits, deduped }
}

/**
 * Run one combined search. Empty queries never touch the content index: the
 * panel opens with an empty box, and a lazy content build there would cost
 * minutes and gigabytes for no results. Failures are contained per group so a
 * broken content cache still shows name results.
 *
 * Stores run concurrently and return raw hits; the evidence phase then enriches
 * only the rows the caller asked for (see {@link applyCombinedEvidence}), and
 * the character budget trims the tail last.
 * @param deps - stores and the lazy-start hook.
 * @param input - normalized request.
 * @param options - per-call enrichment/budget knobs (config-backed).
 * @returns grouped result in content → files → dirs order.
 */
export async function runCombinedSearch(
  deps: CombinedDeps,
  input: CombinedRequest,
  options: CombinedOptions = {},
): Promise<CombinedResponse> {
  const started = Date.now()
  const resolved = resolveOptions(options)
  const request = input.rootPrefix === null
    ? input
    : { ...input, rootPrefix: authorizedRootPrefix(input.rootPrefix, deps.roots ?? []) }
  const { scopes, query } = request
  const contentEnabled = deps.contentSearch !== undefined
  const wantsContent = scopes.content && contentEnabled
  // Empty queries are a browse page: the name groups still answer, but the
  // content store is never asked (and never started) for them.
  const askContent = wantsContent && query.trim() !== ''

  const contentPromise = wantsContent ? contentGroup(deps, request, askContent, resolved) : Promise.resolve(undefined)
  const filesPromise = scopes.files ? nameGroup(deps, request, true) : Promise.resolve(undefined)
  const dirsPromise = scopes.dirs ? nameGroup(deps, request, false) : Promise.resolve(undefined)
  const [content, files, dirs] = await Promise.all([contentPromise, filesPromise, dirsPromise])

  const dedupedFiles = files === undefined
    ? undefined
    : (() => {
        const result = dedupeNameHits(content?.hits ?? [], files.hits)
        return {
          ...files,
          hits: result.hits,
          returned: result.hits.length,
          deduped: result.deduped,
          truncated: files.truncated || result.deduped > 0,
        }
      })()

  const response: CombinedResponse = {
    scopes,
    contentEnabled,
    ...(content === undefined ? {} : { content }),
    ...(dedupedFiles === undefined ? {} : { files: dedupedFiles }),
    ...(dirs === undefined ? {} : { dirs }),
    ...(request.compact ? { compact: true } : {}),
    tookMs: Date.now() - started,
  }
  await applyCombinedEvidence(response, deps, resolved, request)
  response.tookMs = Date.now() - started
  if (resolved.budgetChars > 0) applyCombinedBudget(response, resolved.budgetChars)
  return response
}

/**
 * Fit a combined response inside a character budget by dropping the tail of the
 * lowest-priority groups first: dirs, then files, then content hits. Structural
 * fields (counts, state, warnings) are always kept; each trimmed group reports
 * `returned`/`truncated` and the response carries a {@link OutputBudget} block.
 * @param response - response to trim in place.
 * @param limitChars - soft cap on the serialized response size.
 */
export function applyCombinedBudget(response: CombinedResponse, limitChars: number): void {
  const budget: OutputBudget = { limitChars, usedChars: 0, truncated: false, dropped: 0 }
  response.budget = budget
  const measure = (): number => JSON.stringify(response).length
  const sizeOf = (hit: unknown): number => JSON.stringify(hit).length + 1
  const groups: Array<ContentGroup | NameGroup> = []
  if (response.dirs !== undefined) groups.push(response.dirs)
  if (response.files !== undefined) groups.push(response.files)
  if (response.content !== undefined) groups.push(response.content)
  // Cheap estimate first: base (no hits) plus an approximate per-hit cost.
  let estimate = measure()
  for (const group of groups) {
    for (const hit of group.hits) estimate += sizeOf(hit)
    estimate -= JSON.stringify(group.hits).length
  }
  for (const group of groups) {
    if (group.hits.length === 0) continue
    const hits = group.hits as unknown[]
    while (hits.length > 0 && estimate > limitChars) {
      const removed = hits.pop() as unknown
      estimate -= sizeOf(removed)
      budget.dropped += 1
      group.returned = hits.length
      group.truncated = true
    }
    if (measure() <= limitChars) break
  }
  // The estimate ignores commas; if the real payload is still too big, trim by
  // measuring (the page is bounded, so this loop is short).
  for (const group of groups) {
    while (group.hits.length > 0 && measure() > limitChars) {
      group.hits.pop()
      budget.dropped += 1
      group.returned = group.hits.length
      group.truncated = true
    }
    if (measure() <= limitChars) break
  }
  const size = measure()
  budget.usedChars = size
  budget.truncated = budget.dropped > 0 || size > limitChars
}

/**
 * Page through a directory-shaped name query. Hits come back raw (with the
 * cheap evidence ref attached); freshness/permissions/hash are attached later
 * by {@link applyCombinedEvidence} for the rows that fit the evidence budget.
 */
async function nameGroup(deps: CombinedDeps, request: CombinedRequest, files: boolean): Promise<NameGroup> {
  const started = Date.now()
  const empty = (error?: string, warnings?: string[]): NameGroup => ({
    hits: [],
    returned: 0,
    total: 0,
    truncated: false,
    deduped: 0,
    count: { value: 0, kind: 'exact' },
    tookMs: Date.now() - started,
    ...(warnings === undefined || warnings.length === 0 ? {} : { warnings }),
    ...(error === undefined ? {} : { error }),
  })
  // The name engine understands everything except Notepad++-style escapes:
  // decode them here and drop control characters (file names cannot contain
  // them) instead of searching for a literal backslash sequence.
  let nameQuery = request.query
  let warnings: string[] = []
  if (request.matchMode === 'extended') {
    const decoded = decodeExtendedForNames(request.query)
    warnings = decoded.warnings
    if (!decoded.ok) return empty(decoded.error ?? 'invalid-escape', warnings)
    nameQuery = decoded.text
    // An all-control-escape query must not degrade into "match everything".
    if (nameQuery.trim() === '') return empty(undefined, [...new Set([...warnings, 'name-extended-empty'])])
  }
  try {
    const result = await deps.search({
      query: nameQuery,
      limit: request.limit,
      offset: files ? request.filesOffset : request.dirsOffset,
      sort: request.sort,
      desc: request.desc,
      regex: request.matchMode === 'regex',
      caseSensitive: request.caseSensitive,
      wholeWord: request.wholeWord,
      filesOnly: files,
      dirsOnly: !files,
    })
    const prefix = request.rootPrefix
    const selected = prefix === null ? result.hits : result.hits.filter(hit => pathUnderPrefix(hit.path, prefix))
    const hits: CombinedNameHit[] = selected.map(nameHitRef)
    const narrowed = prefix !== null && hits.length !== result.hits.length
    return {
      hits,
      returned: hits.length,
      total: prefix === null ? result.total : hits.length,
      truncated: result.truncated || narrowed,
      deduped: 0,
      // The engine total covers every root; a narrowed page cannot claim an exact
      // total for the selected root, so the count becomes "unknown" (the UI shows
      // the returned rows).
      count: prefix === null ? { value: result.total, kind: 'exact' } : { value: hits.length, kind: 'unknown' },
      tookMs: result.tookNs / 1e6,
      ...(warnings.length === 0 ? {} : { warnings: [...new Set(warnings)] }),
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    return { ...empty(messageOf(error)), tookMs: Date.now() - started }
  }
}

/** Query the content store, or report its state without starting a build. */
async function contentGroup(
  deps: CombinedDeps,
  request: CombinedRequest,
  ask: boolean,
  options: ResolvedCombinedOptions,
): Promise<ContentGroup> {
  const started = Date.now()
  const empty = (warnings: string[] = []): ContentGroup => {
    let state: ContentState | undefined
    try { state = deps.contentStatus?.() } catch { state = undefined }
    return {
      hits: [],
      returned: 0,
      capped: false,
      count: { value: 0, kind: 'unknown' },
      warnings,
      building: state?.building ?? false,
      files: state?.files ?? 0,
      sessions: state?.sessions ?? 0,
      messages: state?.messages ?? 0,
      truncated: state?.truncated ?? false,
      ...(state?.progress === undefined ? {} : { progress: state.progress }),
      tookMs: 0,
    }
  }
  // 0.9.0 never scans the whole corpus from a panel keystroke: the content
  // group pauses itself in regex mode while the name groups still run.
  if (request.matchMode === 'regex') {
    return { ...empty(['content-regex-paused']), error: 'content-regex-not-supported' }
  }
  if (!ask || deps.contentSearch === undefined) return empty()
  // Reject sub-trigram / over-limit / control-character queries here, before
  // deps.ensure() can start a lazy content build the store cannot answer. The
  // store performs the same check; sharing it keeps the error codes identical.
  // 0.20.2: a 2-code-point query is only gated by the pre-check itself when the
  // bounded short-query fallback is off; otherwise the store decides (and
  // reports `shortQueryFallback` on the result).
  const check = checkContentQuery(
    request.query,
    request.matchMode,
    options.shortQueryFallback ? { allowShort: true } : undefined,
  )
  if (!check.ok) {
    // Only a whole 2-code-point query may reach the bounded fallback; a longer
    // query that merely contains a short term stays a hard error.
    const shortEligible = options.shortQueryFallback
      && check.error === 'content-query-too-short'
      && codePoints(request.query.trim()) === 2
    if (!shortEligible) {
      return { ...empty(check.warnings), error: check.error ?? 'content-query-invalid', tookMs: Date.now() - started }
    }
  }
  if (check.ok && check.terms.length === 0 && check.short !== true) return empty()
  const options_: ContentSearchOptions = {
    matchMode: request.matchMode,
    caseSensitive: request.caseSensitive,
    wholeWord: request.wholeWord,
    count: request.count,
    countLimit: request.countLimit,
    offset: request.contentOffset,
    // Explicit per-query opt-in: the plugin sets contentShortQueryFallback from
    // config and the store must not re-reject the 2-code-point query the
    // pre-check above already admitted.
    ...(options.shortQueryFallback ? { shortQueryFallback: true } : {}),
    ...(request.sessionId === null ? {} : { sessionId: request.sessionId }),
    ...(request.rootPrefix === null ? {} : { pathPrefix: request.rootPrefix }),
    ...(request.includeArchived ? { includeArchived: true } : {}),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  try {
    deps.ensure?.()
    const queryStarted = Date.now()
    const result = await deps.contentSearch(request.query, request.contentLimit, options_) as ContentSearchResultWidened
    // tookMs is the store's own query cost, matching the name group's
    // engine-reported tookMs; enrichment is reported by the group's latency only.
    const queryTookMs = Date.now() - queryStarted
    const state = deps.contentStatus?.()
    // Raw hits carry only the cheap evidence ref; the response-level evidence
    // phase enriches the first N rows (ref/hash/freshness/permissions).
    const hits: CombinedContentHit[] = result.hits.map(contentHitRef)
    return {
      hits,
      returned: hits.length,
      capped: hits.length >= request.contentLimit,
      count: result.count,
      warnings: result.warnings,
      building: state?.building ?? false,
      files: state?.files ?? 0,
      sessions: state?.sessions ?? 0,
      messages: state?.messages ?? 0,
      truncated: state?.truncated ?? false,
      ...(state?.progress === undefined ? {} : { progress: state.progress }),
      tookMs: queryTookMs,
      ...(result.shortQueryFallback === true ? { shortQueryFallback: true } : {}),
      ...(result.scopeFallback === undefined ? {} : { scopeFallback: result.scopeFallback }),
      ...(result.error === undefined ? {} : { error: result.error }),
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    return { ...empty(), error: messageOf(error), tookMs: Date.now() - started }
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function matchMode(value: unknown): ContentMatchMode {
  return value === 'extended' || value === 'regex' ? value : 'normal'
}

function countMode(value: unknown): ContentCountMode {
  return value === 'bounded' || value === 'none' ? value : 'exact'
}

function sortKey(value: unknown): string {
  return value === 'name' || value === 'path' || value === 'size' || value === 'mtime' || value === 'ext' ? value : 'mtime'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
