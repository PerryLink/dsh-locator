/**
 * Contract tests for the shared AI-first envelope, cursor and detail model.
 */

import { describe, expect, it } from 'vitest'
import {
  AGENT_API_VERSION,
  AGENT_DEFAULT_MAX_CHARS,
  AGENT_ERROR_CODES,
  AGENT_MIN_BUDGET_CHARS,
  CURSOR_VERSION,
  CURSOR_VERSION_V2,
  agentFailure,
  agentSuccess,
  applyItemBudget,
  coverageNote,
  cursorMatches,
  decodeCursor,
  encodeCursor,
  encodeCursorV2,
  estimateItemChars,
  makeCoverage,
  makeError,
  makeTiming,
  queryHashOf,
  trimItem,
  trimSnippet,
  type AgentCursorPayload,
  type AgentItem,
} from '../src/agent-core.ts'

const fullItem: AgentItem = {
  kind: 'file',
  path: '/tmp/project/a.ts',
  title: 'a.ts',
  name: 'parseConfig',
  line: 12,
  snippet: 'x'.repeat(400),
  why: ['body:terms'],
  score: 0.5,
  ref: 'ref://file?path=%2Ftmp%2Fproject%2Fa.ts',
  refStatus: 'fresh',
  freshness: { state: 'fresh', observedAt: 1_000, mtime: 2_000 },
  hash: 'a'.repeat(64),
  permissions: { read: 'allowed', visibility: 'workspace', reason: 'inside roots' },
  provenance: { origin: 'index', path: '/tmp/project/a.ts', indexedAt: 900 },
  sources: ['body'],
  sessionId: 'session-1',
  messageId: 'message-1',
  seq: 7,
  eventRef: 'ref://session-event?sid=abc&seq=7',
  size: 4_096,
  mtime: 2_000,
  ext: 'ts',
  dir: false,
  language: 'ts',
  symbolScope: 'class Parser',
}

describe('agent-core envelope', () => {
  it('exposes the 2026-11 contract defaults', () => {
    expect(AGENT_API_VERSION).toBe('2026-11')
    expect(AGENT_DEFAULT_MAX_CHARS).toBe(6_000)
    expect(AGENT_MIN_BUDGET_CHARS).toBe(120)
    expect(Object.values(AGENT_ERROR_CODES)).toHaveLength(12)
  })

  it('builds the unified failure envelope with default provenance fields', () => {
    const envelope = makeError('cursor-invalid', 'stale cursor', { tool: 'locator_find' })
    expect(envelope).toMatchObject({
      apiVersion: '2026-11',
      ok: false,
      tool: 'locator_find',
      error: { code: 'cursor-invalid', message: 'stale cursor', retryable: false },
    })
    expect(envelope.error.remediation).toBeTruthy()
    expect(envelope.error.nextTools).toEqual(['locator_find'])
  })

  it('maps retryability per code and honours explicit overrides', () => {
    expect(makeError('index-building').error.retryable).toBe(true)
    expect(makeError('index-unavailable').error.retryable).toBe(true)
    expect(makeError('query-too-short').error.retryable).toBe(false)
    expect(makeError('budget-too-small').error.retryable).toBe(false)
    const overridden = makeError('internal', 'engine died', {
      retryable: true,
      remediation: 'Retry once.',
      nextTools: ['locator_status'],
      details: { cause: 'engine-error' },
      timing: { tookMs: 3 },
    })
    expect(overridden.error).toMatchObject({ retryable: true, remediation: 'Retry once.', nextTools: ['locator_status'], details: { cause: 'engine-error' } })
    expect(overridden.timing).toEqual({ tookMs: 3 })
    expect(makeError('internal', 'x', { nextTools: [] }).error.nextTools).toBeUndefined()
  })

  it('wraps success results in the shared base', () => {
    const envelope = agentSuccess('locator_find', { items: [] }, makeTiming(Date.now() - 5))
    expect(envelope).toMatchObject({ apiVersion: '2026-11', ok: true, tool: 'locator_find', items: [] })
    expect(envelope.timing?.tookMs).toBeGreaterThanOrEqual(0)
  })

  it('wraps a prebuilt error block', () => {
    const envelope = agentFailure('locator_read', { code: 'not-found', message: 'gone', retryable: false })
    expect(envelope).toMatchObject({ ok: false, tool: 'locator_read', error: { code: 'not-found' } })
    expect(envelope.timing).toBeUndefined()
  })
})

describe('agent-core detail presets', () => {
  it('compact keeps only the cheap identity fields and trims the snippet', () => {
    const compact = trimItem(fullItem, 'compact')
    expect(Object.keys(compact).sort()).toEqual(['eventRef', 'kind', 'line', 'path', 'ref', 'score', 'seq', 'snippet', 'sources', 'title', 'why'])
    // 0.23: a compact session row must stay readable through locator_read.
    expect(compact.eventRef).toBe(fullItem.eventRef)
    expect(compact.seq).toBe(7)
    expect(compact.sources).toEqual(['body'])
    expect(Array.from(compact.snippet ?? '').length).toBe(160)
    expect(compact.freshness).toBeUndefined()
    expect(compact.sessionId).toBeUndefined()
    expect(compact.hash).toBeUndefined()
  })

  it('standard adds freshness but no identity/evidence details', () => {
    const standard = trimItem(fullItem, 'standard')
    expect(standard.freshness).toEqual({ state: 'fresh', observedAt: 1_000, mtime: 2_000 })
    expect(standard.refStatus).toBe('fresh')
    expect(standard.language).toBe('ts')
    expect(standard.sessionId).toBeUndefined()
    expect(standard.provenance).toBeUndefined()
    expect(standard.size).toBeUndefined()
    expect(standard.seq).toBe(7)
    expect(standard.eventRef).toBe(fullItem.eventRef)
  })

  it('full keeps identity, permissions and provenance', () => {
    const full = trimItem(fullItem, 'full')
    expect(full).toMatchObject({
      sessionId: 'session-1',
      messageId: 'message-1',
      seq: 7,
      hash: fullItem.hash,
      permissions: fullItem.permissions,
      provenance: fullItem.provenance,
      size: 4_096,
      mtime: 2_000,
      ext: 'ts',
      name: 'parseConfig',
      eventRef: fullItem.eventRef,
      sources: ['body'],
    })
    expect(Array.from(full.snippet ?? '').length).toBe(320)
  })

  it('drops empty arrays and never mutates the source item', () => {
    const source: AgentItem = { kind: 'dir', path: '/tmp/project', why: [] }
    const trimmed = trimItem(source, 'compact')
    expect(trimmed.why).toBeUndefined()
    expect(source.why).toEqual([])
  })

  it('truncates snippets by code points and appends an ellipsis', () => {
    const text = '日本語'.repeat(100)
    const clipped = trimSnippet(text, 'compact')
    expect(Array.from(clipped)).toHaveLength(160)
    expect(clipped.endsWith('…')).toBe(true)
    expect(trimSnippet('short', 'compact')).toBe('short')
  })
})

describe('agent-core item budget', () => {
  const items: AgentItem[] = [
    { kind: 'file', path: '/tmp/one.md', title: 'one.md' },
    { kind: 'file', path: '/tmp/two.md', title: 'two.md' },
    { kind: 'file', path: '/tmp/three.md', title: 'three.md' },
  ]
  const firstSize = estimateItemChars(items[0]!)

  it('counts only item payload and keeps at least the first item', () => {
    const budgeted = applyItemBudget(items, firstSize + estimateItemChars(items[1]!))
    expect(budgeted.items).toHaveLength(2)
    expect(budgeted.budget.usedChars).toBe(firstSize + estimateItemChars(items[1]!))
    expect(budgeted.budget.dropped).toBe(1)
    expect(budgeted.budget.truncated).toBe(true)
    const tooSmall = applyItemBudget(items, 1)
    expect(tooSmall.items).toHaveLength(1)
    expect(tooSmall.dropped).toBe(2)
  })

  it('disables trimming when maxChars is 0 and reports the real cost', () => {
    const budgeted = applyItemBudget(items, 0)
    expect(budgeted.items).toHaveLength(3)
    expect(budgeted.budget.limitChars).toBe(0)
    expect(budgeted.budget.usedChars).toBeGreaterThan(0)
    expect(budgeted.budget.truncated).toBe(false)
  })
})

describe('agent-core cursor', () => {
  const payload: AgentCursorPayload = { v: 1, mode: 'body', queryHash: 'abc123', offset: 42, scope: 'roots', generation: 7 }

  it('round-trips a base64url JSON payload', () => {
    const token = encodeCursor(payload)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor(token)).toEqual(payload)
  })

  it('rejects malformed or foreign cursors', () => {
    const bad = [
      undefined,
      null,
      42,
      '',
      'not base64url!',
      Buffer.from('{"v":2,"mode":"name","queryHash":"h","offset":0}').toString('base64url'),
      Buffer.from('[]').toString('base64url'),
      Buffer.from('{"v":1,"mode":"invented","queryHash":"h","offset":0}').toString('base64url'),
      Buffer.from('{"v":1,"mode":"name","queryHash":"h","offset":-1}').toString('base64url'),
      Buffer.from('{"v":1,"mode":"name","queryHash":"","offset":0}').toString('base64url'),
    ]
    for (const value of bad) expect(decodeCursor(value)).toBeUndefined()
  })

  it('binds a cursor to the query hash and explicit mode', () => {
    const decoded = decodeCursor(encodeCursor({ v: 1, mode: 'name', queryHash: 'hash-1', offset: 0 }))!
    expect(cursorMatches(decoded, { queryHash: 'hash-1' })).toBe(true)
    expect(cursorMatches(decoded, { queryHash: 'hash-1', mode: 'auto' })).toBe(true)
    expect(cursorMatches(decoded, { queryHash: 'hash-2' })).toBe(false)
    expect(cursorMatches(decoded, { queryHash: 'hash-1', mode: 'body' })).toBe(false)
  })

  it('hashes request parts deterministically', () => {
    const one = queryHashOf({ query: 'x', mode: 'name', scope: 'workspace' })
    expect(one).toMatch(/^[0-9a-f]{16}$/)
    expect(queryHashOf({ query: 'x', mode: 'name', scope: 'workspace' })).toBe(one)
    expect(queryHashOf({ query: 'x', mode: 'name', scope: 'roots' })).not.toBe(one)
  })
})

describe('agent-core cursor v2 (auto cross-source)', () => {
  const payload = {
    v: 2 as const,
    mode: 'auto' as const,
    queryHash: 'abc123',
    offsets: { name: 4, body: 9, symbol: 2 },
    scope: 'roots' as const,
    generation: 7,
    kinds: ['file', 'symbol'] as const,
    includeArchived: true,
  }

  it('exposes both contract versions', () => {
    expect(CURSOR_VERSION).toBe(1)
    expect(CURSOR_VERSION_V2).toBe(2)
  })

  it('round-trips the parity payload shape of scripts/locator-cli.mjs', () => {
    const token = encodeCursorV2({ ...payload, kinds: [...payload.kinds] })
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor(token)).toEqual({ ...payload, kinds: ['file', 'symbol'] })
  })

  it('omits scope/generation/kinds/includeArchived when absent', () => {
    const token = encodeCursorV2({ v: 2, mode: 'auto', queryHash: 'h', offsets: { body: 3 } })
    const decoded = decodeCursor(token)
    expect(decoded).toEqual({ v: 2, mode: 'auto', queryHash: 'h', offsets: { body: 3 } })
    expect(decoded !== undefined && 'scope' in decoded).toBe(false)
  })

  it('clamps negative offsets and round-trips an empty offsets object', () => {
    const decoded = decodeCursor(encodeCursorV2({ v: 2, mode: 'auto', queryHash: 'h', offsets: { name: -2 } }))
    expect(decoded).toEqual({ v: 2, mode: 'auto', queryHash: 'h', offsets: { name: 0 } })
    const empty = decodeCursor(encodeCursorV2({ v: 2, mode: 'auto', queryHash: 'h', offsets: {} }))
    expect(empty).toEqual({ v: 2, mode: 'auto', queryHash: 'h', offsets: {} })
  })

  it('round-trips the bounded cross-page dedupe memory', () => {
    const token = encodeCursorV2({ v: 2, mode: 'auto', queryHash: 'h', offsets: { name: 3 }, seen: ['deadbeef', 'cafebabe'] })
    expect(decodeCursor(token)).toEqual({ v: 2, mode: 'auto', queryHash: 'h', offsets: { name: 3 }, seen: ['deadbeef', 'cafebabe'] })
    const tooMany = Array.from({ length: 97 }, (_, index) => index.toString(16).padStart(8, '0'))
    expect(decodeCursor(encodeCursorV2({ v: 2, mode: 'auto', queryHash: 'h', offsets: {}, seen: tooMany }))).toBeUndefined()
  })

  it('rejects malformed v2 payloads', () => {
    const bad = [
      Buffer.from('{"v":2,"mode":"auto","queryHash":"h"}').toString('base64url'),
      Buffer.from('{"v":2,"mode":"auto","queryHash":"h","offsets":{"nope":1}}').toString('base64url'),
      Buffer.from('{"v":2,"mode":"auto","queryHash":"h","offsets":{"name":-1}}').toString('base64url'),
      Buffer.from('{"v":2,"mode":"invented","queryHash":"h","offsets":{}}').toString('base64url'),
      Buffer.from('{"v":2,"mode":"auto","queryHash":"","offsets":{}}').toString('base64url'),
      Buffer.from('{"v":2,"mode":"auto","queryHash":"h","offsets":{},"kinds":["nope"]}').toString('base64url'),
      Buffer.from('{"v":2,"mode":"auto","queryHash":"h","offsets":{},"seen":["zzz"]}').toString('base64url'),
      Buffer.from('{"v":2,"mode":"auto","queryHash":"h","offsets":{},"seen":"deadbeef"}').toString('base64url'),
    ]
    for (const value of bad) expect(decodeCursor(value)).toBeUndefined()
  })

  it('binds v2 cursors to the query and mode like v1 does', () => {
    const decoded = decodeCursor(encodeCursorV2({ v: 2, mode: 'auto', queryHash: 'hash-1', offsets: { name: 1 } }))!
    expect(cursorMatches(decoded, { queryHash: 'hash-1' })).toBe(true)
    expect(cursorMatches(decoded, { queryHash: 'hash-1', mode: 'auto' })).toBe(true)
    expect(cursorMatches(decoded, { queryHash: 'hash-2' })).toBe(false)
    expect(cursorMatches(decoded, { queryHash: 'hash-1', mode: 'body' })).toBe(false)
  })
})

describe('agent-core coverage and timing', () => {
  it('builds the coverage block with notes', () => {
    const note = coverageNote('scope-fallback', 'searched every root', 'warn')
    const coverage = makeCoverage({ indexing: true, indexTruncated: false, notes: [note] })
    expect(coverage).toEqual({ indexing: true, indexTruncated: false, notes: [{ code: 'scope-fallback', severity: 'warn', message: 'searched every root' }] })
    expect(makeCoverage()).toEqual({ indexing: false, indexTruncated: false, notes: [] })
  })

  it('never reports a negative timing', () => {
    expect(makeTiming(Date.now()).tookMs).toBeGreaterThanOrEqual(0)
    expect(makeTiming(Date.now() + 60_000).tookMs).toBe(0)
  })
})
