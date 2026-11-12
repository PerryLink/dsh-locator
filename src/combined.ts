/**
 * Combined search: one request for the three scopes the Web panel shows by
 * default — content (bodies and sessions), files and directories.
 *
 * The name index and the content index live in different stores, so this module
 * owns the orchestration and the merge rules as pure, injectable functions:
 * scope gating, the lazy-build guard for empty queries, per-group degradation
 * and de-duplication of a path that appears both as a body hit and a name hit.
 * @module dsh-locator/combined
 */

import type { ContentHit, ContentState } from './content.ts'
import type { SearchArgs, SearchHit, SearchResult } from './runtime.ts'

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
  sort: string
  desc: boolean
  scopes: CombinedScopes
}

/** One name-index group: files or directories. */
export interface NameGroup {
  hits: SearchHit[]
  returned: number
  total: number
  truncated: boolean
  /** Rows dropped because the same path already appears in the content group. */
  deduped: number
  tookMs: number
  error?: string
}

/** The content group: body/session hits plus the index state at query time. */
export interface ContentGroup {
  hits: ContentHit[]
  returned: number
  /** True when the group was cut off by its page limit. */
  capped: boolean
  building: boolean
  files: number
  sessions: number
  messages: number
  truncated: boolean
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
  contentSearch?: (query: string, limit: number) => Promise<ContentHit[]>
  contentStatus?: () => ContentState
  ensure?: () => void
  maxResults: number
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
    sort: sortKey(body.sort),
    desc: body.desc === true,
    scopes: readScopes(body),
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
export async function runCombinedSearch(deps: CombinedDeps, request: CombinedRequest): Promise<CombinedResponse> {
  const started = Date.now()
  const { scopes, query } = request
  const contentEnabled = deps.contentSearch !== undefined
  const wantsContent = scopes.content && contentEnabled
  // Two characters are the floor for the content store: one-character queries
  // fall back to an unindexed LIKE scan and are not worth a build or a query.
  const askContent = wantsContent && query.trim().length >= 2

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
  try {
    const result = await deps.search({
      query: request.query,
      limit: request.limit,
      offset: 0,
      sort: request.sort,
      desc: request.desc,
      regex: false,
      caseSensitive: false,
      wholeWord: false,
      filesOnly: files,
      dirsOnly: !files,
    })
    return {
      hits: result.hits,
      returned: result.hits.length,
      total: result.total,
      truncated: result.truncated,
      deduped: 0,
      tookMs: result.tookNs / 1e6,
    }
  } catch (error) {
    return { hits: [], returned: 0, total: 0, truncated: false, deduped: 0, tookMs: Date.now() - started, error: messageOf(error) }
  }
}

/** Query the content store, or report its state without starting a build. */
async function contentGroup(deps: CombinedDeps, request: CombinedRequest, ask: boolean): Promise<ContentGroup> {
  const started = Date.now()
  const empty = (): ContentGroup => {
    const state = deps.contentStatus?.()
    return {
      hits: [],
      returned: 0,
      capped: false,
      building: state?.building ?? false,
      files: state?.files ?? 0,
      sessions: state?.sessions ?? 0,
      messages: state?.messages ?? 0,
      truncated: state?.truncated ?? false,
      tookMs: 0,
    }
  }
  if (!ask || deps.contentSearch === undefined) return empty()
  try {
    deps.ensure?.()
    const hits = await deps.contentSearch(request.query, request.contentLimit)
    const state = deps.contentStatus?.()
    return {
      hits,
      returned: hits.length,
      capped: hits.length >= request.contentLimit,
      building: state?.building ?? false,
      files: state?.files ?? 0,
      sessions: state?.sessions ?? 0,
      messages: state?.messages ?? 0,
      truncated: state?.truncated ?? false,
      tookMs: Date.now() - started,
    }
  } catch (error) {
    return { ...empty(), error: messageOf(error), tookMs: Date.now() - started }
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function sortKey(value: unknown): string {
  return value === 'name' || value === 'path' || value === 'size' || value === 'mtime' || value === 'ext' ? value : 'mtime'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

