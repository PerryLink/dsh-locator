import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ContentIndex } from '../src/content.ts'
import { attachmentRef, fileRef, encodeSessionRef, sessionEventRef, spillRef } from '../src/refs.ts'
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
