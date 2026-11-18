import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { ContentIndex } from '../src/content.ts'
import {
  attachmentRef,
  fileRef,
  encodeSessionRef,
  forgetUrlFreshness,
  parseUrlFreshnessMeta,
  sessionEventRef,
  sha256File,
  spillRef,
  urlFreshnessMetaPatch,
  urlRef,
} from '../src/refs.ts'
import { makeCiteTool, makeResolveTool } from '../src/ref-tools.ts'
import type { LocatorRuntime } from '../src/runtime.ts'

function exec(cwd = '/work/a', sessionId = 'caller-session') {
  return { agent: { session: { id: sessionId, header: { cwd } } } } as never
}

function runtime(roots: string[]): LocatorRuntime {
  return { roots } as unknown as LocatorRuntime
}

function fakeContent(overrides: Record<string, unknown> = {}): ContentIndex {
  return {
    authorizedSessionIds: () => new Set(['caller-session']),
    indexedMtime: () => undefined,
    sessionIndexedMtime: () => undefined,
    sessionBody: () => undefined,
    refsFor: () => [],
    sessionEventBody: async () => undefined,
    ...overrides,
  } as unknown as ContentIndex
}

const schemaOf = (tool: { output: { schema: unknown } }) => tool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]

describe('locator_resolve', () => {
  it('resolves an authorized file ref with hash, freshness and permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-resolve-'))
    const file = join(dir, 'a.md')
    writeFileSync(file, 'evidence body')
    try {
      const tool = makeResolveTool(runtime([dir]))
      const index = fakeContent()
      const value = await tool.execute({ ref: fileRef({ path: file }), mode: 'excerpt', maxBytes: 6 }, exec('/', 'caller-session')) as Record<string, unknown>
      expect(value).toMatchObject({ ok: true, kind: 'file', permissions: { read: 'allowed' } })
      expect(String(value.hash)).toMatch(/^[0-9a-f]{64}$/)
      expect(String(value.excerpt)).toBe('eviden')
      expect(value.freshness).toMatchObject({ state: 'fresh' })
      expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
      // keep the fake content used so the type is exercised
      expect(index.authorizedSessionIds('/work/a', 'caller-session').has('caller-session')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('denies file refs outside the indexed roots', async () => {
    const tool = makeResolveTool(runtime(['/work/a']))
    const value = await tool.execute({ ref: fileRef({ path: '/etc/passwd' }) }, exec()) as { ok: boolean; error?: string }
    expect(value.ok).toBe(false)
    expect(value.error).toBe('content-path-denied')
  })

  it('denies session refs from another workspace', async () => {
    const tool = makeResolveTool(runtime([]), fakeContent({ authorizedSessionIds: () => new Set(['caller-session']) }))
    const ref = encodeSessionRef('other-session')
    const value = await tool.execute({ ref }, exec()) as { ok: boolean; error?: string; permissions?: { read?: string } }
    expect(value.ok).toBe(false)
    expect(value.error).toBe('content-scope-denied')
    expect(value.permissions?.read).toBe('denied')
  })

  it('resolves an authorized session ref excerpt from the index body', async () => {
    const tool = makeResolveTool(runtime([]), fakeContent({
      authorizedSessionIds: () => new Set(['caller-session', 'target-session']),
      sessionIndexedMtime: () => 5,
      indexedMtime: () => 5,
      sessionBody: () => 'stored session body',
    }))
    const ref = encodeSessionRef('target-session')
    const value = await tool.execute({ ref, mode: 'excerpt', messageId: 'msg-1' }, exec()) as Record<string, unknown>
    expect(value).toMatchObject({ ok: true, kind: 'session', excerpt: 'stored session body' })
    expect(value.permissions).toMatchObject({ read: 'allowed', visibility: 'session' })
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('rejects malformed refs', async () => {
    const tool = makeResolveTool(runtime([]))
    const value = await tool.execute({ ref: 'ref://mcp/x/y' }, exec()) as { ok: boolean; error?: string }
    expect(value.ok).toBe(false)
    expect(value.error).toBe('invalid-ref')
  })
})

describe('locator_cite', () => {
  it('renders file and session citations in markdown and mention formats', async () => {
    const tool = makeCiteTool()
    const file = fileRef({ path: '/tmp/report.pdf' })
    const session = encodeSessionRef('session-1234567890')
    const markdown = await tool.execute({ refs: [file, session] }, exec()) as { ok: boolean; citations?: Array<{ markdown: string }> }
    expect(markdown.ok).toBe(true)
    expect(markdown.citations?.[0]?.markdown).toBe(`[report.pdf](${file})`)
    expect(markdown.citations?.[1]?.markdown.startsWith('@[session session-1234]')).toBe(true)
    expect(validateJsonSchemaValue(schemaOf(tool), markdown)).toEqual([])
    const mention = await tool.execute({ refs: [session], format: 'mention' }, exec()) as { format?: string }
    expect(mention.format).toBe('mention')
  })

  it('rejects invalid refs and empty input', async () => {
    const tool = makeCiteTool()
    expect(((await tool.execute({ refs: ['nope'] }, exec())) as { ok: boolean }).ok).toBe(false)
    expect(((await tool.execute({ refs: [] }, exec())) as { ok: boolean }).ok).toBe(false)
  })
})

describe('locator_resolve — Wave 2 ref kinds', () => {
  const stored = (sessionId: string, messageId = 'm1') => ({
    refKey: 'x', kind: 'url', target: '', sha256: null, sessionId, messageId,
    seq: 1, origin: 'session', title: null, bytes: null, meta: null, logMtime: 1, indexedAt: 1,
  })

  it('resolves an authorized session-event excerpt', async () => {
    const body = JSON.stringify({ type: 'assistant/message', data: { message: { id: 'm1', content: [{ type: 'text', text: 'event body' }] } } })
    const tool = makeResolveTool(runtime([]), fakeContent({
      authorizedSessionIds: () => new Set(['caller-session', 'target-session']),
      sessionIndexedMtime: () => Date.now(),
      sessionEventBody: async () => body,
    }))
    const ref = sessionEventRef({ sessionId: 'target-session', seq: 7 })
    const value = await tool.execute({ ref, mode: 'excerpt', maxBytes: 20 }, exec()) as Record<string, unknown>
    expect(value).toMatchObject({ ok: true, kind: 'session-event', title: expect.stringContaining('event 7') })
    expect(String(value.excerpt)).toBe(body.slice(0, 20))
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('denies session-event refs from another workspace', async () => {
    const tool = makeResolveTool(runtime([]), fakeContent({ authorizedSessionIds: () => new Set(['caller-session']) }))
    const value = await tool.execute({ ref: sessionEventRef({ sessionId: 'other', seq: 1 }) }, exec()) as { ok: boolean; error?: string }
    expect(value).toMatchObject({ ok: false, error: 'content-scope-denied' })
  })

  it('resolves an authorized spill ref from its owned session directory', async () => {
    const sessionId = 'target-session'
    const dir = mkdtempSync(join(tmpdir(), 'locator-spill-'))
    const sessionDir = join(dir, `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`)
    mkdirSync(sessionDir, { recursive: true })
    const file = join(sessionDir, 'aaaa-notes.txt')
    writeFileSync(file, 'spill body')
    try {
      const tool = makeResolveTool(runtime([]), fakeContent({
        authorizedSessionIds: () => new Set(['caller-session', sessionId]),
        refsFor: () => [stored(sessionId, 'call-1')],
      }))
      const ref = spillRef({ path: file, sessionId, seq: 2 })
      const value = await tool.execute({ ref, mode: 'excerpt', maxBytes: 5 }, exec()) as Record<string, unknown>
      expect(value).toMatchObject({ ok: true, kind: 'spill', freshness: { state: 'fresh' } })
      expect(String(value.excerpt)).toBe('spill')
      expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('denies spill refs without an authorized occurrence', async () => {
    const tool = makeResolveTool(runtime([]), fakeContent())
    const value = await tool.execute({ ref: spillRef({ path: '/tmp/x' }) }, exec()) as { ok: boolean; error?: string }
    expect(value).toMatchObject({ ok: false, error: 'content-scope-denied' })
  })

  it('resolves an authorized attachment ref from the local store', async () => {
    const sha = 'c'.repeat(64)
    const home = mkdtempSync(join(tmpdir(), 'locator-attach-'))
    const dir = join(home, 'attachments', 'v1', 'file-objects', sha.slice(0, 2))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, sha), 'attachment text')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const tool = makeResolveTool(runtime([]), fakeContent({
        authorizedSessionIds: () => new Set(['caller-session', 'target-session']),
        refsFor: () => [stored('target-session', 'm-user')],
      }))
      const value = await tool.execute({ ref: attachmentRef({ sha256: sha }), mode: 'excerpt', maxBytes: 10 }, exec()) as Record<string, unknown>
      expect(value).toMatchObject({ ok: true, kind: 'attachment', freshness: { state: 'fresh' } })
      expect(String(value.excerpt)).toBe('attachment')
      expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('locator_resolve — lazy missing write-back', () => {
  it('writes one spill miss and answers later resolves from the stored marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-spill-miss-'))
    const file = join(dir, 'gone-notes.txt')
    const sessionId = 'target-session'
    const ref = spillRef({ path: file, sessionId, seq: 2 })
    let meta: string | null = null
    const marked: string[] = []
    const tool = makeResolveTool(runtime([]), fakeContent({
      authorizedSessionIds: () => new Set(['caller-session', sessionId]),
      refsFor: () => [{
        refKey: ref, kind: 'spill', target: file, sha256: null, sessionId, messageId: 'call-1',
        seq: 2, origin: 'spill', title: null, bytes: null, meta, logMtime: 1, indexedAt: 1,
      }],
      markRefMissing: (refKey: string) => {
        marked.push(refKey)
        meta = JSON.stringify({ missing: true, missingAt: 1 })
        return true
      },
    }))
    try {
      const first = await tool.execute({ ref }, exec()) as { ok: boolean; freshness?: { state?: string }; status?: string; warnings?: string[] }
      expect(first).toMatchObject({ ok: true, freshness: { state: 'missing' }, status: 'missing' })
      expect(first.warnings).toContain('spill-file-missing')
      expect(first.warnings).not.toContain('missing-state-cached')
      expect(marked).toEqual([ref])
      // The path appears later; the persisted marker answers without statting it.
      writeFileSync(file, 'created later')
      const second = await tool.execute({ ref }, exec()) as { ok: boolean; freshness?: { state?: string }; status?: string; warnings?: string[] }
      expect(second).toMatchObject({ ok: true, freshness: { state: 'missing' }, status: 'tombstoned' })
      expect(second.warnings).toContain('missing-state-cached')
      expect(marked).toHaveLength(1)
      expect(validateJsonSchemaValue(schemaOf(tool), second)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes one attachment miss and skips the attachment store afterwards', async () => {
    const home = mkdtempSync(join(tmpdir(), 'locator-attach-miss-'))
    const sha = 'd'.repeat(64)
    const sessionId = 'target-session'
    const ref = attachmentRef({ sha256: sha })
    let meta: string | null = null
    const marked: string[] = []
    const tool = makeResolveTool(runtime([]), fakeContent({
      authorizedSessionIds: () => new Set([sessionId]),
      refsFor: () => [{
        refKey: ref, kind: 'attachment', target: sha, sha256: sha, sessionId, messageId: 'm-user',
        seq: null, origin: 'attachment', title: 'pic.png', bytes: 12, meta, logMtime: 1, indexedAt: 1,
      }],
      markRefMissing: (refKey: string) => {
        marked.push(refKey)
        meta = JSON.stringify({ missing: true, missingAt: 1 })
        return true
      },
    }))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const first = await tool.execute({ ref }, exec()) as { ok: boolean; freshness?: { state?: string }; status?: string; warnings?: string[] }
      expect(first).toMatchObject({ ok: true, freshness: { state: 'missing' }, status: 'missing' })
      expect(first.warnings).toContain('attachment-missing')
      expect(marked).toEqual([ref])
      // Materialize the object: the marker must still win (no existsSync probe).
      const objectDir = join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2))
      mkdirSync(objectDir, { recursive: true })
      writeFileSync(join(objectDir, sha), 'image bytes')
      const second = await tool.execute({ ref, mode: 'excerpt' }, exec()) as { ok: boolean; freshness?: { state?: string }; status?: string; warnings?: string[]; excerpt?: string }
      expect(second).toMatchObject({ ok: true, freshness: { state: 'missing' }, status: 'tombstoned' })
      expect(second.warnings).toContain('missing-state-cached')
      expect(second.excerpt).toBeUndefined()
      expect(marked).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
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

/** Small pause used to force a distinct mtime. */
async function tick(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('locator_resolve — lifecycle status (P0-2)', () => {
  it('reports fresh, stale and missing file refs and validates the output schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-status-'))
    const file = join(dir, 'progress.md')
    writeFileSync(file, 'alpha')
    try {
      const info = statSync(file)
      const hash = await sha256File(file)
      if (hash === null) throw new Error('hash expected')
      const ref = fileRef({ path: file, mtime: info.mtimeMs, size: info.size, sha256: hash })
      const tool = makeResolveTool(runtime([dir]))
      const schema = schemaOf(tool)
      const fresh = await tool.execute({ ref }, exec()) as { ok: boolean; status?: string; checkedAt?: number; hash?: string; freshness?: { state?: string } }
      expect(fresh).toMatchObject({ ok: true, status: 'fresh', freshness: { state: 'fresh' }, hash })
      expect(typeof fresh.checkedAt).toBe('number')
      expect(validateJsonSchemaValue(schema, fresh)).toEqual([])
      await tick(20)
      writeFileSync(file, 'beta!')
      const stale = await tool.execute({ ref }, exec()) as { ok: boolean; status?: string; hash?: string; freshness?: { state?: string } }
      expect(stale).toMatchObject({ ok: true, status: 'stale', freshness: { state: 'stale' } })
      expect(stale.hash).not.toBe(hash)
      expect(validateJsonSchemaValue(schema, stale)).toEqual([])
      rmSync(file)
      const missing = await tool.execute({ ref }, exec()) as { ok: boolean; status?: string; warnings?: string[]; freshness?: { state?: string } }
      expect(missing).toMatchObject({ ok: true, status: 'missing', freshness: { state: 'missing' } })
      expect(missing.warnings).toContain('file-missing')
      expect(validateJsonSchemaValue(schema, missing)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips the slow hash when the ref snapshot mtime and size still match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-quick-'))
    const file = join(dir, 'quick.md')
    writeFileSync(file, 'unchanged bytes')
    try {
      const info = statSync(file)
      // A deliberately wrong hash proves the quick stat path answered without re-reading.
      const ref = fileRef({ path: file, mtime: info.mtimeMs, size: info.size, sha256: 'a'.repeat(64) })
      const tool = makeResolveTool(runtime([dir]))
      const value = await tool.execute({ ref }, exec()) as { ok: boolean; status?: string; hash?: string }
      expect(value).toMatchObject({ ok: true, status: 'fresh', hash: 'a'.repeat(64) })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flips a sha256-only file ref to stale when the bytes changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-sha-only-'))
    const file = join(dir, 'sha.md')
    writeFileSync(file, 'original')
    try {
      const hash = await sha256File(file)
      if (hash === null) throw new Error('hash expected')
      const ref = fileRef({ path: file, sha256: hash })
      const tool = makeResolveTool(runtime([dir]))
      const fresh = await tool.execute({ ref }, exec()) as { ok: boolean; status?: string; hash?: string }
      expect(fresh).toMatchObject({ ok: true, status: 'fresh', hash })
      writeFileSync(file, 'altered!')
      const stale = await tool.execute({ ref }, exec()) as { ok: boolean; status?: string; hash?: string }
      expect(stale.status).toBe('stale')
      expect(stale.hash).not.toBe(hash)
      expect(validateJsonSchemaValue(schemaOf(tool), stale)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('anchors a cited line and includes it in the file excerpt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-anchor-'))
    const file = join(dir, 'lines.md')
    writeFileSync(file, 'first\nsecond line\nthird\n')
    try {
      const info = statSync(file)
      const ref = fileRef({ path: file, mtime: info.mtimeMs, size: info.size, line: 2 })
      const tool = makeResolveTool(runtime([dir]))
      const value = await tool.execute({ ref, mode: 'excerpt', maxBytes: 6 }, exec()) as { ok: boolean; anchor?: { line?: number; charStart?: number; charEnd?: number }; excerpt?: string; status?: string }
      expect(value.status).toBe('fresh')
      expect(value.anchor).toEqual({ line: 2, charStart: 0, charEnd: 6 })
      expect(value.excerpt).toBe('second')
      expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports session-event excerpt status and anchor', async () => {
    const body = JSON.stringify({ type: 'assistant/message', data: { message: { id: 'm1', content: [{ type: 'text', text: 'event body' }] } } })
    const tool = makeResolveTool(runtime([]), fakeContent({
      authorizedSessionIds: () => new Set(['caller-session', 'target-session']),
      sessionIndexedMtime: () => Date.now(),
      sessionEventBody: async () => body,
    }))
    const ref = sessionEventRef({ sessionId: 'target-session', seq: 7 })
    const value = await tool.execute({ ref, mode: 'excerpt', maxBytes: 5 }, exec()) as { ok: boolean; status?: string; anchor?: { charStart?: number; charEnd?: number }; excerpt?: string }
    expect(value).toMatchObject({ ok: true, status: 'fresh', anchor: { charStart: 0, charEnd: 5 } })
    expect(value.excerpt).toBe(body.slice(0, 5))
    const missingTool = makeResolveTool(runtime([]), fakeContent({
      authorizedSessionIds: () => new Set(['caller-session', 'target-session']),
      sessionEventBody: async () => undefined,
    }))
    const missing = await missingTool.execute({ ref, mode: 'excerpt' }, exec()) as { ok: boolean; status?: string; warnings?: string[] }
    expect(missing).toMatchObject({ ok: true, status: 'missing' })
    expect(missing.warnings).toContain('event-log-unavailable')
  })
})

describe('locator_cite — detail mode (P0-2)', () => {
  it('quotes the cited file line with offsets, status and fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-cite-detail-'))
    const file = join(dir, 'notes.md')
    writeFileSync(file, 'first line\nsecond EVIDENCE line\nthird line')
    try {
      const info = statSync(file)
      const hash = await sha256File(file)
      if (hash === null) throw new Error('hash expected')
      const ref = fileRef({ path: file, mtime: info.mtimeMs, size: info.size, sha256: hash, line: 2 })
      const tool = makeCiteTool({ roots: [dir] })
      const value = await tool.execute({ refs: [ref], detail: 'exact' }, exec()) as {
        ok: boolean
        citations?: Array<{ kind?: string; title?: string; exact?: string; status?: string; visibility?: string; fallback?: string; markdown?: string; offsets?: { line?: number; charStart?: number; charEnd?: number } }>
        warnings?: string[]
      }
      expect(value.ok).toBe(true)
      const citation = value.citations?.[0]
      expect(citation).toMatchObject({
        kind: 'file',
        title: 'notes.md',
        exact: 'second EVIDENCE line',
        status: 'fresh',
        visibility: 'roots',
        fallback: file,
        offsets: { line: 2, charStart: 0, charEnd: 20 },
      })
      expect(citation?.markdown).toContain('> second EVIDENCE line')
      expect(citation?.markdown).toContain('fallback: ' + file)
      expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps compact citations unchanged and reports detail problems as warnings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-cite-detail-miss-'))
    const file = join(dir, 'gone.md')
    writeFileSync(file, 'gone body')
    const ref = fileRef({ path: file })
    try {
      const compact = await makeCiteTool({ roots: [dir] }).execute({ refs: [ref] }, exec()) as { citations?: Array<{ markdown?: string; exact?: string; status?: string }> }
      expect(compact.citations?.[0]?.markdown).toBe('[gone.md](' + ref + ')')
      expect(compact.citations?.[0]?.exact).toBeUndefined()
      expect(compact.citations?.[0]?.status).toBeUndefined()
      rmSync(file)
      const missing = await makeCiteTool({ roots: [dir] }).execute({ refs: [ref], detail: 'exact' }, exec()) as { citations?: Array<{ status?: string; exact?: string }>; warnings?: string[] }
      expect(missing.citations?.[0]).toMatchObject({ status: 'missing' })
      expect(missing.citations?.[0]?.exact).toBeUndefined()
      expect(missing.warnings).toContain('file-missing')
      const denied = await makeCiteTool({ roots: [join(tmpdir(), 'elsewhere')] }).execute({ refs: [ref], detail: 'exact' }, exec()) as { citations?: Array<{ status?: string }>; warnings?: string[] }
      expect(denied.citations?.[0]?.status).toBe('unknown')
      expect(denied.warnings).toContain('path-outside-roots')
      const unconfigured = await makeCiteTool().execute({ refs: [ref], detail: 'exact' }, exec()) as { citations?: Array<{ status?: string }>; warnings?: string[] }
      expect(unconfigured.citations?.[0]?.status).toBe('unknown')
      expect(unconfigured.warnings).toContain('roots-unavailable')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('quotes the session-event text and honors workspace authorization', async () => {
    const body = JSON.stringify({ type: 'assistant/message', data: { message: { id: 'm1', content: [{ type: 'text', text: 'event evidence body' }] } } })
    const content = fakeContent({
      authorizedSessionIds: () => new Set(['caller-session', 'target-session']),
      sessionEventBody: async () => body,
    })
    const ref = sessionEventRef({ sessionId: 'target-session', seq: 7 })
    const tool = makeCiteTool({ content })
    const value = await tool.execute({ refs: [ref], detail: 'exact' }, exec()) as {
      ok: boolean
      citations?: Array<{ kind?: string; exact?: string; status?: string; visibility?: string; title?: string; markdown?: string }>
      warnings?: string[]
    }
    expect(value.citations?.[0]).toMatchObject({
      kind: 'session-event',
      exact: 'event evidence body',
      status: 'fresh',
      visibility: 'session',
      title: 'session target-sessi event 7',
    })
    expect(value.citations?.[0]?.markdown).toContain('> event evidence body')
    expect(value.warnings).toBeUndefined()
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
    const denied = await makeCiteTool({
      content: fakeContent({
        authorizedSessionIds: () => new Set(['caller-session']),
        sessionEventBody: async () => body,
      }),
    }).execute({ refs: [ref], detail: 'exact' }, exec()) as { citations?: Array<{ status?: string; exact?: string }>; warnings?: string[] }
    expect(denied.citations?.[0]?.status).toBe('unknown')
    expect(denied.citations?.[0]?.exact).toBeUndefined()
    expect(denied.warnings).toContain('ref-not-authorized')
  })

  it('reports the cached URL freshness and fallback without any network call', async () => {
    const url = 'https://example.com/doc'
    const ref = urlRef(url)
    const meta = JSON.stringify(urlFreshnessMetaPatch({ url, status: 'fresh', checkedAt: 123, etag: '"v1"' }))
    const content = fakeContent({
      refsFor: () => [{
        refKey: ref, kind: 'url', target: url, sha256: null, sessionId: 'caller-session', messageId: 'm1',
        seq: null, origin: 'web_search', title: null, bytes: null, meta, logMtime: 1, indexedAt: 9,
      }],
    })
    const tool = makeCiteTool({ content })
    const value = await tool.execute({ refs: [ref], detail: 'exact' }, exec()) as {
      citations?: Array<{ status?: string; checkedAt?: number; fallback?: string; visibility?: string; markdown?: string }>
    }
    expect(value.citations?.[0]).toMatchObject({ status: 'fresh', checkedAt: 123, fallback: url, visibility: 'external' })
    expect(value.citations?.[0]?.markdown).toContain('[fallback](' + url + ')')
    forgetUrlFreshness()
    const unknown = await makeCiteTool({ content: fakeContent() }).execute({ refs: [ref], detail: 'exact' }, exec()) as { citations?: Array<{ status?: string }>; warnings?: string[] }
    expect(unknown.citations?.[0]?.status).toBe('unknown')
    expect(unknown.warnings).toContain('url-not-checked')
  })

  it('reports a plain session citation status from the index', async () => {
    const ref = encodeSessionRef('target-session')
    const tool = makeCiteTool({
      content: fakeContent({
        authorizedSessionIds: () => new Set(['caller-session', 'target-session']),
        sessionIndexedMtime: () => 42,
      }),
    })
    const value = await tool.execute({ refs: [ref], detail: 'exact' }, exec()) as { citations?: Array<{ status?: string; visibility?: string }> }
    expect(value.citations?.[0]).toMatchObject({ status: 'fresh', visibility: 'session' })
  })
})

describe('locator_resolve — URL freshness (P1-5)', () => {
  it('stays metadata-only unless urlFreshness is enabled', async () => {
    forgetUrlFreshness()
    let requests = 0
    const { server, url } = await serve((_req, res) => {
      requests += 1
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('never fetched')
    })
    try {
      const tool = makeResolveTool(runtime([]))
      const value = await tool.execute({ ref: urlRef(url + '/doc') }, exec()) as { ok: boolean; kind?: string; status?: string; warnings?: string[]; checkedAt?: number }
      expect(value).toMatchObject({ ok: true, kind: 'url', status: 'unknown' })
      expect(value.warnings).toContain('url-not-fetched')
      expect(value.checkedAt).toBeUndefined()
      await tick(30)
      expect(requests).toBe(0)
      expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
    } finally {
      await stop(server)
    }
  })

  it('baselines, persists and then revalidates a URL with If-None-Match', async () => {
    forgetUrlFreshness()
    const seen: Array<string | undefined> = []
    const { server, url } = await serve((req, res) => {
      seen.push(req.headers['if-none-match'] as string | undefined)
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304, { etag: '"v1"' })
        res.end()
        return
      }
      res.writeHead(200, { etag: '"v1"', 'content-type': 'text/plain' })
      res.end('fresh evidence body')
    })
    try {
      const patches: Array<{ refKey: string; patch: Record<string, unknown> }> = []
      const content = fakeContent({
        setRefMeta: (refKey: string, patch: Record<string, unknown>) => {
          patches.push({ refKey, patch })
          return true
        },
      })
      const tool = makeResolveTool(runtime([]), content, { urlFreshness: true })
      const ref = urlRef(url + '/doc')
      const schema = schemaOf(tool)
      const first = await tool.execute({ ref }, exec()) as { ok: boolean; status?: string; checkedAt?: number; hash?: string; warnings?: string[]; freshness?: { state?: string } }
      expect(first).toMatchObject({ ok: true, kind: 'url', status: 'fresh', freshness: { state: 'fresh' } })
      expect(first.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(first.warnings).toContain('url-freshness-baseline')
      expect(typeof first.checkedAt).toBe('number')
      expect(validateJsonSchemaValue(schema, first)).toEqual([])
      expect(patches).toHaveLength(1)
      expect(patches[0]?.refKey).toBe(ref)
      expect(parseUrlFreshnessMeta(JSON.stringify(patches[0]?.patch))).toMatchObject({ status: 'fresh' })
      expect(seen[0]).toBeUndefined()
      const second = await tool.execute({ ref }, exec()) as { ok: boolean; status?: string; warnings?: string[]; freshness?: { state?: string } }
      expect(second).toMatchObject({ ok: true, status: 'fresh', freshness: { state: 'fresh' } })
      expect(second.warnings).toBeUndefined()
      expect(seen[1]).toBe('"v1"')
      expect(validateJsonSchemaValue(schema, second)).toEqual([])
    } finally {
      await stop(server)
    }
  })

  it('reuses the persisted refs.meta observation and survives a fresh process cache', async () => {
    forgetUrlFreshness()
    const seen: Array<string | undefined> = []
    const { server, url } = await serve((req, res) => {
      seen.push(req.headers['if-none-match'] as string | undefined)
      res.writeHead(304, { etag: '"v1"' })
      res.end()
    })
    try {
      const target = url + '/doc'
      const ref = urlRef(target)
      const meta = JSON.stringify(urlFreshnessMetaPatch({ url: target, status: 'fresh', checkedAt: 111, etag: '"v1"' }))
      const content = fakeContent({
        refsFor: () => [{
          refKey: ref, kind: 'url', target, sha256: null, sessionId: 'caller-session', messageId: 'm1',
          seq: null, origin: 'web_fetch', title: null, bytes: null, meta, logMtime: 1, indexedAt: 5,
        }],
      })
      const cachedOnly = await makeResolveTool(runtime([]), content).execute({ ref }, exec()) as { status?: string; checkedAt?: number; warnings?: string[] }
      expect(cachedOnly).toMatchObject({ status: 'fresh', checkedAt: 111 })
      expect(cachedOnly.warnings).toContain('url-freshness-cached')
      expect(seen).toHaveLength(0)
      const checked = await makeResolveTool(runtime([]), content, { urlFreshness: true }).execute({ ref }, exec()) as { status?: string; warnings?: string[] }
      expect(checked.status).toBe('fresh')
      expect(seen[0]).toBe('"v1"')
    } finally {
      await stop(server)
    }
  })

  it('maps 410 to missing and network failure to stale', async () => {
    forgetUrlFreshness()
    const gone = await serve((_req, res) => {
      res.writeHead(410)
      res.end()
    })
    try {
      const tool = makeResolveTool(runtime([]), undefined, { urlFreshness: true })
      const value = await tool.execute({ ref: urlRef(gone.url + '/gone') }, exec()) as { ok: boolean; status?: string; warnings?: string[]; freshness?: { state?: string } }
      expect(value).toMatchObject({ ok: true, status: 'missing', freshness: { state: 'missing' } })
      expect(value.warnings).toContain('url-gone')
      expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
    } finally {
      await stop(gone.server)
    }
    const closed = await serve((_req, res) => {
      res.writeHead(200)
      res.end('x')
    })
    const deadUrl = closed.url + '/dead'
    await stop(closed.server)
    const unreachable = await makeResolveTool(runtime([]), undefined, { urlFreshness: true, urlFreshnessTimeoutMs: 500 })
      .execute({ ref: urlRef(deadUrl) }, exec()) as { status?: string; warnings?: string[] }
    expect(unreachable.status).toBe('stale')
    expect(unreachable.warnings).toContain('url-unreachable')
  })
})



describe('locator_resolve — URL freshness persistence', () => {
  it('persists validators through the real content-index refs.meta writer', async () => {
    forgetUrlFreshness()
    const sessions = mkdtempSync(join(tmpdir(), 'locator-url-refs-sessions-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'locator-url-refs-state-'))
    const sessionDir = join(sessions, '--work-a--', 'session-refs-a')
    mkdirSync(sessionDir, { recursive: true })
    let conditionals = 0
    let ifNoneMatch: string | undefined
    const { server, url } = await serve((req, res) => {
      conditionals += 1
      ifNoneMatch = req.headers['if-none-match'] as string | undefined
      if (ifNoneMatch === '"v1"') {
        res.writeHead(304, { etag: '"v1"' })
        res.end()
        return
      }
      res.writeHead(200, { etag: '"v1"', 'content-type': 'text/plain' })
      res.end('persisted url evidence')
    })
    const target = url + '/doc'
    const lines = [
      JSON.stringify({ type: 'session', version: 4, id: 'session-refs-a', createdAt: 1, cwd: '/work/a' }),
      JSON.stringify({
        type: 'tool/result',
        data: {
          seq: 1,
          message: { toolCallId: 'call-1', content: [{ type: 'text', text: 'fetched' }] },
          meta: { sources: [{ url: target, title: 'Doc', snippet: 'abstract' }], truncated: false },
        },
      }),
    ].join('\n')
    writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines)))
    const engine = { dump: async () => ({ entries: [], next: 0, done: true }) } as unknown as LocatorRuntime
    const content = new ContentIndex(engine, { stateDir, sessionDirs: [sessions], maxFileBytes: 1000, maxTotalBytes: 0, maxFiles: 0, maxSessions: 10 })
    try {
      content.start()
      for (let i = 0; i < 200 && content.status().building; i++) await tick(25)
      const ref = urlRef(target)
      const caller = exec('/work/a')
      const first = await makeResolveTool(runtime([]), content, { urlFreshness: true })
        .execute({ ref }, caller) as { ok: boolean; status?: string; checkedAt?: number; hash?: string }
      expect(first).toMatchObject({ ok: true, kind: 'url', status: 'fresh' })
      expect(first.hash).toMatch(/^[0-9a-f]{64}$/)
      const rows = content.refsFor(ref)
      expect(rows.length).toBeGreaterThan(0)
      expect(parseUrlFreshnessMeta(rows[0]?.meta)).toMatchObject({ status: 'fresh', etag: '"v1"' })
      expect(conditionals).toBe(1)
      const second = await makeResolveTool(runtime([]), content, { urlFreshness: true })
        .execute({ ref }, caller) as { ok: boolean; status?: string; warnings?: string[] }
      expect(second.status).toBe('fresh')
      expect(conditionals).toBe(2)
      expect(ifNoneMatch).toBe('"v1"')
    } finally {
      content.close()
      await stop(server)
      rmSync(sessions, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

