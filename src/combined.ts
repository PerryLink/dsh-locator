/**
 * Combined search: one request for the three scopes the Web panel shows by
 * default — content (bodies and sessions), files and directories.
 *
 * The name index and the content index live in different stores, so this module
 * owns the orchestration and the merge rules as pure, injectable functions:
 * scope gating, the lazy-build guard for empty queries, per-group degradation,
 * match-option routing (content vs name engine), page counts and de-duplication
 * of a path that appears both as a body hit and a name hit.
 * @module dsh-locator/combined
 */

import type { ContentHit, ContentProgress, ContentState } from './content.ts'
import { checkContentQuery, decodeExtendedForNames } from './content-search.ts'
import type {
  ContentCount,
  ContentCountMode,
  ContentMatchMode,
  ContentSearchOptions,
  ContentSearchResult,
} from './content-search.ts'
import { encodeSessionRef, fileRef } from './refs.ts'
import type { SearchArgs, SearchHit, SearchResult } from './runtime.ts'

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
}

/** One name-index group: files or directories. */
export interface NameGroup {
  hits: SearchHit[]
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
  hits: ContentHit[]
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
  tookMs: number
}

/** Dependencies required to run a combined search; the HTTP layer supplies them. */
export interface CombinedDeps {
  search(args: SearchArgs): Promise<SearchResult>
  contentSearch?: (query: string, limit: number, options: ContentSearchOptions) => Promise<ContentSearchResult>
  contentStatus?: () => ContentState
  ensure?: () => void
  maxResults: number
  /** Configured roots; a requested root prefix must live under one of them. */
  roots?: string[]
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
export function dedupeNameHits(
  contentHits: readonly ContentHit[],
  nameHits: readonly SearchHit[],
): { hits: SearchHit[], deduped: number } {
  const seen = new Set<string>()
  for (const hit of contentHits) seen.add(hit.path)
  if (seen.size === 0) return { hits: [...nameHits], deduped: 0 }
  const hits: SearchHit[] = []
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
 * @param deps - stores and the lazy-start hook.
 * @param request - normalized request.
 * @returns grouped result in content → files → dirs order.
 */
export async function runCombinedSearch(deps: CombinedDeps, input: CombinedRequest): Promise<CombinedResponse> {
  const started = Date.now()
  const request = input.rootPrefix === null
    ? input
    : { ...input, rootPrefix: authorizedRootPrefix(input.rootPrefix, deps.roots ?? []) }
  const { scopes, query } = request
  const contentEnabled = deps.contentSearch !== undefined
  const wantsContent = scopes.content && contentEnabled
  // Any non-empty query is evaluated against the content store; short or
  // over-limit queries are rejected by the same validator the store uses, so
  // the panel can show `content-query-too-short` without starting a build.
  const askContent = wantsContent && query.trim() !== ''

  const contentPromise = wantsContent ? contentGroup(deps, request, askContent) : Promise.resolve(undefined)
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

  return {
    scopes,
    contentEnabled,
    ...(content === undefined ? {} : { content }),
    ...(dedupedFiles === undefined ? {} : { files: dedupedFiles }),
    ...(dirs === undefined ? {} : { dirs }),
    tookMs: Date.now() - started,
  }
}

/** Page through a directory-shaped name query. */
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
    const hits = selected.map(nameHitRef)
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
    return { ...empty(messageOf(error)), tookMs: Date.now() - started }
  }
}

/** Query the content store, or report its state without starting a build. */
async function contentGroup(deps: CombinedDeps, request: CombinedRequest, ask: boolean): Promise<ContentGroup> {
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
  const check = checkContentQuery(request.query, request.matchMode)
  if (!check.ok) {
    return { ...empty(check.warnings), error: check.error ?? 'content-query-invalid', tookMs: Date.now() - started }
  }
  if (check.terms.length === 0) return empty()
  const options: ContentSearchOptions = {
    matchMode: request.matchMode,
    caseSensitive: request.caseSensitive,
    wholeWord: request.wholeWord,
    count: request.count,
    countLimit: request.countLimit,
    offset: request.contentOffset,
    ...(request.sessionId === null ? {} : { sessionId: request.sessionId }),
    ...(request.rootPrefix === null ? {} : { pathPrefix: request.rootPrefix }),
    ...(request.includeArchived ? { includeArchived: true } : {}),
  }
  try {
    deps.ensure?.()
    const result = await deps.contentSearch(request.query, request.contentLimit, options)
    const state = deps.contentStatus?.()
    const hits = result.hits.map(contentHitRef)
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
      tookMs: Date.now() - started,
      ...(result.error === undefined ? {} : { error: result.error }),
    }
  } catch (error) {
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
