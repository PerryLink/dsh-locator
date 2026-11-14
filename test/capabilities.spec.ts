import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import {
  buildCapabilitySnapshot,
  inferRisk,
  makeCapabilityTools,
  preflightCapability,
  searchCapabilities,
  tokenize,
  type CapabilitySources,
} from '../src/capabilities.ts'

function sources(overrides: Partial<CapabilitySources> = {}): CapabilitySources {
  return {
    tools: {
      definitions: () => [
        { name: 'locator_find', description: 'Search file bodies and session messages by phrase.', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
        { name: 'write_file', description: 'Write a file to disk.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
        { name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
        { name: 'mcp__github__create_issue', description: 'Create an issue on GitHub.', parameters: { type: 'object', properties: {} } },
      ],
      get: (name: string) => name === 'locator_find' ? {} : undefined,
    },
    skills: {
      list: async () => [
        { name: 'office-xlsx', description: 'Read and edit Excel workbooks.', invocation: { modelInvocable: true } },
      ],
    },
    ...overrides,
  }
}

describe('capability tokenizer and risk inference', () => {
  it('expands Chinese intent words and keeps ascii tokens', () => {
    const terms = tokenize('帮我搜索文件并运行命令')
    const joined = terms.join(' ')
    // CJK intent words expand through the alias table.
    expect(joined).toContain('file')
    expect(joined).toContain('search')
    expect(joined).toContain('run')
    expect(joined).toContain('command')
  })

  it('infers read/write/exec risk from names, descriptions and schema', () => {
    expect(inferRisk('locator_find', 'Search file bodies').level).toBe('read')
    expect(inferRisk('write_file', 'Write a file').level).toBe('write')
    expect(inferRisk('bash', 'Run a shell command').level).toBe('exec')
    const schemaWrite = inferRisk('generic_update', 'Update a record', { type: 'object', properties: { content: { type: 'string' } } })
    expect(schemaWrite.level).toBe('write')
    expect(schemaWrite.permission.approval).toBe('ask')
    const escalating = inferRisk('run', 'Run code', { type: 'object', properties: { sandbox_permissions: { type: 'string' } } })
    expect(escalating.actions.join(' ')).toContain('escalated')
  })
})

describe('capability snapshot', () => {
  it('maps tools, MCP actions and skills into cards', async () => {
    const snapshot = await buildCapabilitySnapshot(sources())
    expect(snapshot.warnings).toEqual([])
    const ids = snapshot.cards.map(card => card.id)
    expect(ids).toContain('tool:locator_find')
    expect(ids).toContain('tool:write_file')
    expect(ids).toContain('mcp:github/create_issue')
    expect(ids).toContain('skill:office-xlsx')
    expect(snapshot.cards.find(card => card.id === 'mcp:github/create_issue')?.kind).toBe('mcp')
  })

  it('survives a missing registry with warnings', async () => {
    const snapshot = await buildCapabilitySnapshot({})
    expect(snapshot.cards).toEqual([])
    expect(snapshot.warnings.length).toBeGreaterThan(0)
  })
})

describe('capability search', () => {
  it('ranks by intent and filters by kind and risk', async () => {
    const snapshot = await buildCapabilitySnapshot(sources())
    const fileSearch = searchCapabilities(snapshot.cards, 'find text in files')
    expect(fileSearch.hits[0]?.card.id).toBe('tool:locator_find')
    const readOnly = searchCapabilities(snapshot.cards, 'write', { riskMax: 'read' })
    expect(readOnly.hits.every(hit => hit.card.risk.level === 'read')).toBe(true)
    const mcpOnly = searchCapabilities(snapshot.cards, 'issue', { kinds: ['mcp'] })
    expect(mcpOnly.hits.every(hit => hit.card.kind === 'mcp')).toBe(true)
    const paged = searchCapabilities(snapshot.cards, 'a', { limit: 2, offset: 1 })
    expect(paged.hits.length).toBeLessThanOrEqual(2)
  })
})

describe('capability preflight', () => {
  it('reports visibility, schema validity and requirements', async () => {
    const snapshot = await buildCapabilitySnapshot(sources())
    const source = sources()
    const good = preflightCapability(snapshot, 'tool:locator_find', { query: 'x' }, source)
    expect(good).toMatchObject({ ok: true, admitted: true, schema: { valid: true }, requires: { approval: 'none' } })
    const invalid = preflightCapability(snapshot, 'tool:locator_find', { query: 1 }, source)
    expect(invalid.schema?.valid).toBe(false)
    const missing = preflightCapability(snapshot, 'tool:not-registered')
    expect(missing.ok).toBe(false)
    expect(missing.error).toBe('capability-not-found')
    const hidden = preflightCapability(snapshot, 'tool:write_file', undefined, source)
    expect(hidden.next.callable).toBe(false)
    expect(hidden.next.suggestion).toContain('not visible')
  })
})

describe('capability tools', () => {
  it('expose well-formed schemas and execute through the adapters', async () => {
    const [searchTool, preflightTool] = makeCapabilityTools(sources())
    const searchValue = await searchTool.execute({ intent: 'find text in files', limit: 5 }, {} as never)
    expect(searchValue).toMatchObject({ ok: true, returned: 1 })
    expect(validateJsonSchemaValue(searchTool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0], searchValue)).toEqual([])
    const preflightValue = await preflightTool.execute({ capability: 'tool:locator_find', argsJson: '{"query":"text"}' }, {} as never)
    expect(preflightValue).toMatchObject({ ok: true, admitted: true })
    expect(validateJsonSchemaValue(preflightTool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0], preflightValue)).toEqual([])
    const badJson = await preflightTool.execute({ capability: 'tool:locator_find', argsJson: '{oops' }, {} as never)
    expect(badJson).toMatchObject({ ok: false, error: 'invalid-args-json' })
  })
})
