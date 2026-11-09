/**
 * Agent-facing tools: locator_search, locator_status and locator_rebuild.
 * @module dsh-locator/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LocatorRuntime, SearchHit } from './runtime.ts'

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
  },
} as const

const SEARCH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    query: { type: 'string' },
    total: { type: 'integer' },
    returned: { type: 'integer' },
    offset: { type: 'integer' },
    truncated: { type: 'boolean' },
    tookMs: { type: 'number' },
    hits: { type: 'array', items: HIT_SCHEMA },
    error: { type: 'string' },
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
    scanning: { type: 'boolean' },
    stateDir: { type: 'string' },
    binary: { type: 'string' },
    warning: { type: 'string' },
    error: { type: 'string' },
  },
} as const

const REBUILD_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    started: { type: 'boolean' },
    error: { type: 'string' },
  },
} as const

const SEARCH_DESCRIPTION = [
  'Search a persistent local file-name index in milliseconds (dsh-locator).',
  '',
  'This is not a workspace walk: a background scanner keeps an index of the configured roots in a snapshot, so a query over hundreds of thousands of files returns in a few milliseconds even after a restart.',
  '',
  'Query language (Everything-flavored): bare words are ANDed substrings of the file name; `!word` negates; `"two words"` keeps a phrase; `*.go` and `?` are wildcards; `ext:ts,js` / `ext:!tmp`; `path:src` matches the full path; `size:>10mb`, `size:1kb..2mb`; `dm:today`, `dm:yesterday`, `dm:thisweek`, `dm:2026-01-01`, `dm:>=2026-01-01`; `folder:` or `file:` restrict the kind; `case:1` and `wholeword:1` tune matching.',
  '',
  'Use it when the user remembers part of a name or path but not where it lives (whole disk / home directory), or for filters like "the PDFs over 50 MB from this week". Use `grep` for file contents and `glob` for a known workspace path — this index stores names, sizes and modification times, not contents. Results are limited to the roots the plugin was configured with; `locator_status` reports them.',
].join('\n')

/** Build the locator_search tool. */
export function makeSearchTool(rt: LocatorRuntime) {
  return defineTool({
    name: 'locator_search',
    description: SEARCH_DESCRIPTION,
    parameters: {
      query: { type: 'string', required: true, description: 'Search expression, Everything-style. Empty text matches everything.' },
      limit: { type: 'integer', description: `Maximum hits to return (default 50, at most ${String(rt.config.maxResults)}).` },
      offset: { type: 'integer', description: 'Skip this many sorted matches (pagination).' },
      sort: { type: 'string', enum: ['name', 'path', 'size', 'mtime', 'ext'], description: 'Sort key (default name).' },
      desc: { type: 'boolean', description: 'Sort descending.' },
      regex: { type: 'boolean', description: 'Treat the whole query as a regular expression over the file name.' },
      caseSensitive: { type: 'boolean', description: 'Match letter case.' },
      wholeWord: { type: 'boolean', description: 'Require word boundaries around each bare term.' },
      filesOnly: { type: 'boolean', description: 'Return files only.' },
      dirsOnly: { type: 'boolean', description: 'Return directories only.' },
    },
    output: {
      schema: SEARCH_OUTPUT,
      render: (_args, value) => {
        const v = value as {
          ok: boolean
          query?: string
          total?: number
          returned?: number
          truncated?: boolean
          tookMs?: number
          hits?: SearchHit[]
          error?: string
        }
        if (!v.ok) return [{ type: 'text', text: `locator_search failed: ${v.error ?? 'unknown error'}` }]
        const hits = v.hits ?? []
        const lines = [
          `locator_search ${JSON.stringify(v.query ?? '')}: ${String(v.total ?? 0)} match(es)` +
            `${v.truncated === true ? `, showing ${String(v.returned ?? 0)}` : ''}` +
            ` in ${(v.tookMs ?? 0).toFixed(1)} ms`,
        ]
        for (const hit of hits) {
          const suffix = hit.dir ? '/' : ''
          const size = hit.dir ? '' : `  ${formatSize(hit.size)}`
          lines.push(`${hit.path}${suffix}${size}`)
        }
        if (v.truncated === true && (v.total ?? 0) > (v.returned ?? 0)) {
          lines.push(`(${String((v.total ?? 0) - (v.returned ?? 0))} more not shown; raise limit/offset or narrow the query)`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => {
        const v = value as { ok: boolean; total?: number; truncated?: boolean; hits?: SearchHit[] }
        if (!v.ok) return { shape: 'paths', paths: [], truncated: false, total: 0 }
        return {
          shape: 'paths',
          paths: (v.hits ?? []).map(hit => `${hit.path}${hit.dir ? '/' : ''}`),
          truncated: v.truncated === true,
          total: v.total ?? 0,
        }
      },
    },
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
    async execute(args) {
      const limit = clamp(args.limit ?? 50, 1, rt.config.maxResults)
      try {
        rt.start()
        const result = await rt.search({
          query: args.query,
          limit,
          offset: Math.max(0, args.offset ?? 0),
          sort: args.sort ?? 'name',
          desc: args.desc ?? false,
          regex: args.regex ?? false,
          caseSensitive: args.caseSensitive ?? false,
          wholeWord: args.wholeWord ?? false,
          filesOnly: args.filesOnly ?? false,
          dirsOnly: args.dirsOnly ?? false,
        })
        return {
          ok: true as const,
          query: args.query,
          total: result.total,
          returned: result.returned,
          offset: result.offset,
          truncated: result.truncated,
          tookMs: result.tookNs / 1e6,
          hits: result.hits.map(hit => ({
            path: hit.path,
            name: hit.name,
            size: hit.size,
            mtime: hit.mtime,
            modified: new Date(hit.mtime).toISOString(),
            ext: hit.ext,
            dir: hit.dir,
          })),
        }
      } catch (error) {
        return { ok: false as const, query: args.query, error: messageOf(error) }
      }
    },
  })
}

/** Build the locator_status tool. */
export function makeStatusTool(rt: LocatorRuntime) {
  return defineTool({
    name: 'locator_status',
    description: [
      'Report the local file index behind locator_search (dsh-locator): roots, entry counts, whether the filesystem watcher is active, the state directory and the engine binary.',
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
          scanning?: boolean
          stateDir?: string
          binary?: string
          warning?: string
          error?: string
        }
        if (!v.ok) return [{ type: 'text', text: `locator_status: engine unavailable — ${v.error ?? 'unknown error'}` }]
        const lines = [
          `locator_status: ${String(v.entries ?? 0)} entries (${String(v.files ?? 0)} files, ${String(v.dirs ?? 0)} dirs)`,
          `  roots: ${(v.roots ?? []).join(', ') || '(none)'}`,
          `  watcher: ${v.watching === true ? 'active' : 'inactive'}${v.scanning === true ? '; initial scan running' : ''}`,
          `  state: ${v.stateDir ?? ''}`,
          `  engine: ${v.binary ?? ''}${v.version === undefined ? '' : ` (${v.version}, ${v.platform ?? ''})`}`,
        ]
        if (v.warning !== undefined) lines.push(`  warning: ${v.warning}`)
        if (v.error !== undefined) lines.push(`  error: ${v.error}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      rt.start()
      const status = rt.status
      const engine = await rt.engineStatus()
      return {
        ok: status.error === undefined,
        running: status.running,
        ...(engine === undefined ? {} : { version: engine.version, platform: engine.platform }),
        roots: engine?.roots ?? rt.roots,
        entries: engine?.entries ?? 0,
        files: engine?.files ?? 0,
        dirs: engine?.dirs ?? 0,
        watching: engine?.watching ?? false,
        scanning: status.scanning !== undefined,
        stateDir: engine?.stateDir ?? rt.stateDir,
        binary: rt.binary,
        ...(status.warning === undefined ? {} : { warning: status.warning }),
        ...(status.error === undefined ? {} : { error: status.error }),
      }
    },
  })
}

/** Build the locator_rebuild tool. */
export function makeRebuildTool(rt: LocatorRuntime) {
  return defineTool({
    name: 'locator_rebuild',
    description: [
      'Rebuild the local file index from scratch (dsh-locator). Runs in the background; locator_search keeps answering from the old index until the new one is ready.',
      'Use it after changing indexed roots, after the index looks stale and the watcher is inactive, or when the user explicitly asks to rescan. It can take minutes for a large home directory and costs disk I/O, so do not call it routinely.',
    ].join('\n'),
    parameters: {
      roots: { type: 'array', items: { type: 'string' }, description: 'Replacement root directories (defaults to the current roots).' },
      excludes: { type: 'array', items: { type: 'string' }, description: 'Replacement exclusion globs.' },
    },
    output: {
      schema: REBUILD_OUTPUT,
      render: (_args, value) => {
        const v = value as { ok: boolean; started?: boolean; error?: string }
        if (!v.ok) return [{ type: 'text', text: `locator_rebuild failed: ${v.error ?? 'unknown error'}` }]
        return [{ type: 'text', text: 'locator_rebuild: started in the background; searches keep using the old index until it finishes' }]
      },
    },
    async execute(args) {
      try {
        rt.start()
        const result = await rt.rebuild(
          args.roots === undefined ? undefined : args.roots,
          args.excludes === undefined ? undefined : args.excludes,
        )
        return { ok: true as const, started: result.started }
      } catch (error) {
        return { ok: false as const, error: messageOf(error) }
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit] ?? 'TB'}`
}
