/**
 * Capability index: which tool/skill/MCP action can do a job, what it costs and
 * what it may touch. This is a thin adapter over the DSH registries the host
 * already keeps (tool definitions, skill catalog): it does not re-implement
 * discovery, it adds intent matching, risk labels and a preflight check.
 * @module dsh-locator/capabilities
 */

import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ERROR_CODES, ERROR_INFO_SCHEMA, errorInfoOf, type ErrorInfo } from './scope.ts'

/** One capability card. */
export interface CapabilityCard {
  id: string
  kind: 'tool' | 'mcp' | 'skill'
  name: string
  summary: string
  input?: Record<string, unknown>
  tags: string[]
  risk: { level: 'read' | 'write' | 'exec'; actions: string[]; basis: 'override' | 'mixed' | 'schema' | 'name' }
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

/** Risk level shared by the card and the explicit override table. */
type RiskLevel = CapabilityCard['risk']['level']

/** One explicit override: the authoritative risk of a known side-effect tool. */
interface RiskOverride {
  level: RiskLevel
  actions: string[]
}

/**
 * Explicit risk overrides (0.21.1). Keyword inference is intentionally blunt;
 * maintenance tools such as locator_rebuild/locator_reindex/locator_export do
 * not describe themselves with write/exec verbs, so they used to be reported as
 * risk=read / approval=none and an agent could trigger an expensive full rebuild
 * without any approval. This table wins over the keyword heuristics below.
 */
const RISK_OVERRIDES: Readonly<Record<string, RiskOverride>> = {
  locator_rebuild: {
    level: 'write',
    actions: ['rebuilds the file-name index and replaces its persisted snapshot (can take minutes and costs disk I/O)'],
  },
  locator_reindex: {
    level: 'write',
    actions: ['rebuilds or refreshes the content index (a full rebuild re-reads every indexed document)'],
  },
  locator_export: {
    level: 'write',
    actions: ['writes a SQLite database to disk', 'replaces an existing export only when overwrite is true'],
  },
  locator_refresh: {
    level: 'write',
    actions: ['refreshes persisted index state'],
  },
}

/**
 * Name patterns for side-effect tools from other plugins and MCP servers. They
 * are matched against the tool name only (never the description, where "rename"
 * or "run" can legitimately appear in read-only documentation).
 */
const RISK_NAME_PATTERNS: ReadonlyArray<{ pattern: RegExp; level: RiskLevel; actions: string[] }> = [
  {
    pattern: /(?:^|[_-])(rebuild|reindex|refresh|reload|rescan|recompute|regenerate|migrate|vacuum|compact)(?:$|[_-])/i,
    level: 'write',
    actions: ['performs index/database maintenance (may rebuild or refresh persisted state)'],
  },
  {
    pattern: /(?:^|[_-])(export|import|install|uninstall|publish|deploy|delete|remove|destroy|drop|truncate|reset|clear|overwrite|write|edit|patch|apply|create|update|set|save|commit|push|merge|revert|restore|move|rename|mkdir|chmod|chown|upload)(?:$|[_-])/i,
    level: 'write',
    actions: ['may modify state'],
  },
  {
    pattern: /(?:^|[_-])(shell|bash|terminal|exec|execute|spawn|run|command)(?:$|[_-])/i,
    level: 'exec',
    actions: ['may execute a process'],
  },
]

/** Look up an explicit override: exact card id first, then the name patterns. */
function riskOverrideOf(name: string): RiskOverride | undefined {
  const exact = RISK_OVERRIDES[name.toLowerCase()]
  if (exact !== undefined) return exact
  for (const entry of RISK_NAME_PATTERNS) if (entry.pattern.test(name)) return entry
  return undefined
}
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

/** Function words that only add noise to a capability card's keyword list. */
const TAG_STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'these', 'those', 'from', 'into', 'onto',
  'over', 'under', 'about', 'than', 'then', 'also', 'such', 'only', 'just', 'very',
  'more', 'most', 'some', 'any', 'all', 'each', 'other', 'are', 'was', 'were', 'is',
  'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would',
  'can', 'could', 'should', 'may', 'might', 'must', 'shall', 'not', 'but', 'or', 'of',
  'to', 'in', 'on', 'at', 'by', 'as', 'it', 'its', 'a', 'an', 'if', 'so', 'via', 'per',
  'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how', 'you', 'your', 'we',
  'our', 'us', 'they', 'them', 'their', 'he', 'she', 'his', 'her', 'him', 'i', 'me',
  'my', 'use', 'uses', 'used', 'using',
])

/**
 * Compact keyword list for one capability card: tokenized name + summary with
 * function words removed and at most six entries (0.21.1; the old list was 12
 * raw tokens including "the"/"of"/"and", which made cards noisy and fat).
 */
function keywordsOf(text: string): string[] {
  return tokenize(text).filter(token => !TAG_STOP_WORDS.has(token)).slice(0, 6)
}

/** Infer risk/permission from a tool name, description and parameter schema. */
export function inferRisk(name: string, description: string, parameters?: Record<string, unknown>): CapabilityCard['risk'] & { permission: CapabilityCard['permission'] } {
  const haystack = `${name} ${description}`.toLowerCase()
  const properties = parameters !== undefined && typeof parameters === 'object' && parameters !== null && typeof (parameters as { properties?: unknown }).properties === 'object'
    ? Object.keys((parameters as { properties: Record<string, unknown> }).properties)
    : []
  const hasProperty = (property: string): boolean => properties.includes(property)
  const escalations: string[] = []
  if (hasProperty('sandbox_permissions')) escalations.push('can request escalated sandbox permissions')
  if (hasProperty('allowOutsideStateDir')) escalations.push('can write outside the plugin state directory (allowOutsideStateDir)')
  if (hasProperty('overwrite')) escalations.push('can overwrite an existing file (overwrite)')
  const nameExec = EXEC_WORDS.some(word => haystack.includes(word))
  const nameWrite = WRITE_WORDS.some(word => haystack.includes(word))
  const schemaExec = hasProperty('command') || hasProperty('cmd')
  const schemaWrite = hasProperty('content') || hasProperty('sandbox_permissions') || hasProperty('allowOutsideStateDir') || hasProperty('overwrite')
  const override = riskOverrideOf(name)
  const actions: string[] = []
  let level: RiskLevel
  let basis: CapabilityCard['risk']['basis']
  if (override !== undefined) {
    // The explicit table is authoritative: a maintenance tool stays write even
    // when its description happens to contain "run" or its schema carries no
    // write-looking parameter. Escalation parameters still add their facts.
    level = override.level
    actions.push(...override.actions)
    basis = 'override'
  } else {
    level = 'read'
    if (nameExec || schemaExec) {
      level = 'exec'
      actions.push('may execute a process')
    }
    if (nameWrite || schemaWrite) {
      if (level !== 'exec') level = 'write'
      actions.push('may modify state')
    }
    basis = (nameExec || nameWrite) && (schemaExec || schemaWrite)
      ? 'mixed'
      : schemaExec || schemaWrite
        ? 'schema'
        : nameExec || nameWrite
          ? 'name'
          : properties.length > 0
            ? 'schema'
            : 'name'
  }
  actions.push(...escalations)
  // A declared escalation parameter always means the call is not read-only.
  if (level === 'read' && (schemaWrite || escalations.length > 0)) level = 'write'
  return {
    level,
    actions: [...new Set(actions)],
    basis,
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
    tags: keywordsOf(`${name} ${description}`),
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
    tags: keywordsOf(`${record.name} ${summary}`),
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
  // Function words ("in", "the", "and") match almost every card name/summary
  // and were a large part of the observed mis-ranking (locator_search ahead of
  // locator_find); drop them from the intent terms too.
  const terms = tokenize(intent).filter(term => !TAG_STOP_WORDS.has(term))
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
  /** 0.21.1: ok mirrors admitted (false when the call is not authorized/valid). */
  ok: boolean
  card?: CapabilityCard
  admitted: boolean
  schema?: { valid: boolean; violations: string[] }
  requires: { approval: 'none' | 'ask'; sandbox: 'none' | 'write' | 'any' }
  sideEffects: string[]
  next: { callable: boolean; suggestion?: string }
  /** Legacy string code; mirrors errorInfo.code when ok is false. */
  error?: string
  /** Structured failure detail (0.21.1, additive). */
  errorInfo?: ErrorInfo
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
    const error = 'capability-not-found'
    return {
      ok: false,
      admitted: false,
      requires: { approval: 'none', sandbox: 'none' },
      sideEffects: [],
      next: { callable: false },
      error,
      errorInfo: errorInfoOf(error, 'no capability card matches ' + JSON.stringify(normalized), {
        retryable: false,
        hint: 'Run capability_search first and pass one of the returned card ids.',
      }),
      warnings: [],
    }
  }
  const warnings = [...snapshot.warnings]
  let visible = true
  if (card.kind !== 'skill' && sources?.tools?.get !== undefined) {
    try { visible = sources.tools.get(card.kind === 'mcp' ? card.name.replace('/', '__') : card.name, scope) !== undefined } catch { visible = true }
  }
  const available = card.state === 'available'
  let schema: { valid: boolean; violations: string[] } | undefined
  if (args !== undefined && card.input !== undefined) {
    try {
      const violations = validateJsonSchemaValue(card.input as unknown as Parameters<typeof validateJsonSchemaValue>[0], args)
      schema = { valid: violations.length === 0, violations }
    } catch (error) {
      schema = { valid: false, violations: [error instanceof Error ? error.message : String(error)] }
    }
  }
  const callable = visible && available && (schema?.valid ?? true)
  // 0.21.1: ok now mirrors admitted. Reporting ok:true for an inadmissible call
  // made agents treat a blocked action as a green light; the failure is also
  // machine-readable through errorInfo while the legacy error string survives.
  const suggestion = callable
    ? undefined
    : !visible
      ? 'capability is registered but not visible in this agent scope'
      : !available
        ? 'capability is not available to the model in this scope'
        : 'fix the arguments against the declared schema'
  const failure = callable
    ? undefined
    : !visible
      ? { code: 'capability-not-visible', message: 'capability is registered but not visible in this agent scope', hint: suggestion }
      : !available
        ? { code: 'capability-unavailable', message: 'capability is not available to the model in this scope', hint: suggestion }
        : {
            code: ERROR_CODES.invalidArguments,
            message: 'arguments do not match the declared schema',
            hint: 'fix the arguments against the declared schema' + (schema === undefined || schema.violations.length === 0 ? '' : ': ' + schema.violations.slice(0, 3).join('; ')),
          }
  return {
    ok: callable,
    card: publicCard(card),
    admitted: callable,
    ...(schema === undefined ? {} : { schema }),
    requires: card.permission,
    sideEffects: card.risk.actions,
    next: { callable, ...(suggestion === undefined ? {} : { suggestion }) },
    ...(failure === undefined
      ? {}
      : {
          error: failure.code,
          errorInfo: errorInfoOf(failure.code, failure.message, { retryable: false, ...(failure.hint === undefined ? {} : { hint: failure.hint }) }),
        }),
    warnings,
  }
}

/** JSON payload for the Web panel's capability search. */
export interface CapabilitySearchPayload {
  ok: boolean
  intent: string
  total: number
  returned: number
  /** Offset of the next page; absent when this page is the last one (0.21.1). */
  nextOffset?: number
  /** True when more ranked cards exist beyond this page (0.21.1). */
  truncated?: boolean
  hits: Array<{ card: Omit<CapabilityCard, 'input'>; score: number; why: string[] }>
  warnings: string[]
}

/** Build one capability snapshot and rank cards for the Web panel. */
export async function searchCapabilityCards(
  sources: CapabilitySources,
  intent: string,
  options: { kinds?: readonly CapabilityCard['kind'][]; riskMax?: 'read' | 'write' | 'exec'; limit?: number; offset?: number } = {},
): Promise<CapabilitySearchPayload> {
  const snapshot = await buildCapabilitySnapshot(sources)
  const result = searchCapabilities(snapshot.cards, intent, options)
  const offset = Math.max(0, options.offset ?? 0)
  const nextOffset = offset + result.hits.length
  const truncated = nextOffset < result.total
  return {
    ok: true,
    intent,
    total: result.total,
    returned: result.hits.length,
    ...(truncated ? { nextOffset } : {}),
    truncated,
    hits: result.hits.map(hit => ({ ...hit, card: publicCard(hit.card) })),
    warnings: snapshot.warnings,
  }
}

/** Preflight one capability for the Web panel (no execution). */
export async function preflightCapabilityCard(
  sources: CapabilitySources,
  capability: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const snapshot = await buildCapabilitySnapshot(sources)
  const result = preflightCapability(snapshot, capability, args, sources)
  return result.card === undefined ? result : { ...result, card: publicCard(result.card) }
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

/** Snapshot cache TTL: host registries change when plugins/skills load. */
const SNAPSHOT_TTL_MS = 60_000
/** Maximum per-agent snapshots kept; bounds memory for long-lived hosts. */
const SNAPSHOT_CACHE_MAX = 8

/**
 * Best-effort identity of the agent/scope a snapshot was built for. Tool and
 * skill listings are scope-filtered, so the 60 s cache must not leak one
 * session's visible surface to another; when no identity is available
 * (embedded or legacy callers) the snapshot is shared as before.
 */
function scopeCacheKey(scope: unknown): string {
  if (typeof scope !== 'object' || scope === null) return 'default'
  const record = scope as Record<string, unknown>
  const session = typeof record.session === 'object' && record.session !== null ? record.session as Record<string, unknown> : undefined
  const header = session !== undefined && typeof session.header === 'object' && session.header !== null ? session.header as Record<string, unknown> : undefined
  const parts: string[] = []
  for (const value of [record.id, record.name, record.preset, session?.id, header?.cwd]) {
    if (typeof value === 'string' && value !== '') parts.push(value)
  }
  return parts.length === 0 ? 'default' : parts.join('\u0000')
}

/** Build `capability_search` and `capability_preflight` bound to the host registries. */
export function makeCapabilityTools(sources: CapabilitySources) {
  const snapshots = new Map<string, CapabilitySnapshot>()
  const snapshotFor = async (scope?: unknown): Promise<CapabilitySnapshot> => {
    const key = scopeCacheKey(scope)
    const cached = snapshots.get(key)
    if (cached !== undefined && Date.now() - cached.builtAt <= SNAPSHOT_TTL_MS) return cached
    const built = await buildCapabilitySnapshot(sources, scope)
    // Refresh insertion order so the least recently built key is evicted first.
    snapshots.delete(key)
    snapshots.set(key, built)
    while (snapshots.size > SNAPSHOT_CACHE_MAX) {
      const oldest = snapshots.keys().next().value
      if (oldest === undefined) break
      snapshots.delete(oldest)
    }
    return built
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
    // Read-only registry lookups; overlapping calls share the snapshot cache.
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          intent: { type: 'string' }, total: { type: 'integer' }, returned: { type: 'integer' },
          nextOffset: { type: 'integer', description: 'Offset of the next page; absent when this page is the last one.' },
          truncated: { type: 'boolean', description: 'More ranked cards exist beyond this page.' },
          hits: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { card: CARD_SCHEMA, score: { type: 'number' }, why: { type: 'array', items: { type: 'string' } } } } },
          warnings: { type: 'array', items: { type: 'string' } }, error: { type: 'string' }, errorInfo: ERROR_INFO_SCHEMA,
        },
      },
      render: (_args, value) => {
        const v = value as { ok: boolean; intent?: string; total?: number; returned?: number; nextOffset?: number; truncated?: boolean; hits?: Array<{ card: CapabilityCard; why: string[] }>; warnings?: string[]; error?: string }
        if (!v.ok) return [{ type: 'text', text: `capability_search failed: ${v.error ?? 'unknown error'}` }]
        const lines = [`capability_search ${JSON.stringify(v.intent ?? '')}: ${String(v.total ?? 0)} match(es)`]
        for (const hit of v.hits ?? []) {
          lines.push(`- ${hit.card.id} [${hit.card.kind}] risk=${hit.card.risk.level} approval=${hit.card.permission.approval} — ${hit.card.summary}`)
        }
        if (v.truncated === true && v.nextOffset !== undefined) lines.push(`more: pass offset=${v.nextOffset} for the next page`)
        if ((v.warnings ?? []).length > 0) lines.push(`warnings: ${[...new Set(v.warnings ?? [])].join(', ')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const snapshot = await snapshotFor(exec?.agent)
      const kinds = Array.isArray(args.kinds) ? args.kinds.filter((kind): kind is CapabilityCard['kind'] => kind === 'tool' || kind === 'mcp' || kind === 'skill') : undefined
      const riskMax = args.riskMax === 'read' || args.riskMax === 'write' || args.riskMax === 'exec' ? args.riskMax : undefined
      const offset = Math.max(0, args.offset ?? 0)
      const result = searchCapabilities(snapshot.cards, args.intent, { ...(kinds === undefined ? {} : { kinds }), ...(riskMax === undefined ? {} : { riskMax }), limit: Math.max(1, Math.min(50, args.limit ?? 10)), offset, availableOnly: args.availableOnly === true })
      const hits = result.hits.map(hit => ({ ...hit, card: publicCard(hit.card) }))
      const nextOffset = offset + hits.length
      const truncated = nextOffset < result.total
      return {
        ok: true as const,
        intent: args.intent,
        total: result.total,
        returned: hits.length,
        ...(truncated ? { nextOffset } : {}),
        truncated,
        hits,
        warnings: snapshot.warnings,
      }
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
    // Pure validation over the registries; never executes the target.
    isConcurrencySafe: () => true,
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
          error: { type: 'string' },
          errorInfo: ERROR_INFO_SCHEMA,
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const v = value as {
          ok: boolean
          card?: CapabilityCard
          admitted?: boolean
          schema?: { valid: boolean; violations: string[] }
          requires?: { approval: string; sandbox: string }
          sideEffects?: string[]
          next?: { callable: boolean; suggestion?: string }
          error?: string
          errorInfo?: { code?: string; message?: string; hint?: string }
          warnings?: string[]
        }
        if (v.card === undefined) {
          const lines = [`capability_preflight failed: ${v.error ?? v.errorInfo?.code ?? 'unknown error'}`]
          if (v.errorInfo?.message !== undefined) lines.push(`  ${v.errorInfo.message}`)
          if (v.errorInfo?.hint !== undefined) lines.push(`  hint: ${v.errorInfo.hint}`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const callable = v.next?.callable ?? v.admitted ?? false
        const lines = [
          `capability_preflight ${v.card.id}: callable=${String(callable)}${v.ok ? '' : ' (not admitted)'}`,
          `  risk: ${v.card.risk.level} · approval=${v.requires?.approval ?? '?'} · sandbox=${v.requires?.sandbox ?? '?'}`,
          `  schema: ${v.schema === undefined ? 'not checked (no args/schema)' : v.schema.valid ? 'valid' : `invalid (${v.schema.violations.join('; ')})`}`,
        ]
        if (!v.ok) {
          lines.push(`  failure: ${v.errorInfo?.code ?? v.error ?? 'unknown'}${v.errorInfo?.message === undefined ? '' : ' — ' + v.errorInfo.message}`)
          if (v.errorInfo?.hint !== undefined) lines.push(`  hint: ${v.errorInfo.hint}`)
        }
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
            return {
              ok: false as const,
              admitted: false,
              requires: { approval: 'none' as const, sandbox: 'none' as const },
              sideEffects: [],
              next: { callable: false },
              error: 'invalid-args-json',
              errorInfo: errorInfoOf(ERROR_CODES.invalidJson, 'argsJson is not a JSON object', {
                retryable: false,
                hint: 'Pass argsJson as one JSON object string, e.g. \'{"query":"x"}\'.',
              }),
              warnings: [],
            }
          }
          candidate = parsed as Record<string, unknown>
        } catch {
          return {
            ok: false as const,
            admitted: false,
            requires: { approval: 'none' as const, sandbox: 'none' as const },
            sideEffects: [],
            next: { callable: false },
            error: 'invalid-args-json',
            errorInfo: errorInfoOf(ERROR_CODES.invalidJson, 'argsJson is not valid JSON', {
              retryable: false,
              hint: 'Pass argsJson as one JSON object string, e.g. \'{"query":"x"}\'.',
            }),
            warnings: [],
          }
        }
      }
      return preflightCapability(snapshot, args.capability, candidate, sources, exec?.agent)
    },
  })
  return [searchTool, preflightTool] as const
}

/** ToolRunContext re-export keeps the module self-describing for tests. */
export type { ToolRunContext }
