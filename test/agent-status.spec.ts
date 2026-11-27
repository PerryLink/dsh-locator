/**
 * locator_status (agent-status.ts): brief/full payloads, the ~600-char brief
 * budget, engine-unavailable mapping and the legacy-renderer reuse. Fakes only;
 * no engine process, state directory or live index is touched.
 */

import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import {
  makeAgentStatusTool,
  STATUS_BRIEF_MAX_CHARS,
  STATUS_BRIEF_MAX_ROOTS,
  STATUS_BRIEF_WARNING_MAX_CHARS,
} from '../src/agent-status.ts'
import type { ContentIndex } from '../src/content.ts'
import type { LocatorRuntime } from '../src/runtime.ts'
import { Scope } from '../src/scope.ts'

const exec = () => ({ agent: { session: { id: 'caller-session', header: { cwd: '/work/a' } } } }) as never

interface FakeRuntimeOptions {
  error?: string
  withEngine?: boolean
  warning?: string
  roots?: string[]
  generation?: number
  watchDegraded?: boolean
}

const ENGINE_VERSION = '0.23.0'

function fakeRuntime(options: FakeRuntimeOptions = {}): LocatorRuntime {
  const roots = options.roots ?? ['/work/a', '/work/b']
  const engine = () => ({
    version: ENGINE_VERSION,
    platform: 'linux',
    roots,
    entries: 123,
    files: 100,
    dirs: 23,
    nameBytes: 4096,
    deleted: 0,
    watching: true,
    usn: false,
    stateDir: '/tmp/locator-status-state',
    generation: options.generation ?? 42,
    ...(options.watchDegraded === true ? { watchDegraded: true, watchReason: '9p/DrvFs does not deliver inotify events' } : {}),
  })
  const runtime: Record<string, unknown> = {
    status: {
      running: options.error === undefined,
      ...(options.error === undefined ? {} : { error: options.error }),
      ...(options.warning === undefined ? {} : { warning: options.warning }),
    },
    config: { outputBudgetChars: 8000, rerankCommand: '', ocrCommand: '', maxResults: 100, excludes: [] },
    roots,
    stateDir: '/tmp/locator-status-state',
    binary: '/tmp/locator-indexd',
    start() {},
    async engineStatus() {
      if (options.withEngine === false) return undefined
      return engine()
    },
    // 0.23.0: the brief reads generation/watch health from the pushed stats copy.
    async engineStatusCached() {
      if (options.withEngine === false) return undefined
      return engine()
    },
  }
  return runtime as unknown as LocatorRuntime
}

function fakeContent(truncated = false): ContentIndex {
  return {
    status: () => ({ building: false, files: 10, sessions: 2, messages: 5, truncated, error: '', warnings: [], updatedAt: 1 }),
    diagnostics: () => ({
      coverage: { indexedFiles: 10, candidateFiles: 100, ratio: 0.1, bodyBytes: 1024, budgetBytes: 0, fileBudget: 0, truncated: false, evictedDocs: 0, sessions: 2, messages: 5 },
      dbBytes: 8192, walBytes: 0, dbLiveBytes: 7000, freelistBytes: 1192, dbBudgetBytes: 0, dbOverBudget: false,
      ftsSegments: 1, ftsOptimizedAt: 0, optimizeWarnings: 0, warningCounts: {}, lastRefreshMs: 0, liveRefreshMsLast: 0, engineGeneration: null,
    }),
  } as unknown as ContentIndex
}

const scope = () => new Scope({ notSearchable: ['**/node_modules/**', 'tmp/**'], notReadable: [], notIndexed: [] })

type Schema = Parameters<typeof validateJsonSchemaValue>[0]
const schemaOf = (tool: { output: { schema: unknown } }) => tool.output.schema as unknown as Schema

interface StatusView {
  apiVersion?: string
  ok: boolean
  tool?: string
  detail?: string
  summary?: string
  index?: { running?: boolean; entries?: number; files?: number; dirs?: number; watching?: boolean; scanning?: boolean; roots?: number; watchDegraded?: boolean }
  content?: { enabled?: boolean; building?: boolean; files?: number; sessions?: number; messages?: number; truncated?: boolean }
  scope?: { activeRules?: number; outputBudgetChars?: number; rerank?: boolean; ocr?: boolean }
  roots?: string[]
  warning?: string
  engineVersion?: string
  generation?: number
  truncated?: string[]
  status?: { entries?: number; roots?: string[]; content?: { files?: number }; scope?: { activeRules?: number }; watching?: boolean; warning?: string }
  timing?: { tookMs: number }
  error?: { code?: string; retryable?: boolean; message?: string }
}

type RenderBlock = { type: string; text?: string }
const render = (tool: { output: { render: unknown } }, args: unknown, value: unknown): RenderBlock[] =>
  (tool.output.render as (a: unknown, v: unknown) => RenderBlock[])(args, value)

describe('locator_status brief', () => {
  it('returns the compact index/content/scope/timing payload under the character budget', async () => {
    const tool = makeAgentStatusTool(fakeRuntime(), fakeContent(), scope())
    const value = await tool.execute({}, exec()) as StatusView
    expect(value.ok).toBe(true)
    expect(value.apiVersion).toBe('2026-11')
    expect(value.tool).toBe('locator_status')
    expect(value.detail).toBe('brief')
    expect(value.index).toMatchObject({ running: true, entries: 123, files: 100, dirs: 23, watching: true, scanning: false, roots: 2, watchDegraded: false })
    expect(value.content).toMatchObject({ enabled: true, building: false, files: 10, sessions: 2, messages: 5, truncated: false })
    expect(value.scope).toMatchObject({ activeRules: 2, outputBudgetChars: 8000, rerank: false, ocr: false })
    expect(value.roots).toEqual(['/work/a', '/work/b'])
    expect(value.engineVersion).toBe(ENGINE_VERSION)
    expect(value.generation).toBe(42)
    expect(value.summary).toContain('engine running')
    expect(value.summary).toContain('123 entries')
    expect(typeof value.timing?.tookMs).toBe('number')
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(STATUS_BRIEF_MAX_CHARS)
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('reports content: disabled when the plugin has no content index', async () => {
    const tool = makeAgentStatusTool(fakeRuntime())
    const value = await tool.execute({ detail: 'brief' }, exec()) as StatusView
    expect(value.ok).toBe(true)
    expect(value.content).toMatchObject({ enabled: false })
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('renders a short human summary in brief mode', async () => {
    const tool = makeAgentStatusTool(fakeRuntime(), fakeContent(), scope())
    const value = await tool.execute({}, exec()) as StatusView
    const text = render(tool, {}, value).map(block => block.text ?? '').join('\n')
    expect(text).toContain('locator_status (brief)')
    expect(text).toContain('123 entries')
    expect(text).toContain('2 rule(s)')
  })
})

describe('locator_status full', () => {
  it('returns every legacy status field and still validates against the shared schema', async () => {
    const tool = makeAgentStatusTool(fakeRuntime(), fakeContent(), scope())
    const value = await tool.execute({ detail: 'full' }, exec()) as StatusView
    expect(value.ok).toBe(true)
    expect(value.detail).toBe('full')
    expect(value.status?.entries).toBe(123)
    expect(value.status?.roots).toEqual(['/work/a', '/work/b'])
    expect(value.status?.watching).toBe(true)
    expect(value.status?.content?.files).toBe(10)
    expect(value.status?.scope?.activeRules).toBe(2)
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('reuses the legacy renderer for full output', async () => {
    const tool = makeAgentStatusTool(fakeRuntime(), fakeContent(), scope())
    const value = await tool.execute({ detail: 'full' }, exec()) as StatusView
    const text = render(tool, { detail: 'full' }, value).map(block => block.text ?? '').join('\n')
    expect(text).toContain('123 entries')
    expect(text).toContain('/work/a')
    expect(text).toContain('content:')
  })
})

describe('locator_status failures', () => {
  it('maps an engine error to the shared index-unavailable failure envelope', async () => {
    const tool = makeAgentStatusTool(fakeRuntime({ error: 'engine crashed at startup' }), undefined, scope())
    const value = await tool.execute({}, exec()) as StatusView
    expect(value.ok).toBe(false)
    expect(value.apiVersion).toBe('2026-11')
    expect(value.tool).toBe('locator_status')
    expect(value.error?.code).toBe('index-unavailable')
    expect(value.error?.retryable).toBe(true)
    expect(value.error?.message).toContain('engine crashed')
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })
})

describe('locator_status brief surfaces the hidden warning (0.23.0 P0-5)', () => {
  const DEGRADED = 'filesystem watching degraded: 9p/DrvFs does not deliver inotify events'

  it('reports the engine warning, degraded watcher state, roots and generation', async () => {
    const tool = makeAgentStatusTool(fakeRuntime({ warning: DEGRADED, watchDegraded: true }), fakeContent(), scope())
    const value = await tool.execute({}, exec()) as StatusView
    expect(value.ok).toBe(true)
    expect(value.detail).toBe('brief')
    expect(value.warning).toBe(DEGRADED)
    expect(value.index).toMatchObject({ watching: true, watchDegraded: true })
    expect(value.summary).toContain('watcher degraded')
    expect(value.roots).toEqual(['/work/a', '/work/b'])
    expect(value.generation).toBe(42)
    expect(value.engineVersion).toBe(ENGINE_VERSION)
    expect(value.truncated).toBeUndefined()
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(STATUS_BRIEF_MAX_CHARS)
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
    const text = render(tool, {}, value).map(block => block.text ?? '').join('\n')
    expect(text).toContain('warning: ' + DEGRADED)
    expect(text).toContain('roots: /work/a, /work/b')
    expect(text).toContain('watcher degraded')
  })

  it('truncates a very long warning and lists the shortened section', async () => {
    const long = 'degraded: ' + 'x'.repeat(2000)
    const tool = makeAgentStatusTool(fakeRuntime({ warning: long }), fakeContent(), scope())
    const value = await tool.execute({}, exec()) as StatusView
    expect(value.warning).toBeDefined()
    expect(value.warning?.length).toBeLessThanOrEqual(STATUS_BRIEF_WARNING_MAX_CHARS)
    expect(value.warning?.endsWith('…')).toBe(true)
    expect(value.truncated).toContain('warning')
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(STATUS_BRIEF_MAX_CHARS)
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('bounds the roots list and the serialized brief size under the worst case', async () => {
    const roots = Array.from({ length: 8 }, (_, index) => '/very/long/index/root/' + 'segment-'.repeat(6) + String(index))
    const tool = makeAgentStatusTool(fakeRuntime({ roots, warning: 'w'.repeat(900) }), fakeContent(), scope())
    const value = await tool.execute({}, exec()) as StatusView
    expect(value.roots).toHaveLength(STATUS_BRIEF_MAX_ROOTS)
    expect(value.roots?.every(root => typeof root === 'string' && root.length <= 96)).toBe(true)
    expect(value.truncated).toContain('roots')
    expect(value.truncated).toContain('warning')
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(STATUS_BRIEF_MAX_CHARS)
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('surfaces content.truncated instead of hiding evicted docs', async () => {
    const tool = makeAgentStatusTool(fakeRuntime(), fakeContent(true), scope())
    const value = await tool.execute({}, exec()) as StatusView
    expect(value.content).toMatchObject({ enabled: true, truncated: true })
    expect(value.summary).toContain('content truncated')
    const text = render(tool, {}, value).map(block => block.text ?? '').join('\n')
    expect(text).toContain('truncated')
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('keeps full detail nested and complete', async () => {
    const tool = makeAgentStatusTool(fakeRuntime({ warning: DEGRADED }), fakeContent(), scope())
    const value = await tool.execute({ detail: 'full' }, exec()) as StatusView
    expect(value.detail).toBe('full')
    expect(value.status?.warning).toBe(DEGRADED)
    expect(value.status?.roots).toEqual(['/work/a', '/work/b'])
    // full keeps the legacy nested shape: no duplicated top-level brief fields.
    expect(value.warning).toBeUndefined()
    expect(value.roots).toBeUndefined()
    expect(value.generation).toBeUndefined()
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
    const text = render(tool, { detail: 'full' }, value).map(block => block.text ?? '').join('\n')
    expect(text).toContain('warning: ' + DEGRADED)
    expect(text).toContain('/work/a')
  })
})
