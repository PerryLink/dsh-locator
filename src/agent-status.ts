/**
 * locator_status — the AI-first brief/full status tool of the 0.22.0 interface.
 *
 * detail:"brief" (default) reduces the legacy status payload to the few fields
 * a model needs to decide whether the index is usable (well under 600 chars),
 * while detail:"full" reuses the legacy locator_status payload and renderer
 * unchanged. The shared envelope contract is imported from src/agent-core.ts.
 * @module dsh-locator/agent-status
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentIndex } from './content.ts'
import { makeStatusTool } from './tools.ts'
import type { LocatorRuntime } from './runtime.ts'
import type { Scope } from './scope.ts'
import {
  AGENT_ERROR_CODES,
  AGENT_ERROR_INFO_SCHEMA,
  AGENT_SUCCESS_BASE_SCHEMA,
  agentFailure,
  agentSuccess,
  makeError,
  makeTiming,
  type AgentErrorCode,
  type AgentErrorInfo,
  type AgentTiming,
} from './agent-core.ts'

/** Emit one failure envelope (bridges the contract builder to the schema type). */
function fail(code: AgentErrorCode, message: string, options: Parameters<typeof makeError>[2] = {}): never {
  return makeError(code, message, options) as never
}

/** Emit an already-built failure envelope. */
function failed(tool: string, error: AgentErrorInfo, timing: AgentTiming): never {
  return agentFailure(tool, error, timing) as never
}

/** Emit one success envelope (fields are validated by the declared schema). */
function succeed(tool: string, fields: Record<string, unknown>, timing: AgentTiming): never {
  return agentSuccess(tool, fields, timing) as never
}
const TOOL = 'locator_status'

/**
 * The brief payload is designed to stay under this serialized size. 0.23.0
 * raised it from 600 to 1,400 because the brief now carries what P0-5 showed it
 * was hiding: the engine warning (e.g. degraded watching), the root list and
 * the content-truncated flag. The bundled limits (4 roots, 96 chars each;
 * 240-char warning) keep even the worst case under this ceiling; a realistic
 * brief with 2 roots and a warning stays around 700-900 chars.
 */
export const STATUS_BRIEF_MAX_CHARS = 1_400
/** Longest engine warning kept in the brief; longer ones are cut with an ellipsis. */
export const STATUS_BRIEF_WARNING_MAX_CHARS = 240
/** Index roots listed in the brief; the rest stays counted only. */
export const STATUS_BRIEF_MAX_ROOTS = 4
/** Longest root path kept in the brief. */
export const STATUS_BRIEF_ROOT_MAX_CHARS = 96

/** Subset of the legacy status value this module reads (everything else is opaque). */
interface LegacyStatusValue {
  ok: boolean
  running?: boolean
  error?: string
  warning?: string
  scanning?: boolean
  entries?: number
  files?: number
  dirs?: number
  watching?: boolean
  version?: string
  platform?: string
  watchDegraded?: boolean
  watchReason?: string
  roots?: string[]
  content?: {
    enabled?: boolean
    building?: boolean
    files?: number
    sessions?: number
    messages?: number
    truncated?: boolean
    warnings?: string[]
  }
  scope?: {
    activeRules?: number
    outputBudgetChars?: number
    rerankCommand?: string
    ocrCommand?: string
  }
  errorInfo?: { code?: string; hint?: string }
}

const STATUS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...AGENT_SUCCESS_BASE_SCHEMA.properties,
    detail: { type: 'string', enum: ['brief', 'full'] },
    summary: { type: 'string', description: 'One-line human summary of the most important status fields.' },
    index: {
      type: 'object',
      additionalProperties: false,
      properties: {
        running: { type: 'boolean' },
        entries: { type: 'integer' },
        files: { type: 'integer' },
        dirs: { type: 'integer' },
        watching: { type: 'boolean' },
        scanning: { type: 'boolean' },
        roots: { type: 'integer', description: 'Number of configured index roots.' },
        watchDegraded: { type: 'boolean', description: 'The native watcher covers only part of the roots (incremental refresh compensates).' },
      },
    },
    content: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        building: { type: 'boolean' },
        files: { type: 'integer' },
        sessions: { type: 'integer' },
        messages: { type: 'integer' },
        truncated: { type: 'boolean', description: 'The content index evicted/truncated docs; some bodies are not searchable.' },
      },
    },
    scope: {
      type: 'object',
      additionalProperties: false,
      properties: {
        activeRules: { type: 'integer' },
        outputBudgetChars: { type: 'integer' },
        rerank: { type: 'boolean' },
        ocr: { type: 'boolean' },
      },
    },
    roots: { type: 'array', items: { type: 'string' }, description: 'Configured index roots (brief: first 4, long paths shortened; truncated lists the cut).' },
    warning: { type: 'string', description: 'Last engine warning (for example degraded watcher coverage), truncated.' },
    engineVersion: { type: 'string', description: 'Engine binary version when the running engine reports it.' },
    generation: { type: 'integer', description: 'Index generation (moves on every real mutation) when the runtime can report it.' },
    truncated: { type: 'array', items: { type: 'string' }, description: 'Brief sections that were shortened: "warning", "roots".' },
    status: {
      type: 'object',
      additionalProperties: true,
      description: 'detail:"full" only: every field of the legacy locator_status payload.',
    },
    error: AGENT_ERROR_INFO_SCHEMA,
  },
} as const

/** Finite non-negative integer copy of one optional counter. */
function countOf(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

/** Engine fields the legacy payload does not forward; read from the pushed stats copy. */
interface CachedEngineMeta {
  generation?: number
  watchDegraded?: boolean
  watchReason?: string
}

/**
 * Best-effort generation/watch health from the runtime's pushed engine stats.
 * The legacy status call moments earlier refreshed that copy (1 s TTL), so this
 * normally costs no IPC; when the runtime does not expose the cached accessor
 * the fields are simply omitted instead of paying a second status round-trip.
 */
async function cachedEngineMeta(rt: LocatorRuntime): Promise<CachedEngineMeta> {
  const candidate = (rt as unknown as { engineStatusCached?: (ttlMs?: number) => Promise<unknown> }).engineStatusCached
  if (typeof candidate !== 'function') return {}
  try {
    const engine = await candidate.call(rt, 1_000) as { generation?: unknown; watchDegraded?: unknown; watchReason?: unknown } | undefined
    if (typeof engine !== 'object' || engine === null) return {}
    return {
      ...(typeof engine.generation === 'number' && Number.isFinite(engine.generation) ? { generation: Math.trunc(engine.generation) } : {}),
      ...(engine.watchDegraded === true ? { watchDegraded: true } : {}),
      ...(typeof engine.watchReason === 'string' && engine.watchReason !== '' ? { watchReason: engine.watchReason } : {}),
    }
  } catch {
    return {}
  }
}

/** Whether the watcher only partially covers the roots (legacy field or engine copy). */
function watchDegradedOf(value: LegacyStatusValue, meta: CachedEngineMeta): boolean {
  return value.watchDegraded === true || meta.watchDegraded === true
}

/** Truncate one string, marking the cut with an ellipsis. */
function truncateChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, Math.max(0, maxChars - 1)) + '…', truncated: true }
}

/** Bounded root list for the brief (max entries, max chars per path). */
function briefRoots(roots: readonly string[] | undefined): { roots: string[]; truncated: boolean } {
  const all = Array.isArray(roots) ? roots.filter((root): root is string => typeof root === 'string') : []
  const keptSources = all.slice(0, STATUS_BRIEF_MAX_ROOTS)
  const kept = keptSources.map(root => truncateChars(root, STATUS_BRIEF_ROOT_MAX_CHARS).text)
  const truncated = all.length > kept.length || keptSources.some(root => root.length > STATUS_BRIEF_ROOT_MAX_CHARS)
  return { roots: kept, truncated }
}

/** Build the one-line summary shared by both details. */
function briefSummary(value: LegacyStatusValue, meta: CachedEngineMeta): string {
  const content = value.content
  const parts: string[] = []
  parts.push(value.running === true ? 'engine running' : 'engine stopped')
  parts.push(String(countOf(value.entries)) + ' entries (' + String(countOf(value.files)) + ' files / ' + String(countOf(value.dirs)) + ' dirs)')
  parts.push(value.watching === true ? (watchDegradedOf(value, meta) ? 'watcher degraded' : 'watcher active') : 'watcher inactive')
  parts.push('roots ' + String(Array.isArray(value.roots) ? value.roots.length : 0))
  if (value.scanning === true) parts.push('scanning')
  if (content?.enabled === true) {
    parts.push(content.building === true
      ? 'content building'
      : 'content ' + String(countOf(content.files)) + ' files / ' + String(countOf(content.messages)) + ' messages')
    if (content.truncated === true) parts.push('content truncated')
  } else {
    parts.push('content off')
  }
  parts.push('scope ' + String(countOf(value.scope?.activeRules)) + ' rule(s)')
  if (typeof value.warning === 'string' && value.warning !== '') parts.push('warning')
  return parts.join(' · ')
}

/** Brief index/content/scope blocks; arrays are reduced to counts (roots list is separate). */
function briefFields(value: LegacyStatusValue, meta: CachedEngineMeta): {
  index: { running: boolean; entries: number; files: number; dirs: number; watching: boolean; scanning: boolean; roots: number; watchDegraded: boolean }
  content: { enabled: boolean; building: boolean; files: number; sessions: number; messages: number; truncated: boolean }
  scope: { activeRules: number; outputBudgetChars: number; rerank: boolean; ocr: boolean }
} {
  const content = value.content
  const scope = value.scope
  return {
    index: {
      running: value.running === true,
      entries: countOf(value.entries),
      files: countOf(value.files),
      dirs: countOf(value.dirs),
      watching: value.watching === true,
      scanning: value.scanning === true,
      roots: Array.isArray(value.roots) ? value.roots.length : 0,
      watchDegraded: watchDegradedOf(value, meta),
    },
    content: {
      enabled: content?.enabled === true,
      building: content?.building === true,
      files: countOf(content?.files),
      sessions: countOf(content?.sessions),
      messages: countOf(content?.messages),
      truncated: content?.truncated === true,
    },
    scope: {
      activeRules: countOf(scope?.activeRules),
      outputBudgetChars: countOf(scope?.outputBudgetChars),
      rerank: (scope?.rerankCommand ?? '') !== '',
      ocr: (scope?.ocrCommand ?? '') !== '',
    },
  }
}

/** Map the legacy engine-unavailable result onto the closed error set. */
function unavailableError(value: LegacyStatusValue): AgentErrorInfo {
  const message = typeof value.error === 'string' && value.error !== '' ? value.error : 'the locator engine is unavailable'
  const reason = value.errorInfo?.hint
  return {
    code: AGENT_ERROR_CODES.indexUnavailable,
    message,
    retryable: true,
    ...(typeof reason === 'string' && reason !== ''
      ? { remediation: reason }
      : { remediation: 'The engine may still be starting: retry once, and check locator_admin only after the engine answers.' }),
  }
}

/** Build the locator_status tool. */
export function makeAgentStatusTool(rt: LocatorRuntime, content?: ContentIndex, scope?: Scope) {
  const legacy = makeStatusTool(rt, content, scope)
  return defineTool({
    name: TOOL,
    description: [
      'Report local file-index/content-index health (dsh-locator).',
      '',
      'detail: brief (default: counts, watcher health, roots, warning, generation) or full (every status field: roots, watcher, resources, diagnostics). Call when search looks stale, to check the disk is indexed, or before locator_admin maintenance.',
    ].join('\n'),
    parameters: {
      detail: {
        type: 'string',
        enum: ['brief', 'full'],
        description: 'brief (default) or full.',
      },
    },
    output: {
      schema: STATUS_OUTPUT,
      render: (args, value) => {
        const v = value as {
          ok: boolean
          detail?: 'brief' | 'full'
          summary?: string
          index?: { running?: boolean; entries?: number; files?: number; dirs?: number; watching?: boolean; scanning?: boolean; roots?: number; watchDegraded?: boolean }
          content?: { enabled?: boolean; building?: boolean; files?: number; sessions?: number; messages?: number; truncated?: boolean }
          scope?: { activeRules?: number; outputBudgetChars?: number; rerank?: boolean; ocr?: boolean }
          roots?: string[]
          warning?: string
          engineVersion?: string
          generation?: number
          truncated?: string[]
          error?: AgentErrorInfo
        }
        if (v.ok !== true) {
          const error = v.error
          return [{ type: 'text', text: 'locator_status failed: ' + (error?.code ?? 'internal') + ': ' + (error?.message ?? 'unknown error') + (error?.remediation === undefined ? '' : ' — ' + error.remediation) }]
        }
        const summary = v.summary ?? ''
        if (args.detail === 'full') {
          // The full value exists on the raw envelope; the renderer only gets
          // the declared shape, so the legacy renderer is invoked in execute
          // via a stashed text block instead.
          const full = typeof value === 'object' && value !== null ? (value as { status?: unknown }).status : undefined
          if (full !== undefined) {
            try {
              return legacy.output.render({}, full as never)
            } catch { /* fall through to the summary */ }
          }
          return [{ type: 'text', text: 'locator_status (full): ' + summary }]
        }
        const index = v.index ?? {}
        const content = v.content ?? {}
        const scope = v.scope ?? {}
        const rootList = v.roots ?? []
        const rootNote = rootList.length === 0 ? '' : ' (roots: ' + rootList.join(', ') + (v.truncated?.includes('roots') === true ? ', …' : '') + ')'
        const lines = [
          'locator_status (brief): ' + summary,
          '  index: ' + String(index.entries ?? 0) + ' entries / ' + String(index.files ?? 0) + ' files / ' + String(index.dirs ?? 0) + ' dirs · roots ' + String(index.roots ?? 0) + (index.watching === true ? (index.watchDegraded === true ? ' · watcher degraded' : ' · watcher active') : ' · watcher inactive') + (index.scanning === true ? ' · scanning' : '') + rootNote,
          '  content: ' + (content.enabled === true ? (content.building === true ? 'building' : 'ready') + ' · ' + String(content.files ?? 0) + ' files / ' + String(content.sessions ?? 0) + ' sessions / ' + String(content.messages ?? 0) + ' messages' + (content.truncated === true ? ' · truncated' : '') : 'disabled'),
          '  scope: ' + String(scope.activeRules ?? 0) + ' rule(s) · output budget ' + String(scope.outputBudgetChars ?? 0) + ' chars · rerank ' + (scope.rerank === true ? 'on' : 'off') + ' · ocr ' + (scope.ocr === true ? 'on' : 'off'),
        ]
        if (v.engineVersion !== undefined || v.generation !== undefined) {
          lines.push('  engine: ' + [v.engineVersion === undefined ? '' : 'v' + v.engineVersion, v.generation === undefined ? '' : 'generation ' + String(v.generation)].filter(part => part !== '').join(' · '))
        }
        if (v.warning !== undefined) lines.push('  warning: ' + v.warning)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const startedAt = Date.now()
      const timing = makeTiming(startedAt)
      const detail = args.detail === 'full' ? 'full' : 'brief'
      let raw: unknown
      try {
        raw = await legacy.execute({}, exec)
      } catch (error) {
        return fail(AGENT_ERROR_CODES.internal, error instanceof Error ? error.message : String(error), { tool: TOOL, timing })
      }
      const value = raw as LegacyStatusValue
      if (value.ok !== true) return failed(TOOL, unavailableError(value), timing)
      // The brief must answer "is this index usable and why not": it carries
      // the engine warning (P0-5), the bounded root list, the content-truncated
      // flag and, when cheap, the index generation/engine version.
      const meta = detail === 'brief' ? await cachedEngineMeta(rt) : {}
      const summary = briefSummary(value, meta)
      if (detail === 'full') {
        return succeed(TOOL, {
          detail: 'full' as const,
          summary,
          status: value,
        }, timing)
      }
      const fields = briefFields(value, meta)
      const roots = briefRoots(value.roots)
      const warning = typeof value.warning === 'string' && value.warning !== ''
        ? truncateChars(value.warning, STATUS_BRIEF_WARNING_MAX_CHARS)
        : undefined
      const truncated: string[] = []
      if (warning?.truncated === true) truncated.push('warning')
      if (roots.truncated) truncated.push('roots')
      return succeed(TOOL, {
        detail: 'brief' as const,
        summary,
        ...fields,
        roots: roots.roots,
        ...(warning === undefined ? {} : { warning: warning.text }),
        ...(value.version === undefined ? {} : { engineVersion: value.version }),
        ...(meta.generation === undefined ? {} : { generation: meta.generation }),
        ...(truncated.length === 0 ? {} : { truncated }),
      }, timing)
    },
  })
}
