/**
 * Capability index: which tool/skill/MCP action can do a job, what it costs and
 * what it may touch. This is a thin adapter over the DSH registries the host
 * already keeps (tool definitions, skill catalog): it does not re-implement
 * discovery, it adds intent matching, risk labels and a preflight check.
 * @module dsh-locator/capabilities
 */

import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** One capability card. */
export interface CapabilityCard {
  id: string
  kind: 'tool' | 'mcp' | 'skill'
  name: string
  summary: string
  input?: Record<string, unknown>
  tags: string[]
  risk: { level: 'read' | 'write' | 'exec'; actions: string[]; basis: 'schema' | 'name' }
  permission: { approval: 'none' | 'ask'; sandbox: 'none' | 'write' | 'any' }
  state: 'available' | 'unknown'
  source: 'tools' | 'skills'
}

/** One snapshot of the live capability surface. */
export interface CapabilitySnapshot {
  builtAt: number
  cards: CapabilityCard[]
  warnings: string[]
}

/** Minimal shape of the host services this module reads. */
export interface CapabilitySources {
  tools?: {
    definitions?: (scope?: unknown, toolSet?: unknown) => readonly unknown[]
    get?: (name: string, scope?: unknown) => unknown
  } | undefined
  skills?: { list?: (options?: Record<string, unknown>) => Promise<readonly unknown[]> } | undefined
}

const WRITE_WORDS = ['write', 'edit', 'delete', 'remove', 'move', 'rename', 'mkdir', 'install', 'uninstall', 'publish', 'patch', 'apply']
const EXEC_WORDS = ['bash', 'shell', 'execute', 'terminal', 'run_code', 'spawn', 'command']
const ALIASES: Record<string, string[]> = {
  文件: ['file', 'files', 'path'], 搜索: ['search', 'find', 'grep'], 写: ['write', 'edit'], 删除: ['delete', 'remove'],
  运行: ['run', 'exec', 'bash'], 命令: ['command', 'shell'], 网页: ['web', 'http', 'url'], 截图: ['screenshot', 'screen'],
  测试: ['test'], 安装: ['install'], 插件: ['plugin'], 技能: ['skill'], 工具: ['tool'],
}

/** Tokenize one intent/name for the lexical scorer (letters, digits, CJK). */
export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase()
  const ascii = lowered.match(/[a-z0-9_]{2,}/g) ?? []
  const cjk = lowered.match(/[\u4e00-\u9fff]{2}/g) ?? []
  const expanded = [...ascii, ...cjk]
  for (const [key, values] of Object.entries(ALIASES)) {
    if (lowered.includes(key)) expanded.push(...values)
  }
  return [...new Set(expanded)]
}

/** Infer risk/permission from a tool name, description and parameter schema. */
export function inferRisk(name: string, description: string, parameters?: Record<string, unknown>): CapabilityCard['risk'] & { permission: CapabilityCard['permission'] } {
  const haystack = `${name} ${description}`.toLowerCase()
  const properties = parameters !== undefined && typeof parameters === 'object' && parameters !== null && typeof (parameters as { properties?: unknown }).properties === 'object'
    ? Object.keys((parameters as { properties: Record<string, unknown> }).properties)
    : []
  const actions: string[] = []
  let level: 'read' | 'write' | 'exec' = 'read'
  if (EXEC_WORDS.some(word => haystack.includes(word)) || properties.includes('command') || properties.includes('cmd')) { level = 'exec'; actions.push('may execute a process') }
  if (WRITE_WORDS.some(word => haystack.includes(word)) || properties.includes('content') || properties.includes('sandbox_permissions')) {
    if (level !== 'exec') level = 'write'
    actions.push('may modify state')
  }
  if (properties.includes('sandbox_permissions')) actions.push('can request escalated sandbox permissions')
  return {
    level,
    actions: [...new Set(actions)],
    basis: properties.length > 0 ? 'schema' : 'name',
    permission: { approval: level === 'read' ? 'none' : 'ask', sandbox: level === 'read' ? 'none' : level === 'exec' ? 'any' : 'write' },
  }
}

/** Convert one DSH ToolDefinition into a capability card. */
function toolCard(definition: unknown): CapabilityCard | undefined {
  if (typeof definition !== 'object' || definition === null) return undefined
  const record = definition as { name?: unknown; description?: unknown; parameters?: unknown; output?: unknown }
  if (typeof record.name !== 'string' || record.name === '') return undefined
  const name = record.name
  const description = typeof record.description === 'string' ? record.description : ''
  const parameters = typeof record.parameters === 'object' && record.parameters !== null ? record.parameters as Record<string, unknown> : undefined
  const risk = inferRisk(name, description, parameters)
  const mcpParts = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
  const kind: CapabilityCard['kind'] = mcpParts !== null ? 'mcp' : 'tool'
  const display = mcpParts !== null ? `${mcpParts[1]}/${mcpParts[2]}` : name
  return {
    id: kind === 'mcp' ? `mcp:${display}` : `tool:${name}`,
    kind,
    name: display,
    summary: description.split('\n')[0]?.slice(0, 240) ?? '',
    ...(parameters === undefined ? {} : { input: parameters }),
    tags: tokenize(`${name} ${description}`).slice(0, 12),
    risk: { level: risk.level, actions: risk.actions, basis: risk.basis },
    permission: risk.permission,
    state: 'available',
    source: 'tools',
  }
}

/** Convert one SkillSummary into a capability card. */
function skillCard(skill: unknown): CapabilityCard | undefined {
  if (typeof skill !== 'object' || skill === null) return undefined
  const record = skill as { name?: unknown; description?: unknown; whenToUse?: unknown; source?: unknown; invocation?: unknown }
  if (typeof record.name !== 'string' || record.name === '') return undefined
  const summary = `${typeof record.description === 'string' ? record.description : ''}${typeof record.whenToUse === 'string' ? ` · ${record.whenToUse}` : ''}`.trim()
  const invocation = typeof record.invocation === 'object' && record.invocation !== null ? record.invocation as { modelInvocable?: unknown } : undefined
  return {
    id: `skill:${record.name}`,
    kind: 'skill',
    name: record.name,
    summary: summary.slice(0, 240),
    tags: tokenize(`${record.name} ${summary}`).slice(0, 12),
    risk: { level: 'read', actions: ['loads instructions, no direct side effects'], basis: 'name' },
    permission: { approval: 'none', sandbox: 'none' },
    state: invocation?.modelInvocable === false ? 'unknown' : 'available',
    source: 'skills',
  }
}

/** Build one capability snapshot from the live host services. */
export async function buildCapabilitySnapshot(sources: CapabilitySources, scope?: unknown): Promise<CapabilitySnapshot> {
  const warnings: string[] = []
  const cards: CapabilityCard[] = []
  try {
    const definitions = sources.tools?.definitions?.(scope) ?? []
    for (const definition of definitions) {
      const card = toolCard(definition)
      if (card !== undefined) cards.push(card)
    }
  } catch (error) {
    warnings.push(`tool-catalog-unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (sources.skills?.list !== undefined) {
    try {
      const skills = await sources.skills.list(scope === undefined ? {} : { scope })
      for (const skill of skills) {
        const card = skillCard(skill)
        if (card !== undefined) cards.push(card)
      }
    } catch (error) {
      warnings.push(`skill-catalog-unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    warnings.push('skill-service-unavailable')
  }
  cards.sort((left, right) => left.id.localeCompare(right.id))
  return { builtAt: Date.now(), cards, warnings }
}

/** Card projection returned by tools: drop the full input schema payload. */
export function publicCard(card: CapabilityCard): Omit<CapabilityCard, 'input'> {
  const { input: _input, ...rest } = card
  return rest
}

/** One ranked capability hit. */
export interface CapabilityHit {
  card: CapabilityCard
  score: number
  why: string[]
}

/**
 * Rank capability cards against an intent and optional filters.
 * @param cards - snapshot cards.
 * @param intent - what the caller wants to do.
 * @param options - kind/risk filters and pagination.
 * @returns ranked hits and the total before paging.
 */
export function searchCapabilities(
  cards: readonly CapabilityCard[],
  intent: string,
  options: { kinds?: readonly CapabilityCard['kind'][]; riskMax?: 'read' | 'write' | 'exec'; limit?: number; offset?: number; availableOnly?: boolean } = {},
): { hits: CapabilityHit[]; total: number } {
  const terms = tokenize(intent)
  const limit = Math.max(1, Math.min(50, options.limit ?? 10))
  const offset = Math.max(0, options.offset ?? 0)
  const matches = cards.filter(card => {
    if (options.kinds !== undefined && options.kinds.length > 0 && !options.kinds.includes(card.kind)) return false
    if (options.availableOnly === true && card.state !== 'available') return false
    if (options.riskMax !== undefined) {
      const order = { read: 0, write: 1, exec: 2 } as const
      if (order[card.risk.level] > order[options.riskMax]) return false
    }
    return true
  })
  const scored: CapabilityHit[] = []
  for (const card of matches) {
    const haystack = tokenize(`${card.name} ${card.summary} ${card.tags.join(' ')}`)
    const why: string[] = []
    let score = 0
    for (const term of terms) {
      if (card.name.toLowerCase().includes(term)) { score += 6; why.push(`name:${term}`); continue }
      if (haystack.includes(term)) { score += 2; why.push(`text:${term}`) }
    }
    if (terms.length === 0) { score = 1; why.push('intent-empty: lists capabilities') }
    if (score > 0) scored.push({ card, score, why: why.slice(0, 6) })
  }
  scored.sort((left, right) => right.score - left.score || left.card.id.localeCompare(right.card.id))
  return { hits: scored.slice(offset, offset + limit), total: scored.length }
}

/** One preflight result. */
export interface PreflightResult {
  ok: boolean
  card?: CapabilityCard
  admitted: boolean
  schema?: { valid: boolean; violations: string[] }
  requires: { approval: 'none' | 'ask'; sandbox: 'none' | 'write' | 'any' }
  sideEffects: string[]
  next: { callable: boolean; suggestion?: string }
  error?: string
  warnings: string[]
}

/**
 * Check whether one capability can be called with the given arguments right
 * now: existence/visibility, argument schema, predicted approval/sandbox and
 * side effects. It never executes the target.
 */
export function preflightCapability(
  snapshot: CapabilitySnapshot,
  target: string,
  args?: Record<string, unknown>,
  sources?: CapabilitySources,
  scope?: unknown,
): PreflightResult {
  const normalized = target.trim()
  const card = snapshot.cards.find(entry => entry.id === normalized || entry.name === normalized || entry.id === `tool:${normalized}` || entry.id === `mcp:${normalized}` || entry.id === `skill:${normalized}`)
  if (card === undefined) {
    return { ok: false, admitted: false, requires: { approval: 'none', sandbox: 'none' }, sideEffects: [], next: { callable: false }, error: 'capability-not-found', warnings: [] }
  }
  const warnings = [...snapshot.warnings]
  let visible = true
  if (card.kind !== 'skill' && sources?.tools?.get !== undefined) {
    try { visible = sources.tools.get(card.kind === 'mcp' ? card.name.replace('/', '__') : card.name, scope) !== undefined } catch { visible = true }
  }
  let schema: { valid: boolean; violations: string[] } | undefined
  if (args !== undefined && card.input !== undefined) {
    try {
      const violations = validateJsonSchemaValue(card.input as unknown as Parameters<typeof validateJsonSchemaValue>[0], args)
      schema = { valid: violations.length === 0, violations }
    } catch (error) {
      schema = { valid: false, violations: [error instanceof Error ? error.message : String(error)] }
    }
  }
  const callable = visible && (schema?.valid ?? true)
  const suggestion = callable
    ? undefined
    : !visible
      ? 'capability is registered but not visible in this agent scope'
      : schema?.valid === false
        ? 'fix the arguments against the declared schema'
        : 'capability is not callable from this scope'
  return {
    ok: true,
    card: publicCard(card),
    admitted: callable,
    ...(schema === undefined ? {} : { schema }),
    requires: card.permission,
    sideEffects: card.risk.actions,
    next: { callable, ...(suggestion === undefined ? {} : { suggestion }) },
    warnings,
  }
}

const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' }, kind: { type: 'string', enum: ['tool', 'mcp', 'skill'] },
    name: { type: 'string' }, summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    risk: { type: 'object', additionalProperties: false, properties: { level: { type: 'string' }, actions: { type: 'array', items: { type: 'string' } }, basis: { type: 'string' } } },
    permission: { type: 'object', additionalProperties: false, properties: { approval: { type: 'string' }, sandbox: { type: 'string' } } },
    state: { type: 'string' }, source: { type: 'string' },
  },
} as const

/** Build `capability_search` and `capability_preflight` bound to the host registries. */
export function makeCapabilityTools(sources: CapabilitySources) {
  let cached: CapabilitySnapshot | undefined
  const snapshotFor = async (scope?: unknown): Promise<CapabilitySnapshot> => {
    if (cached === undefined || Date.now() - cached.builtAt > 60_000) cached = await buildCapabilitySnapshot(sources, scope)
    return cached
  }
  const searchTool = defineTool({
    name: 'capability_search',
    description: [
      'Find the tool, MCP action or skill that can do a job (dsh-locator capability adapter).',
      '',
      'Use it when the caller knows the goal but not which capability performs it: pass the intent in natural language and filter by kind/risk. Every hit carries risk and permission hints plus the card id usable with `capability_preflight`.',
      '',
      'This is not a file search: it indexes the live DSH capability registry (tool definitions and the skill catalog), not file names or bodies.',
    ].join('\n'),
    parameters: {
      intent: { type: 'string', required: true, description: 'What should be done, in natural language (English or Chinese).' },
      kinds: { type: 'array', items: { type: 'string', enum: ['tool', 'mcp', 'skill'] }, description: 'Restrict to these capability kinds.' },
      riskMax: { type: 'string', enum: ['read', 'write', 'exec'], description: 'Only return capabilities at or below this risk level.' },
      availableOnly: { type: 'boolean', description: 'Only return cards that are currently visible/available.' },
      limit: { type: 'integer', description: 'Maximum hits (default 10, at most 50).' },
      offset: { type: 'integer', description: 'Skip this many ranked hits.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          intent: { type: 'string' }, total: { type: 'integer' }, returned: { type: 'integer' },
          hits: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { card: CARD_SCHEMA, score: { type: 'number' }, why: { type: 'array', items: { type: 'string' } } } } },
          warnings: { type: 'array', items: { type: 'string' } }, error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok: boolean; intent?: string; total?: number; hits?: Array<{ card: CapabilityCard; why: string[] }>; warnings?: string[]; error?: string }
        if (!v.ok) return [{ type: 'text', text: `capability_search failed: ${v.error ?? 'unknown error'}` }]
        const lines = [`capability_search ${JSON.stringify(v.intent ?? '')}: ${String(v.total ?? 0)} match(es)`]
        for (const hit of v.hits ?? []) {
          lines.push(`- ${hit.card.id} [${hit.card.kind}] risk=${hit.card.risk.level} approval=${hit.card.permission.approval} — ${hit.card.summary}`)
        }
        if ((v.warnings ?? []).length > 0) lines.push(`warnings: ${[...new Set(v.warnings ?? [])].join(', ')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const snapshot = await snapshotFor(exec?.agent)
      const kinds = Array.isArray(args.kinds) ? args.kinds.filter((kind): kind is CapabilityCard['kind'] => kind === 'tool' || kind === 'mcp' || kind === 'skill') : undefined
      const riskMax = args.riskMax === 'read' || args.riskMax === 'write' || args.riskMax === 'exec' ? args.riskMax : undefined
      const result = searchCapabilities(snapshot.cards, args.intent, { ...(kinds === undefined ? {} : { kinds }), ...(riskMax === undefined ? {} : { riskMax }), limit: Math.max(1, Math.min(50, args.limit ?? 10)), offset: Math.max(0, args.offset ?? 0), availableOnly: args.availableOnly === true })
      const hits = result.hits.map(hit => ({ ...hit, card: publicCard(hit.card) }))
      return { ok: true as const, intent: args.intent, total: result.total, returned: hits.length, hits, warnings: snapshot.warnings }
    },
  })
  const preflightTool = defineTool({
    name: 'capability_preflight',
    description: [
      'Check one capability before calling it (dsh-locator capability adapter): whether it exists and is visible, whether the arguments match its declared schema, and which approval/sandbox/side effects it implies.',
      '',
      'It never executes the target. Use it when a plan depends on a tool/MCP action/skill and the caller needs to know the cost or permission risk first.',
    ].join('\n'),
    parameters: {
      capability: { type: 'string', required: true, description: 'Card id (`tool:<name>`, `mcp:<server>/<action>`, `skill:<name>`) or plain name from capability_search.' },
      argsJson: { type: 'string', description: 'Candidate arguments as a JSON object string to validate against the declared schema.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          card: CARD_SCHEMA,
          admitted: { type: 'boolean' },
          schema: { type: 'object', additionalProperties: false, properties: { valid: { type: 'boolean' }, violations: { type: 'array', items: { type: 'string' } } } },
          requires: { type: 'object', additionalProperties: false, properties: { approval: { type: 'string' }, sandbox: { type: 'string' } } },
          sideEffects: { type: 'array', items: { type: 'string' } },
          next: { type: 'object', additionalProperties: false, properties: { callable: { type: 'boolean' }, suggestion: { type: 'string' } } },
          error: { type: 'string' }, warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const v = value as { ok: boolean; card?: CapabilityCard; admitted?: boolean; schema?: { valid: boolean; violations: string[] }; requires?: { approval: string; sandbox: string }; sideEffects?: string[]; next?: { callable: boolean; suggestion?: string }; error?: string; warnings?: string[] }
        if (!v.ok) return [{ type: 'text', text: `capability_preflight failed: ${v.error ?? 'unknown error'}` }]
        const lines = [
          `capability_preflight ${v.card?.id ?? ''}: callable=${String(v.next?.callable ?? v.admitted ?? false)}`,
          `  risk: ${v.card?.risk.level ?? '?'} · approval=${v.requires?.approval ?? '?'} · sandbox=${v.requires?.sandbox ?? '?'}`,
          `  schema: ${v.schema === undefined ? 'not checked (no args/schema)' : v.schema.valid ? 'valid' : `invalid (${v.schema.violations.join('; ')})`}`,
        ]
        if ((v.sideEffects ?? []).length > 0) lines.push(`  side effects: ${(v.sideEffects ?? []).join('; ')}`)
        if (v.next?.suggestion !== undefined) lines.push(`  suggestion: ${v.next.suggestion}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const snapshot = await snapshotFor(exec?.agent)
      let candidate: Record<string, unknown> | undefined
      if (typeof args.argsJson === 'string' && args.argsJson.trim() !== '') {
        try {
          const parsed: unknown = JSON.parse(args.argsJson)
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { ok: false as const, admitted: false, requires: { approval: 'none' as const, sandbox: 'none' as const }, sideEffects: [], next: { callable: false }, error: 'invalid-args-json', warnings: [] }
          }
          candidate = parsed as Record<string, unknown>
        } catch {
          return { ok: false as const, admitted: false, requires: { approval: 'none' as const, sandbox: 'none' as const }, sideEffects: [], next: { callable: false }, error: 'invalid-args-json', warnings: [] }
        }
      }
      return preflightCapability(snapshot, args.capability, candidate, sources, exec?.agent)
    },
  })
  return [searchTool, preflightTool] as const
}

/** ToolRunContext re-export keeps the module self-describing for tests. */
export type { ToolRunContext }
