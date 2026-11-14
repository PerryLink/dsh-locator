import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decodeSessionRef,
  encodeSessionRef,
  fileRef,
  fileRefTitle,
  freshnessFor,
  normalizeUrl,
  parseRef,
  sha256File,
  urlRef,
} from '../src/refs.ts'

describe('session refs', () => {
  it('round-trips through the canonical dsh-session URI', () => {
    const id = 'session-8f2a'
    const ref = encodeSessionRef(id)
    expect(ref.startsWith('dsh-session:')).toBe(true)
    expect(decodeSessionRef(ref)).toBe(id)
    expect(parseRef(ref)).toMatchObject({ kind: 'session', sessionId: id })
  })

  it('rejects malformed session refs', () => {
    expect(decodeSessionRef('dsh-session:')).toBeUndefined()
    expect(decodeSessionRef('dsh-session:%%%')).toBeUndefined()
    expect(decodeSessionRef('dsh-session:Zm9v')).toBeUndefined() // valid base64url, not a JSON string
    expect(decodeSessionRef('ref://file?path=/tmp/a')).toBeUndefined()
  })
})

describe('file and url refs', () => {
  it('round-trips file refs with locator and hash metadata', () => {
    const ref = fileRef({ path: '/tmp/a b.md', mtime: 10, size: 3, sha256: 'ab'.repeat(32) })
    expect(ref.startsWith('ref://file?')).toBe(true)
    expect(parseRef(ref)).toMatchObject({ kind: 'file', path: '/tmp/a b.md', sha256: 'ab'.repeat(32) })
    expect(fileRefTitle('/tmp/a b.md')).toBe('a b.md')
  })

  it('treats the path as a locator, not identity', () => {
    const one = fileRef({ path: '/tmp/a.md', sha256: 'aa' })
    const two = fileRef({ path: '/tmp/b.md', sha256: 'aa' })
    expect(one).not.toBe(two)
    expect(parseRef(fileRef({ path: '/tmp/a.md' }))).toMatchObject({ kind: 'file', path: '/tmp/a.md' })
  })

  it('builds URL refs from the normalized URL and rejects unknown schemes', () => {
    const ref = urlRef('HTTPS://Example.COM/docs#frag')
    expect(ref.startsWith('ref://url?')).toBe(true)
    const parsed = parseRef(ref)
    expect(parsed).toMatchObject({ kind: 'url', url: 'https://example.com/docs' })
    expect(normalizeUrl('not a url')).toBe('not a url')
    expect(parseRef('ref://mcp/server/resource')).toBeUndefined()
    expect(parseRef('https://example.com')).toBeUndefined()
  })
})

describe('hashing and freshness', () => {
  it('hashes files, respects the size cap and reports missing files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-refs-'))
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'hello')
    try {
      const hash = await sha256File(file)
      expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
      expect(await sha256File(file, 1)).toBeNull()
      expect(await sha256File(join(dir, 'missing.txt'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('labels freshness from indexed and current mtimes', () => {
    expect(freshnessFor(100, 100, 1)).toMatchObject({ state: 'fresh', mtime: 100, observedAt: 1 })
    expect(freshnessFor(100, 200, 1)).toMatchObject({ state: 'stale', mtime: 200 })
    expect(freshnessFor(100, undefined, 1)).toMatchObject({ state: 'missing' })
    expect(freshnessFor(undefined, undefined, 1)).toMatchObject({ state: 'unknown' })
  })
})
