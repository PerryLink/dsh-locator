/**
 * locator_read (agent-read.ts): meta/excerpt/quote shapes, whole-line windows,
 * batch reads, freshness, and the shared failure envelope. All file reads use
 * mkdtemp directories under the OS temp dir; no live index is touched.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { makeAgentReadTool, READ_MAX_BYTES } from '../src/agent-read.ts'
import type { ContentIndex } from '../src/content.ts'
import { encodeSessionRef, fileRef, sessionEventRef, urlRef } from '../src/refs.ts'
import { makeCiteTool, makeResolveTool } from '../src/ref-tools.ts'
import type { LocatorRuntime } from '../src/runtime.ts'
import { Scope } from '../src/scope.ts'

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
  sessionId?: string
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
  counts?: { requested: number; returned: number; failed: number; duplicates?: number; linesDropped?: number }
  budget?: { limitChars: number; usedChars: number; truncated: boolean; dropped: number }
  limits?: { perExcerptChars: number; batchLimitChars: number; maxChars: number; maxRefs: number }
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
    // 0.23.0: the per-excerpt / batch split is explicit instead of implied by limitChars.
    expect(value.limits).toEqual({ perExcerptChars: 2000, batchLimitChars: 2000, maxChars: 0, maxRefs: 20 })
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
    // Rows are never dropped by read: the trimmed window lines are reported in
    // counts.linesDropped, and budget.dropped stays 0 (items, not lines).
    expect(value.budget).toMatchObject({ truncated: true, dropped: 0 })
    expect(value.counts).toMatchObject({ requested: 1, returned: 1, failed: 0, linesDropped: 4 })
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
    expect(value.counts).toMatchObject({ requested: 3, returned: 2, failed: 1, duplicates: 0, linesDropped: 0 })
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
    const twentyOne = await tool.execute({ refs: Array.from({ length: 21 }, (_, index) => fileRef({ path: doc, line: index + 1 })) }, exec()) as ReadValueView
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

  it('exposes sessionId and seq at the top level of a meta row', async () => {
    const ref = sessionEventRef({ sessionId, seq: 3 })
    const tool = eventTool()
    const value = await tool.execute({ ref, as: 'meta' }, exec()) as ReadValueView
    expect(value.ok).toBe(true)
    expect(value.items?.[0]).toMatchObject({ kind: 'session-event', sessionId, seq: 3 })
    expect(value.items?.[0]?.excerpt).toBeUndefined()
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })
})

describe('locator_read meta identity fields (0.23.0)', () => {
  it('exposes the file path and cited line at the top level of a meta row', async () => {
    const info = infoOf(doc)
    const ref = fileRef({ path: doc, mtime: info.mtime, size: info.size, line: 2 })
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ ref, as: 'meta' }, exec()) as ReadValueView
    expect(value.ok).toBe(true)
    expect(value.items?.[0]).toMatchObject({ kind: 'file', status: 'fresh', path: nativePath(doc), line: 2 })
    expect(value.items?.[0]?.excerpt).toBeUndefined()
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('exposes sessionId for a session-level meta row', async () => {
    const ref = encodeSessionRef('caller-session')
    const tool = makeAgentReadTool(runtime([]), fakeContent())
    const value = await tool.execute({ ref, as: 'meta' }, exec()) as ReadValueView
    expect(value.ok).toBe(true)
    expect(value.items?.[0]).toMatchObject({ kind: 'session', sessionId: 'caller-session' })
  })
})

describe('locator_read budget and limits (0.23.0)', () => {
  it('reports per-excerpt and batch limits and counts only the excerpt text', async () => {
    const info = infoOf(lines)
    const first = fileRef({ path: lines, mtime: info.mtime, size: info.size, line: 2 })
    const second = fileRef({ path: lines, mtime: info.mtime, size: info.size, line: 4 })
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ refs: [first, second], maxBytes: 10 }, exec()) as ReadValueView
    expect(value.ok).toBe(true)
    expect(value.limits).toEqual({ perExcerptChars: 10, batchLimitChars: 20, maxChars: 0, maxRefs: 20 })
    expect(value.budget).toMatchObject({ limitChars: 20, usedChars: 4, truncated: false, dropped: 0 })
    expect(value.counts).toMatchObject({ requested: 2, duplicates: 0, linesDropped: 0 })
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('collapses repeated refs before reading and reports the duplicate count', async () => {
    const info = infoOf(doc)
    const ref = fileRef({ path: doc, mtime: info.mtime, size: info.size, line: 1 })
    const otherRef = fileRef({ path: other, mtime: statSync(other).mtimeMs, size: statSync(other).size, line: 2 })
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ refs: [ref, ref, otherRef, ref] }, exec()) as ReadValueView
    expect(value.ok).toBe(true)
    expect(value.counts).toMatchObject({ requested: 2, returned: 2, failed: 0, duplicates: 2 })
    expect(value.items).toHaveLength(2)
    expect(value.items?.[0]?.excerpt).toBe('alpha')
    expect(value.items?.[1]?.excerpt).toBe('two')
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })
})

describe('locator_read remediation (0.23.0)', () => {
  it('points a directory path at locator_find kinds:[dir]', async () => {
    const tool = makeAgentReadTool(runtime([root]))
    const value = await tool.execute({ path: root, as: 'excerpt' }, exec()) as ReadValueView
    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('invalid-argument')
    expect(value.error?.message).toContain('not directories')
    expect(value.error?.remediation).toContain('kinds:["dir"]')
    expect(value.error?.remediation).toContain('locator_find')
  })

  it('points a session-level excerpt at eventRef and detail full', async () => {
    const tool = makeAgentReadTool(runtime([]), fakeContent())
    const value = await tool.execute({ ref: encodeSessionRef('caller-session'), as: 'excerpt' }, exec()) as ReadValueView
    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('invalid-argument')
    expect(value.error?.remediation).toContain('eventRef')
    expect(value.error?.remediation).toContain('detail:"full"')
  })
})

describe('locator_read notReadable fence (0.23.0 P0-1)', () => {
  const secretDir = join(root, 'secret')
  const secretFile = join(secretDir, 'keys.txt')
  const secretBytes = 'TOP-SECRET-BYTES-MUST-NEVER-LEAK'
  const scope = new Scope({ notSearchable: [], notReadable: ['**/secret/**'], notIndexed: [] }, false)
  const scopedRead = () => makeAgentReadTool(runtime([root]), undefined, { scope })

  beforeAll(() => {
    mkdirSync(secretDir, { recursive: true })
    writeFileSync(secretFile, secretBytes + '\nsecond secret line\n')
  })

  it('denies a notReadable path target before reading its bytes', async () => {
    const value = await scopedRead().execute({ path: secretFile, as: 'excerpt' }, exec()) as ReadValueView
    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('scope-denied')
    expect(value.error?.message).toContain('notReadable')
    expect(JSON.stringify(value)).not.toContain(secretBytes)
    expect(validateJsonSchemaValue(schemaOf(scopedRead()), value)).toEqual([])
  })

  it('denies meta/excerpt/quote for a notReadable ref, and never returns its body', async () => {
    const info = infoOf(secretFile)
    const ref = fileRef({ path: secretFile, mtime: info.mtime, size: info.size, line: 1 })
    for (const as of ['meta', 'excerpt', 'quote'] as const) {
      const value = await scopedRead().execute({ ref, as }, exec()) as ReadValueView
      expect(value.ok, as).toBe(false)
      expect(value.error?.code, as).toBe('scope-denied')
      expect(JSON.stringify(value), as).not.toContain(secretBytes)
    }
  })

  it('locator_resolve refuses the notReadable ref with denied permissions and no excerpt/hash', async () => {
    const info = infoOf(secretFile)
    const ref = fileRef({ path: secretFile, mtime: info.mtime, size: info.size, line: 1 })
    const tool = makeResolveTool(runtime([root]), undefined, { scope })
    const value = await tool.execute({ ref, mode: 'excerpt' }, exec()) as Record<string, unknown>
    expect(value).toMatchObject({ ok: false, kind: 'file', error: 'content-scope-denied', permissions: { read: 'denied' } })
    expect((value as { warnings?: string[] }).warnings).toContain('path-not-readable')
    expect(value.excerpt).toBeUndefined()
    expect(value.hash).toBeUndefined()
    expect(value.size).toBeUndefined()
    expect(JSON.stringify(value)).not.toContain(secretBytes)
  })

  it('locator_cite refuses the notReadable ref in compact and exact detail', async () => {
    const info = infoOf(secretFile)
    const ref = fileRef({ path: secretFile, mtime: info.mtime, size: info.size })
    const tool = makeCiteTool({ roots: [root], scope })
    for (const detail of ['compact', 'exact'] as const) {
      const value = await tool.execute({ refs: [ref], detail }, exec()) as { ok: boolean; error?: string; warnings?: string[]; citations?: unknown[] }
      expect(value.ok, detail).toBe(false)
      expect(value.error, detail).toBe('content-scope-denied')
      expect(value.warnings, detail).toContain('path-not-readable')
      expect(JSON.stringify(value), detail).not.toContain(secretBytes)
    }
  })

  it('keeps the default (unscoped) behavior: no fence configured means readable', async () => {
    const info = infoOf(secretFile)
    const ref = fileRef({ path: secretFile, mtime: info.mtime, size: info.size })
    const cite = makeCiteTool({ roots: [root] })
    const cited = await cite.execute({ refs: [ref] }, exec()) as { ok: boolean }
    expect(cited.ok).toBe(true)
    const read = await makeAgentReadTool(runtime([root])).execute({ ref, as: 'excerpt' }, exec()) as ReadValueView
    expect(read.ok).toBe(true)
    expect(read.items?.[0]?.excerpt).toBe(secretBytes)
  })
})
