/**
 * locator_read (agent-read.ts): meta/excerpt/quote shapes, whole-line windows,
 * batch reads, freshness, and the shared failure envelope. All file reads use
 * mkdtemp directories under the OS temp dir; no live index is touched.
 */

import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { makeAgentReadTool, READ_MAX_BYTES } from '../src/agent-read.ts'
import type { ContentIndex } from '../src/content.ts'
import { encodeSessionRef, fileRef, sessionEventRef, urlRef } from '../src/refs.ts'
import type { LocatorRuntime } from '../src/runtime.ts'

/** Windows may return 8.3 short names; compare canonical forms. */
const nativePath = (value: string): string => {
  try { return realpathSync.native(value) } catch { return realpathSync(value) }
}

function exec(cwd = '/work/a', sessionId = 'caller-session') {
  return { agent: { session: { id: sessionId, header: { cwd } } } } as never
}

function runtime(roots: string[]): LocatorRuntime {
  return { roots } as unknown as LocatorRuntime
}

function fakeContent(overrides: Record<string, unknown> = {}): ContentIndex {
  return {
    authorizedSessionIds: () => new Set(['caller-session']),
    refsFor: () => [],
    sessionEventBody: async () => undefined,
    sessionIndexedMtime: () => 5,
    ...overrides,
  } as unknown as ContentIndex
}

type Schema = Parameters<typeof validateJsonSchemaValue>[0]
const schemaOf = (tool: { output: { schema: unknown } }) => tool.output.schema as unknown as Schema

interface ReadItemView {
  ref?: string
  kind?: string
  title?: string
  path?: string
  seq?: number
  line?: number
  startLine?: number
  endLine?: number
  lineCount?: number
  excerpt?: string
  markdown?: string
  status?: string
  truncated?: boolean
  provenance?: { path?: string }
  permissions?: { read?: string }
  error?: { code?: string; message?: string; remediation?: string }
  warnings?: string[]
}

interface ReadValueView {
  apiVersion?: string
  ok: boolean
  tool?: string
  items?: ReadItemView[]
  counts?: { requested: number; returned: number; failed: number }
  budget?: { limitChars: number; usedChars: number; truncated: boolean; dropped: number }
  timing?: { tookMs: number }
  error?: { code?: string; message?: string; retryable?: boolean; remediation?: string }
}

const root = mkdtempSync(join(tmpdir(), 'locator-agent-read-'))
const rootReal = nativePath(root)
const doc = join(root, 'doc.md')
const other = join(root, 'other.md')
const lines = join(root, 'lines.txt')
const longLine = join(root, 'long.txt')
const missing = join(root, 'missing.md')

beforeAll(() => {
  writeFileSync(doc, 'alpha\nbeta\ngamma\n')
  writeFileSync(other, 'one\ntwo\n')
  writeFileSync(lines, 'l1\nl2\nl3\nl4\nl5\n')
  writeFileSync(longLine, 'x'.repeat(3000) + '\nsecond\n')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function infoOf(path: string) {
  const info = statSync(path)
  return { mtime: info.mtimeMs, size: info.size }
}

describe('locator_read meta', () => {
  it('returns the evidence block for one file ref and validates its schema', async () => {
    const info = infoOf(doc)
    const ref = fileRef({ path: doc, mtime: info.mtime, size: info.size })
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ ref, as: 'meta' }, exec()) as ReadValueView
    expect(value.ok).toBe(true)
    expect(value.apiVersion).toBe('2026-11')
    expect(value.tool).toBe('locator_read')
    expect(value.items).toHaveLength(1)
    const item = value.items?.[0]
    expect(item).toMatchObject({ kind: 'file', status: 'fresh', ref, permissions: { read: 'allowed' } })
    expect(item?.provenance?.path).toBe(nativePath(doc))
    expect(item?.excerpt).toBeUndefined()
    expect(typeof value.timing?.tookMs).toBe('number')
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('reports a missing file as status missing in meta mode instead of failing', async () => {
    const ref = fileRef({ path: missing })
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ ref, as: 'meta' }, exec()) as ReadValueView
    expect(value.ok).toBe(true)
    expect(value.items?.[0]?.status).toBe('missing')
  })

  it('leaves URL refs metadata-only', async () => {
    const ref = urlRef('https://example.com/report')
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ ref, as: 'meta' }, exec()) as ReadValueView
    expect(value.ok).toBe(true)
    expect(value.items?.[0]).toMatchObject({ kind: 'url', status: 'unknown' })
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })
})

describe('locator_read excerpt', () => {
  it('reads the ref anchor line by default (window 0)', async () => {
    const info = infoOf(doc)
    const ref = fileRef({ path: doc, mtime: info.mtime, size: info.size, line: 2 })
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ ref }, exec()) as ReadValueView
    expect(value.ok).toBe(true)
    const item = value.items?.[0]
    expect(item?.excerpt).toBe('beta')
    expect(item).toMatchObject({ line: 2, startLine: 2, endLine: 2, status: 'fresh' })
    expect(value.budget).toMatchObject({ limitChars: 2000, truncated: false, dropped: 0 })
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('adds window lines on both sides and keeps them whole', async () => {
    const info = infoOf(lines)
    const ref = fileRef({ path: lines, mtime: info.mtime, size: info.size, line: 3 })
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ ref, window: 1 }, exec()) as ReadValueView
    const item = value.items?.[0]
    expect(item?.excerpt).toBe('l2\nl3\nl4')
    expect(item).toMatchObject({ startLine: 2, endLine: 4 })
    expect(item?.warnings).toBeUndefined()
  })

  it('drops window lines over maxBytes but keeps the target line whole', async () => {
    const info = infoOf(lines)
    const ref = fileRef({ path: lines, mtime: info.mtime, size: info.size, line: 3 })
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ ref, window: 2, maxBytes: 2 }, exec()) as ReadValueView
    const item = value.items?.[0]
    expect(item?.excerpt).toBe('l3')
    expect(item?.truncated).toBe(true)
    expect(value.budget).toMatchObject({ truncated: true, dropped: 4 })
  })

  it('never slices the target line to satisfy maxBytes', async () => {
    const info = infoOf(longLine)
    const ref = fileRef({ path: longLine, mtime: info.mtime, size: info.size, line: 1 })
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ ref, maxBytes: 100 }, exec()) as ReadValueView
    const item = value.items?.[0]
    expect(item?.excerpt).toHaveLength(3000)
    expect(item?.truncated).toBe(true)
    expect(value.budget?.truncated).toBe(true)
  })

  it('clamps maxBytes to the documented ceiling', async () => {
    const info = infoOf(doc)
    const ref = fileRef({ path: doc, mtime: info.mtime, size: info.size })
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ ref, maxBytes: READ_MAX_BYTES * 4 }, exec()) as ReadValueView
    expect(value.ok).toBe(true)
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })
})

describe('locator_read quote', () => {
  it('renders a markdown blockquote plus the citation link and fallback path', async () => {
    const info = infoOf(doc)
    const ref = fileRef({ path: doc, mtime: info.mtime, size: info.size, line: 2 })
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ ref, as: 'quote', window: 0 }, exec()) as ReadValueView
    const item = value.items?.[0]
    expect(item?.markdown).toContain('> beta')
    expect(item?.markdown).toContain('[' + 'doc.md' + '](')
    expect(item?.markdown).toContain('fallback: ' + rootReal)
    expect(item?.excerpt).toBe('beta')
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('quotes a multi-line window', async () => {
    const info = infoOf(lines)
    const ref = fileRef({ path: lines, mtime: info.mtime, size: info.size, line: 3 })
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ ref, as: 'quote', window: 1 }, exec()) as ReadValueView
    expect(value.items?.[0]?.markdown).toBe([
      '> l2\n> l3\n> l4',
      '',
      '[lines.txt](' + ref + ')',
      '',
      'fallback: ' + nativePath(lines),
    ].join('\n'))
  })
})

describe('locator_read path target', () => {
  it('reads one line of a workspace path and builds its ref', async () => {
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ path: doc, line: 3, as: 'excerpt' }, exec()) as ReadValueView
    const item = value.items?.[0]
    expect(item?.kind).toBe('file')
    expect(item?.path).toBe(nativePath(doc))
    expect(item?.excerpt).toBe('gamma')
    expect(item?.ref).toMatch(/^ref:\/\/file\?path=/)
    expect(item?.status).toBe('fresh')
  })

  it('resolves a relative path against the caller cwd', async () => {
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ path: 'doc.md', as: 'excerpt' }, exec(root)) as ReadValueView
    expect(value.ok).toBe(true)
    expect(value.items?.[0]?.excerpt).toBe('alpha')
  })
})

describe('locator_read batches', () => {
  it('returns one row per ref, including per-ref errors, instead of failing the call', async () => {
    const info = infoOf(doc)
    const ref = fileRef({ path: doc, mtime: info.mtime, size: info.size, line: 1 })
    const ref2 = fileRef({ path: other, mtime: statSync(other).mtimeMs, size: statSync(other).size, line: 2 })
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ refs: [ref, fileRef({ path: missing }), ref2] }, exec()) as ReadValueView
    expect(value.ok).toBe(true)
    expect(value.counts).toEqual({ requested: 3, returned: 2, failed: 1 })
    expect(value.items).toHaveLength(3)
    expect(value.items?.[0]?.excerpt).toBe('alpha')
    expect(value.items?.[1]?.error?.code).toBe('not-found')
    expect(value.items?.[2]?.excerpt).toBe('two')
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('fails the envelope when every ref fails', async () => {
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ refs: ['ref://mcp/nope', 'not-a-ref'] }, exec()) as ReadValueView
    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('invalid-argument')
    expect(value.apiVersion).toBe('2026-11')
    expect(value.tool).toBe('locator_read')
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })
})

describe('locator_read errors', () => {
  it('rejects ambiguous or oversized arguments with invalid-argument', async () => {
    const tool = makeAgentReadTool(runtime([root]))
    const both = await tool.execute({ ref: fileRef({ path: doc }), path: doc }, exec()) as ReadValueView
    expect(both.ok).toBe(false)
    expect(both.error?.code).toBe('invalid-argument')
    const twentyOne = await tool.execute({ refs: new Array(21).fill(fileRef({ path: doc })) }, exec()) as ReadValueView
    expect(twentyOne.error?.code).toBe('invalid-argument')
    const window = await tool.execute({ path: doc, window: 21 }, exec()) as ReadValueView
    expect(window.error?.code).toBe('invalid-argument')
    const badLine = await tool.execute({ path: doc, line: 0 }, exec()) as ReadValueView
    expect(badLine.error?.code).toBe('invalid-argument')
  })

  it('maps scope, not-found and unsupported-mode failures to closed codes', async () => {
    const tool = makeAgentReadTool(runtime([root]))
    const outside = await tool.execute({ path: '/etc/hostname', as: 'excerpt' }, exec()) as ReadValueView
    expect(outside.ok).toBe(false)
    expect(outside.error?.code).toBe('scope-denied')
    const beyond = await tool.execute({ path: lines, line: 99, as: 'excerpt' }, exec()) as ReadValueView
    expect(beyond.error?.code).toBe('not-found')
    const url = await tool.execute({ ref: urlRef('https://example.com/x'), as: 'excerpt' }, exec()) as ReadValueView
    expect(url.error?.code).toBe('invalid-argument')
    const session = await tool.execute({ ref: encodeSessionRef('caller-session'), as: 'excerpt' }, exec()) as ReadValueView
    expect(session.error?.code).toBe('invalid-argument')
    const malformed = await tool.execute({ ref: 'ref://mcp/x/y' }, exec()) as ReadValueView
    expect(malformed.error?.code).toBe('invalid-argument')
  })

  it('returns a retryable-free not-found for a missing excerpt target', async () => {
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ ref: fileRef({ path: missing }), as: 'excerpt' }, exec()) as ReadValueView
    expect(value.ok).toBe(false)
    expect(value.error).toMatchObject({ code: 'not-found', retryable: false })
  })
})

describe('locator_read session-event refs', () => {
  const sessionId = 'caller-session'
  const body = JSON.stringify({ type: 'message', data: { content: [{ type: 'text', text: 'hello event text' }] } })
  function eventTool() {
    return makeAgentReadTool(runtime([]), fakeContent({
      authorizedSessionIds: () => new Set([sessionId]),
      sessionEventBody: async () => body,
    }))
  }

  it('reads event text as an excerpt', async () => {
    const ref = sessionEventRef({ sessionId, seq: 3 })
    const tool = eventTool()
    const value = await tool.execute({ ref, as: 'excerpt' }, exec()) as ReadValueView
    expect(value.ok).toBe(true)
    expect(value.items?.[0]).toMatchObject({ kind: 'session-event', seq: 3, excerpt: 'hello event text', status: 'fresh' })
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('renders event text as a quoted citation', async () => {
    const ref = sessionEventRef({ sessionId, seq: 3 })
    const tool = eventTool()
    const value = await tool.execute({ ref, as: 'quote' }, exec()) as ReadValueView
    expect(value.items?.[0]?.markdown).toContain('> hello event text')
    expect(value.items?.[0]?.markdown).toContain(ref)
  })

  it('denies session events owned by another workspace', async () => {
    const ref = sessionEventRef({ sessionId: 'other-session', seq: 1 })
    const tool = eventTool()
    const value = await tool.execute({ ref, as: 'excerpt' }, exec()) as ReadValueView
    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('scope-denied')
  })
})
