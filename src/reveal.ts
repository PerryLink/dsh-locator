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
 * Ask the platform file manager to select a path. Uses an argument vector, not
 * a shell, so a path can never be interpreted as a command. The child is
 * detached: the opener outlives the plugin call.
 */
export async function revealInFileManager(target: string): Promise<void> {
  const absolute = resolve(target)
  let command: string
  let args: string[]
  if (process.platform === 'win32') {
    command = 'explorer.exe'
    args = [`/select,${absolute}`]
  } else if (process.platform === 'darwin') {
    command = 'open'
    args = ['-R', absolute]
  } else {
    command = 'xdg-open'
    args = [dirname(absolute)]
  }
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolvePromise()
    })
  })
}
