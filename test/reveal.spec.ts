import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { editorLaunchArgs, mountEscape, parseLineNumber, withinRoots } from '../src/reveal.ts'

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

  it('validates the optional open line number', () => {
    expect(parseLineNumber(1)).toBe(1)
    expect(parseLineNumber(42)).toBe(42)
    for (const invalid of [0, -1, 1.5, 1_000_001, '3', null, undefined, Number.NaN]) expect(parseLineNumber(invalid), String(invalid)).toBeNull()
  })
})

describe('editor line launch', () => {
  it('builds editor-specific goto arguments', () => {
    expect(editorLaunchArgs('code', '/home/u/a.md', 12)).toEqual(['--goto', '/home/u/a.md:12'])
    expect(editorLaunchArgs('/usr/bin/cursor', '/home/u/a.md', 7)).toEqual(['--goto', '/home/u/a.md:7'])
    expect(editorLaunchArgs('code-insiders.cmd', '/home/u/a.md', 3)).toEqual(['--goto', '/home/u/a.md:3'])
    expect(editorLaunchArgs('subl', '/home/u/a.md', 9)).toEqual(['/home/u/a.md:9'])
    expect(editorLaunchArgs('notepad', '/home/u/a.md', 5)).toEqual(['/home/u/a.md'])
  })
})
