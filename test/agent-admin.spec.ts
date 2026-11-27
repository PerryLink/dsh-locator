/**
 * locator_admin (agent-admin.ts): action routing to the existing rebuild/
 * reindex/export factories, deferred loading, result envelopes, error mapping
 * and the export overwrite/outside-state guards. All writes stay under mkdtemp
 * directories; no live engine, host or index is touched.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { makeAgentAdminTool } from '../src/agent-admin.ts'
import type { ContentIndex } from '../src/content.ts'
import type { LocatorRuntime } from '../src/runtime.ts'

/** Windows may return 8.3 short names; compare canonical forms. */
const nativePath = (value: string): string => {
  try { return realpathSync.native(value) } catch { return realpathSync(value) }
}

const exec = () => ({ agent: { session: { id: 'caller-session', header: { cwd: '/work/a' } } } }) as never

interface AdminView {
  apiVersion?: string
  ok: boolean
  tool?: string
  action?: string
  ignored?: string[]
  hint?: string
  nextTools?: string[]
  result?: { started?: boolean; full?: boolean; path?: string; rows?: number; bytes?: number; tookMs?: number }
  timing?: { tookMs: number }
  error?: { code?: string; retryable?: boolean; message?: string }
}

type Schema = Parameters<typeof validateJsonSchemaValue>[0]
const schemaOf = (tool: { output: { schema: unknown } }) => tool.output.schema as unknown as Schema
type RenderBlock = { type: string; text?: string }
const render = (tool: { output: { render: unknown } }, args: unknown, value: unknown): RenderBlock[] =>
  (tool.output.render as (a: unknown, v: unknown) => RenderBlock[])(args, value)

const tempDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

interface RebuildCalls { count: number; roots?: string[]; excludes?: string[] }
interface ReindexCalls { rebuild: number; refresh: number }

function fakeRuntime(root: string, calls: RebuildCalls = { count: 0 }): LocatorRuntime {
  return {
    roots: [root],
    config: { excludes: ['**/node_modules/**'], maxResults: 100 },
    stateDir: join(root, 'state'),
    status: { running: true },
    binary: '/tmp/locator-indexd',
    start() {},
    async rebuild(roots?: string[], excludes?: string[]) {
      calls.count++
      if (roots !== undefined) calls.roots = roots
      if (excludes !== undefined) calls.excludes = excludes
      return { started: true }
    },
  } as unknown as LocatorRuntime
}

function fakeContent(calls: ReindexCalls): ContentIndex {
  return {
    rebuild() { calls.rebuild++; return true },
    refreshNow() { calls.refresh++; return true },
  } as unknown as ContentIndex
}

interface DumpEntry { path: string; name: string; size: number; mtime: number; ext: string; dir: boolean }
function fakeExportRuntime(stateDir: string, entries: readonly DumpEntry[] = []): LocatorRuntime {
  return {
    stateDir,
    roots: [],
    config: { maxResults: 100, excludes: [] },
    status: { running: true },
    binary: '/tmp/locator-indexd',
    start() {},
    async dump(after: number, limit: number) {
      const page = entries.slice(after, after + limit)
      const next = after + page.length
      return { entries: page, next, done: next >= entries.length }
    },
    async engineStatus() { return undefined },
  } as unknown as LocatorRuntime
}

describe('locator_admin registration contract', () => {
  it('is deferred, describes the write operations and stays schema-valid', () => {
    const root = tempDir('locator-admin-contract-')
    const tool = makeAgentAdminTool({ rt: fakeRuntime(root) })
    expect(tool.name).toBe('locator_admin')
    expect(tool.deferLoading).toBe(true)
    expect(tool.description).toMatch(/write operations/i)
    expect(tool.description).toMatch(/rebuild/i)
    expect(tool.description).toMatch(/reindex/i)
    expect(tool.description).toMatch(/export/i)
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual(expect.arrayContaining(['action', 'roots', 'excludes', 'full', 'path', 'overwrite', 'allowOutsideStateDir', 'pageSize']))
  })
})

describe('locator_admin guidance and ignored parameters (0.23.0)', () => {
  it('reports a parameter the action does not consume instead of dropping it silently', async () => {
    const root = tempDir('locator-admin-ignored-')
    const calls: RebuildCalls = { count: 0 }
    const tool = makeAgentAdminTool({ rt: fakeRuntime(root, calls) })
    const value = await tool.execute({ action: 'rebuild', roots: [root], full: true }, exec()) as AdminView
    expect(value.ok).toBe(true)
    // full belongs to reindex only: it was NOT applied, and the payload says so.
    expect(value.ignored).toEqual(['full'])
    expect(calls.count).toBe(1)
    expect(value.hint).toContain('locator_status')
    expect(value.nextTools).toEqual(['locator_status'])
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
    const text = render(tool, { action: 'rebuild' }, value).map(block => block.text ?? '').join('\n')
    expect(text).toContain('ignored parameter(s): full')
    expect(text).toContain('next: locator_status')
  })

  it('names every inapplicable parameter for export and points at the written file', async () => {
    const root = tempDir('locator-admin-ignored-export-')
    const stateDir = join(root, 'state')
    const tool = makeAgentAdminTool({ rt: fakeExportRuntime(stateDir) })
    const value = await tool.execute({ action: 'export', path: 'snap.sqlite', roots: [root], full: true }, exec()) as AdminView
    expect(value.ok).toBe(true)
    expect(value.ignored).toEqual(['roots', 'full'])
    expect(value.hint).toContain('SQLite')
    expect(value.nextTools).toBeUndefined()
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
    const text = render(tool, { action: 'export' }, value).map(block => block.text ?? '').join('\n')
    expect(text).toContain('ignored parameter(s): roots, full')
  })

  it('reports export-only parameters as ignored for reindex', async () => {
    const root = tempDir('locator-admin-ignored-reindex-')
    const calls: ReindexCalls = { rebuild: 0, refresh: 0 }
    const tool = makeAgentAdminTool({ rt: fakeRuntime(root), content: fakeContent(calls) })
    const value = await tool.execute({ action: 'reindex', path: 'x.db', overwrite: true }, exec()) as AdminView
    expect(value.ok).toBe(true)
    expect(value.ignored).toEqual(['path', 'overwrite'])
    expect(value.nextTools).toEqual(['locator_status'])
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('omits ignored when every provided parameter applies', async () => {
    const root = tempDir('locator-admin-applicable-')
    const calls: RebuildCalls = { count: 0 }
    const tool = makeAgentAdminTool({ rt: fakeRuntime(root, calls) })
    const value = await tool.execute({ action: 'rebuild', roots: [root], excludes: ['**/node_modules/**'] }, exec()) as AdminView
    expect(value.ok).toBe(true)
    expect(value.ignored).toBeUndefined()
    expect(value.hint).toBeDefined()
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })
})

describe('locator_admin rebuild', () => {
  it('routes action rebuild to the rebuild factory with narrowed arguments', async () => {
    const root = tempDir('locator-admin-rebuild-')
    const calls: RebuildCalls = { count: 0 }
    const tool = makeAgentAdminTool({ rt: fakeRuntime(root, calls) })
    const value = await tool.execute({ action: 'rebuild' }, exec()) as AdminView
    expect(value).toMatchObject({ apiVersion: '2026-11', ok: true, tool: 'locator_admin', action: 'rebuild' })
    expect(value.result).toMatchObject({ started: true })
    expect(calls.count).toBe(1)
    expect(typeof value.timing?.tookMs).toBe('number')
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })

  it('passes an explicit configured root through and canonicalizes it', async () => {
    const root = tempDir('locator-admin-narrow-')
    const calls: RebuildCalls = { count: 0 }
    const tool = makeAgentAdminTool({ rt: fakeRuntime(root, calls) })
    const value = await tool.execute({ action: 'rebuild', roots: [root], excludes: ['**/node_modules/**'] }, exec()) as AdminView
    expect(value.ok).toBe(true)
    expect(calls.roots?.map(nativePath)).toEqual([nativePath(root)])
    expect(calls.excludes).toEqual(['**/node_modules/**'])
  })

  it('maps a root outside the configured scope to invalid-argument without acting', async () => {
    const root = tempDir('locator-admin-scope-')
    const outside = tempDir('locator-admin-outside-')
    const calls: RebuildCalls = { count: 0 }
    const tool = makeAgentAdminTool({ rt: fakeRuntime(root, calls) })
    const value = await tool.execute({ action: 'rebuild', roots: [outside] }, exec()) as AdminView
    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('invalid-argument')
    expect(calls.count).toBe(0)
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
  })
})

describe('locator_admin reindex', () => {
  it('routes incremental and full reindex to the content factory and calls ensure', async () => {
    const root = tempDir('locator-admin-reindex-')
    const calls: ReindexCalls = { rebuild: 0, refresh: 0 }
    let ensured = 0
    const tool = makeAgentAdminTool({ rt: fakeRuntime(root), content: fakeContent(calls), ensure: () => { ensured++ } })
    const incremental = await tool.execute({ action: 'reindex' }, exec()) as AdminView
    expect(incremental.ok).toBe(true)
    expect(incremental.result).toMatchObject({ started: true, full: false })
    expect(calls.refresh).toBe(1)
    expect(ensured).toBe(1)
    const full = await tool.execute({ action: 'reindex', full: true }, exec()) as AdminView
    expect(full.ok).toBe(true)
    expect(full.result).toMatchObject({ started: true, full: true })
    expect(calls.rebuild).toBe(1)
    expect(validateJsonSchemaValue(schemaOf(tool), full)).toEqual([])
  })

  it('maps a running build to retryable index-building', async () => {
    const root = tempDir('locator-admin-busy-')
    const content = { rebuild: () => true, refreshNow: () => false } as unknown as ContentIndex
    const tool = makeAgentAdminTool({ rt: fakeRuntime(root), content })
    const value = await tool.execute({ action: 'reindex' }, exec()) as AdminView
    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('index-building')
    expect(value.error?.retryable).toBe(true)
  })

  it('rejects reindex when the content index is disabled in this profile', async () => {
    const root = tempDir('locator-admin-nocontent-')
    const tool = makeAgentAdminTool({ rt: fakeRuntime(root) })
    const value = await tool.execute({ action: 'reindex', full: true }, exec()) as AdminView
    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('index-unavailable')
    expect(value.error?.retryable).toBe(false)
  })
})

describe('locator_admin export', () => {
  it('routes action export to the export factory and reports the written file', async () => {
    const root = tempDir('locator-admin-export-')
    const stateDir = join(root, 'state')
    const tool = makeAgentAdminTool({ rt: fakeExportRuntime(stateDir) })
    const value = await tool.execute({ action: 'export' }, exec()) as AdminView
    expect(value.ok).toBe(true)
    expect(value.action).toBe('export')
    expect(value.result?.path).toBeDefined()
    expect(value.result?.path?.endsWith('locator-export.sqlite')).toBe(true)
    expect(value.result?.rows).toBe(0)
    expect(existsSync(value.result?.path ?? '')).toBe(true)
    expect(validateJsonSchemaValue(schemaOf(tool), value)).toEqual([])
    const text = render(tool, { action: 'export' }, value).map(block => block.text ?? '').join('\n')
    expect(text).toContain('locator_admin export')
    expect(text).toContain('locator-export.sqlite')
  })

  it('refuses to overwrite a file it did not create', async () => {
    const root = tempDir('locator-admin-overwrite-')
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'other.db'), 'not a database')
    const tool = makeAgentAdminTool({ rt: fakeExportRuntime(stateDir) })
    const value = await tool.execute({ action: 'export', path: 'other.db', overwrite: true }, exec()) as AdminView
    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('invalid-argument')
    expect(value.error?.message).toContain('refusing to overwrite')
  })

  it('maps an absolute path outside the state directory to scope-denied', async () => {
    const root = tempDir('locator-admin-path-')
    const tool = makeAgentAdminTool({ rt: fakeExportRuntime(join(root, 'state')) })
    const outside = join(tempDir('locator-admin-target-'), 'export.db')
    const value = await tool.execute({ action: 'export', path: outside }, exec()) as AdminView
    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('scope-denied')
  })
})
