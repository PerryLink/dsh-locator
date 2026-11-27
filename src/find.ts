/**
 * locator_find — search file bodies and DSH session messages.
 * @module dsh-locator/find
 */

import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentHit, ContentIndex, ContentState } from './content.ts'
import type { ContentCount, ContentSearchOptions } from './content-search.ts'
import { encodeSessionRef, fileRef, freshnessFor, sha256File, type RefFreshness, type RefPermissions, type RefProvenance } from './refs.ts'
import { withinRoots } from './reveal.ts'
import type { LocatorRuntime } from './runtime.ts'
import {
  applyOutputBudget,
  DEFAULT_OUTPUT_BUDGET_CHARS,
  ERROR_INFO_SCHEMA,
  errorInfoOf,
  evidenceLimitOf,
  evidenceVisible,
  fetchNamePage,
  outputBudgetOf,
  pageAdvance,
  pageSize,
  rerankHits,
  selectPage,
  TRUNCATION_SCHEMA,
  WARNING_HINTS_SCHEMA,
  warningHintsOf,
  type HitDetail,
  type Scope,
} from './scope.ts'
import { isSlowFilesystemPath } from './combined.ts'

const HIT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['file', 'session', 'dir'], required: true },
    path: { type: 'string', required: true },
    name: { type: 'string', description: 'Base name for name-index hits (mode names).' },
    title: { type: 'string' },
    snippet: { type: 'string' },
    sessionId: { type: 'string' },
    messageId: { type: 'string' },
    nodeKey: { type: 'string' },
    line: { type: 'integer', description: '1-based line of the first match in the stored body (file hits).' },
    score: { type: 'number' },
    size: { type: 'integer', description: 'File size in bytes when known (name hits).' },
    mtime: { type: 'integer', description: 'Modification time in Unix milliseconds when known (name hits).' },
    dir: { type: 'boolean', description: 'True for a directory hit (name mode).' },
    context: { type: 'array', items: { type: 'string' }, description: 'Lines around the hit line, when contextLines > 0.' },
    contextStart: { type: 'integer', description: '1-based line number of context[0].' },
    format: { type: 'string', description: 'Extracted document format (pdf, docx, xlsx, pptx, epub) for file hits whose body came from a document.' },
    ref: { type: 'string', description: 'Citable evidence reference: dsh-session: URI for session hits, ref://file for file hits.' },
    seq: { type: 'integer', description: 'Session event sequence of this message when the content index stored a session-event ref for it.' },
    eventRef: { type: 'string', description: 'Full ref://session-event?sid=...&seq=N evidence reference for the indexed event, when one was stored.' },
    hash: { type: 'string', description: 'sha256 of the file bytes when cheap to compute (files up to 2 MiB).' },
    refStatus: {
      type: 'string',
      enum: ['fresh', 'stale', 'missing', 'unknown'],
      description: 'Short freshness label for the evidence ref (same value as freshness.state).',
    },
    provenance: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string', enum: ['index', 'tool', 'session', 'web'] },
        path: { type: 'string' },
        sessionId: { type: 'string' },
        messageId: { type: 'string' },
        indexedAt: { type: 'integer' },
      },
    },
    freshness: {
      type: 'object',
      additionalProperties: false,
      properties: {
        state: { type: 'string', enum: ['fresh', 'stale', 'missing', 'unknown'] },
        observedAt: { type: 'integer' },
        mtime: { type: 'integer' },
      },
    },
    permissions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        read: { type: 'string', enum: ['allowed', 'denied'] },
        visibility: { type: 'string', enum: ['workspace', 'roots', 'session', 'external'] },
        reason: { type: 'string' },
      },
    },
  },
} as const

/** The additive locator_find hit schema, shared with locator_search mode content. */
export const CONTENT_HIT_SCHEMA = HIT

/** The additive per-result budget block (see scope.ts applyOutputBudget). */
export const BUDGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limitChars: { type: 'integer', description: 'Configured soft cap in characters (0 = disabled).' },
    usedChars: { type: 'integer', description: 'Characters of the JSON payload actually returned.' },
    truncated: { type: 'boolean', description: 'True when at least one hit was dropped to satisfy the cap.' },
    dropped: { type: 'integer', description: 'Hits dropped by the budget.' },
  },
} as const

/**
 * Content-index state shared by the locator_find and locator_status output
 * schemas. Keep it in sync with ContentState: the host validates every tool
 * result against the declared schema and rejects undeclared fields, so a state
 * field missing here makes the whole tool call fail as "invalid output".
 */
export const CONTENT_STATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    building: { type: 'boolean' },
    files: { type: 'integer' },
    sessions: { type: 'integer' },
    messages: { type: 'integer' },
    truncated: { type: 'boolean' },
    updatedAt: { type: 'integer' },
    error: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Non-fatal build problems, e.g. an unreadable session log.' },
    fullIndex: { type: 'boolean' },
    reasoningIndex: { type: 'boolean' },
    toolResultsIndex: { type: 'boolean' },
    refs: {
      type: 'object',
      additionalProperties: false,
      properties: {
        total: { type: 'integer', description: 'Distinct evidence ref identities stored in the content index.' },
        byKind: { type: 'object', additionalProperties: true, description: 'Distinct ref identities per kind (url, session-event, spill, attachment).' },
      },
    },
    progress: {
      type: 'object',
      additionalProperties: false,
      properties: {
        phase: { type: 'string' },
        scanned: { type: 'integer' },
        indexed: { type: 'integer' },
        total: { type: 'integer' },
        path: { type: 'string' },
        startedAt: { type: 'integer' },
      },
    },
  },
} as const

/** One content hit after evidence metadata (evidence is absent on surplus/compact rows). */
export type EnrichedContentHit = ContentHit & {
  ref: string
  hash?: string
  seq?: number
  eventRef?: string
  provenance?: RefProvenance
  freshness?: RefFreshness
  permissions?: RefPermissions
  refStatus?: RefFreshness['state']
}

/** Files bigger than this are never re-read just to add context lines. */
const CONTEXT_MAX_FILE_BYTES = 4 * 1024 * 1024
/** Upper bound for the contextLines argument; keeps one hit a few KB at most. */
export const CONTEXT_MAX_LINES = 10

/** Options for enrichContentHits; every field is additive. */
export interface EnrichContentHitsOptions {
  /** full (default) attaches evidence; compact attaches only the cheap identity/ref fields. */
  detail?: HitDetail
  /** Evidence-bearing rows in full mode (default 10). */
  evidenceLimit?: number
  /** Compute a sha256 hash per file hit (default false; slow/network mounts are skipped). */
  includeHash?: boolean
  /** Query scope: file-hit visibility is workspace only for workspace-scoped body searches. */
  scope?: 'workspace' | 'all'
  /** Test seam: hash implementation (defaults to refs.sha256File). */
  hashFile?: (path: string, maxBytes?: number) => Promise<string | null>
  /** Test seam: slow/network filesystem classifier (defaults to combined.isSlowFilesystemPath). */
  isSlowPath?: (path: string) => boolean
}

/**
 * Attach citable evidence metadata to content hits.
 *
 * Hashing is off by default and skipped on slow/network filesystems, so a tool
 * call no longer reads every hit file. In full mode only the first
 * evidenceLimit rows pay for stat/hash (later rows keep a path-only ref);
 * compact mode never pays for evidence at all.
 * @param hits - raw content hits.
 * @param content - content store providing indexed mtimes and session-event refs.
 * @param callerCwd - caller workspace, when the embedder has an Agent session.
 * @param options - detail/evidenceLimit/includeHash plus test seams.
 * @returns hits ready for the tool output.
 */
export async function enrichContentHits(
  hits: readonly ContentHit[],
  content: ContentIndex,
  callerCwd: string | undefined,
  options: EnrichContentHitsOptions = {},
): Promise<EnrichedContentHit[]> {
  const detail: HitDetail = options.detail === 'compact' ? 'compact' : 'full'
  const evidenceLimit = evidenceLimitOf(detail, options.evidenceLimit)
  const includeHash = options.includeHash === true
  const scope = options.scope ?? 'workspace'
  const visibility = scope === 'all' || callerCwd === undefined ? 'roots' as const : 'workspace' as const
  const hashFile = options.hashFile ?? sha256File
  const slowPath = options.isSlowPath ?? isSlowFilesystemPath
  const wantsEvidence = (index: number): boolean => evidenceVisible(index, detail, evidenceLimit)
  // One query per involved session attaches the event seq/ref that the same
  // content build stored for each indexed message. Older/embedder fakes may not
  // implement the lookup; those hits simply keep their canonical session ref.
  const eventRefsBySession = new Map<string, Map<string, { seq: number; ref: string }>>()
  if (typeof content.sessionEventRefs === 'function') {
    const idsBySession = new Map<string, string[]>()
    for (let index = 0; index < hits.length; index++) {
      const hit = hits[index]!
      if (!wantsEvidence(index)) continue
      if (hit.kind !== 'session' || hit.sessionId === undefined || hit.messageId === undefined) continue
      const ids = idsBySession.get(hit.sessionId)
      if (ids === undefined) idsBySession.set(hit.sessionId, [hit.messageId])
      else ids.push(hit.messageId)
    }
    for (const [sessionId, messageIds] of idsBySession) {
      eventRefsBySession.set(sessionId, content.sessionEventRefs(sessionId, messageIds))
    }
  }
  return await Promise.all(hits.map(async (hit, index) => {
    const observedAt = Date.now()
    const withEvidence = wantsEvidence(index)
    if (hit.kind === 'session' && hit.sessionId !== undefined) {
      const ref = encodeSessionRef(hit.sessionId)
      if (!withEvidence) return { ...hit, ref }
      // The output schema declares indexedAt as an integer; derived/SQLite ages
      // can be fractional, so truncate here like ref-tools.ts does.
      const indexedAtRaw = content.indexedMtime('session', hit.path, hit.messageId)
      const indexedAt = indexedAtRaw === undefined ? undefined : Math.trunc(indexedAtRaw)
      let currentMtime: number | undefined
      try { currentMtime = (await stat(hit.path)).mtimeMs } catch { currentMtime = undefined }
      const event = hit.messageId === undefined ? undefined : eventRefsBySession.get(hit.sessionId)?.get(hit.messageId)
      const freshness = freshnessFor(indexedAt, currentMtime, observedAt)
      return {
        ...hit,
        ...(event === undefined ? {} : { seq: event.seq, eventRef: event.ref }),
        ref,
        provenance: { origin: 'index' as const, sessionId: hit.sessionId, ...(hit.messageId === undefined ? {} : { messageId: hit.messageId }), ...(indexedAt === undefined ? {} : { indexedAt }) },
        freshness,
        permissions: { read: 'allowed' as const, visibility: 'session' as const, reason: 'session messages are scoped to the caller workspace' },
        refStatus: freshness.state,
      }
    }
    const line = typeof hit.line === 'number' && hit.line > 0 ? hit.line : undefined
    if (!withEvidence) {
      // Surplus/compact rows keep only their citable identity ref: no stat and
      // no hash, so a long page cannot turn into one read per hit.
      const refInput: { path: string; line?: number } = { path: hit.path }
      if (line !== undefined) refInput.line = line
      return { ...hit, ref: fileRef(refInput) }
    }
    const indexedAtRaw = content.indexedMtime('file', hit.path)
    const indexedAt = indexedAtRaw === undefined ? undefined : Math.trunc(indexedAtRaw)
    let currentMtime: number | undefined
    let size: number | undefined
    try { const info = await stat(hit.path); currentMtime = info.mtimeMs; size = info.size } catch { currentMtime = undefined }
    const hash = includeHash && currentMtime !== undefined && !slowPath(hit.path)
      ? await hashFile(hit.path, 2 * 1024 * 1024)
      : null
    const refInput: { path: string; mtime?: number; size?: number; sha256?: string; line?: number } = { path: hit.path }
    if (currentMtime !== undefined) refInput.mtime = currentMtime
    if (size !== undefined) refInput.size = size
    if (hash !== null) refInput.sha256 = hash
    // Carry the hit line into the ref so locator_cite detail mode can quote the
    // exact matched source line instead of the file head.
    if (line !== undefined) refInput.line = line
    const freshness = freshnessFor(indexedAt, currentMtime, observedAt)
    return {
      ...hit,
      ref: fileRef(refInput),
      ...(hash === null ? {} : { hash }),
      provenance: { origin: 'index' as const, path: hit.path, ...(indexedAt === undefined ? {} : { indexedAt }) },
      freshness,
      permissions: { read: 'allowed' as const, visibility, reason: 'file hits come from the configured index roots' },
      refStatus: freshness.state,
    }
  }))
}

/** Caller identity used by the content workspace/session authorization. */
export interface CallerIdentity {
  sessionId?: string
  cwd?: string
}

/** One content query after argument parsing (shared by find and search content mode). */
export interface ContentRequest {
  query: string
  limit: number
  offset: number
  scope: 'workspace' | 'all'
  sessionId?: string
  matchMode?: 'normal' | 'extended'
  caseSensitive?: boolean
  wholeWord?: boolean
  count?: 'exact' | 'bounded' | 'none'
  countLimit?: number
  pathPrefix?: string
  /** File documents only: used by the public HTTP API, which has no caller session identity. */
  filesOnly?: boolean
  /**
   * Include archived sessions in this query (0.23). Archived session logs stay
   * indexed; the default false hides them from ordinary results. The config
   * default (`contentIncludeArchived`) is ORed in by the content layer, so this
   * flag only widens one query.
   */
  includeArchived?: boolean
  /** Hit detail: compact skips evidence enrichment entirely (default full). */
  detail?: HitDetail
  /** Evidence-bearing rows in full mode (default 10). */
  evidenceLimit?: number
  /** Compute a sha256 per file hit (default false; slow/network filesystems are skipped). */
  includeHash?: boolean
}

/**
 * Plugin-supplied content-scope context for {@link runContentSearchRequest}.
 * These values come from the validated plugin configuration, never from the
 * caller, so they are kept out of {@link ContentRequest} (and out of tool args).
 */
export interface ContentSearchRequestOptions {
  /** config.contentExcludes: path rules that keep a directory out of the content index. */
  contentExcludes?: readonly string[]
  /** config.contentShortQueryFallback: admit 2-code-point queries to the bounded fallback. */
  shortQueryFallback?: boolean
}

/**
 * Whether a directory is outside the content index because of `contentExcludes`.
 * Mirrors the content layer's own skip rule (a rule containing `/` matches as a
 * path substring, a bare rule matches a path segment) so the workspace-scope
 * fallback agrees with what the index actually scanned. The plugin's `.dsh`
 * tree is always excluded.
 * @param path - absolute directory (usually the caller cwd).
 * @param excludes - configured content excludes.
 * @returns true when the directory itself cannot have indexed bodies.
 */
export function contentPathExcluded(path: string, excludes: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, '/')
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

/**
 * Read the content-scope knobs off the runtime configuration. The 0.20.2
 * fields are read defensively: an embedder runtime or an older profile keeps
 * the 0.20.1 behavior (no cwd fallback, no short-query fallback) instead of
 * throwing.
 * @param rt - the locator runtime, when the caller has one.
 * @returns options ready for {@link runContentSearchRequest}.
 */
export function contentScopeOptionsOf(rt: LocatorRuntime | undefined): ContentSearchRequestOptions {
  if (rt === undefined) return {}
  return {
    contentExcludes: Array.isArray(rt.config.contentExcludes) ? rt.config.contentExcludes : [],
    shortQueryFallback: rt.config.contentShortQueryFallback !== false,
  }
}

/** Result of one authorized content query. */
export type ContentRequestResult =
  | {
      ok: true
      hits: EnrichedContentHit[]
      count: ContentCount
      warnings: string[]
      state: ContentState
      scope: 'workspace' | 'all'
      scopeFallback?: string
      /** True when a 2-code-point query was answered by the bounded fallback. */
      shortQueryFallback?: boolean
      /** True when a workspace-scoped first page came back empty: pass scope "all" to widen. */
      workspaceEmpty?: boolean
    }
  | {
      ok: false
      error: string
      warnings: string[]
      hits: EnrichedContentHit[]
      state: ContentState
      scope?: 'workspace' | 'all'
    }

/**
 * Run one content query with the same workspace/session authorization
 * locator_find always applied. Extracted so locator_search mode "content" can
 * reuse the exact rules instead of duplicating them.
 */
export async function runContentSearchRequest(
  content: ContentIndex,
  request: ContentRequest,
  roots: readonly string[],
  allowCrossWorkspaceSessions: boolean,
  caller: CallerIdentity = {},
  requestOptions: ContentSearchRequestOptions = {},
): Promise<ContentRequestResult> {
  const state = content.status()
  const query = request.query.trim()
  const offset = request.offset
  const scope = request.scope
  // Caller identity is needed for every scope: "all" must not turn into
  // "read every session in the index" for an authenticated agent.
  const callerSessionId = caller.sessionId
  const callerCwd = caller.cwd
  const requestedSessionId = typeof request.sessionId === 'string' && request.sessionId.trim() !== '' ? request.sessionId.trim() : undefined
  const allowedSessions = content.authorizedSessionIds(callerCwd, callerSessionId)
  if (requestedSessionId !== undefined && !allowedSessions.has(requestedSessionId)) {
    return {
      ok: false,
      error: 'content-scope-denied',
      warnings: ['session-not-authorized'],
      hits: [],
      state,
      scope,
    }
  }
  if (request.pathPrefix !== undefined && request.pathPrefix !== '') {
    if (!roots.some(root => withinRoots(request.pathPrefix as string, [root]))) {
      return { ok: false, error: 'content-path-denied', warnings: ['path-outside-roots'], hits: [], state, scope }
    }
  }
  // A cwd outside every configured root has no indexed workspace subset.
  const cwdIsIndexed = callerCwd !== undefined && roots.some(root => withinRoots(callerCwd, [root]))
  const fileHitsAllRoots = callerSessionId !== undefined && !cwdIsIndexed
  // 0.20.2: a cwd can live inside a name-index root but outside the content
  // index (a contentExcludes rule such as /mnt/d/). The workspace body subset
  // then does not exist at all, so an empty page must fall back to the global
  // content roots instead of looking like 'no matches'.
  const cwdOutsideContent = callerCwd !== undefined && cwdIsIndexed && contentPathExcluded(callerCwd, requestOptions.contentExcludes ?? [])
  const sessionFilter = requestedSessionId ?? (scope === 'workspace' ? callerSessionId : undefined)
  // scope "all" keeps every file searchable but sessions stay limited to the
  // caller's authorized set unless the operator opts into cross-workspace reads.
  const restrictSessions = scope === 'all' && !allowCrossWorkspaceSessions && callerSessionId !== undefined
  const baseOptions: ContentSearchOptions = {
    ...(fileHitsAllRoots ? { fileHitsAllRoots: true } : {}),
    // Before the active session settles the session id is not indexed yet;
    // workspace scope must still search file bodies in that window.
    ...(scope === 'workspace' || requestedSessionId !== undefined ? { sessionUnavailable: 'files-only' as const } : {}),
    ...(request.matchMode === undefined ? {} : { matchMode: request.matchMode }),
    ...(request.caseSensitive === undefined ? {} : { caseSensitive: request.caseSensitive }),
    ...(request.wholeWord === undefined ? {} : { wholeWord: request.wholeWord }),
    ...(requestOptions.shortQueryFallback === true ? { shortQueryFallback: true } : {}),
    ...(sessionFilter === undefined ? {} : { sessionId: sessionFilter }),
    ...(restrictSessions ? { allowedSessionIds: [...allowedSessions] } : {}),
    ...(request.count === undefined ? {} : { count: request.count }),
    ...(request.countLimit === undefined ? {} : { countLimit: request.countLimit }),
    ...(request.filesOnly === true ? { excludeSessions: true } : {}),
    ...(request.includeArchived === true ? { includeArchived: true } : {}),
    ...(offset === 0 ? {} : { offset }),
  }
  const workspacePathPrefix = request.pathPrefix !== undefined && request.pathPrefix !== ''
    ? request.pathPrefix
    : !cwdIsIndexed || scope === 'all' ? undefined : callerCwd
  const options: ContentSearchOptions = workspacePathPrefix === undefined
    ? baseOptions
    : { ...baseOptions, pathPrefix: workspacePathPrefix }
  let result = await content.search(query, request.limit, options)
  let scopeFallback: string | undefined
  // Only a page that would otherwise be empty pays for the second query, and
  // only when the narrowing came from the cwd (an explicit pathPrefix is the
  // caller's own choice and is never widened).
  const cwdNarrowed = request.pathPrefix === undefined || request.pathPrefix === ''
  if (
    cwdOutsideContent
    && cwdNarrowed
    && scope === 'workspace'
    && offset === 0
    && result.error === undefined
    && result.hits.length === 0
    && (result.count.kind !== 'exact' || result.count.value === 0)
  ) {
    // File documents from every content root, session documents still limited
    // to the caller's session; fileHitsAllRoots is the content layer's existing
    // 'no workspace file subset' mode.
    const fallback = await content.search(query, request.limit, { ...baseOptions, fileHitsAllRoots: true })
    if (fallback.error === undefined) {
      result = fallback
      scopeFallback = 'global'
    }
  }
  if (result.error !== undefined) {
    return { ok: false, error: result.error, warnings: result.warnings, hits: [], state, scope }
  }
  // File-hit visibility mirrors where the rows actually came from: a workspace
  // cwd inside the roots is workspace-scoped, every other case searched all
  // roots (cwd outside the index or an explicit scope "all").
  const enrichmentScope: 'workspace' | 'all' = scope === 'workspace' && cwdIsIndexed ? 'workspace' : 'all'
  const hits = await enrichContentHits(result.hits, content, callerCwd, {
    detail: request.detail ?? 'full',
    // Embedders that predate the evidence budget (locator_explore) keep the
    // historical all-rows enrichment; the tools pass an explicit limit.
    evidenceLimit: request.evidenceLimit === undefined ? Number.POSITIVE_INFINITY : request.evidenceLimit,
    includeHash: request.includeHash === true,
    scope: enrichmentScope,
  })
  const fallbackNote = scopeFallback
    ?? (scope === 'workspace' && callerSessionId !== undefined && !cwdIsIndexed
      ? 'cwd-not-indexed; files searched across configured roots'
      : undefined)
  // A workspace page that is empty because the caller narrowed to a cwd with no
  // body matches must say so: the caller can pass scope "all" to widen. This
  // deliberately does not widen behind the caller's back (the content page is
  // already cwd-filtered, so there is nothing to refill from).
  const workspaceEmpty = scope === 'workspace'
    && cwdIsIndexed
    && cwdNarrowed
    && requestedSessionId === undefined
    && offset === 0
    && scopeFallback === undefined
    && result.hits.length === 0
  return {
    ok: true,
    hits,
    count: result.count,
    warnings: result.warnings,
    state,
    scope,
    ...(fallbackNote === undefined ? {} : { scopeFallback: fallbackNote }),
    ...(result.shortQueryFallback === true ? { shortQueryFallback: true } : {}),
    ...(workspaceEmpty ? { workspaceEmpty: true } : {}),
  }
}

/**
 * Read a bounded window of lines around one hit line. Files that are missing,
 * non-text-sized or unreadable simply get no context; context is an additive
 * convenience, never a reason to fail the query.
 */
export async function readContextLines(
  path: string,
  line: number,
  contextLines: number,
): Promise<{ start: number; lines: string[] } | undefined> {
  if (contextLines <= 0 || !Number.isFinite(line) || line < 1) return undefined
  const window = Math.min(CONTEXT_MAX_LINES, Math.trunc(contextLines))
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > CONTEXT_MAX_FILE_BYTES) return undefined
    const text = await readFile(path, 'utf8')
    const all = text.split('\n')
    const center = Math.min(all.length, Math.trunc(line))
    const start = Math.max(1, center - window)
    const end = Math.min(all.length, center + window)
    return {
      start,
      lines: all.slice(start - 1, end).map(contextLine => contextLine.replace(/\r$/, '')),
    }
  } catch {
    return undefined
  }
}

/** Modes locator_find understands; the default keeps the historical behavior. */
export type FindMode = 'names' | 'content' | 'count'

/** Parse one mode argument, defaulting to "content". */
export function parseFindMode(value: unknown): FindMode {
  return value === 'names' || value === 'count' ? value : 'content'
}

/** Options the plugin passes to makeFindTool (all optional for embedders). */
export interface FindToolOptions {
  /** Name index backing mode "names" (the plugin always supplies it). */
  rt?: LocatorRuntime
  /** Layered ignore rules; omitted means no filtering. */
  scope?: Scope
  /** Soft result budget in characters; omitted uses the catalog default. */
  budgetChars?: number
  /** Optional external rerank command (config.rerankCommand); empty disables. */
  rerankCommand?: string
}

/** Build the locator_find tool. */
export function makeFindTool(
  content: ContentIndex,
  ensure?: () => void,
  roots: readonly string[] = [],
  allowCrossWorkspaceSessions = false,
  options: FindToolOptions = {},
) {
  const modeLimit = options.rt === undefined ? 100 : Math.max(1, Math.trunc(options.rt.config.maxResults))
  return defineTool({
    deferLoading: true,
    name: 'locator_find',
    description: [
      'Search the **contents** of text files and DSH session messages (dsh-locator).',
      '',
      'Use it when the user remembers a phrase, a sentence, a decision or a code snippet rather than a file name. locator_search searches names and paths; this searches bodies and returns snippets plus sessionId/messageId for session hits, so the result can be opened at its source.',
      '',
      'Modes: content (default) searches bodies; names searches the file-name index with the Everything-style query language; count only counts body matches. contextLines adds surrounding source lines to file hits. Every result reports totalCount, truncated, nextOffset and a budget block so a caller can page or narrow instead of guessing.',
      '',
      'Content is substring search over an FTS5 trigram index. Terms of 3+ characters drive the matcher; a 2-character term mixed with longer terms is enforced as a post-filter over the matches, and a 1-character term is dropped with a terms-dropped warning when a longer term exists. Only an all-short query (ai, js, 索引) is rejected with content-query-too-short, or answered by the bounded substring fallback when the plugin enables contentShortQueryFallback (default on) with a shortQueryFallback marker. Text files are capped by contentMaxFileBytes; session logs are decompressed from $DSH_HOME/sessions.',
      '',
      'By default it searches the caller workspace: the current session for session hits and files under the caller cwd when that cwd is inside an indexed root. If the cwd is outside every indexed root, file hits cover the indexed roots (there is no workspace subset to restrict to); pass scope "all" to search every indexed file (session hits still stay limited to the caller workspace unless the operator enables cross-workspace session reads). Every returned row carries a citable ref; the first evidenceLimit rows (default 10) also carry provenance, freshness and permissions, and hashing is opt-in via includeHash.',
    ].join('\n'),
    parameters: {
      query: { type: 'string', required: true, description: 'Words or a phrase to find in file/session content (or a name query in mode names).' },
      mode: { type: 'string', enum: ['names', 'content', 'count'], description: 'content (default) searches bodies; names searches the file-name index; count only returns the match count.' },
      limit: { type: 'integer', description: 'Maximum hits (default 8) for content mode / names mode; the final page is always sliced to this size.' },
      headLimit: { type: 'integer', description: 'Explicit page-size cap (alias of limit, min of both is used).' },
      offset: { type: 'integer', description: 'Skip this many ranked hits (pagination). Use nextOffset from the previous page; pages never skip a hit the budget deferred.' },
      contextLines: { type: 'integer', description: 'Lines of surrounding file content to include with file hits (0-10, default 0).' },
      budgetChars: { type: 'integer', description: 'Soft cap on the serialized result size in characters (default 8000; 0 disables the budget and its trimming).' },
      detail: { type: 'string', enum: ['full', 'compact'], description: 'full (default) keeps ref/provenance/freshness/permissions evidence; compact keeps only kind/path/name/title/snippet/line/score/ref and drops hash/provenance/freshness/permissions/refStatus.' },
      evidenceLimit: { type: 'integer', description: 'Evidence-bearing rows in full mode (default 10, at most 50); later rows keep the cheap fields and their ref.' },
      includeHash: { type: 'boolean', description: 'Compute a sha256 hash per file hit (default false; slow/network filesystems are always skipped).' },
      matchMode: { type: 'string', enum: ['normal', 'extended'], description: 'normal: whitespace-separated substring terms. extended: one literal phrase with Notepad++ escapes (\\n, \\r, \\t, \\0, \\xNN, \\\\).' },
      caseSensitive: { type: 'boolean', description: 'Match letter case exactly.' },
      wholeWord: { type: 'boolean', description: 'Only match whole words ([A-Za-z0-9_] boundaries; CJK counts as non-word).' },
      sessionId: { type: 'string', description: 'Only search messages of one DSH session id (defaults to the caller session in workspace scope).' },
      scope: { type: 'string', enum: ['workspace', 'all'], description: 'workspace (default) restricts file hits to the caller workspace/cwd and session hits to the caller session; all searches every indexed file and session (explicit cross-workspace access).' },
      count: { type: 'string', enum: ['exact', 'bounded', 'none'], description: 'How much counting work to spend; bounded stops at countLimit.' },
      countLimit: { type: 'integer', description: 'Counting cap for bounded counts (default 1000, at most 5000).' },
      pathPrefix: { type: 'string', description: 'Only return file hits whose path starts with this directory (session hits are unaffected).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          query: { type: 'string' },
          mode: { type: 'string', enum: ['names', 'content', 'count'] },
          offset: { type: 'integer' },
          total: { type: 'integer', description: 'Primary match count: names mode is the name-index total across configured roots; content/count modes are the content count when known.' },
          totalCount: { type: 'integer', description: 'Alias of total: total matches when the index knows them (engine total or content count).' },
          totalAllRoots: {
            type: 'integer',
            description: 'Names mode only: the global match count across every configured root. Present when the cwd/pathPrefix filter narrowed the result, since total is then not a scope count.',
          },
          indexing: { type: 'boolean', description: 'The name index is still scanning (mode names; results are partial).' },
          nextOffset: { type: 'integer', description: 'Offset of the next page; absent when this page is the last one.' },
          truncated: { type: 'boolean', description: 'More hits exist beyond this result (page, scope or budget).' },
          hasMore: { type: 'boolean', description: 'True when paging further can still return rows (same as truncated).' },
          consumed: { type: 'integer', description: 'Raw store rows this page consumed (nextOffset - offset).' },
          truncation: TRUNCATION_SCHEMA,
          detail: { type: 'string', enum: ['full', 'compact'], description: 'Present when the caller requested compact (evidence-free) hits.' },
          hits: { type: 'array', items: HIT },
          budget: BUDGET_SCHEMA,
          count: {
            type: 'object',
            additionalProperties: false,
            properties: {
              value: { type: 'integer' },
              kind: { type: 'string', enum: ['exact', 'bounded', 'unknown'] },
              limit: { type: 'integer' },
            },
          },
          contentCount: {
            type: 'object',
            additionalProperties: false,
            description: 'Alias of count: the content count block (value/kind/limit) for content and count modes.',
            properties: {
              value: { type: 'integer' },
              kind: { type: 'string', enum: ['exact', 'bounded', 'unknown'] },
              limit: { type: 'integer' },
            },
          },
          warnings: { type: 'array', items: { type: 'string' } },
          warningHints: WARNING_HINTS_SCHEMA,
          state: CONTENT_STATE_SCHEMA,
          scope: { type: 'string', enum: ['workspace', 'all'] },
          scopeFallback: { type: 'string' },
          shortQueryFallback: {
            type: 'boolean',
            description: 'True when a 2-character query was answered by the bounded short-query fallback (the page is approximate).',
          },
          error: { type: 'string' },
          errorInfo: ERROR_INFO_SCHEMA,
        },
      },
      render: (_args, value) => {
        const v = value as {
          ok: boolean
          query?: string
          mode?: string
          hits?: Array<{ kind: string; title?: string; name?: string; snippet?: string; path?: string; line?: number; sessionId?: string; messageId?: string; ref?: string; refStatus?: string; freshness?: { state?: string }; context?: string[]; contextStart?: number; permissions?: { read?: string } }>
          offset?: number
          total?: number
          totalCount?: number
          totalAllRoots?: number
          nextOffset?: number
          truncated?: boolean
          hasMore?: boolean
          consumed?: number
          truncation?: { reason?: string; dropped?: number; consumed?: number }
          detail?: string
          budget?: { dropped?: number; limitChars?: number; usedChars?: number }
          scope?: string
          scopeFallback?: string
          shortQueryFallback?: boolean
          count?: { value: number; kind: 'exact' | 'bounded' | 'unknown' }
          contentCount?: { value: number; kind: 'exact' | 'bounded' | 'unknown' }
          warnings?: string[]
          warningHints?: Record<string, string>
          error?: string
          errorInfo?: { code?: string; hint?: string }
          state?: ContentState & { progress?: { indexed?: number; scanned?: number; total?: number } }
        }
        if (!v.ok) {
          const warnings = v.warnings !== undefined && v.warnings.length > 0 ? ' (' + [...new Set(v.warnings)].join(', ') + ')' : ''
          const hint = v.errorInfo?.hint === undefined ? '' : ' — ' + v.errorInfo.hint
          return [{ type: 'text', text: 'locator_find failed: ' + (v.error ?? 'unknown') + warnings + hint }]
        }
        const mode = v.mode ?? 'content'
        const lines = (v.hits ?? []).map((hit, index) => {
          const ref = hit.kind === 'session' && (hit.sessionId !== undefined || hit.messageId !== undefined)
            ? '\n   session ' + String(hit.sessionId ?? '') + (hit.messageId === undefined ? '' : ' message ' + String(hit.messageId))
            : ''
          const evidence = hit.ref === undefined ? '' : '\n   ref ' + hit.ref + (hit.refStatus === undefined ? (hit.freshness?.state === undefined ? '' : ' (' + hit.freshness.state + ')') : ' (' + hit.refStatus + ')')
          const label = hit.title ?? hit.name ?? basename(hit.path ?? '')
          const readDenied = hit.permissions?.read === 'denied' ? '\n   read denied by scope rules' : ''
          const context = hit.context === undefined || hit.context.length === 0
            ? ''
            : '\n' + hit.context.map((line, lineIndex) => '   ' + String((hit.contextStart ?? 1) + lineIndex) + ': ' + line).join('\n')
          return String(index + 1) + '. [' + hit.kind + '] ' + label + ' — ' + (hit.snippet ?? '') + '\n   ' + (hit.path ?? '') + (typeof hit.line === 'number' ? ' (line ' + String(hit.line) + ')' : '') + ref + evidence + readDenied + context
        })
        const contentCount = v.contentCount ?? v.count
        const count = contentCount === undefined
          ? ''
          : contentCount.kind === 'unknown'
            ? ', count unavailable'
            : contentCount.kind === 'bounded'
              ? ', count ≥ ' + String(contentCount.value)
              : ', count ' + String(contentCount.value)
        const warnings = [...new Set([...(v.warnings ?? []), ...(v.state?.warnings ?? [])])]
        const progress = v.state?.progress
        const buildingNote = v.state?.building === true
          ? ' (index still building' + (typeof progress?.indexed === 'number' ? ' — ' + String(progress.indexed) + ' entries indexed so far' : '') + ')'
          : ''
        const notes = [
          buildingNote,
          v.state?.truncated === true ? ' (content budget reached: raise contentMaxTotalBytes or trim contentExcludes; later files are not searchable)' : '',
          v.shortQueryFallback === true ? ' (short-query fallback: this page is approximate)' : '',
          warnings.length > 0 ? ' (warnings: ' + warnings.join(', ') + ')' : '',
        ].join('')
        const hintEntries = Object.entries(v.warningHints ?? {})
        const hintNote = hintEntries.length === 0 ? '' : '\n(hints: ' + hintEntries.map(([code, hint]) => code + ' — ' + hint).join(' | ') + ')'
        const scopeNote = v.scope === undefined ? '' : ' (scope: ' + v.scope + (v.scopeFallback === undefined ? '' : '; ' + v.scopeFallback) + ')'
        const globalNote = v.totalAllRoots === undefined ? '' : ' (total is across all configured roots, not just the workspace)'
        const truncReason = v.truncation?.reason === undefined ? '' : '; reason: ' + v.truncation.reason
        const pageNote = v.truncated === true || v.hasMore === true || v.nextOffset !== undefined
          ? '\n(truncated' + truncReason + (v.nextOffset === undefined ? '' : '; nextOffset ' + String(v.nextOffset)) + (v.budget?.dropped === undefined || v.budget.dropped === 0 ? '' : '; ' + String(v.budget.dropped) + ' hit(s) over the ' + String(v.budget.limitChars ?? 0) + '-char budget') + ')'
          : ''
        const modeNote = mode === 'content' ? '' : ' (mode: ' + mode + ')'
        const detailNote = v.detail === 'compact' ? ' (compact: evidence fields omitted)' : ''
        const header = mode === 'count'
          ? 'locator_find (count) ' + JSON.stringify(v.query ?? '') + ': content' + (count === '' ? ' count unavailable' : count)
          : String(v.hits?.length ?? 0) + ' content hit(s)' + count
        return [{ type: 'text', text: header + modeNote + globalNote + scopeNote + notes + detailNote + pageNote + hintNote + '\n' + lines.join('\n') }]
      },
    },
    // Body search only reads the content store and the two indexes; sibling
    // read-only calls may join one parallel group.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      ensure?.()
      const query = args.query.trim()
      const state = content.status()
      if (query === '') {
        return { ok: false as const, query, error: 'query is empty', errorInfo: errorInfoOf('query-empty', 'query is empty'), state }
      }
      const mode = parseFindMode(args.mode)
      const limit = pageSize(args.limit, args.headLimit, modeLimit, 8)
      const offset = Math.max(0, Math.trunc(args.offset ?? 0))
      const scope: 'workspace' | 'all' = args.scope === 'all' ? 'all' : 'workspace'
      const caller: CallerIdentity = {
        ...(exec?.agent?.session?.id === undefined ? {} : { sessionId: exec.agent.session.id }),
        ...(exec?.agent?.session?.header?.cwd === undefined ? {} : { cwd: exec.agent.session.header.cwd }),
      }
      const limitChars = outputBudgetOf(args.budgetChars, options.budgetChars ?? DEFAULT_OUTPUT_BUDGET_CHARS)
      const scopeRules = options.scope
      const contextLines = Math.max(0, Math.min(CONTEXT_MAX_LINES, Math.trunc(args.contextLines ?? 0)))
      const detail: HitDetail = args.detail === 'compact' ? 'compact' : 'full'
      const evidenceLimit = evidenceLimitOf(detail, args.evidenceLimit)
      const includeHash = args.includeHash === true
      if (mode === 'names') {
        return await runNamesMode({
          query,
          limit,
          offset,
          scope,
          detail,
          evidenceLimit,
          limitChars,
          contextLines,
          args,
          caller,
          rt: options.rt,
          scopeRules,
        })
      }
      const request: ContentRequest = {
        query,
        limit,
        offset,
        scope,
        detail,
        evidenceLimit,
        ...(includeHash ? { includeHash: true } : {}),
        ...(typeof args.sessionId === 'string' && args.sessionId.trim() !== '' ? { sessionId: args.sessionId } : {}),
        ...(args.matchMode === undefined ? {} : { matchMode: args.matchMode }),
        ...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive }),
        ...(args.wholeWord === undefined ? {} : { wholeWord: args.wholeWord }),
        ...(args.count === undefined ? {} : { count: args.count }),
        ...(args.countLimit === undefined ? {} : { countLimit: args.countLimit }),
        ...(args.pathPrefix === undefined || args.pathPrefix === '' ? {} : { pathPrefix: args.pathPrefix }),
      }
      const result = await runContentSearchRequest(content, mode === 'count' ? { ...request, count: request.count ?? 'exact', limit: 1, offset: 0 } : request, roots, allowCrossWorkspaceSessions, caller, contentScopeOptionsOf(options.rt))
      if (!result.ok) {
        const hints = warningHintsOf(result.warnings)
        return {
          ok: false as const,
          query,
          offset,
          mode,
          error: result.error,
          errorInfo: errorInfoOf(result.error),
          warnings: result.warnings,
          ...(hints === undefined ? {} : { warningHints: hints }),
          hits: [],
          state: result.state,
        }
      }
      if (mode === 'count') {
        const known = result.count.kind !== 'unknown'
        const warnings = [...result.warnings]
        if (result.count.kind === 'bounded') warnings.push('bounded-count')
        if (result.shortQueryFallback === true) warnings.push('query-degraded')
        const uniqueWarnings = [...new Set(warnings)]
        const hints = warningHintsOf(uniqueWarnings)
        return {
          ok: true as const,
          query,
          mode,
          offset: 0,
          hits: [],
          count: result.count,
          contentCount: result.count,
          ...(known ? { total: result.count.value, totalCount: result.count.value } : {}),
          truncated: result.count.kind === 'bounded',
          hasMore: false,
          consumed: 0,
          budget: { limitChars, usedChars: 0, truncated: false, dropped: 0 },
          warnings: uniqueWarnings,
          ...(hints === undefined ? {} : { warningHints: hints }),
          state: result.state,
          scope,
          ...(result.scopeFallback === undefined ? {} : { scopeFallback: result.scopeFallback }),
          ...(result.shortQueryFallback === true ? { shortQueryFallback: true } : {}),
          ...(detail === 'compact' ? { detail } : {}),
        }
      }
      const warnings = [...result.warnings]
      const keepVisible = (hit: { path: string }): boolean => scopeRules === undefined
        ? true
        : scopeRules.isSearchable(hit.path) && scopeRules.isIndexable(hit.path) && scopeRules.isReadable(hit.path)
      // Select the page without the budget first: the optional rerank hook and
      // context lines both change the payload, so the budget is applied once at
      // the end and the raw positions stay aligned with the returned rows.
      const selected = selectPage(result.hits, limit, 0, keepVisible)
      let items = selected.items
      let keptIndices = [...selected.keptIndices]
      const dropped = [...selected.dropped]
      const scopeDropped = selected.dropped.filter(drop => drop.reason === 'scope').length
      if (scopeDropped > 0) warnings.push('scope-filtered:' + String(scopeDropped))
      if (options.rerankCommand !== undefined && options.rerankCommand.trim() !== '' && items.length > 1) {
        const positionByItem = new Map<unknown, number>()
        items.forEach((item, index) => positionByItem.set(item, keptIndices[index]!))
        const reranked = await rerankHits(options.rerankCommand, query, items)
        items = reranked.hits
        keptIndices = items.map(item => positionByItem.get(item) ?? 0)
        warnings.push(...reranked.warnings)
      }
      if (contextLines > 0) {
        items = await Promise.all(items.map(async hit => {
          if (hit.kind !== 'file' || hit.line === undefined) return hit
          const context = await readContextLines(hit.path, hit.line, contextLines)
          return context === undefined ? hit : { ...hit, context: context.lines, contextStart: context.start }
        }))
      }
      const budgeted = applyOutputBudget(items, limitChars)
      for (let index = budgeted.items.length; index < keptIndices.length; index++) {
        dropped.push({ index: keptIndices[index]!, reason: 'budget' })
      }
      keptIndices = keptIndices.slice(0, budgeted.items.length)
      // selectPage works on page-relative positions; the cursor math is in
      // absolute store offsets.
      const advance = pageAdvance({
        offset,
        fetchedRows: result.hits.length,
        keptIndices: keptIndices.map(index => offset + index),
        dropped: dropped.map(drop => ({ index: offset + drop.index, reason: drop.reason })),
        more: result.hits.length >= limit || selected.unscanned > 0,
      })
      if (result.shortQueryFallback === true) warnings.push('query-degraded')
      if (result.count.kind === 'bounded') warnings.push('bounded-count')
      if (result.workspaceEmpty === true) warnings.push('workspace-empty')
      const uniqueWarnings = [...new Set(warnings)]
      const hints = warningHintsOf(uniqueWarnings)
      const totalKnown = result.count.kind === 'unknown' ? undefined : result.count.value
      return {
        ok: true as const,
        query,
        mode,
        offset,
        hits: budgeted.items,
        count: result.count,
        contentCount: result.count,
        ...(totalKnown === undefined ? {} : { total: totalKnown, totalCount: totalKnown }),
        ...(advance.nextOffset === undefined ? {} : { nextOffset: advance.nextOffset }),
        truncated: advance.truncated,
        hasMore: advance.hasMore,
        consumed: advance.consumed,
        ...(advance.truncation === undefined ? {} : { truncation: advance.truncation }),
        budget: budgeted.budget,
        warnings: uniqueWarnings,
        ...(hints === undefined ? {} : { warningHints: hints }),
        state: result.state,
        scope,
        ...(result.scopeFallback === undefined ? {} : { scopeFallback: result.scopeFallback }),
        ...(result.shortQueryFallback === true ? { shortQueryFallback: true } : {}),
        ...(detail === 'compact' ? { detail } : {}),
      }
    },
  })
}

/** One name-index page rendered in the locator_find hit shape. */
interface FindNamesOptions {
  query: string
  limit: number
  offset: number
  scope: 'workspace' | 'all'
  detail: HitDetail
  evidenceLimit: number
  limitChars: number
  contextLines: number
  args: { sort?: 'name' | 'path' | 'size' | 'mtime' | 'ext'; desc?: boolean; regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; filesOnly?: boolean; dirsOnly?: boolean; pathPrefix?: string }
  caller: CallerIdentity
  rt: LocatorRuntime | undefined
  scopeRules: Scope | undefined
}

async function runNamesMode(options: FindNamesOptions) {
  const { query, limit, offset, scope, rt } = options
  if (rt === undefined) {
    return { ok: false as const, query, offset, mode: 'names' as const, error: 'name-index-unavailable', errorInfo: errorInfoOf('name-index-unavailable') }
  }
  const callerCwd = options.caller.cwd
  const pathPrefix = typeof options.args.pathPrefix === 'string' && options.args.pathPrefix.trim() !== ''
    ? options.args.pathPrefix.trim()
    : undefined
  // The names mode must honour the same workspace/pathPfx narrowing as content
  // mode instead of silently searching every configured root. An explicit
  // pathPrefix wins (and is validated) exactly like the content request.
  if (pathPrefix !== undefined && !rt.roots.some(root => withinRoots(pathPrefix, [root]))) {
    return {
      ok: false as const,
      query,
      offset,
      mode: 'names' as const,
      error: 'content-path-denied',
      errorInfo: errorInfoOf('content-path-denied'),
      warnings: ['path-outside-roots'],
    }
  }
  const prefixBoundary = pathPrefix === undefined ? undefined : pathPrefix.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
  const insidePrefix = (path: string): boolean => prefixBoundary === undefined
    ? true
    : path.replace(/\\/g, '/') === prefixBoundary.slice(0, -1) || path.replace(/\\/g, '/').startsWith(prefixBoundary)
  try {
    rt.start()
    const cwdIsIndexed = callerCwd !== undefined && rt.roots.some(root => withinRoots(callerCwd, [root]))
    const narrowToCwd = scope === 'workspace' && cwdIsIndexed && pathPrefix === undefined
    const narrowToPrefix = pathPrefix !== undefined
    const narrowing = narrowToCwd || narrowToPrefix
    const fetchSize = narrowing ? Math.min(rt.config.maxResults, Math.max(limit * 5, 50)) : limit
    const window = await fetchNamePage(
      async page => await rt.search({
        query,
        limit: page.limit,
        offset: page.offset,
        sort: options.args.sort ?? 'name',
        desc: options.args.desc ?? false,
        regex: options.args.regex ?? false,
        caseSensitive: options.args.caseSensitive ?? false,
        wholeWord: options.args.wholeWord ?? false,
        filesOnly: options.args.filesOnly ?? false,
        dirsOnly: options.args.dirsOnly ?? false,
      }),
      {
        offset,
        limit,
        fetchSize,
        maxRows: narrowing ? 250 : limit,
        keep: hit => {
          if (narrowToCwd && !withinRoots(hit.path, [callerCwd as string])) return 'narrow'
          if (narrowToPrefix && !insidePrefix(hit.path)) return 'narrow'
          if (options.scopeRules !== undefined && !options.scopeRules.isSearchable(hit.path)) return 'scope'
          return 'keep'
        },
      },
    )
    const observedAt = Date.now()
    const visibility = scope === 'all' || !cwdIsIndexed ? 'roots' as const : 'workspace' as const
    const mapped = window.items.map((hit, index) => {
      const readable = options.scopeRules?.readability(hit.path) ?? { read: 'allowed' as const, reason: 'name hits come from the configured index roots' }
      const base = {
        kind: hit.dir ? 'dir' as const : 'file' as const,
        path: hit.path,
        name: hit.name,
        size: hit.size,
        mtime: hit.mtime,
        dir: hit.dir,
        ...(hit.dir || readable.read !== 'allowed' ? {} : { ref: fileRef({ path: hit.path, mtime: hit.mtime, size: hit.size }) }),
      }
      if (!evidenceVisible(index, options.detail, options.evidenceLimit)) return base
      return {
        ...base,
        freshness: { state: 'unknown' as const, observedAt, mtime: hit.mtime },
        refStatus: 'unknown' as const,
        permissions: { read: readable.read, visibility, reason: readable.reason },
      }
    })
    // Budget the mapped payload and recompute the cursor from raw positions so
    // evidence bytes cannot overrun the budget or skip a deferred row.
    const budgeted = applyOutputBudget(mapped, options.limitChars)
    const dropped = [...window.dropped]
    for (let index = budgeted.items.length; index < mapped.length; index++) {
      dropped.push({ index: window.indices[index]!, reason: 'budget' })
    }
    const advance = pageAdvance({
      offset,
      fetchedRows: window.rawConsumed,
      keptIndices: window.indices.slice(0, budgeted.items.length),
      dropped,
      more: window.more,
    })
    const hits = budgeted.items
    const warnings: string[] = options.contextLines > 0 ? ['context-lines-ignored-in-names-mode'] : []
    if (window.scopeDropped > 0) warnings.push('scope-filtered:' + String(window.scopeDropped))
    if (narrowing && window.items.length === 0 && offset === 0) warnings.push('workspace-empty')
    const uniqueWarnings = [...new Set(warnings)]
    const hintCodes = narrowing ? [...uniqueWarnings, 'total-is-global'] : uniqueWarnings
    const hints = warningHintsOf(hintCodes)
    return {
      ok: true as const,
      query,
      mode: 'names' as const,
      offset,
      hits,
      total: window.total,
      totalCount: window.total,
      ...(narrowing ? { totalAllRoots: window.total } : {}),
      ...(advance.nextOffset === undefined ? {} : { nextOffset: advance.nextOffset }),
      truncated: advance.truncated,
      hasMore: advance.hasMore,
      consumed: advance.consumed,
      ...(advance.truncation === undefined ? {} : { truncation: advance.truncation }),
      budget: budgeted.budget,
      ...(uniqueWarnings.length === 0 ? {} : { warnings: uniqueWarnings }),
      ...(hints === undefined ? {} : { warningHints: hints }),
      scope,
      ...(scope === 'workspace' && !cwdIsIndexed ? { scopeFallback: 'cwd-not-indexed; searched every configured root' } : {}),
      indexing: window.indexing === true,
      tookMs: window.tookMs,
      ...(options.detail === 'compact' ? { detail: 'compact' as const } : {}),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false as const, query, offset, mode: 'names' as const, error: message, errorInfo: errorInfoOf('engine-error', message) }
  }
}
