/**
 * Plugin configuration.
 * @module dsh-locator/config
 */

import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_OUTPUT_BUDGET_CHARS, validateExternalCommand } from './scope.ts'

/** Locator plugin configuration. */
export interface Config {
  /** Master switch; false mounts no tools and starts no engine. */
  enabled: boolean
  /** Directories to index. Empty means the current user's home directory. */
  roots: string[]
  /** Base-name globs to skip while scanning and watching. */
  excludes: string[]
  /** Keep the index current with filesystem notifications when supported. */
  watch: boolean
  /**
   * Rebuild cadence used only when the platform has no native watcher (macOS
   * today). Zero disables the fallback; the index then changes only on
   * `locator_rebuild`.
   */
  refreshIntervalMs: number
  /**
   * Periodic fallback refreshes only the roots the native watcher cannot cover
   * (incremental refresh). Default true; false restores the 0.18 behavior of
   * re-scanning every root on each fallback tick.
   */
  refreshIncremental?: boolean
  /**
   * Refresh cadence for roots without a native watcher (9p/DrvFs, NFS, SMB and
   * similar). The fallback refresh rescans only those roots; default 300000
   * (5 minutes; with the 2x backoff cap the worst-case staleness is 10
   * minutes) keeps workspace-visible files fresh without rescanning the
   * whole tree.
   */
  unwatchedRefreshIntervalMs?: number
  /** Directory reader concurrency during scans; 0 uses the CPU count. */
  scanWorkers: number
  /**
   * Soft Go heap limit in MiB for the engine. 0 means "auto": the plugin
   * derives a limit from the machine (clamp 25% of RAM to 384–1024 MiB) and
   * passes it to the engine, which applies GOMEMLIMIT plus a GC after the
   * snapshot/watcher load. Set a positive value to pin it; use a very large
   * value to effectively disable the limit.
   */
  memoryLimitMB: number
  /**
   * Include well-known toolchain and package caches (Go module cache, Cargo
   * registry, Rustup, pip/npm/pnpm stores, .local/lib, site-packages) in the
   * name index and watcher. Off by default: these trees are usually the
   * majority of the entry count and almost never the thing a user searches
   * for. Set true to restore the pre-0.20 behavior. The content index has its
   * own independent cache excludes.
   */
  includeCaches?: boolean
  /**
   * Hard cap on watched directories across all roots (default 120000). When a
   * root exceeds the budget the remaining directories are covered by the
   * periodic incremental refresh instead of the native watcher.
   */
  watchMaxDirs?: number
  /**
   * Snapshot compression for the on-disk index: none (default) keeps the
   * fastest load/save; zstd halves the file but adds a few hundred ms to both.
   */
  snapshotCompression?: 'none' | 'zstd'
  /** Index text-file bodies and DSH session messages into the content database. */
  contentIndex: boolean
  /**
   * Build the content index on the first content search instead of at plugin
   * start. Lazy keeps DSH startup free of content indexing; set false to build
   * eagerly in the background right after startup.
   */
  contentLazy: boolean
  /** Maximum bytes read from one text file. */
  contentMaxFileBytes: number
  /** Stop adding content after this many body bytes (default 1.6 GB); 0 means unlimited. */
  contentMaxTotalBytes: number
  /** Incremental content refresh cadence; 0 disables it. */
  contentRefreshMs: number
  /** Maximum text files indexed per build; 0 means no cap. */
  contentMaxFiles: number
  /**
   * Index assistant reasoning/thinking blocks in session messages too. Off by
   * default: reasoning is large, noisy, and may contain scratch work the user
   * does not expect to be searchable. Enabling it forces a session rebuild.
   */
  contentIndexReasoning: boolean
  /**
   * Index tool results (`tool/result` events) as session documents too. Off by
   * default: results can be large and often duplicate file bodies. Enabling it
   * rebuilds session documents only; the file index is kept.
   */
  contentIndexToolResults: boolean
  /**
   * Extract bodies from PDF/Office/EPUB documents into the content index
   * (default true). Turn it off to index plain text only, e.g. to keep a first
   * build cheap on a document-heavy disk.
   */
  contentExtractDocuments?: boolean
  /** Largest document handed to the extractor in bytes (default 8 MiB; 0 unlimited). */
  contentExtractMaxBytes?: number
  /** Evict the oldest indexed documents when the body budget is full (default true). */
  contentEvict?: boolean
  /** Maximum symbols stored per code file (default 500; lower keeps the symbols table small). */
  contentSymbolsPerFile?: number
  /** Hard budget for content.db in bytes (default 5 GB); oversize triggers an idle rebuild. */
  contentMaxDbBytes?: number
  /** Adaptive bm25: skip rank ordering for result sets above this hit threshold (default 2000). */
  contentRankAdaptive?: boolean
  /** Content search result cache entries (default 64; 0 disables the cache). */
  contentQueryCacheSize?: number
  /** Content search result cache TTL in ms (default 60000). */
  contentQueryCacheTtlMs?: number
  /** Largest session log read as a whole; bigger logs index only their head (default 64 MiB; 0 unlimited). */
  contentSessionMaxBytes?: number
  /** Pause/slow content builds when the machine is busy or on battery (default true). */
  contentRefreshAdaptive?: boolean
  /** Parallel file read/decode/symbol extraction workers during a full build (default 4; 1 disables). */
  contentParallelPrefetch?: number
  /** Sniff extensionless files for text content (default true; raises content coverage). */
  contentTextSniff?: boolean
  /** Allow a bounded LIKE fallback for 2-character content queries (default true). */
  contentShortQueryFallback?: boolean
  /** Index code symbols for locator_outline/locator_symbol/locator_repo_map (default true). */
  contentIndexSymbols?: boolean
  /** Largest code file considered for symbol extraction in bytes (default 512 KiB). */
  contentSymbolMaxBytes?: number
  /**
   * One switch for full content search: overrides both body and file caps to
   * unlimited. Off by default because a full index costs gigabytes of disk and
   * a long first build; set this instead of hand-writing two zero values.
   */
  contentFullIndex: boolean
  /** Most recent session logs indexed (default 1000); 0 means all. */
  contentMaxSessions: number
  /**
   * Search archived sessions by default. Archived logs are indexed either way
   * (so a panel checkbox can include them per query); the default false keeps
   * them out of ordinary results.
   */
  contentIncludeArchived: boolean
  /**
   * Let `locator_find scope:"all"` read session bodies from other workspaces.
   * Off by default: files stay searchable across roots, but session documents
   * are limited to the caller session and sessions with the same immutable cwd
   * (the DSH `tool-session-query` authorization rule).
   */
  allowCrossWorkspaceSessions: boolean
  /**
   * Session logs modified more recently than this are skipped until they have
   * been quiet that long, so the session being written now is not re-read on
   * every background refresh.
   */
  contentActiveSessionDelayMs: number
  /** Extra session directories; empty means $DSH_HOME/sessions. */
  contentSessionDirs: string[]
  /**
   * Path segments or substrings skipped by the content index only: dependency
   * trees and toolchains would otherwise eat the body-bytes budget before a
   * user's own documents. The name index still covers them.
   */
  contentExcludes: string[]
  /**
   * Glob patterns that must not enter the content index at all (the name index
   * keeps them). This is the "indexable" layer: document extractors (PDF,
   * Office, OCR sidecars) skip a match before reading bytes, and content hits
   * are filtered for databases built before the rule existed. Complements
   * `contentExcludes`, which stays a fast substring/segment pre-filter.
   */
  notIndexed?: string[]
  /**
   * Glob patterns never returned as hits by `locator_search`/`locator_find`.
   * The path stays indexed (and readable unless `notReadable` also matches),
   * but no result names it. This is the "searchable" layer.
   */
  notSearchable?: string[]
  /**
   * Glob patterns whose body and evidence ref must not be returned: content
   * hits are dropped, refs are stripped from name hits and ref resolution must
   * refuse them. This is the "readable" layer. See `readableDenial` in
   * `src/scope.ts` for the hook the resolve/cite tools consume.
   */
  notReadable?: string[]
  /**
   * Soft cap on the character size of one locator tool result. Hits that no
   * longer fit are dropped and the result reports `truncated`, `nextOffset`
   * and a `budget` block (JSON-serialized characters). 0 disables the budget.
   */
  outputBudgetChars?: number
  /**
   * Optional external rerank command for content hits. Empty (the default)
   * disables it. The command is spawned without a shell and speaks JSON on
   * stdin/stdout: `{ protocol: "rerank/v1", query, hits: [{path,title,snippet,
   * score}] }` in, `{ order: number[] }` out (see `src/scope.ts`). A broken
   * hook only adds a warning; the lexical order is kept.
   */
  rerankCommand?: string
  /**
   * Optional external OCR command for the document extraction layer. Empty
   * (the default) disables it. Spawned without a shell; stdin
   * `{ protocol: "ocr/v1", path, mime? }`, stdout `{ text: string }` (see
   * `runOcrCommand` in `src/scope.ts`).
   */
  ocrCommand?: string
  /**
   * Let locator_resolve revalidate URL refs with one bounded conditional HTTP
   * request (5 s timeout, no crawling, no robots fetch). Off (the default)
   * keeps URL refs metadata-only: resolving never opens a network connection.
   */
  urlFreshness?: boolean
  /**
   * Try the NTFS USN/MFT enumeration before the portable walk (Windows only,
   * requires running DSH as administrator). Falls back automatically.
   */
  windowsUsn: boolean
  /** Snapshot directory. Empty means the platform cache directory. */
  stateDir: string
  /** Override the engine binary path (development or custom builds). */
  binaryPath: string
  /** Maximum hits one search returns. */
  maxResults: number
  /** How long a cold index build may take before the plugin reports failure. */
  startupTimeoutMs: number
  /** Per-request deadline for the engine. */
  requestTimeoutMs: number
  /** Start the engine during plugin activation instead of the first search (default true). */
  prewarm?: boolean
  /** Optional character budget for /combined responses (0 keeps the old unbudgeted behavior). */
  combinedBudgetChars?: number
  /** Parallel stat/hash enrichment limit for panel /combined (default 8). */
  combinedEnrichConcurrency?: number
  /** Maximum files whose sha256 is computed per /combined response (default 5; 0 disables hashes). */
  combinedHashMaxHits?: number
  /**
   * Resource preset applied on top of explicit settings: eco lowers memory,
   * content, watch and refresh budgets; performance raises them; balanced
   * keeps the documented defaults.
   */
  resourcePreset?: 'balanced' | 'eco' | 'performance'
  /**
   * Allow the panel HTTP routes to operate without the DSH connection service,
   * relying on the host's request authentication plus the same-origin Fetch
   * metadata check. Off by default; useful on hosts where the connection
   * service is not injected during plugin boot.
   */
  httpConnectionOptional: boolean
}

/** Configuration schema; invalid values fail the profile load loudly. */
export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  roots: Schema.array(Schema.string()).default([]),
  excludes: Schema.array(Schema.string()).default([
    'node_modules',
    '.git',
    '.hg',
    '.svn',
    '.cache',
    '__pycache__',
    '.venv',
    'venv',
    '.next',
  ]),
  watch: Schema.boolean().default(true),
  refreshIntervalMs: Schema.number().default(1_800_000),
  refreshIncremental: Schema.boolean().default(true),
  unwatchedRefreshIntervalMs: Schema.number().default(300_000),
  scanWorkers: Schema.number().default(0),
  memoryLimitMB: Schema.number().default(0),
  includeCaches: Schema.boolean().default(false),
  watchMaxDirs: Schema.number().default(120_000),
  snapshotCompression: Schema.union(['none', 'zstd']).default('none'),
  contentIndex: Schema.boolean().default(true),
  contentLazy: Schema.boolean().default(true),
  contentMaxFileBytes: Schema.number().default(1_000_000),
  contentMaxTotalBytes: Schema.number().default(1_600_000_000),
  contentRefreshMs: Schema.number().default(300_000),
  contentMaxFiles: Schema.number().default(200_000),
  contentIndexReasoning: Schema.boolean().default(false),
  contentIndexToolResults: Schema.boolean().default(false),
  contentExtractDocuments: Schema.boolean().default(true),
  contentExtractMaxBytes: Schema.number().default(8_000_000),
  contentEvict: Schema.boolean().default(true),
  contentSymbolsPerFile: Schema.number().default(500),
  contentMaxDbBytes: Schema.number().default(8_000_000_000),
  contentRankAdaptive: Schema.boolean().default(true),
  contentQueryCacheSize: Schema.number().default(64),
  contentQueryCacheTtlMs: Schema.number().default(60_000),
  contentSessionMaxBytes: Schema.number().default(67_108_864),
  contentRefreshAdaptive: Schema.boolean().default(true),
  /** Parallel file read/decode/symbol extraction workers during a full content build (1 disables). */
  contentParallelPrefetch: Schema.number().default(4),
  /** Sniff extensionless files for text content (default true; raises coverage). */
  contentTextSniff: Schema.boolean().default(true),
  /** Allow a bounded LIKE fallback for 2-character queries (default true). */
  contentShortQueryFallback: Schema.boolean().default(true),
  contentIndexSymbols: Schema.boolean().default(true),
  contentSymbolMaxBytes: Schema.number().default(524_288),
  contentFullIndex: Schema.boolean().default(false),
  contentMaxSessions: Schema.number().default(1000),
  contentIncludeArchived: Schema.boolean().default(false),
  allowCrossWorkspaceSessions: Schema.boolean().default(false),
  contentActiveSessionDelayMs: Schema.number().default(120_000),
  contentSessionDirs: Schema.array(Schema.string()).default([]),
  contentExcludes: Schema.array(Schema.string()).default([
    'node_modules',
    '.git',
    '.hg',
    '.svn',
    '.cache',
    '__pycache__',
    '.venv',
    'venv',
    '.next',
    '.turbo',
    '.yarn',
    '.pnpm',
    '.npm',
    '.cargo',
    '.rustup',
    '.bun',
    '.gradle',
    '.m2',
    '.nuget',
    '.nvm',
    '.pyenv',
    '.conda',
    '.asdf',
    'toolchain',
    'site-packages',
    'dist-packages',
    '/.local/lib/',
    '/.local/share/pnpm/',
    '/go/pkg/mod/',
  ]),
  notIndexed: Schema.array(Schema.string()).default([]),
  notSearchable: Schema.array(Schema.string()).default([]),
  notReadable: Schema.array(Schema.string()).default([]),
  outputBudgetChars: Schema.number().default(8000),
  rerankCommand: Schema.string().default(''),
  ocrCommand: Schema.string().default(''),
  urlFreshness: Schema.boolean().default(false),
  windowsUsn: Schema.boolean().default(false),
  stateDir: Schema.string().default(''),
  binaryPath: Schema.string().default(''),
  maxResults: Schema.number().default(100),
  startupTimeoutMs: Schema.number().default(120_000),
  requestTimeoutMs: Schema.number().default(15_000),
  prewarm: Schema.boolean().default(true),
  combinedBudgetChars: Schema.number().default(0),
  combinedEnrichConcurrency: Schema.number().default(8),
  combinedHashMaxHits: Schema.number().default(5),
  resourcePreset: Schema.union(['balanced', 'eco', 'performance']).default('balanced'),
  httpConnectionOptional: Schema.boolean().default(false),
})

/**
 * Effective per-tool-result character budget. Unset or invalid values fall back
 * to {@link DEFAULT_OUTPUT_BUDGET_CHARS}; 0 disables the budget.
 * @param config - validated plugin configuration.
 * @returns the soft cap in JSON-serialized characters.
 */
export function outputBudgetChars(config: Pick<Config, 'outputBudgetChars'>): number {
  const value = config.outputBudgetChars
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : DEFAULT_OUTPUT_BUDGET_CHARS
}

/**
 * Validate the optional external command settings. An empty command is a valid
 * "disabled" value; anything else must split into a program without a shell.
 * These are configuration problems, not query failures: `locator_status`
 * reports them as warnings and the hook is simply not run.
 * @param config - validated plugin configuration.
 * @returns human-readable problems, empty when both hooks are valid/off.
 */
export function validateHookCommands(config: Pick<Config, 'rerankCommand' | 'ocrCommand'>): string[] {
  const problems: string[] = []
  for (const name of ['rerankCommand', 'ocrCommand'] as const) {
    const value = config[name]
    if (typeof value !== 'string') continue
    const problem = validateExternalCommand(value)
    if (problem !== undefined) problems.push(name + ': ' + problem)
  }
  return problems
}

/**
 * Effective content caps. `contentFullIndex` is the explicit one-switch full
 * mode; otherwise the two numeric caps apply (0 still means unlimited).
 * @param config - validated plugin configuration.
 * @returns limits passed to {@link ContentIndex}.
 */
export function contentLimits(config: Pick<Config, 'contentFullIndex' | 'contentMaxTotalBytes' | 'contentMaxFiles'>): { maxTotalBytes: number; maxFiles: number } {
  if (config.contentFullIndex) return { maxTotalBytes: 0, maxFiles: 0 }
  return { maxTotalBytes: config.contentMaxTotalBytes, maxFiles: config.contentMaxFiles }
}
const MIB = 1024 * 1024

/** Resource presets layered on top of the explicit configuration. */
export function applyResourcePreset(config: Config): Config {
  const preset = config.resourcePreset ?? 'balanced'
  if (preset === 'balanced') return config
  if (preset === 'eco') {
    return {
      ...config,
      memoryLimitMB: 256,
      watchMaxDirs: Math.min(config.watchMaxDirs ?? 120_000, 60_000),
      contentMaxTotalBytes: Math.min(config.contentMaxTotalBytes, 256 * MIB),
      contentMaxFiles: Math.min(config.contentMaxFiles, 50_000),
      contentExtractDocuments: false,
      contentIndexSymbols: false,
      contentRefreshMs: Math.max(config.contentRefreshMs, 1_800_000),
      refreshIntervalMs: Math.max(config.refreshIntervalMs, 21_600_000),
      unwatchedRefreshIntervalMs: Math.max(config.unwatchedRefreshIntervalMs ?? 600_000, 3_600_000),
      combinedHashMaxHits: 0,
      contentQueryCacheSize: Math.min(config.contentQueryCacheSize ?? 64, 32),
    }
  }
  return {
    ...config,
    memoryLimitMB: Math.max(config.memoryLimitMB, 1024),
    watchMaxDirs: Math.max(config.watchMaxDirs ?? 120_000, 200_000),
    contentMaxTotalBytes: Math.max(config.contentMaxTotalBytes, 2_000_000_000),
    contentMaxFiles: Math.max(config.contentMaxFiles, 500_000),
    contentRefreshMs: Math.min(config.contentRefreshMs, 300_000),
    refreshIntervalMs: Math.min(config.refreshIntervalMs, 600_000),
    unwatchedRefreshIntervalMs: Math.min(config.unwatchedRefreshIntervalMs ?? 300_000, 120_000),
    contentSymbolsPerFile: Math.max(config.contentSymbolsPerFile ?? 500, 1_000),
    combinedHashMaxHits: Math.max(config.combinedHashMaxHits ?? 5, 20),
    contentQueryCacheSize: Math.max(config.contentQueryCacheSize ?? 64, 256),
  }
}
