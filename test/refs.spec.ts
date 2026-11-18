import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import {
  attachmentRef,
  checkUrlFreshness,
  decodeSessionRef,
  encodeSessionRef,
  fileRef,
  fileRefTitle,
  forgetUrlFreshness,
  freshnessFor,
  normalizeUrl,
  parseRef,
  parseUrlFreshnessMeta,
  recallUrlFreshness,
  refStatusForFreshness,
  rememberUrlFreshness,
  sessionEventRef,
  sha256File,
  spillRef,
  urlFreshnessMetaPatch,
  urlRef,
  type UrlFreshnessRecord,
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

describe('session-event, spill and attachment refs', () => {
  it('round-trips session-event refs without breaking the canonical session URI', () => {
    const ref = sessionEventRef({ sessionId: 'session-abc', seq: 42 })
    expect(parseRef(ref)).toEqual({ kind: 'session-event', ref, sessionId: 'session-abc', seq: 42 })
    expect(parseRef('dsh-session:abc#seq=4')).toBeUndefined()
  })

  it('round-trips spill refs with optional ownership', () => {
    const bare = spillRef({ path: '/tmp/spill/x' })
    expect(parseRef(bare)).toEqual({ kind: 'spill', ref: bare, path: '/tmp/spill/x' })
    const owned = spillRef({ path: '/tmp/spill/y', sessionId: 's1', seq: 3 })
    expect(parseRef(owned)).toMatchObject({ kind: 'spill', path: '/tmp/spill/y', sessionId: 's1', seq: 3 })
  })

  it('validates attachment digests', () => {
    const sha = 'a'.repeat(64)
    const ref = attachmentRef({ sha256: sha.toUpperCase() })
    expect(parseRef(ref)).toEqual({ kind: 'attachment', ref, sha256: sha })
    expect(parseRef('ref://attachment?sha256=not-a-digest')).toBeUndefined()
  })

  it('normalizes URL fragments for identity', () => {
    const ref = urlRef('https://Example.com/a.pdf#page=3')
    expect(ref).toContain(encodeURIComponent('https://example.com/a.pdf'))
    expect(ref).not.toContain('page=3')
  })
})


describe('ref lifecycle status', () => {
  it('maps freshness states onto the additive lifecycle status', () => {
    expect(refStatusForFreshness('fresh')).toBe('fresh')
    expect(refStatusForFreshness('stale')).toBe('stale')
    expect(refStatusForFreshness('missing')).toBe('missing')
    expect(refStatusForFreshness('unknown')).toBe('unknown')
  })

  it('round-trips file ref line anchors and snapshot metadata', () => {
    const ref = fileRef({
      path: '/tmp/a.md',
      mtime: 1234,
      size: 99,
      sha256: 'ab'.repeat(32),
      line: 7,
      charStart: 3,
      charEnd: 9,
    })
    expect(parseRef(ref)).toMatchObject({
      kind: 'file',
      path: '/tmp/a.md',
      mtime: 1234,
      size: 99,
      sha256: 'ab'.repeat(32),
      line: 7,
      charStart: 3,
      charEnd: 9,
    })
  })

  it('keeps legacy file refs without anchors usable and drops invalid anchors', () => {
    const legacy = parseRef(fileRef({ path: '/tmp/legacy.md', mtime: 10 }))
    expect(legacy).toMatchObject({ kind: 'file', path: '/tmp/legacy.md', mtime: 10 })
    expect(legacy !== undefined && 'line' in legacy).toBe(false)
    expect(legacy !== undefined && 'size' in legacy).toBe(false)
    const bad = 'ref://file?path=%2Ftmp%2Fb.md&line=0&cs=-1&ce=abc'
    expect(parseRef(bad)).toMatchObject({ kind: 'file', path: '/tmp/b.md' })
  })
})

/** Start one loopback HTTP server and return its base URL. */
async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server has no port')
  return { server, url: 'http://127.0.0.1:' + String(address.port) }
}

/** Close one test server, dropping keep-alive sockets so the test can finish. */
async function stop(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
}

describe('url freshness metadata', () => {
  it('round-trips the observation through the bounded refs.meta patch', () => {
    const record: UrlFreshnessRecord = {
      url: 'https://example.com/doc',
      status: 'fresh',
      checkedAt: 1_700_000_000_000,
      etag: '"v1"',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
      contentSha256: 'a'.repeat(64),
      contentLength: 42,
      statusCode: 200,
    }
    const patch = urlFreshnessMetaPatch(record)
    const parsed = parseUrlFreshnessMeta(JSON.stringify(patch))
    expect(parsed).toEqual({
      url: '',
      status: 'fresh',
      checkedAt: record.checkedAt,
      etag: '"v1"',
      lastModified: record.lastModified,
      contentSha256: record.contentSha256,
      contentLength: 42,
      statusCode: 200,
    })
    expect(JSON.stringify(patch).length).toBeLessThan(400)
  })

  it('ignores legacy or malformed meta rows', () => {
    expect(parseUrlFreshnessMeta(null)).toBeUndefined()
    expect(parseUrlFreshnessMeta('not json')).toBeUndefined()
    expect(parseUrlFreshnessMeta(JSON.stringify({ snippet: 'x' }))).toBeUndefined()
    expect(parseUrlFreshnessMeta(JSON.stringify({ urlFreshness: { status: 'weird', checkedAt: 1 } }))).toBeUndefined()
  })

  it('remembers and forgets in-process observations', () => {
    forgetUrlFreshness()
    const record: UrlFreshnessRecord = { url: 'https://example.com/a', status: 'stale', checkedAt: 5 }
    rememberUrlFreshness('ref://url?x', record)
    expect(recallUrlFreshness('ref://url?x')).toBe(record)
    forgetUrlFreshness('ref://url?x')
    expect(recallUrlFreshness('ref://url?x')).toBeUndefined()
    rememberUrlFreshness('', record)
    expect(recallUrlFreshness('')).toBeUndefined()
    forgetUrlFreshness()
  })
})

describe('url freshness checks', () => {
  it('baselines a 200 response and revalidates it with a 304', async () => {
    const seen: Array<string | undefined> = []
    const { server, url } = await serve((req, res) => {
      seen.push(req.headers['if-none-match'] as string | undefined)
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304, { etag: '"v1"' })
        res.end()
        return
      }
      res.writeHead(200, { etag: '"v1"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT', 'content-type': 'text/plain' })
      res.end('hello evidence')
    })
    try {
      const first = await checkUrlFreshness(url + '/doc')
      expect(first.record).toMatchObject({ status: 'fresh', statusCode: 200, etag: '"v1"' })
      expect(first.record.contentSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(first.warnings).toContain('url-freshness-baseline')
      const second = await checkUrlFreshness(url + '/doc', first.record)
      expect(second.record).toMatchObject({ status: 'fresh', statusCode: 304, etag: '"v1"' })
      expect(second.record.contentSha256).toBe(first.record.contentSha256)
      expect(second.warnings).toEqual([])
      expect(seen[0]).toBeUndefined()
      expect(seen[1]).toBe('"v1"')
    } finally {
      await stop(server)
    }
  })

  it('reports stale when the body hash changed and missing for 410', async () => {
    let body = 'original body'
    const { server, url } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(body)
    })
    try {
      const first = await checkUrlFreshness(url + '/a')
      body = 'changed body'
      const second = await checkUrlFreshness(url + '/a', first.record)
      expect(second.record.status).toBe('stale')
      expect(second.warnings).toContain('url-content-changed')
    } finally {
      await stop(server)
    }
    const gone = await serve((_req, res) => {
      res.writeHead(410)
      res.end()
    })
    try {
      const check = await checkUrlFreshness(gone.url + '/gone')
      expect(check.record).toMatchObject({ status: 'missing', statusCode: 410 })
      expect(check.warnings).toContain('url-gone')
    } finally {
      await stop(gone.server)
    }
  })

  it('reports stale, not missing, for timeouts and unreachable targets', async () => {
    const slow = await serve((_req, res) => {
      setTimeout(() => {
        res.writeHead(200)
        res.end('late body')
      }, 400)
    })
    try {
      const check = await checkUrlFreshness(slow.url + '/slow', undefined, { timeoutMs: 100 })
      expect(check.record.status).toBe('stale')
      expect(check.warnings).toContain('url-check-timeout')
    } finally {
      await stop(slow.server)
    }
    const closed = await serve((_req, res) => {
      res.writeHead(200)
      res.end('x')
    })
    const deadUrl = closed.url + '/x'
    await stop(closed.server)
    const unreachable = await checkUrlFreshness(deadUrl, undefined, { timeoutMs: 500 })
    expect(unreachable.record.status).toBe('stale')
    expect(unreachable.warnings).toContain('url-unreachable')
  })

  it('rejects unsupported schemes and malformed URLs without a request', async () => {
    expect(await checkUrlFreshness('file:///tmp/evidence.txt')).toMatchObject({
      record: { status: 'unknown' },
      warnings: ['url-scheme-unsupported'],
    })
    expect((await checkUrlFreshness('not a url')).warnings).toContain('url-invalid')
  })
})

