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
  stateDir: Schema.string().default(''),
  binaryPath: Schema.string().default(''),
  maxResults: Schema.number().default(100),
  startupTimeoutMs: Schema.number().default(120_000),
  requestTimeoutMs: Schema.number().default(15_000),
})
