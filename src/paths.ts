/**
 * Platform paths: engine binary lookup, default state directory and roots.
 * @module dsh-locator/paths
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from './config.ts'

/** `linux-x64`, `win32-arm64`, `darwin-arm64`, … */
export function platformTag(): string {
  return `${process.platform}-${process.arch}`
}

/** Engine file name for this platform. */
export function engineName(): string {
  return process.platform === 'win32' ? 'indexd.exe' : 'indexd'
}

/** The package root, one level above the compiled `lib/` directory. */
export function packageRoot(): string {
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
}

/** The default snapshot directory, outside the session data tree. */
export function defaultStateDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return join(base, 'dsh-locator')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'dsh-locator')
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dsh-locator')
}

/** Absolute roots to index. An empty configuration means the home directory. */
export function resolveRoots(config: Config, cwd: string): string[] {
  const roots = config.roots.length > 0 ? config.roots : [homedir()]
  return roots.map(root => resolve(cwd, root))
}

/** The configured engine binary, or the bundled one for this platform. */
export function resolveBinary(config: Config, cwd: string): string {
  if (config.binaryPath !== '') return resolve(cwd, config.binaryPath)
  const name = engineName()
  const bundled = join(packageRoot(), 'bin', platformTag(), name)
  if (existsSync(bundled)) return bundled
  // A development build may live directly under bin/.
  const plain = join(packageRoot(), 'bin', name)
  if (existsSync(plain)) return plain
  // Fall back to PATH: `indexd` on Unix and `indexd.exe` on Windows.
  return name
}

/** The state directory actually used. */
export function resolveStateDir(config: Config, cwd: string): string {
  return config.stateDir === '' ? defaultStateDir() : resolve(cwd, config.stateDir)
}

/**
 * The version of this package (package.json), read once.
 *
 * The engine copy below the state directory is keyed by this version, so a
 * Windows in-place upgrade can never spawn a half-overwritten executable: each
 * package version gets its own copy and the old ones are removed.
 * @returns the package version, or `'0.0.0'` when package.json is unreadable.
 */
let cachedPackageVersion: string | undefined
export function packageVersion(): string {
  if (cachedPackageVersion !== undefined) return cachedPackageVersion
  let version = '0.0.0'
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version !== '') version = parsed.version
  } catch {
    // A bundled/stripped install may not ship package.json next to the code.
  }
  cachedPackageVersion = version
  return version
}

/** State-directory files that must be owner-only on POSIX platforms. */
const PRIVATE_STATE_FILES = [
  'index.snapshot',
  'index.journal',
  'meta.json',
  'content.db',
  'content.db-wal',
  'content.db-shm',
  'engine.lock',
] as const

/** Outcome of one {@link secureStateDir} pass. */
export interface StateDirPermissions {
  stateDir: string
  /** The directory had to be created by this pass. */
  created: boolean
  /** File names (and `.` for the directory) whose mode was corrected. */
  fixed: string[]
  /** Non-fatal failures; a read-only profile must not break plugin startup. */
  warnings: string[]
}

/**
 * Create the state directory (0700) and tighten the permissions of existing
 * state files (0600).
 *
 * 0.22 and older engines created the state directory 0755 and its files 0644,
 * so a profile that already has a state directory keeps leaking path listings
 * until every writer is upgraded. This pass is idempotent, best effort and a
 * no-op on Windows (where POSIX mode bits do not exist); the engine that owns
 * the directory fixes future writes itself.
 * @param stateDir - the resolved state directory.
 * @returns what was created/corrected, plus any non-fatal warnings.
 */
export function secureStateDir(stateDir: string): StateDirPermissions {
  const result: StateDirPermissions = { stateDir, created: false, fixed: [], warnings: [] }
  if (process.platform === 'win32') {
    // Windows has no POSIX modes; the state directory lives under %LOCALAPPDATA%
    // and inherits the user's ACLs.
    try {
      if (!existsSync(stateDir)) {
        mkdirSync(stateDir, { recursive: true })
        result.created = true
      }
    } catch (error) {
      result.warnings.push(`cannot create ${stateDir}: ${messageOf(error)}`)
    }
    return result
  }
  try {
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      result.created = true
    }
  } catch (error) {
    result.warnings.push(`cannot create ${stateDir}: ${messageOf(error)}`)
    return result
  }
  tighten(stateDir, '.', 0o700, result)
  for (const name of PRIVATE_STATE_FILES) {
    const path = join(stateDir, name)
    if (!existsSync(path)) continue
    tighten(path, name, 0o600, result)
  }
  return result
}

/** One best-effort chmod, recording a correction or a warning. */
function tighten(path: string, label: string, mode: number, result: StateDirPermissions): void {
  try {
    if ((statSync(path).mode & 0o777) === mode) return
    chmodSync(path, mode)
    result.fixed.push(label)
  } catch (error) {
    result.warnings.push(`cannot chmod ${path}: ${messageOf(error)}`)
  }
}

/** Latest last-good-profile file, plus its two rotated predecessors. */
const LAST_GOOD_NAMES = ['last-good-profile.json', 'last-good-profile.1.json', 'last-good-profile.2.json'] as const

/**
 * A compact record of a plugin instance that booted successfully.
 *
 * It is written to the state directory only (never to the DSH profile) and is
 * used by `scripts/doctor.mjs` to print how to get back to a known-good
 * install. Recording it must never fail a boot, so the write helper reports
 * problems instead of throwing.
 */
export interface LastGoodProfile {
  /** ISO timestamp of the record. */
  recordedAt: string
  /** Version of dsh-locator that booted. */
  packageVersion: string
  /** Version reported by the engine, when known. */
  engineVersion?: string
  /** The state directory the record was written into. */
  stateDir: string
  /** `linux-x64`, `win32-arm64`, … */
  platform: string
  /** `v24.1.0` style Node version. */
  nodeVersion: string
  /** Indexed roots, when the caller knows them. */
  roots?: string[]
  /** Whether the content index was enabled. */
  contentIndex?: boolean
  /** Engine/plugin warnings observed at boot. */
  warnings?: string[]
  /** Sanitized configuration snapshot, for manual recovery only. */
  config?: Record<string, unknown>
}

/** Subset of {@link LastGoodProfile} the caller supplies. */
export type LastGoodProfileInput = Omit<LastGoodProfile, 'recordedAt' | 'stateDir' | 'platform' | 'nodeVersion'>

/** Outcome of one {@link recordLastGoodProfile} call. */
export interface LastGoodProfileRecord {
  path: string
  written: boolean
  warning?: string
}

/** Number of last-good-profile records kept (including the latest). */
export const LAST_GOOD_PROFILE_RETENTION = LAST_GOOD_NAMES.length

/** The paths of the retained last-good-profile records, newest first. */
export function lastGoodProfilePaths(stateDir: string): string[] {
  return LAST_GOOD_NAMES.map(name => join(stateDir, name))
}

/**
 * Record one successful boot into `<stateDir>/last-good-profile.json`.
 *
 * Older records rotate to `last-good-profile.1.json` / `.2.json`, so up to
 * three known-good versions stay available. The file is written 0600 on POSIX
 * and atomically (temporary file plus rename). Nothing outside the state
 * directory is read or written.
 * @param stateDir - the resolved state directory.
 * @param input - the version/roots/warnings of the boot.
 * @returns the written path, or a warning when recording was skipped.
 */
export function recordLastGoodProfile(stateDir: string, input: LastGoodProfileInput): LastGoodProfileRecord {
  const latest = join(stateDir, LAST_GOOD_NAMES[0])
  const record: LastGoodProfile = {
    ...input,
    recordedAt: new Date().toISOString(),
    stateDir,
    platform: platformTag(),
    nodeVersion: process.version,
  }
  try {
    secureStateDir(stateDir)
    // Rotate: .2 is dropped, .1 -> .2, latest -> .1. Missing files are fine.
    try { rmSync(join(stateDir, LAST_GOOD_NAMES[2]), { force: true }) } catch { /* best effort */ }
    try { renameSync(join(stateDir, LAST_GOOD_NAMES[1]), join(stateDir, LAST_GOOD_NAMES[2])) } catch { /* first records */ }
    try { renameSync(latest, join(stateDir, LAST_GOOD_NAMES[1])) } catch { /* first record */ }
    const tmp = latest + '.tmp'
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    if (process.platform !== 'win32') {
      try { chmodSync(tmp, 0o600) } catch { /* recorded as a warning below if it matters */ }
    }
    renameSync(tmp, latest)
    return { path: latest, written: true }
  } catch (error) {
    return { path: latest, written: false, warning: `cannot record last-good profile: ${messageOf(error)}` }
  }
}

/**
 * Read the retained last-good-profile records, newest first.
 *
 * Corrupt or missing records are skipped: this is recovery metadata, so a
 * damaged file must not prevent the newer records from being shown.
 * @param stateDir - the resolved state directory.
 * @returns the parseable records, newest first.
 */
export function readLastGoodProfiles(stateDir: string): LastGoodProfile[] {
  const records: LastGoodProfile[] = []
  for (const path of lastGoodProfilePaths(stateDir)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LastGoodProfile>
      if (typeof parsed !== 'object' || parsed === null) continue
      if (typeof parsed.recordedAt !== 'string' || typeof parsed.packageVersion !== 'string') continue
      records.push(parsed as LastGoodProfile)
    } catch {
      // Missing or corrupt rotation slot: skip it.
    }
  }
  return records
}

/** Message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
