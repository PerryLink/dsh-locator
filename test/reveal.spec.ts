import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mountEscape, withinRoots } from '../src/reveal.ts'

describe('withinRoots', () => {
  const root = resolve(tmpdir(), 'locator-reveal-root')
  it('accepts the root and descendants', () => {
    expect(withinRoots(root, [root])).toBe(true)
    expect(withinRoots(join(root, 'docs', 'report.pdf'), [root])).toBe(true)
  })
  it('rejects siblings that only share a prefix', () => {
    expect(withinRoots(`${root}-other`, [root])).toBe(false)
    expect(withinRoots(join(root, '..', 'elsewhere'), [root])).toBe(false)
  })
  it('rejects relative and empty paths', () => {
    expect(withinRoots('relative/file.txt', [root])).toBe(false)
    expect(withinRoots('', [root])).toBe(false)
  })

  it('rejects targets below a nested mount point', () => {
    expect(mountEscape('/home/u/root/bind/secret.txt', ['/home/u/root'], ['/home/u/root/bind'])).toBe('/home/u/root/bind')
    // An ancestor mount (home on its own filesystem) is not an escape.
    expect(mountEscape('/home/u/root/a.txt', ['/home/u/root'], ['/home'])).toBeUndefined()
    // The root itself is allowed even when it is a mount point.
    expect(mountEscape('/home/u/root/a.txt', ['/home/u/root'], ['/home/u/root'])).toBeUndefined()
  })
})
