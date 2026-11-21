/**
 * Agent-facing tools: locator_search, locator_status and locator_rebuild.
 * @module dsh-locator/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CodeSymbol, ContentIndex, ContentState, RepoMapFile, SymbolMatch } from './content.ts'
import { estimateSymbolTokens } from './symbols.ts'
import type { Config } from './config.ts'
import { outputBudgetChars, validateHookCommands } from './config.ts'
import {
  BUDGET_SCHEMA,
  CONTENT_HIT_SCHEMA,
  CONTENT_STATE_SCHEMA,
  contentScopeOptionsOf,
  readContextLines,
  runContentSearchRequest,
  type CallerIdentity,
  type ContentRequest,
} from './find.ts'
import { fileRef } from './refs.ts'
import { engineResourceFields, type EngineStatus, type LocatorRuntime, type SearchHit } from './runtime.ts'
import { resolveWithinRoots, withinRoots } from './reveal.ts'
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
  Scope,
  selectPage,
  TRUNCATION_SCHEMA,
  WARNING_HINTS_SCHEMA,
  warningHintsOf,
  type HitDetail,
} from './scope.ts'

const HIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    name: { type: 'string', required: true },
    size: { type: 'integer' },
    mtime: { type: 'integer', description: 'Modification time in Unix milliseconds.' },
    modified: { type: 'string', description: 'ISO-8601 modification time.' },
    ext: { type: 'string' },
    dir: { type: 'boolean' },
    ref: { type: 'string', description: 'Citable ref://file reference (files only).' },
    refStatus: {
      type: 'string',
      enum: ['fresh', 'stale', 'missing', 'unknown'],
      description: 'Evidence freshness label (name hits are always "unknown": the name index stores no bytes).',
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

const SEARCH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    query: { type: 'string' },
    mode: { type: 'string', enum: ['names', 'content', 'count'] },
    total: { type: 'integer', description: 'Primary match count: names mode is the name-index total across every configured root; content/count modes are the content count when known.' },
    totalCount: { type: 'integer', description: 'Alias of total: total matches when the index knows them (engine total or content count).' },
    nameCount: { type: 'integer', description: 'Count mode only: name-index matches (global across configured roots), when the name query returned a count.' },
    totalAllRoots: {
      type: 'integer',
      description: 'Names mode only: the global match count across every configured root. Present when scope=workspace narrowed the result, since total is then not a workspace count.',
    },
    returned: { type: 'integer' },
    offset: { type: 'integer' },
    nextOffset: { type: 'integer', description: 'Offset of the next page; absent when this page is the last one.' },
    truncated: { type: 'boolean' },
    hasMore: { type: 'boolean', description: 'True when paging further can still return rows (same as truncated).' },
    consumed: { type: 'integer', description: 'Raw store rows this page consumed (nextOffset - offset).' },
    truncation: TRUNCATION_SCHEMA,
    detail: { type: 'string', enum: ['full', 'compact'], description: 'Present when the caller requested compact (evidence-free) hits.' },
    indexing: { type: 'boolean' },
    tookMs: { type: 'number' },
    hits: { type: 'array', items: HIT_SCHEMA },
    contentHits: { type: 'array', items: CONTENT_HIT_SCHEMA, description: 'Content hits for mode "content".' },
    contentCount: {
      type: 'object',
      additionalProperties: false,
      properties: {
        value: { type: 'integer' },
        kind: { type: 'string', enum: ['exact', 'bounded', 'unknown'] },
        limit: { type: 'integer' },
      },
    },
    budget: BUDGET_SCHEMA,
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
} as const

const STATUS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    running: { type: 'boolean' },
    version: { type: 'string' },
    platform: { type: 'string' },
    roots: { type: 'array', items: { type: 'string' } },
    entries: { type: 'integer' },
    files: { type: 'integer' },
    dirs: { type: 'integer' },
    watching: { type: 'boolean' },
    watchDegraded: { type: 'boolean' },
    watchReason: { type: 'string' },
    watchRoots: { type: 'integer' },
    refreshFallback: { type: 'boolean' },
    incrementalRefresh: { type: 'boolean', description: 'Fallback refreshes only watcher-less roots.' },
    watchUnwatchedRoots: { type: 'array', items: { type: 'string' } },
    refreshMode: { type: 'string', description: 'Last fallback refresh mode (incremental|full).' },
    refreshReason: { type: 'string' },
    refreshScannedRoots: { type: 'array', items: { type: 'string' } },
    refreshSkippedRoots: { type: 'array', items: { type: 'string' } },
    refreshEntries: { type: 'integer' },
    refreshTookMs: { type: 'integer' },
    refreshAt: { type: 'integer' },
    // 0.20.0 engine resource/observability fields (all optional; absent when the
    // running engine does not report them).
    generation: { type: 'integer', description: 'Index generation (moves on every real mutation).' },
    builtAt: { type: 'integer', description: 'Epoch ms of the snapshot the index was built from.' },
    rssBytes: { type: 'integer', description: 'Engine resident set size in bytes.' },
    hwmBytes: { type: 'integer', description: 'Engine peak resident set size in bytes.' },
    watchDirs: { type: 'integer', description: 'Directories watched by the native watcher.' },
    watchLimit: { type: 'integer', description: 'Configured watcher directory budget (0 = no budget/unknown).' },
    watchLimited: { type: 'boolean', description: 'The watcher hit its directory budget; the rest is refreshed periodically.' },
    watchInitializing: { type: 'boolean', description: 'The asynchronous watcher install is still running.' },
    snapshotBytes: { type: 'integer', description: 'On-disk snapshot size in bytes.' },
    saveBytes: { type: 'integer', description: 'Bytes written by the last snapshot save.' },
    saveMs: { type: 'integer', description: 'Wall-clock cost of the last snapshot save, in ms.' },
    saveCount: { type: 'integer', description: 'Snapshot saves since engine start.' },
    queueDepth: { type: 'integer', description: 'Pending refresh/scan work items.' },
    queryCount: { type: 'integer', description: 'Completed engine query RPCs since start.' },
    lastQueryMs: { type: 'number', description: 'Wall-clock cost of the last query RPC, in ms.' },
    recentQueryMs: { type: 'array', items: { type: 'number' }, description: 'Recent query durations in ms, newest last.' },
    heapBytes: { type: 'integer', description: 'Go heap size in bytes.' },
    numGC: { type: 'integer', description: 'Completed GC cycles.' },
    refreshBackoffMs: { type: 'integer', description: 'Current refresh retry backoff in ms.' },
    // 0.20.2 unwatched-root freshness observability (absent on older engines).
    unwatchedRefreshMs: { type: 'integer', description: 'Refresh cadence for roots without a native watcher, in ms.' },
    nextRefreshAt: { type: 'integer', description: 'Epoch ms of the next scheduled fallback refresh.' },
    refreshRounds: { type: 'integer', description: 'Completed fallback refresh rounds since engine start.' },
    refreshSkippedByPressure: { type: 'integer', description: 'Fallback refreshes skipped by the pressure gate since start.' },
    content: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        ...CONTENT_STATE_SCHEMA.properties,
        // 0.20.0 content observability: coverage/db bytes/refresh mode. Passed
        // through opaquely (content owns the shape), so nested fields stay open.
        diagnostics: {
          type: 'object',
          additionalProperties: true,
          description: 'Content coverage/db-byte/refresh diagnostics (shape owned by the content layer).',
        },
      },
    },
    scope: {
      type: 'object',
      additionalProperties: false,
      properties: {
        notSearchable: { type: 'array', items: { type: 'string' } },
        notReadable: { type: 'array', items: { type: 'string' } },
        notIndexed: { type: 'array', items: { type: 'string' } },
        activeRules: { type: 'integer' },
        outputBudgetChars: { type: 'integer' },
        rerankCommand: { type: 'string' },
        ocrCommand: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    usn: { type: 'boolean' },
    scanning: { type: 'boolean' },
    stateDir: { type: 'string' },
    binary: { type: 'string' },
    warning: { type: 'string' },
    error: { type: 'string' },
    errorInfo: ERROR_INFO_SCHEMA,
  },
} as const

const REBUILD_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    started: { type: 'boolean' },
    error: { type: 'string' },
    errorInfo: ERROR_INFO_SCHEMA,
  },
} as const

/** Validated rebuild scope: only narrowing of the configured roots/excludes is allowed. */
export interface RebuildScope {
  roots?: string[]
  excludes?: string[]
}

/** Validation result for one locator_rebuild argument pair. */
export type RebuildScopeResult =
  | { ok: true; roots?: string[]; excludes?: string[] }
  | { ok: false; error: string }

/**
 * Restrict a locator_rebuild request to the configured scope.
 *
 * Root replacement is the dangerous knob: letting the model pick an arbitrary
 * absolute path would turn a search tool into a disk-indexer for directories
 * the operator never configured. A requested root must therefore canonicalize
 * (symlinks resolved) to a configured root or a directory below one; requested
 * excludes must be drawn from the configured exclude list. Everything is passed
 * through the same canonicalization as /reveal and /open.
 * @param roots - requested replacement roots, if any.
 * @param excludes - requested replacement excludes, if any.
 * @param configuredRoots - the plugin's configured (resolved) roots.
 * @param configuredExcludes - the plugin's configured excludes.
 * @returns the canonical narrowed scope, or the first refusal.
 */
export function validateRebuildArguments(
  roots: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  configuredRoots: readonly string[],
  configuredExcludes: readonly string[],
): RebuildScopeResult {
  let narrowedRoots: string[] | undefined
  if (roots !== undefined) {
    if (!Array.isArray(roots) || roots.length === 0) {
      return { ok: false, error: 'roots must be a non-empty array of directory paths' }
    }
    narrowedRoots = []
    for (const root of roots) {
      if (typeof root !== 'string' || root.trim() === '') {
        return { ok: false, error: 'roots must contain non-empty directory paths' }
      }
      const resolved = resolveWithinRoots(root.trim(), configuredRoots)
      if (resolved === undefined) {
        return { ok: false, error: 'root is outside the configured roots: ' + root }
      }
      if (!narrowedRoots.includes(resolved.path)) narrowedRoots.push(resolved.path)
    }
  }
  let narrowedExcludes: string[] | undefined
  if (excludes !== undefined) {
    if (!Array.isArray(excludes)) return { ok: false, error: 'excludes must be an array of configured globs' }
    const allowed = new Set(configuredExcludes)
    narrowedExcludes = []
    for (const exclude of excludes) {
      if (typeof exclude !== 'string' || exclude.trim() === '') {
        return { ok: false, error: 'excludes must contain non-empty globs' }
      }
      if (!allowed.has(exclude)) {
        return { ok: false, error: 'exclude is not one of the configured excludes: ' + exclude }
      }
      if (!narrowedExcludes.includes(exclude)) narrowedExcludes.push(exclude)
    }
  }
  return {
    ok: true,
    ...(narrowedRoots === undefined ? {} : { roots: narrowedRoots }),
    ...(narrowedExcludes === undefined ? {} : { excludes: narrowedExcludes }),
  }
}

/** Optional collaborators for locator_search (content mode + scope + budget). */
export interface SearchToolOptions {
  /** Content index backing mode "content"/"count"; omitted disables those modes. */
  content?: ContentIndex
  /** Lazy content boot hook. */
  ensure?: () => void
  /** Layered ignore rules; omitted means no filtering. */
  scope?: Scope
  /** Soft result budget in characters; omitted uses the catalog default. */
  budgetChars?: number
}

/** Modes locator_search understands; the default keeps the historical behavior. */
export type SearchMode = 'names' | 'content' | 'count'

/** Parse one search mode, defaulting to "names". */
export function parseSearchMode(value: unknown): SearchMode {
  return value === 'content' || value === 'count' ? value : 'names'
}

/** Bounded content-hit render shared by search/find-style output. */
function contentHitLines(hits: ReadonlyArray<Record<string, unknown>>): string[] {
  return hits.map((hit, index) => {
    const title = typeof hit.title === 'string' ? hit.title : typeof hit.path === 'string' ? hit.path : ''
    const line = typeof hit.line === 'number' ? ' (line ' + String(hit.line) + ')' : ''
    const refLine = typeof hit.ref === 'string' ? '\n   ref ' + hit.ref : ''
    return String(index + 1) + '. [' + String(hit.kind ?? 'file') + '] ' + title + ' — ' + String(hit.snippet ?? '') + '\n   ' + String(hit.path ?? '') + line + refLine
  })
}

const SEARCH_DESCRIPTION = [
  'Search a persistent local file-name index in milliseconds (dsh-locator).',
  '',
  'This is not a workspace walk: a background scanner keeps an index of the configured roots in a snapshot, so a query over hundreds of thousands of files returns in a few milliseconds even after a restart.',
  '',
  'Query language (Everything-flavored): bare words are ANDed substrings of the file name; !word negates; "two words" keeps a phrase; *.go and ? are wildcards; ext:ts,js / ext:!tmp; path:src matches the full path; size:>10mb, size:1kb..2mb; dm:today, dm:yesterday, dm:thisweek, dm:2026-01-01, dm:>=2026-01-01; folder: or file: restrict the kind; case:1 and wholeword:1 tune matching.',
  '',
  'Modes: names (default) searches file names/paths; content searches file and session bodies through the content index; count only returns how many matches exist. Every result reports totalCount, truncated, nextOffset and a budget block, so a caller can page instead of guessing.',
  '',
  'Use it when the user remembers part of a name or path but not where it lives (whole disk / home directory), or for filters like "the PDFs over 50 MB from this week". Use grep for file contents and glob for a known workspace path. Results are limited to the roots the plugin was configured with; locator_status reports them.',
].join('\n')

/** Build the locator_search tool. */
export function makeSearchTool(rt: LocatorRuntime, options: SearchToolOptions = {}) {
  const scopeRules = options.scope
  const budgetChars = options.budgetChars ?? DEFAULT_OUTPUT_BUDGET_CHARS
  return defineTool({
    name: 'locator_search',
    description: SEARCH_DESCRIPTION,
    parameters: {
      query: { type: 'string', required: true, description: 'Search expression, Everything-style. Empty text matches everything.' },
      mode: { type: 'string', enum: ['names', 'content', 'count'], description: 'names (default) searches file names; content searches file/session bodies; count only returns match counts.' },
      limit: { type: 'integer', description: 'Maximum hits to return (default 10, at most ' + String(rt.config.maxResults) + '). The final page is always sliced to this size.' },
      headLimit: { type: 'integer', description: 'Explicit page-size cap (min of limit and headLimit is used).' },
      offset: { type: 'integer', description: 'Skip this many sorted matches (pagination). Use nextOffset from the previous page; pages never skip a hit the budget deferred.' },
      contextLines: { type: 'integer', description: 'Lines of surrounding file content to include with content-mode file hits (0-10, default 0).' },
      budgetChars: { type: 'integer', description: 'Soft cap on the serialized result size in characters (default 8000; 0 disables the budget and its trimming).' },
      detail: { type: 'string', enum: ['full', 'compact'], description: 'full (default) keeps ref/freshness/permissions evidence; compact keeps only kind/path/name/title/snippet/line/score/ref and drops hash/provenance/freshness/permissions/refStatus/modified.' },
      evidenceLimit: { type: 'integer', description: 'Evidence-bearing rows in full mode (default 10, at most 50); later rows keep the cheap fields and their ref.' },
      includeHash: { type: 'boolean', description: 'Content mode: compute a sha256 hash per file hit (default false; skipped on slow/network filesystems).' },
      sort: { type: 'string', enum: ['name', 'path', 'size', 'mtime', 'ext'], description: 'Sort key (default name).' },
      desc: { type: 'boolean', description: 'Sort descending.' },
      regex: { type: 'boolean', description: 'Treat the whole query as a regular expression over the file name.' },
      caseSensitive: { type: 'boolean', description: 'Match letter case.' },
      wholeWord: { type: 'boolean', description: 'Require word boundaries around each bare term.' },
      filesOnly: { type: 'boolean', description: 'Return files only.' },
      dirsOnly: { type: 'boolean', description: 'Return directories only.' },
      countLimit: { type: 'integer', description: 'Count mode: counting cap for the exact content count (default 1000, at most 5000).' },
      scope: {
        type: 'string',
        enum: ['workspace', 'all'],
        description: 'workspace (default) restricts hits to the caller cwd when that cwd is inside an indexed root; all searches every configured root.',
      },
    },
    output: {
      schema: SEARCH_OUTPUT,
      render: (_args, value) => {
        const v = value as {
          ok: boolean
          query?: string
          mode?: string
          total?: number
          totalCount?: number
          nameCount?: number
          totalAllRoots?: number
          returned?: number
          offset?: number
          nextOffset?: number
          truncated?: boolean
          hasMore?: boolean
          consumed?: number
          truncation?: { reason?: string; dropped?: number; consumed?: number }
          detail?: string
          indexing?: boolean
          tookMs?: number
          hits?: Array<SearchHit & { ref?: string; refStatus?: string; freshness?: { state?: string }; permissions?: { read?: string } }>
          contentHits?: Array<Record<string, unknown>>
          contentCount?: { value: number; kind: 'exact' | 'bounded' | 'unknown' }
          budget?: { dropped?: number; limitChars?: number }
          warnings?: string[]
          warningHints?: Record<string, string>
          scope?: string
          scopeFallback?: string
          shortQueryFallback?: boolean
          error?: string
          errorInfo?: { code?: string; hint?: string }
        }
        if (!v.ok) {
          const hint = v.errorInfo?.hint === undefined ? '' : ' — ' + v.errorInfo.hint
          return [{ type: 'text', text: 'locator_search failed: ' + (v.error ?? 'unknown error') + hint }]
        }
        const mode = v.mode ?? 'names'
        const truncReason = v.truncation?.reason === undefined ? '' : '; reason: ' + v.truncation.reason
        const budgetNote = v.truncated === true || v.hasMore === true
          ? '\n(truncated' + truncReason + (v.nextOffset === undefined ? '' : '; nextOffset ' + String(v.nextOffset)) + (v.budget?.dropped === undefined || v.budget.dropped === 0 ? '' : '; ' + String(v.budget.dropped) + ' hit(s) over the ' + String(v.budget.limitChars ?? 0) + '-char budget') + ')'
          : ''
        const warnings = v.warnings === undefined || v.warnings.length === 0 ? '' : ' (warnings: ' + [...new Set(v.warnings)].join(', ') + ')'
        const hintText = v.warningHints === undefined
          ? ''
          : '\n(hints: ' + Object.entries(v.warningHints).map(([code, hint]) => code + ' — ' + hint).join(' | ') + ')'
        const shortNote = v.shortQueryFallback === true ? ' (short-query fallback: approximate page)' : ''
        const detailNote = v.detail === 'compact' ? ' (compact: evidence fields omitted)' : ''
        const scopeNote = v.scope === undefined ? '' : ' (scope: ' + v.scope + (v.scopeFallback === undefined ? '' : '; ' + v.scopeFallback) + ')'
        if (mode === 'content') {
          const hits = v.contentHits ?? []
          const count = v.contentCount === undefined
            ? ''
            : v.contentCount.kind === 'bounded'
              ? ', count ≥ ' + String(v.contentCount.value)
              : v.contentCount.kind === 'exact'
                ? ', count ' + String(v.contentCount.value)
                : ', count unavailable'
          const lines = contentHitLines(hits)
          return [{ type: 'text', text: 'locator_search (content) ' + JSON.stringify(v.query ?? '') + ': ' + String(hits.length) + ' hit(s)' + count + ' in ' + (v.tookMs ?? 0).toFixed(1) + ' ms' + scopeNote + warnings + detailNote + shortNote + budgetNote + hintText + '\n' + lines.join('\n') }]
        }
        if (mode === 'count') {
          const content = v.contentCount === undefined
            ? ''
            : v.contentCount.kind === 'unknown'
              ? ', content count unavailable'
              : ', content ' + String(v.contentCount.value) + (v.contentCount.kind === 'bounded' ? '+' : '')
          const names = v.nameCount === undefined ? ', names count unavailable' : ', names ' + String(v.nameCount) + ' (all roots)'
          return [{ type: 'text', text: 'locator_search (count) ' + JSON.stringify(v.query ?? '') + ': primary ' + String(v.total ?? v.totalCount ?? 0) + names + content + warnings + hintText }]
        }
        const hits = v.hits ?? []
        const globalNote = v.totalAllRoots === undefined ? '' : ' (total is across all configured roots, not just the workspace)'
        const lines = [
          'locator_search ' + JSON.stringify(v.query ?? '') + ': ' + String(v.total ?? 0) + ' match(es)' + globalNote +
            (v.truncated === true || v.hasMore === true ? ', showing ' + String(v.returned ?? 0) : '') +
            ' in ' + (v.tookMs ?? 0).toFixed(1) + ' ms' +
            (v.indexing === true ? ' (initial scan still running; results are partial)' : '') +
            scopeNote +
            warnings + detailNote,
        ]
        for (const hit of hits) {
          const suffix = hit.dir ? '/' : ''
          const size = hit.dir ? '' : '  ' + formatSize(hit.size)
          lines.push(hit.path + suffix + size)
          if (hit.ref !== undefined) lines.push('   ref ' + hit.ref)
          if (hit.permissions?.read === 'denied') lines.push('   read denied by scope rules')
        }
        if (budgetNote !== '') lines.push(budgetNote)
        if (hintText !== '') lines.push(hintText)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => {
        const v = value as { ok: boolean; total?: number; truncated?: boolean; hits?: SearchHit[]; contentHits?: Array<Record<string, unknown>> }
        if (!v.ok) return { shape: 'paths', paths: [], truncated: false, total: 0 }
        const paths = (v.hits ?? []).map(hit => hit.path + (hit.dir ? '/' : ''))
        for (const hit of v.contentHits ?? []) if (typeof hit.path === 'string') paths.push(hit.path)
        return {
          shape: 'paths',
          paths,
          truncated: v.truncated === true,
          total: v.total ?? 0,
        }
      },
    },
    // locator_search only reads the two indexes; sibling read-only calls may
    // run in the same parallel group (a lazy content boot is idempotent).
    isConcurrencySafe: () => true,
    presentResult: (_args, result) => {
      const meta = result.meta
      if (!isPathsMeta(meta)) return undefined
      return {
        card: 'search' as const,
        shape: 'paths' as const,
        paths: meta.paths,
        truncated: meta.truncated,
        total: meta.total,
      }
    },
    async execute(args, exec) {
      const mode = parseSearchMode(args.mode)
      const limit = pageSize(args.limit, args.headLimit, rt.config.maxResults)
      const offset = Math.max(0, Math.trunc(args.offset ?? 0))
      const scope: 'workspace' | 'all' = args.scope === 'all' ? 'all' : 'workspace'
      const callerCwd = exec?.agent?.session?.header?.cwd
      const caller: CallerIdentity = {
        ...(exec?.agent?.session?.id === undefined ? {} : { sessionId: exec.agent.session.id }),
        ...(callerCwd === undefined ? {} : { cwd: callerCwd }),
      }
      const contextLines = Math.max(0, Math.min(10, Math.trunc(args.contextLines ?? 0)))
      const detail: HitDetail = args.detail === 'compact' ? 'compact' : 'full'
      const evidenceLimit = evidenceLimitOf(detail, args.evidenceLimit)
      const limitChars = outputBudgetOf(args.budgetChars, budgetChars)
      const scopeNoteOf = (value: 'workspace' | 'all', cwdIndexed: boolean) => value === 'all' || !cwdIndexed ? 'roots' as const : 'workspace' as const
      if (mode === 'content' || mode === 'count') {
        if (options.content === undefined) {
          return {
            ok: false as const,
            query: args.query,
            mode,
            error: 'content-index-unavailable',
            errorInfo: errorInfoOf('content-index-unavailable'),
            hits: [],
            contentHits: [],
            warnings: [],
          }
        }
        options.ensure?.()
        // 0.20.0 P0-15: report the real wall-clock cost of the content query;
        // this used to be 0 because no tookMs was emitted for content modes.
        const contentStarted = Date.now()
        const request: ContentRequest = {
          query: args.query,
          limit: mode === 'count' ? 1 : limit,
          offset: mode === 'count' ? 0 : offset,
          scope,
          detail,
          evidenceLimit,
          ...(args.includeHash === true ? { includeHash: true } : {}),
          ...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive }),
          ...(args.wholeWord === undefined ? {} : { wholeWord: args.wholeWord }),
          ...(mode === 'count' ? { count: 'exact' as const } : {}),
          ...(args.countLimit === undefined ? {} : { countLimit: args.countLimit }),
        }
        try {
          const result = await runContentSearchRequest(options.content, request, rt.roots, false, caller, contentScopeOptionsOf(rt))
          if (!result.ok) {
            const errorHints = warningHintsOf(result.warnings)
            return {
              ok: false as const,
              query: args.query,
              mode,
              error: result.error,
              errorInfo: errorInfoOf(result.error),
              warnings: result.warnings,
              ...(errorHints === undefined ? {} : { warningHints: errorHints }),
              hits: [],
              contentHits: [],
              state: result.state,
            }
          }
          if (mode === 'count') {
            // Count mode asks both stores: the content count is the primary
            // number (the mode's purpose), the name-engine count is additive
            // and reported separately as nameCount. A failed name count must
            // never be reported as a zero content count.
            let namesTotal: number | undefined
            const countWarnings = [...result.warnings]
            try {
              rt.start()
              const nameResult = await rt.search({
                query: args.query,
                limit: 1,
                offset: 0,
                sort: 'name',
                desc: false,
                regex: args.regex ?? false,
                caseSensitive: args.caseSensitive ?? false,
                wholeWord: args.wholeWord ?? false,
                filesOnly: args.filesOnly ?? false,
                dirsOnly: args.dirsOnly ?? false,
              })
              namesTotal = nameResult.total
            } catch (error) {
              countWarnings.push('name-count-unavailable')
              countWarnings.push('name-count-failed:' + messageOf(error).slice(0, 120))
            }
            if (result.count.kind === 'bounded') countWarnings.push('bounded-count')
            if (result.shortQueryFallback === true) countWarnings.push('query-degraded')
            const contentKnown = result.count.kind !== 'unknown'
            const primary = contentKnown ? result.count.value : namesTotal
            const uniqueWarnings = [...new Set(countWarnings)]
            const countHints = warningHintsOf(uniqueWarnings)
            return {
              ok: true as const,
              query: args.query,
              mode,
              ...(primary === undefined ? {} : { total: primary, totalCount: primary }),
              ...(namesTotal === undefined ? {} : { nameCount: namesTotal }),
              returned: 0,
              offset: 0,
              truncated: result.count.kind === 'bounded',
              hasMore: false,
              consumed: 0,
              hits: [],
              contentHits: [],
              contentCount: result.count,
              budget: { limitChars, usedChars: 0, truncated: false, dropped: 0 },
              warnings: uniqueWarnings,
              ...(countHints === undefined ? {} : { warningHints: countHints }),
              state: result.state,
              scope: result.scope,
              ...(result.scopeFallback === undefined ? {} : { scopeFallback: result.scopeFallback }),
              ...(result.shortQueryFallback === true ? { shortQueryFallback: true } : {}),
              ...(detail === 'compact' ? { detail } : {}),
              tookMs: Date.now() - contentStarted,
            }
          }
          const warnings = [...result.warnings]
          const keepVisible = (hit: { path: string }): boolean => scopeRules === undefined
            ? true
            : scopeRules.isSearchable(hit.path) && scopeRules.isIndexable(hit.path) && scopeRules.isReadable(hit.path)
          const selected = selectPage(result.hits, limit, limitChars, keepVisible)
          const scopeDropped = selected.dropped.filter(drop => drop.reason === 'scope').length
          if (scopeDropped > 0) warnings.push('scope-filtered:' + String(scopeDropped))
          let items = selected.items
          let keptIndices = selected.keptIndices
          const dropped = [...selected.dropped]
          let budget = selected.budget
          if (contextLines > 0) {
            const withContext = await Promise.all(items.map(async hit => {
              if (hit.kind !== 'file' || hit.line === undefined) return hit
              const context = await readContextLines(hit.path, hit.line, contextLines)
              return context === undefined ? hit : { ...hit, context: context.lines, contextStart: context.start }
            }))
            // Context lines add bytes after the scope/budget selection, so trim
            // once more and keep the raw positions in sync with the final rows.
            const rebudget = applyOutputBudget(withContext, limitChars)
            for (let index = rebudget.items.length; index < keptIndices.length; index++) {
              dropped.push({ index: keptIndices[index]!, reason: 'budget' })
            }
            keptIndices = keptIndices.slice(0, rebudget.items.length)
            items = rebudget.items
            budget = rebudget.budget
          }
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
          const contentHints = warningHintsOf(uniqueWarnings)
          const totalKnown = result.count.kind === 'unknown' ? undefined : result.count.value
          return {
            ok: true as const,
            query: args.query,
            mode,
            ...(totalKnown === undefined ? {} : { total: totalKnown, totalCount: totalKnown }),
            returned: items.length,
            offset,
            ...(advance.nextOffset === undefined ? {} : { nextOffset: advance.nextOffset }),
            truncated: advance.truncated,
            hasMore: advance.hasMore,
            consumed: advance.consumed,
            ...(advance.truncation === undefined ? {} : { truncation: advance.truncation }),
            hits: [],
            contentHits: items,
            contentCount: result.count,
            budget,
            warnings: uniqueWarnings,
            ...(contentHints === undefined ? {} : { warningHints: contentHints }),
            state: result.state,
            scope: result.scope,
            tookMs: Date.now() - contentStarted,
            ...(result.scopeFallback === undefined ? {} : { scopeFallback: result.scopeFallback }),
            ...(result.shortQueryFallback === true ? { shortQueryFallback: true } : {}),
            ...(detail === 'compact' ? { detail } : {}),
          }
        } catch (error) {
          return {
            ok: false as const,
            query: args.query,
            mode,
            error: messageOf(error),
            errorInfo: errorInfoOf('content-index-error', messageOf(error)),
          }
        }
      }
      const cwdIsIndexed = callerCwd !== undefined && rt.roots.some(root => withinRoots(callerCwd, [root]))
      const narrowToCwd = scope === 'workspace' && cwdIsIndexed
      const visibility = scopeNoteOf(scope, cwdIsIndexed)
      // Workspace narrowing happens after the engine page, so the first window is
      // wider than the page and the filler keeps fetching (bounded) until the
      // page is full or the row bound is exhausted.
      const fetchSize = narrowToCwd ? Math.min(rt.config.maxResults, Math.max(limit * 5, 50)) : limit
      try {
        rt.start()
        const window = await fetchNamePage(
          async page => await rt.search({
            query: args.query,
            limit: page.limit,
            offset: page.offset,
            sort: args.sort ?? 'name',
            desc: args.desc ?? false,
            regex: args.regex ?? false,
            caseSensitive: args.caseSensitive ?? false,
            wholeWord: args.wholeWord ?? false,
            filesOnly: args.filesOnly ?? false,
            dirsOnly: args.dirsOnly ?? false,
          }),
          {
            offset,
            limit,
            fetchSize,
            maxRows: narrowToCwd ? 250 : limit,
            keep: hit => {
              if (narrowToCwd && !withinRoots(hit.path, [callerCwd as string])) return 'narrow'
              if (scopeRules !== undefined && !scopeRules.isSearchable(hit.path)) return 'scope'
              return 'keep'
            },
          },
        )
        const observedAt = Date.now()
        const mapped = window.items.map((hit, index) => {
          const readable = scopeRules?.readability(hit.path) ?? { read: 'allowed' as const, reason: 'name hits come from the configured index roots' }
          const base = {
            path: hit.path,
            name: hit.name,
            size: hit.size,
            mtime: hit.mtime,
            ext: hit.ext,
            dir: hit.dir,
            ...(hit.dir || readable.read !== 'allowed' ? {} : { ref: fileRef({ path: hit.path, mtime: hit.mtime, size: hit.size }) }),
          }
          if (!evidenceVisible(index, detail, evidenceLimit)) return base
          return {
            ...base,
            modified: new Date(hit.mtime).toISOString(),
            refStatus: 'unknown' as const,
            freshness: { state: 'unknown' as const, observedAt, mtime: hit.mtime },
            permissions: { read: readable.read, visibility, reason: readable.reason },
          }
        })
        // The budget measures the mapped payload (evidence fields included), and
        // the cursor is recomputed from its raw positions so deferred rows stay
        // reachable on the next page.
        const budgeted = applyOutputBudget(mapped, limitChars)
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
        const warnings: string[] = []
        if (window.scopeDropped > 0) warnings.push('scope-filtered:' + String(window.scopeDropped))
        // A workspace page that stays empty past the bounded fill is reported
        // explicitly: an empty page must not read as "this file does not exist".
        if (narrowToCwd && window.items.length === 0 && offset === 0) warnings.push('workspace-empty')
        const uniqueWarnings = [...new Set(warnings)]
        const hints = warningHintsOf(narrowToCwd ? [...uniqueWarnings, 'total-is-global'] : uniqueWarnings)
        return {
          ok: true as const,
          query: args.query,
          mode: 'names' as const,
          total: window.total,
          totalCount: window.total,
          ...(narrowToCwd ? { totalAllRoots: window.total } : {}),
          returned: hits.length,
          offset,
          ...(advance.nextOffset === undefined ? {} : { nextOffset: advance.nextOffset }),
          truncated: advance.truncated,
          hasMore: advance.hasMore,
          consumed: advance.consumed,
          ...(advance.truncation === undefined ? {} : { truncation: advance.truncation }),
          indexing: window.indexing === true,
          tookMs: window.tookMs,
          hits,
          budget: budgeted.budget,
          ...(uniqueWarnings.length === 0 ? {} : { warnings: uniqueWarnings }),
          ...(hints === undefined ? {} : { warningHints: hints }),
          scope,
          ...(scope === 'workspace' && !cwdIsIndexed ? { scopeFallback: 'cwd-not-indexed; searched every configured root' } : {}),
          ...(detail === 'compact' ? { detail } : {}),
        }
      } catch (error) {
        return { ok: false as const, query: args.query, error: messageOf(error), errorInfo: errorInfoOf('engine-error', messageOf(error)) }
      }
    },
  })
}



/** One symbol row shared by outline/symbol/repo-map output schemas. */
const SYMBOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    line: { type: 'integer', required: true, description: '1-based declaration line.' },
    scope: { type: 'string', description: 'Enclosing type/namespace, when known.' },
    language: { type: 'string' },
  },
} as const

/** One symbol hit with its file location and evidence ref. */
const SYMBOL_HIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    name: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    line: { type: 'integer', required: true },
    scope: { type: 'string' },
    language: { type: 'string' },
    ref: { type: 'string', description: 'ref://file evidence reference (absent when the path is not readable).' },
  },
} as const

const OUTLINE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    path: { type: 'string' },
    format: { type: 'string', description: 'Extracted document format (pdf, docx, ...) when the index stored one.' },
    symbols: { type: 'array', items: SYMBOL_SCHEMA },
    count: { type: 'integer' },
    totalCount: { type: 'integer', description: 'Symbols known for the file before the page cap.' },
    truncated: { type: 'boolean' },
    budget: BUDGET_SCHEMA,
    state: CONTENT_STATE_SCHEMA,
    warnings: { type: 'array', items: { type: 'string' } },
    error: { type: 'string' },
    errorInfo: ERROR_INFO_SCHEMA,
  },
} as const

const SYMBOL_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    name: { type: 'string' },
    symbols: { type: 'array', items: SYMBOL_HIT_SCHEMA },
    count: { type: 'integer', description: 'Symbols returned on this page.' },
    totalCount: { type: 'integer', description: 'Symbols matched before the page cap (the store caps at 200).' },
    truncated: { type: 'boolean' },
    budget: BUDGET_SCHEMA,
    state: CONTENT_STATE_SCHEMA,
    warnings: { type: 'array', items: { type: 'string' } },
    error: { type: 'string' },
    errorInfo: ERROR_INFO_SCHEMA,
  },
} as const

const REPO_MAP_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    tokenBudget: { type: 'integer' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          ref: { type: 'string' },
          format: { type: 'string' },
          symbols: { type: 'array', items: SYMBOL_SCHEMA },
        },
      },
    },
    count: { type: 'integer', description: 'Files included in the map.' },
    tokensEstimated: { type: 'integer', description: 'Estimated tokens (characters / 4) of the included files.' },
    truncated: { type: 'boolean' },
    state: CONTENT_STATE_SCHEMA,
    warnings: { type: 'array', items: { type: 'string' } },
    error: { type: 'string' },
    errorInfo: ERROR_INFO_SCHEMA,
  },
} as const

/** Engine status through the runtime's 1 s stats cache when it provides one. */
async function statusEngine(rt: LocatorRuntime): Promise<EngineStatus | undefined> {
  const candidate = (rt as unknown as {
    engineStatusCached?: (ttlMs?: number) => Promise<EngineStatus | undefined>
  }).engineStatusCached
  if (typeof candidate === 'function') return await candidate.call(rt, 1_000)
  return await rt.engineStatus()
}

/** Read-only 0.20.0 content diagnostics (coverage/db bytes/refresh mode). */
function contentDiagnosticsOf(content: ContentIndex): Record<string, unknown> {
  const candidate = (content as unknown as { diagnostics?: () => unknown }).diagnostics
  if (typeof candidate !== 'function') return {}
  try {
    const value = candidate.call(content)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? { diagnostics: value } : {}
  } catch {
    return {}
  }
}

/** Snapshot the content state for a symbol view, tolerating embedder fakes. */
function contentStateOf(content: ContentIndex): ContentState | undefined {
  try {
    if (typeof content.status === 'function') return content.status()
  } catch { /* a closed/fake store has no state */ }
  return undefined
}

/** Copy one extracted symbol into the bounded output shape. */
function symbolRow(symbol: CodeSymbol | SymbolMatch): { name: string; kind: CodeSymbol['kind']; line: number; scope?: string; language?: string } {
  const language = 'language' in symbol && typeof symbol.language === 'string' && symbol.language !== '' ? symbol.language : undefined
  return {
    name: symbol.name,
    // The store only writes extractor SymbolKind values; the lookup row widens
    // it to string for forward compatibility.
    kind: symbol.kind as CodeSymbol['kind'],
    line: symbol.line,
    ...(symbol.scope === undefined ? {} : { scope: symbol.scope }),
    ...(language === undefined ? {} : { language }),
  }
}

/** A file-level evidence ref for symbol results (path identity only). */
function symbolFileRef(path: string): string {
  return fileRef({ path })
}

/** Build locator_outline: every stored symbol for one indexed file. */
export function makeOutlineTool(content: ContentIndex, ensure?: () => void, roots: readonly string[] = [], scope?: Scope, budgetChars = DEFAULT_OUTPUT_BUDGET_CHARS) {
  return defineTool({
    name: 'locator_outline',
    description: [
      'List the code symbols stored for one indexed file (dsh-locator): functions, classes, methods, types, Markdown headings, in declaration order with 1-based lines.',
      '',
      'Use it before reading a big file to find the right declaration, or to confirm that a file was symbol-indexed. The symbol layer is heuristic and line-oriented (no AST); files above the symbol size cap keep no symbols. The path must live inside the configured index roots.',
    ].join('\n'),
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute file path inside the indexed roots.' },
      maxSymbols: { type: 'integer', description: 'Maximum symbols to return (default 200, at most 200).' },
    },
    output: {
      schema: OUTLINE_OUTPUT,
      render: (_args, value) => {
        const v = value as { ok: boolean; path?: string; format?: string; symbols?: Array<{ name: string; kind: string; line: number; scope?: string }>; count?: number; totalCount?: number; truncated?: boolean; warnings?: string[]; error?: string }
        if (!v.ok) return [{ type: 'text', text: 'locator_outline failed: ' + (v.error ?? 'unknown error') }]
        const lines = ['locator_outline ' + (v.path ?? '') + (v.format === undefined ? '' : ' (' + v.format + ')') + ': ' + String(v.totalCount ?? v.symbols?.length ?? 0) + ' symbol(s)']
        for (const symbol of v.symbols ?? []) {
          lines.push('  ' + String(symbol.line) + ': ' + symbol.kind + ' ' + (symbol.scope === undefined ? '' : symbol.scope + '.') + symbol.name)
        }
        if (v.truncated === true) lines.push('  (truncated; raise maxSymbols)')
        if (v.warnings !== undefined && v.warnings.length > 0) lines.push('  warnings: ' + v.warnings.join(', '))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      ensure?.()
      const path = args.path.trim()
      const state = contentStateOf(content)
      if (path === '') {
        return {
          ok: false as const,
          path,
          symbols: [],
          error: 'path is empty',
          errorInfo: errorInfoOf('invalid-arguments', 'path is empty', { hint: 'Pass an absolute file path inside the configured index roots.' }),
          ...(state === undefined ? {} : { state }),
        }
      }
      const resolved = resolveWithinRoots(path, roots)
      if (resolved === undefined) {
        return {
          ok: false as const,
          path,
          symbols: [],
          error: 'content-path-denied',
          errorInfo: errorInfoOf('content-path-denied'),
          warnings: ['path-outside-roots'],
          ...(state === undefined ? {} : { state }),
        }
      }
      const readable = scope?.readability(resolved.path) ?? { read: 'allowed' as const, reason: 'path is inside the configured roots' }
      if (readable.read === 'denied') {
        return {
          ok: false as const,
          path: resolved.path,
          symbols: [],
          error: 'content-scope-denied',
          errorInfo: errorInfoOf('content-scope-denied'),
          warnings: ['path-not-readable'],
          ...(state === undefined ? {} : { state }),
        }
      }
      if (scope !== undefined && (!scope.isSearchable(resolved.path) || !scope.isIndexable(resolved.path))) {
        return {
          ok: false as const,
          path: resolved.path,
          symbols: [],
          error: 'content-scope-denied',
          errorInfo: errorInfoOf('content-scope-denied'),
          warnings: ['scope-filtered'],
          ...(state === undefined ? {} : { state }),
        }
      }
      const limit = Math.max(1, Math.min(200, Math.trunc(args.maxSymbols ?? 200)))
      // The store keeps the configured-root spelling the engine indexed, while
      // `resolved.path` is the canonical real path used for authorization.
      // Query with the caller's own spelling; the store resolves the canonical
      // variants itself (macOS symlinks, Windows short names), so neither the
      // tool nor the test seam has to canonicalize before a lookup.
      const all = content.outline(path)
      const budgeted = applyOutputBudget(all.slice(0, limit).map(symbolRow), budgetChars)
      const format = content.formatsFor([path]).get(path)
      return {
        ok: true as const,
        path: resolved.path,
        ...(format === undefined ? {} : { format }),
        symbols: budgeted.items,
        count: budgeted.items.length,
        totalCount: all.length,
        truncated: all.length > budgeted.items.length,
        budget: budgeted.budget,
        ...(state === undefined ? {} : { state }),
      }
    },
  })
}

/** Build locator_symbol: find declarations by name across the index. */
export function makeSymbolTool(content: ContentIndex, ensure?: () => void, scope?: Scope, budgetChars = DEFAULT_OUTPUT_BUDGET_CHARS) {
  return defineTool({
    name: 'locator_symbol',
    description: [
      'Find code declarations by symbol name across the local index (dsh-locator): functions, methods, classes, types, headings. Exact names rank before prefix matches, then substrings.',
      '',
      'Use it when the user names a symbol ("where is parseConfig defined") instead of a file, then locator_outline or locator_find to read the body. The symbol layer is heuristic (line-oriented, no AST) and only covers files the content index symbol-indexed.',
    ].join('\n'),
    parameters: {
      name: { type: 'string', required: true, description: 'Symbol name or fragment (case-insensitive substring).' },
      limit: { type: 'integer', description: 'Maximum hits (default 50, at most 200).' },
    },
    output: {
      schema: SYMBOL_OUTPUT,
      render: (_args, value) => {
        const v = value as { ok: boolean; name?: string; symbols?: Array<{ path: string; line: number; kind: string; name: string; scope?: string }>; count?: number; totalCount?: number; truncated?: boolean; warnings?: string[]; error?: string }
        if (!v.ok) return [{ type: 'text', text: 'locator_symbol failed: ' + (v.error ?? 'unknown error') }]
        const lines = ['locator_symbol ' + JSON.stringify(v.name ?? '') + ': ' + String(v.count ?? 0) + ' hit(s)']
        for (const hit of v.symbols ?? []) {
          lines.push('  ' + hit.path + ':' + String(hit.line) + '  ' + hit.kind + ' ' + (hit.scope === undefined ? '' : hit.scope + '.') + hit.name)
        }
        if (v.truncated === true) lines.push('  (truncated; raise limit)')
        if (v.warnings !== undefined && v.warnings.length > 0) lines.push('  warnings: ' + v.warnings.join(', '))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      ensure?.()
      const state = contentStateOf(content)
      const name = args.name.trim()
      if (name === '') {
        return {
          ok: false as const,
          name,
          symbols: [],
          error: 'name is empty',
          errorInfo: errorInfoOf('invalid-arguments', 'name is empty', { hint: 'Pass a non-empty symbol name or fragment.' }),
          ...(state === undefined ? {} : { state }),
        }
      }
      const limit = Math.max(1, Math.min(200, Math.trunc(args.limit ?? 50)))
      const all = content.findSymbols(name, limit)
      const visible: Array<{ path: string; name: string; kind: string; line: number; scope?: string; language?: string; ref?: string; permissions?: { read: 'allowed' | 'denied'; visibility: 'workspace' | 'roots' | 'session' | 'external'; reason: string } }> = []
      const warnings = new Set<string>()
      let dropped = 0
      for (const hit of all) {
        if (scope !== undefined && (!scope.isSearchable(hit.path) || !scope.isIndexable(hit.path))) { dropped++; continue }
        const readable = scope?.readability(hit.path) ?? { read: 'allowed' as const, reason: 'path is inside the configured roots' }
        if (readable.read === 'denied') { dropped++; continue }
        visible.push({ ...symbolRow(hit), path: hit.path, ref: symbolFileRef(hit.path) })
      }
      if (dropped > 0) warnings.add('scope-filtered:' + String(dropped))
      const budgeted = applyOutputBudget(visible, budgetChars)
      return {
        ok: true as const,
        name,
        symbols: budgeted.items,
        count: budgeted.items.length,
        totalCount: all.length,
        truncated: all.length > budgeted.items.length || all.length >= limit,
        budget: budgeted.budget,
        ...(warnings.size === 0 ? {} : { warnings: [...warnings] }),
        ...(state === undefined ? {} : { state }),
      }
    },
  })
}

/** Build locator_repo_map: a token-budgeted repository structure digest. */
export function makeRepoMapTool(content: ContentIndex, ensure?: () => void, roots: readonly string[] = [], scope?: Scope, budgetChars = DEFAULT_OUTPUT_BUDGET_CHARS) {
  return defineTool({
    name: 'locator_repo_map',
    description: [
      'Return a compact repository map from the local index (dsh-locator): the most structural files with their declaration lists, cut to an approximate token budget (characters / 4).',
      '',
      'Use it to orient inside an unfamiliar repository without reading files, then locator_outline/locator_symbol for one file or symbol. Files are included whole (a file that does not fit is skipped so smaller files can still make it); only root-authorized, readable files are returned. Pass roots to focus one or more directories.',
    ].join('\n'),
    parameters: {
      roots: { type: 'array', items: { type: 'string' }, description: 'Only map files under these directories; each must resolve inside a configured root (defaults to every configured root).' },
      tokenBudget: { type: 'integer', description: 'Approximate token budget (default 1000, at most 8000).' },
    },
    output: {
      schema: REPO_MAP_OUTPUT,
      render: (_args, value) => {
        const v = value as { ok: boolean; tokenBudget?: number; tokensEstimated?: number; files?: Array<{ path: string; symbols: Array<{ name: string; kind: string; line: number }> }>; count?: number; truncated?: boolean; warnings?: string[]; error?: string }
        if (!v.ok) return [{ type: 'text', text: 'locator_repo_map failed: ' + (v.error ?? 'unknown error') }]
        const files = v.files ?? []
        const symbolTotal = files.reduce((total, file) => total + file.symbols.length, 0)
        const lines = ['locator_repo_map: ' + String(v.count ?? files.length) + ' file(s), ' + String(symbolTotal) + ' symbol(s), budget ' + String(v.tokenBudget ?? 0) + ' tokens (est. ' + String(v.tokensEstimated ?? 0) + ')']
        for (const file of files) {
          lines.push('  ' + file.path + ' (' + String(file.symbols.length) + ')')
          for (const symbol of file.symbols.slice(0, 12)) lines.push('    ' + String(symbol.line) + ': ' + symbol.kind + ' ' + symbol.name)
          if (file.symbols.length > 12) lines.push('    … ' + String(file.symbols.length - 12) + ' more')
        }
        if (v.warnings !== undefined && v.warnings.length > 0) lines.push('  warnings: ' + v.warnings.join(', '))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      ensure?.()
      const state = contentStateOf(content)
      const tokenBudget = Math.max(1, Math.min(8000, Math.trunc(args.tokenBudget ?? 1000)))
      let narrowed: readonly string[] = roots
      if (Array.isArray(args.roots) && args.roots.length > 0) {
        const requested: string[] = []
        for (const root of args.roots) {
          if (typeof root !== 'string' || root.trim() === '') {
            return {
              ok: false as const,
              files: [],
              error: 'content-path-denied',
              errorInfo: errorInfoOf('invalid-arguments', 'content-path-denied', { hint: 'Pass directory paths inside the configured index roots.' }),
              warnings: ['invalid-root'],
              ...(state === undefined ? {} : { state }),
            }
          }
          const spelling = root.trim()
          const resolved = resolveWithinRoots(spelling, roots)
          if (resolved === undefined) {
            return {
              ok: false as const,
              files: [],
              error: 'content-path-denied',
              errorInfo: errorInfoOf('content-path-denied'),
              warnings: ['path-outside-roots'],
              ...(state === undefined ? {} : { state }),
            }
          }
          // Keep the caller's spelling: authorization used the canonical real
          // path, but the symbol rows are keyed by the configured-root spelling
          // the engine indexed and the store compares both sides canonically.
          if (!requested.includes(spelling)) requested.push(spelling)
        }
        narrowed = requested
      }
      const mapped: RepoMapFile[] = content.repoMap(narrowed, tokenBudget)
      const warnings = new Set<string>()
      let dropped = 0
      const files: Array<{ path: string; ref?: string; symbols: ReturnType<typeof symbolRow>[] }> = []
      for (const file of mapped) {
        if (scope !== undefined && (!scope.isSearchable(file.path) || !scope.isIndexable(file.path) || !scope.isReadable(file.path))) { dropped++; continue }
        const symbols = file.symbols.map(symbolRow)
        files.push({ path: file.path, ref: symbolFileRef(file.path), symbols })
      }
      if (dropped > 0) warnings.add('scope-filtered:' + String(dropped))
      const budgeted = applyOutputBudget(files, budgetChars)
      // Token estimate of the included files, characters / 4 (same heuristic as
      // the store's own token budget).
      let tokensEstimated = 0
      for (const file of budgeted.items) {
        tokensEstimated += estimateSymbolTokens(file.path, file.symbols)
      }
      return {
        ok: true as const,
        tokenBudget,
        files: budgeted.items,
        count: budgeted.items.length,
        tokensEstimated,
        truncated: mapped.length > budgeted.items.length,
        ...(warnings.size === 0 ? {} : { warnings: [...warnings] }),
        ...(state === undefined ? {} : { state }),
      }
    },
  })
}

/** Build the locator_status tool. */
export function makeStatusTool(rt: LocatorRuntime, content?: ContentIndex, scope?: Scope) {
  return defineTool({
    name: 'locator_status',
    description: [
      'Report the local file index behind locator_search (dsh-locator): roots, entry counts, whether the filesystem watcher is active, the state directory and the engine binary.',
      'It also reports the effective ignore rules: notSearchable/notReadable/notIndexed globs, the result budget and the optional rerank/OCR hooks.',
      'Call it when a locator_search result looks stale, when the user asks whether their disk is indexed, or to explain which directories are covered.',
    ].join('\n'),
    parameters: {},
    output: {
      schema: STATUS_OUTPUT,
      render: (_args, value) => {
        const v = value as {
          ok: boolean
          running?: boolean
          version?: string
          platform?: string
          roots?: string[]
          entries?: number
          files?: number
          dirs?: number
          watching?: boolean
          watchDegraded?: boolean
          watchReason?: string
          watchRoots?: number
          refreshFallback?: boolean
          incrementalRefresh?: boolean
          watchUnwatchedRoots?: string[]
          refreshMode?: string
          refreshReason?: string
          refreshScannedRoots?: string[]
          refreshSkippedRoots?: string[]
          refreshEntries?: number
          refreshTookMs?: number
          refreshAt?: number
          generation?: number
          builtAt?: number
          rssBytes?: number
          hwmBytes?: number
          watchDirs?: number
          watchLimit?: number
          watchLimited?: boolean
          watchInitializing?: boolean
          snapshotBytes?: number
          saveBytes?: number
          saveMs?: number
          saveCount?: number
          queueDepth?: number
          queryCount?: number
          lastQueryMs?: number
          recentQueryMs?: number[]
          heapBytes?: number
          numGC?: number
          refreshBackoffMs?: number
          unwatchedRefreshMs?: number
          nextRefreshAt?: number
          refreshRounds?: number
          refreshSkippedByPressure?: number
          content?: {
            enabled?: boolean
            building?: boolean
            files?: number
            sessions?: number
            messages?: number
            truncated?: boolean
            fullIndex?: boolean
            reasoningIndex?: boolean
            toolResultsIndex?: boolean
            progress?: { phase?: string; scanned?: number; indexed?: number; total?: number; path?: string; startedAt?: number }
            warnings?: string[]
            refs?: { total?: number; byKind?: Record<string, number> }
            diagnostics?: {
              coverage?: {
                indexedFiles?: number
                candidateFiles?: number | null
                ratio?: number | null
                evictedDocs?: number
                truncated?: boolean
              }
              dbBytes?: number
              walBytes?: number
              dbLiveBytes?: number
              freelistBytes?: number
              ftsSegments?: number
              ftsOptimizedAt?: number
              optimizeWarnings?: number
              warningCounts?: Record<string, number>
              dbOverBudget?: boolean
              lastRefreshMs?: number
              lastRefreshMode?: string
              liveRefreshMsLast?: number
              engineGeneration?: number | null
            }
          }
          scope?: {
            notSearchable?: string[]
            notReadable?: string[]
            notIndexed?: string[]
            activeRules?: number
            outputBudgetChars?: number
            rerankCommand?: string
            ocrCommand?: string
            warnings?: string[]
          }
          usn?: boolean
          scanning?: boolean
          stateDir?: string
          binary?: string
          warning?: string
          error?: string
          errorInfo?: { code?: string; hint?: string }
        }
        if (!v.ok) {
          const hint = v.errorInfo?.hint === undefined ? '' : ' — ' + v.errorInfo.hint
          return [{ type: 'text', text: 'locator_status: engine unavailable — ' + (v.error ?? 'unknown error') + hint }]
        }
        const lines = [
          'locator_status: ' + String(v.entries ?? 0) + ' entries (' + String(v.files ?? 0) + ' files, ' + String(v.dirs ?? 0) + ' dirs)',
          '  roots: ' + ((v.roots ?? []).join(', ') || '(none)'),
          '  watcher: ' + (v.watching === true ? 'active' : 'inactive') + (v.watchDegraded === true ? ' (degraded: ' + (v.watchReason ?? 'partial coverage') + '; roots ' + String(v.watchRoots ?? 0) + ')' : '') + (v.usn === true ? '; USN-built index (size/date fill in on display)' : '') + (v.scanning === true ? '; initial scan running' : ''),
          '  state: ' + (v.stateDir ?? ''),
          '  engine: ' + (v.binary ?? '') + (v.version === undefined ? '' : ' (' + v.version + ', ' + (v.platform ?? '') + ')'),
        ]
        // 0.20.0 resource gauges: only what the running engine reported.
        const resources: string[] = []
        if (v.rssBytes !== undefined) {
          resources.push('rss ' + formatSize(v.rssBytes) + (v.hwmBytes === undefined ? '' : ' / hwm ' + formatSize(v.hwmBytes)))
        }
        if (v.watchDirs !== undefined) {
          resources.push('watch ' + String(v.watchDirs) + (v.watchLimit === undefined || v.watchLimit === 0 ? '' : '/' + String(v.watchLimit)))
        }
        if (v.watchLimited === true) resources.push('watch-limited')
        if (v.watchInitializing === true) resources.push('watch-initializing')
        if (v.snapshotBytes !== undefined) resources.push('snapshot ' + formatSize(v.snapshotBytes))
        if (v.saveBytes !== undefined) {
          resources.push('last save ' + formatSize(v.saveBytes) + (v.saveMs === undefined ? '' : ' in ' + String(v.saveMs) + ' ms'))
        }
        if (v.lastQueryMs !== undefined) resources.push('last query ' + v.lastQueryMs.toFixed(1) + ' ms')
        if (v.queueDepth !== undefined) resources.push('queue ' + String(v.queueDepth))
        if (v.heapBytes !== undefined) resources.push('heap ' + formatSize(v.heapBytes))
        if (v.unwatchedRefreshMs !== undefined) resources.push('unwatched refresh ' + String(v.unwatchedRefreshMs) + ' ms')
        if (v.nextRefreshAt !== undefined) resources.push('next refresh ' + new Date(v.nextRefreshAt).toISOString())
        if (v.refreshRounds !== undefined) resources.push('refresh rounds ' + String(v.refreshRounds))
        if (v.refreshSkippedByPressure !== undefined && v.refreshSkippedByPressure > 0) {
          resources.push('pressure skips ' + String(v.refreshSkippedByPressure))
        }
        if (resources.length > 0) lines.push('  resources: ' + resources.join(' · '))
        if (v.refreshFallback === true) lines.push('  fallback: periodic rebuild is active (native watcher incomplete)')
        if (v.refreshMode !== undefined || v.refreshTookMs !== undefined || (v.watchUnwatchedRoots?.length ?? 0) > 0) {
          const skipped = v.refreshSkippedRoots?.length ?? v.watchUnwatchedRoots?.length ?? 0
          lines.push('  incremental: ' + (v.incrementalRefresh === false ? 'off (full rescan fallback)' : 'on') + ' · skipped ' + String(skipped) + ' healthy root(s), last ' + (v.refreshMode ?? 'refresh') + (v.refreshTookMs === undefined ? '' : ' in ' + String(v.refreshTookMs) + ' ms') + (v.refreshEntries === undefined ? '' : ' (' + String(v.refreshEntries) + ' entries)') + (v.refreshReason === undefined ? '' : ' · ' + v.refreshReason))
        }
        if (v.content?.enabled === true) {
          const progress = v.content.progress
          const building = v.content.building === true
          const indexedSoFar = typeof progress?.indexed === 'number' ? progress.indexed : undefined
          if (building) {
            // Never report a building index as an empty one: the live counters
            // (or the progress block) say how much is already searchable.
            const files = v.content.files ?? 0
            const messages = v.content.messages ?? 0
            const live = files > 0 || messages > 0
              ? String(files) + ' files / ' + String(messages) + ' messages indexed so far'
              : indexedSoFar === undefined
                ? 'starting'
                : String(indexedSoFar) + ' entries indexed so far'
            lines.push('  content: building — ' + live + (v.content.fullIndex === true ? ' · full-index' : '') + (v.content.reasoningIndex === true ? ' · reasoning-indexed' : '') + (v.content.toolResultsIndex === true ? ' · tool-results-indexed' : '') + (v.content.truncated === true ? ' · truncated' : '') + ' (searchable results and counts will grow)')
          } else {
            lines.push('  content: ' + String(v.content.files ?? 0) + ' files / ' + String(v.content.messages ?? 0) + ' messages' + (v.content.fullIndex === true ? ' · full-index' : '') + (v.content.reasoningIndex === true ? ' · reasoning-indexed' : '') + (v.content.toolResultsIndex === true ? ' · tool-results-indexed' : '') + (v.content.truncated === true ? ' · truncated' : ''))
          }
          if (progress !== undefined) {
            const total = typeof progress.total === 'number' ? ' / ' + String(progress.total) : ''
            lines.push('  building: ' + (progress.phase === 'sessions' ? 'sessions' : 'files') + ' ' + String(progress.scanned ?? 0) + total + ' scanned, ' + String(progress.indexed ?? 0) + ' indexed' + (typeof progress.path === 'string' && progress.path !== '' ? ' · ' + progress.path : ''))
          }
          if (v.content.refs !== undefined) {
            const kinds = Object.entries(v.content.refs.byKind ?? {})
              .map(([kind, count]) => kind + ' ' + String(count))
              .join(', ')
            lines.push('  refs: ' + String(v.content.refs.total ?? 0) + (kinds === '' ? '' : ' (' + kinds + ')'))
          }
          const diagnostics = v.content.diagnostics
          if (diagnostics !== undefined) {
            const parts: string[] = []
            const coverage = diagnostics.coverage
            if (typeof diagnostics.dbBytes === 'number') {
              parts.push('db ' + formatSize(diagnostics.dbBytes) + (typeof diagnostics.walBytes === 'number' && diagnostics.walBytes > 0 ? ' + wal ' + formatSize(diagnostics.walBytes) : ''))
            }
            if (coverage !== undefined && typeof coverage.indexedFiles === 'number') {
              const candidate = typeof coverage.candidateFiles === 'number' ? ' / ' + String(coverage.candidateFiles) : ''
              const ratio = typeof coverage.ratio === 'number' ? ' (' + (coverage.ratio * 100).toFixed(1) + '%)' : ''
              parts.push('coverage ' + String(coverage.indexedFiles) + candidate + ratio)
            }
            if (coverage !== undefined && typeof coverage.evictedDocs === 'number' && coverage.evictedDocs > 0) {
              parts.push('evicted ' + String(coverage.evictedDocs))
            }
            if (typeof diagnostics.dbLiveBytes === 'number' && diagnostics.dbLiveBytes > 0) {
              parts.push('db live ' + formatSize(diagnostics.dbLiveBytes))
            }
            if (typeof diagnostics.freelistBytes === 'number' && diagnostics.freelistBytes > 0) {
              parts.push('freelist ' + formatSize(diagnostics.freelistBytes))
            }
            if (typeof diagnostics.ftsSegments === 'number' && diagnostics.ftsSegments > 0) {
              parts.push('fts segments ' + String(diagnostics.ftsSegments))
            }
            if (typeof diagnostics.ftsOptimizedAt === 'number') {
              parts.push(diagnostics.ftsOptimizedAt > 0 ? 'fts optimized' : 'fts never optimized')
            }
            if (typeof diagnostics.optimizeWarnings === 'number' && diagnostics.optimizeWarnings > 0) {
              parts.push('optimize warnings ' + String(diagnostics.optimizeWarnings))
            }
            if (diagnostics.warningCounts !== undefined && typeof diagnostics.warningCounts === 'object') {
              const codes = Object.entries(diagnostics.warningCounts)
                .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
                .map(([code, count]) => code + ' ' + String(count))
              if (codes.length > 0) parts.push('warning counts: ' + codes.slice(0, 3).join(', '))
            }
            if (typeof diagnostics.lastRefreshMs === 'number' && diagnostics.lastRefreshMs > 0) {
              parts.push('refresh ' + String(diagnostics.lastRefreshMs) + ' ms' + (typeof diagnostics.lastRefreshMode === 'string' && diagnostics.lastRefreshMode !== '' ? ' (' + diagnostics.lastRefreshMode + ')' : ''))
            }
            if (typeof diagnostics.liveRefreshMsLast === 'number' && diagnostics.liveRefreshMsLast > 0) {
              parts.push('live refresh ' + String(diagnostics.liveRefreshMsLast) + ' ms')
            }
            if (diagnostics.dbOverBudget === true) parts.push('db over budget')
            if (parts.length > 0) lines.push('  content resources: ' + parts.join(' · '))
          }
        }
        const scopeInfo = v.scope
        if (scopeInfo !== undefined) {
          const rules = [
            ...(scopeInfo.notSearchable ?? []).map(rule => '-searchable:' + rule),
            ...(scopeInfo.notReadable ?? []).map(rule => '-readable:' + rule),
            ...(scopeInfo.notIndexed ?? []).map(rule => '-indexed:' + rule),
          ]
          lines.push('  scope: ' + String(scopeInfo.activeRules ?? 0) + ' rule(s)' + (rules.length === 0 ? '' : ' · ' + rules.join(', ')))
          lines.push('  budget: ' + String(scopeInfo.outputBudgetChars ?? 0) + ' chars/result · rerank ' + ((scopeInfo.rerankCommand ?? '') === '' ? 'off' : 'on') + ' · ocr ' + ((scopeInfo.ocrCommand ?? '') === '' ? 'off' : 'on'))
          if (scopeInfo.warnings !== undefined && scopeInfo.warnings.length > 0) lines.push('  hooks: ' + scopeInfo.warnings.join('; '))
        }
        if (v.warning !== undefined) lines.push('  warning: ' + v.warning)
        if (v.error !== undefined) lines.push('  error: ' + v.error)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    // Status reads the pushed engine stats copy and one content snapshot.
    isConcurrencySafe: () => true,
    async execute() {
      rt.start()
      const status = rt.status
      // 0.20.0 P0-12: answer from the engine's pushed stats copy for up to 1 s
      // instead of paying an IPC round-trip on every status poll.
      const engine = await statusEngine(rt)
      const config = (rt.config ?? {}) as Partial<Config>
      const scopeDescription = (scope ?? EMPTY_STATUS_SCOPE).describe()
      const hookWarnings = validateHookCommands({
        rerankCommand: config.rerankCommand ?? '',
        ocrCommand: config.ocrCommand ?? '',
      })
      return {
        ok: status.error === undefined,
        running: status.running,
        ...(engine === undefined ? {} : { version: engine.version, platform: engine.platform }),
        roots: engine?.roots ?? rt.roots,
        entries: engine?.entries ?? 0,
        files: engine?.files ?? 0,
        dirs: engine?.dirs ?? 0,
        watching: engine?.watching ?? false,
        usn: engine?.usn ?? false,
        ...(engine === undefined ? {} : {
          ...(engine.incrementalRefresh === undefined ? {} : { incrementalRefresh: engine.incrementalRefresh }),
          ...(engine.watchUnwatchedRoots === undefined ? {} : { watchUnwatchedRoots: engine.watchUnwatchedRoots }),
          ...(engine.refreshMode === undefined ? {} : { refreshMode: engine.refreshMode }),
          ...(engine.refreshReason === undefined ? {} : { refreshReason: engine.refreshReason }),
          ...(engine.refreshScannedRoots === undefined ? {} : { refreshScannedRoots: engine.refreshScannedRoots }),
          ...(engine.refreshSkippedRoots === undefined ? {} : { refreshSkippedRoots: engine.refreshSkippedRoots }),
          ...(engine.refreshEntries === undefined ? {} : { refreshEntries: engine.refreshEntries }),
          ...(engine.refreshTookMs === undefined ? {} : { refreshTookMs: engine.refreshTookMs }),
          ...(engine.refreshAt === undefined ? {} : { refreshAt: engine.refreshAt }),
        }),
        // 0.20.0 observability: rss/watch/snapshot/save/query gauges, forwarded
        // only when the running engine reports them.
        ...engineResourceFields(engine),
        scanning: status.scanning !== undefined,
        stateDir: engine?.stateDir ?? rt.stateDir,
        binary: rt.binary,
        ...(content === undefined ? {} : (() => {
          // One snapshot per status call: content.status() is the live counters
          // block (it grows while a build runs), diagnostics is O(1).
          const contentState = contentStateOf(content)
          return contentState === undefined ? {} : { content: { enabled: true, ...contentState, ...contentDiagnosticsOf(content) } }
        })()),
        scope: {
          ...scopeDescription,
          outputBudgetChars: outputBudgetChars(config),
          rerankCommand: config.rerankCommand ?? '',
          ocrCommand: config.ocrCommand ?? '',
          ...(hookWarnings.length === 0 ? {} : { warnings: hookWarnings }),
        },
        ...(status.warning === undefined ? {} : { warning: status.warning }),
        ...(status.error === undefined ? {} : { error: status.error, errorInfo: errorInfoOf('engine-error', status.error) }),
      }
    },
  })
}

/** Empty scope used when status is built without a plugin scope. */
const EMPTY_STATUS_SCOPE = new Scope({ notSearchable: [], notReadable: [], notIndexed: [] })

/** Build the locator_rebuild tool. */
export function makeRebuildTool(rt: LocatorRuntime) {
  return defineTool({
    name: 'locator_rebuild',
    description: [
      'Rebuild the local file index from scratch (dsh-locator). Runs in the background; locator_search keeps answering from the old index until the new one is ready.',
      'The rebuild is always confined to the configured scope: replacement roots must resolve inside the roots the plugin was configured with, and replacement excludes must come from the configured exclude list. To index a different directory, change the plugin configuration instead.',
      'Use it after changing indexed roots, after the index looks stale and the watcher is inactive, or when the user explicitly asks to rescan. It can take minutes for a large home directory and costs disk I/O, so do not call it routinely.',
    ].join('\n'),
    parameters: {
      roots: { type: 'array', items: { type: 'string' }, description: 'Replacement root directories (defaults to the current roots). Each must be a configured root or inside one.' },
      excludes: { type: 'array', items: { type: 'string' }, description: 'Replacement exclusion globs (defaults to the current excludes). Each must already be configured.' },
    },
    output: {
      schema: REBUILD_OUTPUT,
      render: (_args, value) => {
        const v = value as { ok: boolean; started?: boolean; error?: string }
        if (!v.ok) return [{ type: 'text', text: 'locator_rebuild failed: ' + (v.error ?? 'unknown error') }]
        return [{ type: 'text', text: 'locator_rebuild: started in the background; searches keep using the old index until it finishes' }]
      },
    },
    async execute(args) {
      const scope = validateRebuildArguments(
        args.roots,
        args.excludes,
        rt.roots,
        rt.config.excludes,
      )
      if (!scope.ok) {
        return {
          ok: false as const,
          error: scope.error,
          errorInfo: errorInfoOf('invalid-arguments', scope.error, { hint: 'Rebuild roots must stay inside the configured roots and excludes must come from the configured exclude list.' }),
        }
      }
      try {
        rt.start()
        const result = await rt.rebuild(scope.roots, scope.excludes)
        return { ok: true as const, started: result.started }
      } catch (error) {
        const message = messageOf(error)
        return { ok: false as const, error: message, errorInfo: errorInfoOf('engine-error', message) }
      }
    },
  })
}

function isPathsMeta(value: unknown): value is { paths: string[]; truncated: boolean; total: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.shape === 'paths' &&
    Array.isArray(record.paths) &&
    record.paths.every(path => typeof path === 'string') &&
    typeof record.truncated === 'boolean' &&
    typeof record.total === 'number'
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return String(bytes) + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return value.toFixed(value >= 10 ? 0 : 1) + ' ' + (units[unit] ?? 'TB')
}
