/**
 * Reveal one indexed path in the platform file manager.
 * @module dsh-locator/reveal
 */

import { spawn } from 'node:child_process'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** Whether target is one of the roots or lives below one of them. */
export function withinRoots(target: string, roots: readonly string[]): boolean {
  if (!isAbsolute(target)) return false
  const absolute = resolve(target)
  for (const root of roots) {
    const base = resolve(root)
    const rel = relative(base, absolute)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true
  }
  return false
}

/**
 * Ask the platform to reveal a path in its file manager. Uses an argument
 * vector, not a shell, so a path can never be interpreted as a command. The
 * child is detached: the opener outlives the plugin call.
 */
export async function revealInFileManager(target: string): Promise<void> {
  const absolute = resolve(target)
  if (process.platform === 'win32') return spawnDetached('explorer.exe', [`/select,${absolute}`])
  if (process.platform === 'darwin') return spawnDetached('open', ['-R', absolute])
  return spawnDetached('xdg-open', [dirname(absolute)])
}

/** Open a path with its default application. */
export async function openWithDefaultApp(target: string): Promise<void> {
  const absolute = resolve(target)
  if (process.platform === 'win32') return spawnDetached('explorer.exe', [absolute])
  if (process.platform === 'darwin') return spawnDetached('open', [absolute])
  return spawnDetached('xdg-open', [absolute])
}

async function spawnDetached(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolvePromise()
    })
  })
}
