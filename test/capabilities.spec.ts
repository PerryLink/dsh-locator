import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import {
  buildCapabilitySnapshot,
  inferRisk,
  makeCapabilityTools,
  preflightCapability,
  searchCapabilities,
  searchCapabilityCards,
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
        { name: 'locator_rebuild', description: 'Rebuild the local file index from scratch.', parameters: { type: 'object', properties: { roots: { type: 'array' } } } },
        { name: 'locator_reindex', description: 'Rebuild or refresh the content index.', parameters: { type: 'object', properties: { full: { type: 'boolean' } } } },
        {
          name: 'locator_export',
          description: 'Export the file index as a SQLite database.',
          parameters: { type: 'object', properties: { path: { type: 'string' }, overwrite: { type: 'boolean' }, allowOutsideStateDir: { type: 'boolean' } } },
        },
        { name: 'refresh_cache', description: 'Refresh the cached records and the of and scan.', parameters: { type: 'object', properties: {} } },
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
describe('capability risk overrides (0.21.1)', () => {
  it('marks maintenance and export tools write/ask with an override basis', () => {
    for (const name of ['locator_rebuild', 'locator_reindex', 'locator_export', 'refresh_cache']) {
      const risk = inferRisk(name, 'maintenance tool')
      expect(risk.level, name).toBe('write')
      expect(risk.permission, name).toEqual({ approval: 'ask', sandbox: 'write' })
      expect(risk.basis, name).toBe('override')
    }
    // The explicit table wins over a description that mentions running work.
    const rebuild = inferRisk('locator_rebuild', 'Runs in the background and may run a scan')
    expect(rebuild.level).toBe('write')
    expect(rebuild.basis).toBe('override')
    expect(rebuild.actions.join(' ')).toContain('rebuild')
  })

  it('reports dangerous parameters even for an override card', () => {
    const exported = inferRisk('locator_export', 'Export the file index', {
      type: 'object',
      properties: { allowOutsideStateDir: { type: 'boolean' }, overwrite: { type: 'boolean' } },
    })
    expect(exported.level).toBe('write')
    expect(exported.permission.approval).toBe('ask')
    expect(exported.actions.join(' ')).toContain('outside')
    expect(exported.actions.join(' ')).toContain('overwrite')
    const sandboxed = inferRisk('run', 'Run code', { type: 'object', properties: { sandbox_permissions: { type: 'string' } } })
    expect(sandboxed.actions.join(' ')).toContain('escalated')
    // A name that reads as read-only is still write/ask when it can leave the
    // state directory: the parameter itself is the side effect.
    const outside = inferRisk('copy_database', 'Copy a database', { type: 'object', properties: { allowOutsideStateDir: { type: 'boolean' } } })
    expect(outside.level).toBe('write')
    expect(outside.permission.approval).toBe('ask')
    expect(outside.actions.join(' ')).toContain('outside')
  })

  it('keeps the basis honest: override, schema, name or mixed', () => {
    expect(inferRisk('locator_find', 'Search file bodies', { type: 'object', properties: { query: { type: 'string' } } }).basis).toBe('schema')
    expect(inferRisk('write_file', 'Write a file').basis).toBe('override')
    expect(inferRisk('bash', 'Run a shell command', { type: 'object', properties: { command: { type: 'string' } } }).basis).toBe('override')
    expect(inferRisk('offline_helper', 'Offline helper').basis).toBe('name')
    expect(inferRisk('offline_helper', 'Offline helper', { type: 'object', properties: {} }).basis).toBe('name')
  })

  it('does not infer read for the cards built into the snapshot', async () => {
    const snapshot = await buildCapabilitySnapshot(sources())
    for (const id of ['tool:locator_rebuild', 'tool:locator_reindex', 'tool:locator_export']) {
      const card = snapshot.cards.find(entry => entry.id === id)
      expect(card?.risk.level, id).toBe('write')
      expect(card?.permission.approval, id).toBe('ask')
      expect(card?.risk.basis, id).toBe('override')
    }
  })
})

describe('capability card tags (0.21.1)', () => {
  it('removes stopwords, de-duplicates and caps tags at six', async () => {
    const snapshot = await buildCapabilitySnapshot(sources())
    const refresh = snapshot.cards.find(card => card.id === 'tool:refresh_cache')
    expect(refresh?.tags.length).toBeLessThanOrEqual(6)
    expect(refresh?.tags).toContain('refresh')
    for (const stopword of ['the', 'of', 'and']) expect(refresh?.tags, stopword).not.toContain(stopword)
    for (const card of snapshot.cards) {
      expect(card.tags.length).toBeLessThanOrEqual(6)
      expect(new Set(card.tags).size).toBe(card.tags.length)
    }
  })
})

describe('capability preflight ok = admitted (0.21.1)', () => {
  it('reports invalid arguments as ok:false with errorInfo', async () => {
    const snapshot = await buildCapabilitySnapshot(sources())
    const invalid = preflightCapability(snapshot, 'tool:locator_find', { query: 1 }, sources())
    expect(invalid.ok).toBe(false)
    expect(invalid.admitted).toBe(false)
    expect(invalid.schema?.valid).toBe(false)
    expect(invalid.errorInfo).toMatchObject({ code: 'invalid-arguments', retryable: false })
    expect(invalid.errorInfo?.hint).toBeTruthy()
  })

  it('reports a hidden capability as ok:false with errorInfo', async () => {
    const snapshot = await buildCapabilitySnapshot(sources())
    const hidden = preflightCapability(snapshot, 'tool:write_file', undefined, sources())
    expect(hidden.ok).toBe(false)
    expect(hidden.admitted).toBe(false)
    expect(hidden.next.callable).toBe(false)
    expect(hidden.errorInfo?.code).toBe('capability-not-visible')
    expect(hidden.next.suggestion).toContain('not visible')
  })

  it('keeps the legacy error string and adds errorInfo for unknown cards', () => {
    const missing = preflightCapability({ builtAt: Date.now(), cards: [], warnings: [] }, 'tool:not-registered')
    expect(missing.ok).toBe(false)
    expect(missing.error).toBe('capability-not-found')
    expect(missing.errorInfo?.code).toBe('capability-not-found')
  })

  it('still surfaces write/ask risk for a known maintenance card', async () => {
    const snapshot = await buildCapabilitySnapshot(sources())
    const ready = sources()
    const result = preflightCapability(snapshot, 'tool:locator_rebuild', { roots: ['/tmp'] }, ready)
    expect(result.card?.risk.level).toBe('write')
    expect(result.requires).toEqual({ approval: 'ask', sandbox: 'write' })
  })

  it('keeps the tool output schema valid for admitted and rejected calls', async () => {
    const [searchTool, preflightTool] = makeCapabilityTools(sources())
    const schema = preflightTool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    const admitted = await preflightTool.execute({ capability: 'tool:locator_find', argsJson: '{"query":"text"}' }, {} as never)
    expect(validateJsonSchemaValue(schema, admitted)).toEqual([])
    const rejected = await preflightTool.execute({ capability: 'tool:locator_find', argsJson: '{"query":1}' }, {} as never)
    expect(rejected).toMatchObject({ ok: false, admitted: false, error: 'invalid-arguments' })
    expect(validateJsonSchemaValue(schema, rejected)).toEqual([])
    const invalidJson = await preflightTool.execute({ capability: 'tool:locator_find', argsJson: '{oops' }, {} as never)
    expect(invalidJson).toMatchObject({ ok: false, error: 'invalid-args-json' })
    expect(validateJsonSchemaValue(schema, invalidJson)).toEqual([])
    // Both capability tools are pure read-only adapters.
    expect(searchTool.isConcurrencySafe?.({ intent: 'x' } as never)).toBe(true)
    expect(preflightTool.isConcurrencySafe?.({ capability: 'tool:locator_find' } as never)).toBe(true)
  })
})

describe('capability search paging (0.21.1)', () => {
  function manySources(count: number): CapabilitySources {
    return {
      tools: {
        definitions: () => Array.from({ length: count }, (_, index) => ({
          name: 'alpha_' + String(index),
          description: 'alpha helper',
          parameters: { type: 'object', properties: {} },
        })),
        get: () => ({}),
      },
      skills: { list: async () => [] },
    }
  }

  it('returns nextOffset and truncated from the tool', async () => {
    const [searchTool] = makeCapabilityTools(manySources(7))
    const page = await searchTool.execute({ intent: 'alpha', limit: 3, offset: 3 }, {} as never)
    expect(page).toMatchObject({ ok: true, total: 7, returned: 3, nextOffset: 6, truncated: true })
    const schema = searchTool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0]
    expect(validateJsonSchemaValue(schema, page)).toEqual([])
    const last = await searchTool.execute({ intent: 'alpha', limit: 3, offset: 6 }, {} as never) as { nextOffset?: number }
    expect(last).toMatchObject({ ok: true, total: 7, returned: 1, truncated: false })
    expect(last.nextOffset).toBeUndefined()
  })

  it('reports the same paging metadata on the Web payload', async () => {
    const payload = await searchCapabilityCards(manySources(7), 'alpha', { limit: 2, offset: 1 })
    expect(payload).toMatchObject({ total: 7, returned: 2, nextOffset: 3, truncated: true })
    const tail = await searchCapabilityCards(manySources(7), 'alpha', { limit: 5, offset: 5 })
    expect(tail.truncated).toBe(false)
    expect(tail.nextOffset).toBeUndefined()
  })
})

describe('capability snapshot cache identity (0.21.1)', () => {
  it('keeps one snapshot per agent/scope identity and reuses it', async () => {
    const seen: unknown[] = []
    const scoped: CapabilitySources = {
      tools: {
        definitions: (scope?: unknown) => {
          seen.push(scope)
          return [{ name: 'alpha_card', description: 'alpha helper', parameters: { type: 'object', properties: {} } }]
        },
        get: () => ({}),
      },
      skills: { list: async () => [] },
    }
    const [searchTool] = makeCapabilityTools(scoped)
    const agentA = { id: 'agent-a', session: { id: 'session-a', header: { cwd: '/a' } } }
    const agentB = { id: 'agent-b', session: { id: 'session-b', header: { cwd: '/b' } } }
    const execFor = (agent: unknown) => ({ signal: new AbortController().signal, agent } as never)
    await searchTool.execute({ intent: 'alpha' }, execFor(agentA))
    await searchTool.execute({ intent: 'alpha' }, execFor(agentB))
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(agentA)
    expect(seen[1]).toBe(agentB)
    // Same identity inside the TTL hits the cache instead of rebuilding.
    await searchTool.execute({ intent: 'alpha' }, execFor(agentA))
    expect(seen).toHaveLength(2)
  })
})

/**
 * 0.23.0: a realistic 3+1 resident surface plus the deferred legacy tools, so
 * ranking can be asserted with the real names/descriptions.
 */
function residentSources(): CapabilitySources {
  const tool = (name: string, description: string, properties: Record<string, unknown> = {}, deferLoading = false) => ({
    name,
    description,
    parameters: { type: 'object', properties },
    ...(deferLoading ? { deferLoading: true } : {}),
  })
  return {
    tools: {
      definitions: () => [
        tool('locator_find', 'Search local file names and bodies or session messages by phrase; every hit carries a citable ref.', { query: { type: 'string' } }),
        tool('locator_read', 'Read a file/session ref from locator_find instead of shell cat/head.', { ref: { type: 'string' } }),
        tool('locator_status', 'Report local file-index/content-index health and the effective ignore rules.', {}),
        tool('locator_admin', 'Index maintenance: rebuild the name index, reindex content or export a snapshot.', { action: { type: 'string' } }),
        tool('locator_search', 'Search local file names (legacy).', { query: { type: 'string' } }, true),
        tool('locator_resolve', 'Resolve evidence refs (legacy).', { ref: { type: 'string' } }, true),
        tool('locator_cite', 'Render citations for evidence refs (legacy).', { refs: { type: 'array' } }, true),
        tool('locator_rebuild', 'Rebuild the local file index from scratch.', { roots: { type: 'array' } }, true),
        tool('locator_reindex', 'Rebuild or refresh the content index.', { full: { type: 'boolean' } }, true),
      ],
      get: () => ({}),
    },
    skills: { list: async () => [] },
  }
}

describe('capability risk uses the name, not read-only description examples (0.23.0 P0-9)', () => {
  it('keeps a read-only description that mentions shell/install/execute at read', () => {
    const image = inferRisk('read_image', 'Read a PNG/JPEG image. Large images are downscaled; do not install image libraries or create thumbnails, and never shell out to an execute command.')
    expect(image.level).toBe('read')
    expect(image.permission).toEqual({ approval: 'none', sandbox: 'none' })
    const preview = inferRisk('preview_file', 'Read a file preview; do not edit, write, delete or execute anything.')
    expect(preview.level).toBe('read')
    // The schema still declares side effects on its own (name is not the only input).
    const schemaWrite = inferRisk('copy_record', 'Copy a record', { type: 'object', properties: { content: { type: 'string' } } })
    expect(schemaWrite.level).toBe('write')
  })

  it('pins locator_read at read/none and locator_admin at write/ask with concrete actions', () => {
    const read = inferRisk('locator_read', 'Read a ref; use it instead of shell cat/head and never run a bash command.')
    expect(read.level).toBe('read')
    expect(read.permission).toEqual({ approval: 'none', sandbox: 'none' })
    expect(read.basis).toBe('override')
    expect(read.actions.join(' ')).toContain('reads')
    const admin = inferRisk('locator_admin', 'Index maintenance: rebuild, reindex or export.')
    expect(admin.level).toBe('write')
    expect(admin.permission).toEqual({ approval: 'ask', sandbox: 'write' })
    expect(admin.basis).toBe('override')
    const actions = admin.actions.join(' ')
    expect(actions).toContain('rebuild')
    expect(actions).toContain('reindex')
    expect(actions).toContain('export')
    expect(actions).toContain('writes')
  })
})

describe('capability cards for the 0.23.0 surface', () => {
  it('marks resident vs deferred tools and keeps each risk honest', async () => {
    const snapshot = await buildCapabilitySnapshot(residentSources())
    const byId = (id: string) => snapshot.cards.find(card => card.id === id)
    expect(byId('tool:locator_read')?.risk.level).toBe('read')
    expect(byId('tool:locator_read')?.permission.approval).toBe('none')
    expect(byId('tool:locator_read')?.deferred).toBe(false)
    expect(byId('tool:locator_find')?.deferred).toBe(false)
    expect(byId('tool:locator_status')?.deferred).toBe(false)
    expect(byId('tool:locator_admin')?.risk.level).toBe('write')
    expect(byId('tool:locator_admin')?.permission).toEqual({ approval: 'ask', sandbox: 'write' })
    expect(byId('tool:locator_search')?.deferred).toBe(true)
    expect(byId('tool:locator_rebuild')?.deferred).toBe(true)
  })
})

describe('capability resident ranking (0.23.0 P0-9)', () => {
  it('ranks the resident locator_find above the deferred legacy locator_search', async () => {
    const snapshot = await buildCapabilitySnapshot(residentSources())
    const hits = searchCapabilities(snapshot.cards, 'search files by name')
    const ids = hits.hits.map(hit => hit.card.id)
    expect(ids[0]).toBe('tool:locator_find')
    const findAt = ids.indexOf('tool:locator_find')
    const searchAt = ids.indexOf('tool:locator_search')
    expect(findAt).toBeGreaterThanOrEqual(0)
    expect(searchAt).toBeGreaterThanOrEqual(0)
    expect(findAt).toBeLessThan(searchAt)
  })

  it('keeps relevance ahead of residency for a maintenance intent', async () => {
    const snapshot = await buildCapabilitySnapshot(residentSources())
    const hits = searchCapabilities(snapshot.cards, 'rebuild the file name index')
    expect(hits.hits[0]?.card.id).toBe('tool:locator_rebuild')
    // A resident tool that only weakly matches must not jump the real action.
    const statusAt = hits.hits.findIndex(hit => hit.card.id === 'tool:locator_status')
    expect(statusAt === -1 || statusAt > 0).toBe(true)
  })

  it('prefers the resident tool when the score is exactly equal', () => {
    const cards = [
      { id: 'tool:shared_tool', kind: 'tool' as const, name: 'shared_tool', summary: 'zeta helper', tags: [], risk: { level: 'read' as const, actions: [], basis: 'name' as const }, permission: { approval: 'none' as const, sandbox: 'none' as const }, state: 'available' as const, source: 'tools' as const, deferred: true },
      { id: 'tool:zeta_tool', kind: 'tool' as const, name: 'zeta_tool', summary: 'plain helper', tags: [], risk: { level: 'read' as const, actions: [], basis: 'name' as const }, permission: { approval: 'none' as const, sandbox: 'none' as const }, state: 'available' as const, source: 'tools' as const, deferred: false },
    ]
    const hits = searchCapabilities(cards, 'shared zeta')
    // shared_tool: name match (5) + text zeta (1) = 6; zeta_tool: name zeta (6) = 6.
    expect(hits.hits[0]?.score).toBe(6)
    expect(hits.hits[1]?.score).toBe(6)
    expect(hits.hits[0]?.card.id).toBe('tool:zeta_tool')
  })

  it('keeps the deferred flag in the tool output schema', async () => {
    const [searchTool] = makeCapabilityTools(residentSources())
    const value = await searchTool.execute({ intent: 'find text in files', limit: 5 }, {} as never) as { hits?: Array<{ card: { id: string; deferred?: boolean } }> }
    expect(value.hits?.[0]?.card.id).toBe('tool:locator_find')
    expect(value.hits?.every(hit => typeof hit.card.deferred === 'boolean')).toBe(true)
    expect(validateJsonSchemaValue(searchTool.output.schema as unknown as Parameters<typeof validateJsonSchemaValue>[0], value)).toEqual([])
  })
})
