/**
 * Plugin configuration.
 * @module dsh-locator/config
 */

import Schema from '@deepseek-ai/schemastery'

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
  /** Directory reader concurrency during scans; 0 uses the CPU count. */
  scanWorkers: number
  /** Soft Go heap limit in MiB for the engine; 0 leaves it to GOMEMLIMIT/GOGC. */
  memoryLimitMB: number
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
  /** Stop adding content after this many body bytes; 0 means unlimited. */
  contentMaxTotalBytes: number
  /** Incremental content refresh cadence; 0 disables it. */
  contentRefreshMs: number
  /** Maximum text files indexed per build; 0 means no cap. */
  contentMaxFiles: number
  /** Most recent session logs indexed; 0 means all. */
  contentMaxSessions: number
  /** Index archived sessions too; the default leaves them out. */
  contentIncludeArchived: boolean
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
  scanWorkers: Schema.number().default(0),
  memoryLimitMB: Schema.number().default(0),
  contentIndex: Schema.boolean().default(true),
  contentLazy: Schema.boolean().default(true),
  contentMaxFileBytes: Schema.number().default(1_000_000),
  contentMaxTotalBytes: Schema.number().default(1_000_000_000),
  contentRefreshMs: Schema.number().default(300_000),
  contentMaxFiles: Schema.number().default(200_000),
  contentMaxSessions: Schema.number().default(100),
  contentIncludeArchived: Schema.boolean().default(false),
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
  windowsUsn: Schema.boolean().default(false),
  stateDir: Schema.string().default(''),
  binaryPath: Schema.string().default(''),
  maxResults: Schema.number().default(100),
  startupTimeoutMs: Schema.number().default(120_000),
  requestTimeoutMs: Schema.number().default(15_000),
})
