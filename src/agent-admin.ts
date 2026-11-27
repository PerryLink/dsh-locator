/**
 * locator_admin — deferred-loading maintenance actions for the 0.22.0 interface.
 *
 * One tool routes the three existing maintenance factories (locator_rebuild,
 * locator_reindex, locator_export) through the shared envelope instead of
 * registering three always-visible tools. The underlying business logic is
 * reused verbatim: this module only validates/routes arguments and maps the
 * legacy result/error shapes onto the closed agent error set.
 * @module dsh-locator/agent-admin
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentIndex } from './content.ts'
import { makeExportTool } from './export.ts'
import { makeReindexTool } from './reindex.ts'
import type { LocatorRuntime } from './runtime.ts'
import { makeRebuildTool } from './tools.ts'
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

/** Structured error block with the shared per-code defaults. */
function errorInfo(code: AgentErrorCode, message: string, extra: { retryable?: boolean; remediation?: string } = {}): AgentErrorInfo {
  return makeError(code, message, extra).error
}

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
const TOOL = 'locator_admin'

/** Deferred-loading maintenance tool: writes and can be slow. */
export const ADMIN_ACTIONS = ['rebuild', 'reindex', 'export'] as const
type AdminAction = (typeof ADMIN_ACTIONS)[number]

/** Declared parameters (action excluded); unknown keys are never routed. */
const ADMIN_PARAMS = ['roots', 'excludes', 'full', 'path', 'overwrite', 'allowOutsideStateDir', 'pageSize'] as const

/** Parameters each action consumes; every other provided parameter is reported as ignored. */
const APPLICABLE_PARAMS: Readonly<Record<AdminAction, readonly string[]>> = {
  rebuild: ['roots', 'excludes'],
  reindex: ['full'],
  export: ['path', 'overwrite', 'allowOutsideStateDir', 'pageSize'],
}

/** How to verify/act after a successful action (the tool never polls by itself). */
const ACTION_HINTS: Readonly<Record<AdminAction, { hint: string; nextTools: string[] }>> = {
  rebuild: {
    hint: 'Poll locator_status (detail:"brief") until scanning is false; searches keep using the old index meanwhile.',
    nextTools: ['locator_status'],
  },
  reindex: {
    hint: 'Poll locator_status until content.building is false; searches keep answering while it runs.',
    nextTools: ['locator_status'],
  },
  export: {
    hint: 'The result is a read-only SQLite snapshot on disk; open result.path with any SQLite client. No status polling is needed.',
    nextTools: [],
  },
}

/** Wiring for the admin tool; the plugin passes its runtime/content/ensure hook. */
export interface AgentAdminToolOptions {
  rt: LocatorRuntime
  content?: ContentIndex
  ensure?: () => void
}

/** Union of the legacy rebuild/reindex/export result shapes this module reads. */
interface LegacyAdminResult {
  ok: boolean
  started?: boolean
  full?: boolean
  path?: string
  rows?: number
  bytes?: number
  tookMs?: number
  error?: string
  errorInfo?: { code?: string; hint?: string }
}

const ADMIN_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...AGENT_SUCCESS_BASE_SCHEMA.properties,
    action: { type: 'string', enum: ADMIN_ACTIONS },
    /** Parameters that the chosen action does not consume (they were not applied). */
    ignored: { type: 'array', items: { type: 'string' } },
    /** One actionable sentence: how to track/verify the action. */
    hint: { type: 'string' },
    /** Tools to call next (status tracking). */
    nextTools: { type: 'array', items: { type: 'string' } },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        started: { type: 'boolean' },
        full: { type: 'boolean' },
        path: { type: 'string' },
        rows: { type: 'integer' },
        bytes: { type: 'integer' },
        tookMs: { type: 'number', description: 'Export action only: wall-clock cost of the database write.' },
      },
    },
    error: AGENT_ERROR_INFO_SCHEMA,
  },
} as const

/** Format a size for the admin result rendering. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return String(bytes) + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return value.toFixed(value >= 10 ? 0 : 1) + ' ' + (units[unit] ?? 'TB')
}

/** Map one legacy maintenance failure onto the closed agent error set. */
export function adminErrorOf(value: LegacyAdminResult): AgentErrorInfo {
  const message = typeof value.error === 'string' && value.error !== '' ? value.error : 'locator_admin action failed'
  const hint = value.errorInfo?.hint
  const legacyCode = value.errorInfo?.code
  if (legacyCode === 'invalid-arguments') {
    return errorInfo(AGENT_ERROR_CODES.invalidArgument, message, {
      ...(hint === undefined ? {} : { remediation: hint }),
    })
  }
  if (legacyCode === 'engine-error') {
    return errorInfo(AGENT_ERROR_CODES.indexUnavailable, message, {
      retryable: true,
      ...(hint === undefined
        ? { remediation: 'Retry once; if it persists, check locator_status for engine errors or restart the plugin host.' }
        : { remediation: hint }),
    })
  }
  if (/already running|is already running/i.test(message)) {
    return errorInfo(AGENT_ERROR_CODES.indexBuilding, message, {
      retryable: true,
      remediation: 'Wait for the running build to finish; poll locator_status until content.building is false.',
    })
  }
  if (/refusing to overwrite/i.test(message)) {
    return errorInfo(AGENT_ERROR_CODES.invalidArgument, message, {
      remediation: 'Pass overwrite: true to replace a database created by a previous locator_admin export.',
    })
  }
  if (/plugin state directory|state directory/i.test(message)) {
    return errorInfo(AGENT_ERROR_CODES.scopeDenied, message, {
      remediation: 'Export inside the plugin state directory (omit path or pass a relative path), or pass allowOutsideStateDir: true.',
    })
  }
  if (/node:sqlite is unavailable/i.test(message)) {
    return errorInfo(AGENT_ERROR_CODES.internal, message, {
      retryable: false,
      remediation: 'The export action needs Node 22.5+ (node:sqlite); rebuild/reindex still work.',
    })
  }
  return errorInfo(AGENT_ERROR_CODES.internal, message)
}

/** Build the success envelope payload from one legacy result. */
function adminPayload(action: AdminAction, value: LegacyAdminResult): { action: AdminAction; result: Record<string, boolean | number | string> } {
  return {
    action,
    result: {
      ...(value.started === undefined ? {} : { started: value.started }),
      ...(value.full === undefined ? {} : { full: value.full }),
      ...(value.path === undefined ? {} : { path: value.path }),
      ...(value.rows === undefined ? {} : { rows: value.rows }),
      ...(value.bytes === undefined ? {} : { bytes: value.bytes }),
      ...(value.tookMs === undefined ? {} : { tookMs: value.tookMs }),
    },
  }
}

/** Build the locator_admin tool (deferLoading: write operations, loaded on demand). */
export function makeAgentAdminTool(options: AgentAdminToolOptions) {
  const { rt, content } = options
  const rebuildTool = makeRebuildTool(rt)
  const exportTool = makeExportTool(rt)
  const reindexTool = content === undefined ? undefined : makeReindexTool(content, options.ensure)
  return defineTool({
    name: TOOL,
    description: [
      'Index maintenance for dsh-locator (dsh-locator). These are write operations and can be expensive; the tool is deferred and not loaded until needed.',
      '',
      'action "rebuild": rescan the local file index from scratch (roots/excludes may only narrow the configured scope). Runs in the background: searches keep answering from the old index. Expensive (minutes of disk I/O on a large home directory).',
      'action "reindex": rebuild (full: true) or incrementally refresh the content database behind locator_find content mode. Search keeps working while it runs.',
      'action "export": write a read-only SQLite snapshot of the name index to disk (path/overwrite/allowOutsideStateDir/pageSize). Writes a file and can take tens of seconds on a large index.',
      '',
      'Parameters the chosen action does not consume are reported in "ignored" and are NOT applied (roots/excludes: rebuild only; full: reindex only; path/overwrite/allowOutsideStateDir/pageSize: export only). On success hint/nextTools say how to track progress with locator_status.',
      '',
      'Call it only when the user explicitly asks to rescan/rebuild/export, or when locator_status reports a stale or failed index. Never poll these actions: rebuild/reindex run in the background and export writes a file.',
    ].join('\n'),
    parameters: {
      action: { type: 'string', enum: ADMIN_ACTIONS, required: true, description: 'rebuild = rescan the name index; reindex = rebuild/refresh the content database; export = write a SQLite snapshot of the name index.' },
      roots: { type: 'array', items: { type: 'string' }, description: 'rebuild only: replacement index roots; each must be a configured root or inside one (default: current roots).' },
      excludes: { type: 'array', items: { type: 'string' }, description: 'rebuild only: replacement exclusion globs; each must already be configured (default: current excludes).' },
      full: { type: 'boolean', description: 'reindex only: true drops and re-reads the content database; false (default) refreshes changed files/sessions only.' },
      path: { type: 'string', description: 'export only: output .sqlite/.db file; relative paths resolve inside the plugin state directory (default: <stateDir>/locator-export.sqlite).' },
      overwrite: { type: 'boolean', description: 'export only: replace an existing file created by a previous export (default false). Any other existing file is never replaced.' },
      allowOutsideStateDir: { type: 'boolean', description: 'export only: allow an absolute path outside the plugin state directory (explicit opt-in, default false).' },
      pageSize: { type: 'integer', description: 'export only: rows per engine request (default 5000, at most 10000).' },
    },
    output: {
      schema: ADMIN_OUTPUT,
      render: (args, value) => {
        const v = value as {
          ok: boolean
          action?: AdminAction
          ignored?: string[]
          hint?: string
          nextTools?: string[]
          result?: { started?: boolean; full?: boolean; path?: string; rows?: number; bytes?: number; tookMs?: number }
          error?: AgentErrorInfo
        }
        const action = v.action ?? args.action
        if (v.ok !== true) {
          const error = v.error
          return [{ type: 'text', text: 'locator_admin (' + action + ') failed: ' + (error?.code ?? 'internal') + ': ' + (error?.message ?? 'unknown error') + (error?.remediation === undefined ? '' : ' — ' + error.remediation) }]
        }
        const ignored = v.ignored === undefined || v.ignored.length === 0 ? '' : ' (ignored parameter(s): ' + v.ignored.join(', ') + ')'
        const tail = (v.hint === undefined ? '' : '\n   → ' + v.hint) + (v.nextTools === undefined || v.nextTools.length === 0 ? '' : '\n   next: ' + v.nextTools.join(', '))
        const result = v.result ?? {}
        if (action === 'export') {
          return [{ type: 'text', text: 'locator_admin export: ' + String(result.rows ?? 0) + ' row(s) -> ' + (result.path ?? '') + ' (' + formatSize(result.bytes ?? 0) + ', ' + ((result.tookMs ?? 0) / 1000).toFixed(1) + ' s)' + ignored + tail }]
        }
        if (action === 'reindex') {
          if (result.started !== true) return [{ type: 'text', text: 'locator_admin reindex: nothing was started.' + ignored }]
          return [{ type: 'text', text: 'locator_admin reindex: ' + (result.full === true ? 'full' : 'incremental') + ' content rebuild started; searches keep answering while it runs.' + ignored + tail }]
        }
        if (result.started !== true) return [{ type: 'text', text: 'locator_admin rebuild: nothing was started.' + ignored }]
        return [{ type: 'text', text: 'locator_admin rebuild: started in the background; searches keep using the old index until it finishes.' + ignored + tail }]
      },
    },
    deferLoading: true,
    timeoutMs: 180_000,
    async execute(args, exec) {
      const startedAt = Date.now()
      const timing = makeTiming(startedAt)
      const action: AdminAction = args.action
      // 0.23.0: a parameter the chosen action does not consume is reported back
      // instead of being silently dropped, so the model can correct its call.
      const provided = args as unknown as Record<string, unknown>
      const applicable = APPLICABLE_PARAMS[action]
      const ignored = ADMIN_PARAMS.filter(name => !applicable.includes(name) && provided[name] !== undefined)
      const guidance = ACTION_HINTS[action]
      const extra = {
        ...(ignored.length === 0 ? {} : { ignored: [...ignored] }),
        hint: guidance.hint,
        ...(guidance.nextTools.length === 0 ? {} : { nextTools: [...guidance.nextTools] }),
      }
      try {
        if (action === 'rebuild') {
          const value = await rebuildTool.execute({
            ...(args.roots === undefined ? {} : { roots: args.roots }),
            ...(args.excludes === undefined ? {} : { excludes: args.excludes }),
          }, exec) as LegacyAdminResult
          if (value.ok !== true) return failed(TOOL, adminErrorOf(value), timing)
          return succeed(TOOL, { ...adminPayload(action, value), ...extra }, timing)
        }
        if (action === 'reindex') {
          if (reindexTool === undefined) {
            return fail(AGENT_ERROR_CODES.indexUnavailable, 'the content index is disabled in this profile', {
              tool: TOOL,
              timing,
              retryable: false,
              remediation: 'Enable the content index to use action reindex; action rebuild and export still work.',
            })
          }
          const value = await reindexTool.execute({ full: args.full === true }, exec) as LegacyAdminResult
          if (value.ok !== true) return failed(TOOL, adminErrorOf(value), timing)
          return succeed(TOOL, { ...adminPayload(action, value), ...extra }, timing)
        }
        const value = await exportTool.execute({
          ...(args.path === undefined ? {} : { path: args.path }),
          ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }),
          ...(args.allowOutsideStateDir === undefined ? {} : { allowOutsideStateDir: args.allowOutsideStateDir }),
          ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
        }, exec) as LegacyAdminResult
        if (value.ok !== true) return failed(TOOL, adminErrorOf(value), timing)
        return succeed(TOOL, { ...adminPayload(action, value), ...extra }, timing)
      } catch (error) {
        return fail(AGENT_ERROR_CODES.internal, error instanceof Error ? error.message : String(error), { tool: TOOL, timing })
      }
    },
  })
}
