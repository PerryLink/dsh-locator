/**
 * Platform paths: engine binary lookup, default state directory and roots.
 * @module dsh-locator/paths
 */

import { existsSync } from 'node:fs'
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
