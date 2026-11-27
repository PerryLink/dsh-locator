#!/usr/bin/env node
/**
 * locator-mcp.mjs — a read-only MCP stdio server in front of dsh-locator.
 *
 * Protocol subset: JSON-RPC 2.0 over newline-delimited stdio, implementing
 * initialize, ping, tools/list, tools/call, shutdown/exit and the empty
 * resources listings. There are no write tools, no network calls and no
 * live-host dependency.
 *
 * 0.21.1 AI contract:
 *   - initialize starts one long-lived engine backed by a temporary read-only
 *     copy of the state directory; tools/call reuses it and shutdown/EOF stops
 *     it (the engine is never spawned once per call);
 *   - tools/list publishes an outputSchema plus read-only annotations;
 *   - tools/call sets isError whenever the tool result has ok=false;
 *   - every hit carries a citable ref, and search/find report
 *     truncated/nextOffset/budget;
 *   - session-log body hits are excluded unless allowSessions is passed, and
 *     file hits are restricted to the configured roots.
 *
 * Start it from an MCP client:
 *   node /path/to/dsh-locator/scripts/locator-mcp.mjs --root /path/to/dir
 *
 * Configuration is fixed at startup: --root (repeatable), --state, --bin,
 * --timeout; environment variables DSH_LOCATOR_ROOTS, DSH_LOCATOR_STATE and
 * DSH_LOCATOR_BIN are the fallbacks. No tool can widen the roots.
 */

import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  AGENT_API_VERSION,
  AGENT_TOOL_SCHEMAS,
  CliError,
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  agentFailureEnvelope,
  agentFailureFromThrown,
  asCliError,
  citeRefs,
  createEngineSession,
  legacyCodeToAgentCode,
  makeAgentErrorInfo,
  makeAgentTiming,
  makeSettings,
  parseCliArgs,
  renderAgentText,
  resolveRef,
  runAgentFind,
  runAgentRead,
  runAgentStatus,
  runFindSearch,
  runNameSearch,
  runStatus,
  settingsFromFlags,
  version,
} from './locator-cli.mjs'

/** Newest MCP protocol version this server implements. */
export const LATEST_PROTOCOL_VERSION = '2025-11-25'

/**
 * MCP protocol versions this server understands (newest first).
 *
 * An unknown/absent requested version negotiates the NEWEST supported version
 * (not the oldest): clients that predate this server must not silently get a
 * downgraded tool face.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05']

/** Every tool is read-only; the client can trust the annotations. */
const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
})

/** Additive output-budget block emitted by search/find. */
const BUDGET_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limitChars: { type: 'integer' },
    usedChars: { type: 'integer' },
    truncated: { type: 'boolean' },
    dropped: { type: 'integer' },
  },
  required: ['limitChars', 'usedChars', 'truncated', 'dropped'],
}

/** One search/find hit: a citable ref plus the fields it resolves from. */
const HIT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    kind: { type: 'string', enum: ['file', 'session', 'dir'] },
    path: { type: 'string' },
    name: { type: 'string' },
    title: { type: 'string' },
    snippet: { type: 'string' },
    line: { type: 'integer' },
    size: { type: 'integer' },
    mtime: { type: 'integer' },
    dir: { type: 'boolean' },
    sessionId: { type: 'string' },
    messageId: { type: 'string' },
    ref: { type: 'string', description: 'ref://file?... or dsh-session:... usable with locator_resolve/locator_cite.' },
    refStatus: { type: 'string', enum: ['fresh', 'stale', 'missing', 'tombstoned', 'unknown'] },
    freshness: { type: 'object', additionalProperties: true },
    permissions: { type: 'object', additionalProperties: true },
    context: { type: 'array', items: { type: 'string' } },
    contextStart: { type: 'integer' },
  },
  required: ['kind', 'path'],
}

const SEARCH_OUTPUT_SCHEMA = { type: 'object', additionalProperties: true, properties: {
  ok: { type: 'boolean' }, command: { type: 'string' }, mode: { type: 'string' }, query: { type: 'string' },
  limit: { type: 'integer' }, offset: { type: 'integer' }, total: { type: 'integer' }, totalCount: { type: 'integer' },
  returned: { type: 'integer' }, truncated: { type: 'boolean' }, nextOffset: { type: 'integer' }, indexing: { type: 'boolean' },
  budget: BUDGET_OUTPUT_SCHEMA,
  warnings: { type: 'array', items: { type: 'string' } },
  hits: { type: 'array', items: HIT_OUTPUT_SCHEMA },
}, required: ['ok'] }

const FIND_OUTPUT_SCHEMA = { type: 'object', additionalProperties: true, properties: {
  ok: { type: 'boolean' }, command: { type: 'string' }, mode: { type: 'string' }, query: { type: 'string' }, db: { type: 'string' },
  limit: { type: 'integer' }, offset: { type: 'integer' }, total: { type: 'integer' }, returned: { type: 'integer' },
  truncated: { type: 'boolean' }, nextOffset: { type: 'integer' },
  budget: BUDGET_OUTPUT_SCHEMA,
  warnings: { type: 'array', items: { type: 'string' } },
  hits: { type: 'array', items: HIT_OUTPUT_SCHEMA },
}, required: ['ok'] }

const STATUS_OUTPUT_SCHEMA = { type: 'object', additionalProperties: true, properties: {
  ok: { type: 'boolean' }, command: { type: 'string' }, readOnly: { type: 'boolean' },
  roots: { type: 'array', items: { type: 'string' } }, stateDir: { type: 'string' }, binary: { type: 'string' },
  engine: { type: 'object', additionalProperties: true }, content: { type: 'object', additionalProperties: true },
  copiedStateFiles: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } },
}, required: ['ok'] }

const RESOLVE_OUTPUT_SCHEMA = { type: 'object', additionalProperties: true, properties: {
  ok: { type: 'boolean' }, ref: { type: 'string' }, kind: { type: 'string' }, path: { type: 'string' },
  title: { type: 'string' }, excerpt: { type: 'string' }, error: { type: 'string' },
  freshness: { type: 'object', additionalProperties: true }, permissions: { type: 'object', additionalProperties: true },
  warnings: { type: 'array', items: { type: 'string' } },
}, required: ['ok'] }

const CITE_OUTPUT_SCHEMA = { type: 'object', additionalProperties: true, properties: {
  ok: { type: 'boolean' }, command: { type: 'string' }, format: { type: 'string' },
  citations: { type: 'array', items: { type: 'object', additionalProperties: true } },
}, required: ['ok'] }

const SEARCH_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'Everything-style file-name query.' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Page size; aligns with the host tools (max 100).' },
    offset: { type: 'integer', minimum: 0 },
    sort: { type: 'string', enum: ['name', 'path', 'size', 'mtime', 'ext'] },
    desc: { type: 'boolean' },
    regex: { type: 'boolean' },
    caseSensitive: { type: 'boolean' },
    wholeWord: { type: 'boolean' },
    filesOnly: { type: 'boolean' },
    dirsOnly: { type: 'boolean' },
  },
  required: ['query'],
}

const FIND_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'Words or a phrase to find in file bodies (terms need 3+ characters).' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    offset: { type: 'integer', minimum: 0 },
    contextLines: { type: 'integer', minimum: 0, maximum: 10 },
    caseSensitive: { type: 'boolean' },
    wholeWord: { type: 'boolean' },
    allowSessions: { type: 'boolean', description: 'Include session-log body hits. Off by default; the log path and its recorded workspace must stay inside the configured roots.' },
  },
  required: ['query'],
}

const RESOLVE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'string', description: 'ref://file?... or dsh-session:... reference.' },
    mode: { type: 'string', enum: ['meta', 'excerpt'] },
    maxBytes: { type: 'integer', minimum: 1, maximum: 65536 },
  },
  required: ['ref'],
}

const CITE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    refs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
    format: { type: 'string', enum: ['markdown', 'json', 'mention'] },
  },
  required: ['refs'],
}

/** The five read-only tools, in a stable order. */
export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'locator_search',
    title: 'Search local file names (read-only)',
    description: 'Search the local file-name index (dsh-locator) read-only. Roots are fixed at server start; every hit carries a citable ref. Results are paginated (truncated/nextOffset) and budgeted (8000 characters by default).',
    inputSchema: SEARCH_INPUT_SCHEMA,
    outputSchema: SEARCH_OUTPUT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'locator_find',
    title: 'Search local file contents (read-only)',
    description: 'Search file bodies in the local content index (dsh-locator) read-only. File hits are restricted to the configured roots; session-log hits are omitted unless allowSessions is true (then their log path and recorded workspace must stay inside the roots). Every term needs 3+ characters (FTS5 trigram); results are paginated and budgeted.',
    inputSchema: FIND_INPUT_SCHEMA,
    outputSchema: FIND_OUTPUT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'locator_status',
    title: 'Report local index status (read-only)',
    description: 'Report the local index status read-only: roots, entry counts, state directory, engine binary and content-index counts (files, sessions, messages, refs). The engine runs against a temporary state copy; the caller state directory is never written.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: STATUS_OUTPUT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'locator_resolve',
    title: 'Resolve one evidence ref (read-only)',
    description: 'Resolve one evidence ref (ref://file or dsh-session:) read-only. Paths must stay inside the configured roots; session refs are metadata-only.',
    inputSchema: RESOLVE_INPUT_SCHEMA,
    outputSchema: RESOLVE_OUTPUT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'locator_cite',
    title: 'Render citations for evidence refs (read-only)',
    description: 'Render markdown/mention citations for up to 20 evidence refs, read-only. Does not read file bodies.',
    inputSchema: CITE_INPUT_SCHEMA,
    outputSchema: CITE_OUTPUT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS,
  },
])

/** Look up one legacy tool definition by name. */
export function toolByName(name) {
  return TOOL_DEFINITIONS.find(tool => tool.name === name)
}

/**
 * The versioned agent-API (2026-11) tool face: locator_find, locator_read and
 * locator_status only. locator_admin is never exposed by any MCP surface.
 * Schemas are standard JSON Schema generated from the host DSL by
 * scripts/gen-agent-schemas.mjs (scripts/locator-cli.mjs materializes them).
 */
export const AGENT_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'locator_find',
    title: 'Find local files by name, body or symbol (read-only, agent API 2026-11)',
    description: [
      'One AI-first search entry point over the local dsh-locator indexes (read-only).',
      '',
      'mode: auto (symbols/body/name merged), name, body or symbol. kinds: file, dir, symbol (session rows are never returned on this files-only surface). where: pathPrefix/ext/modifiedAfter/minSize. scope: workspace (the server --cwd), roots or all. detail: compact (default), standard or full. count: exact, bounded or none. maxChars caps one page of items (default 6000, 0 = unlimited).',
      '',
      'Pages are opaque: pass page.nextCursor back as cursor. Every item carries a citable ref; coverage.notes explains fallbacks. Errors are uniform envelopes with one of 12 closed codes.',
    ].join('\n'),
    inputSchema: AGENT_TOOL_SCHEMAS.find.input,
    outputSchema: AGENT_TOOL_SCHEMAS.find.output,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'locator_read',
    title: 'Read evidence refs or files (read-only, agent API 2026-11)',
    description: [
      'Read a ref from locator_find, a bounded batch of refs, or a file path under the configured roots (read-only).',
      '',
      'Pass exactly one of ref, refs[] (1-20) or path. as: meta (evidence only), excerpt (default, verbatim whole lines) or quote (markdown blockquote + citation link). line targets a 1-based line; window (0-20) adds context lines; maxBytes caps each excerpt (default 2000, max 65536).',
      '',
      'Session refs are hidden on this files-only surface. Every item keeps ref/status/freshness; batch failures appear as item.error.',
    ].join('\n'),
    inputSchema: AGENT_TOOL_SCHEMAS.read.input,
    outputSchema: AGENT_TOOL_SCHEMAS.read.output,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'locator_status',
    title: 'Report local index health (read-only, agent API 2026-11)',
    description: [
      'Report the local index/content-index health read-only (agent API ' + AGENT_API_VERSION + ').',
      '',
      'detail: brief (default, compact index/content/scope summary under 600 characters) or full (every legacy status field under status). The engine runs against a temporary read-only state copy; the caller state directory is never written.',
    ].join('\n'),
    inputSchema: AGENT_TOOL_SCHEMAS.status.input,
    outputSchema: AGENT_TOOL_SCHEMAS.status.output,
    annotations: READ_ONLY_ANNOTATIONS,
  },
])

/** Tools of one negotiated surface. */
export function toolsForSurface(surface) {
  return surface === 'agent' ? AGENT_TOOL_DEFINITIONS : TOOL_DEFINITIONS
}

/**
 * Pick the protocol version to answer with: an explicitly supported version is
 * echoed, anything else (unknown or absent) gets the newest supported version.
 */
export function negotiateProtocolVersion(requested) {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION
}

/** A tool-argument problem: reported as an isError tool result, not a JSON-RPC error. */
class ToolArgumentError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ToolArgumentError'
  }
}

/** A JSON-RPC level failure (unknown method, malformed request). */
class RpcError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RpcError'
    this.code = code
  }
}

/** Require a non-empty string argument. */
function requireString(args, name) {
  const value = args[name]
  if (typeof value !== 'string' || value.trim() === '') throw new ToolArgumentError(name + ' is required')
  return value
}

/** Optional integer argument with a range check. */
function optionalInteger(args, name, min, max) {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolArgumentError(name + ' must be an integer between ' + String(min) + ' and ' + String(max))
  }
  return value
}

/** Optional boolean argument. */
function optionalBoolean(args, name) {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new ToolArgumentError(name + ' must be a boolean')
  return value
}

/** Optional enum argument. */
function optionalEnum(args, name, values) {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !values.includes(value)) throw new ToolArgumentError(name + ' must be one of: ' + values.join(', '))
  return value
}

/** Copy only the entries whose value is defined. */
function definedOnly(entries) {
  const out = {}
  for (const [key, value] of entries) if (value !== undefined) out[key] = value
  return out
}

/**
 * Execute one tool call against the read-only core.
 * @param settings - fixed roots/state/binary snapshot taken at startup.
 * @param name - tool name.
 * @param args - tool arguments already checked to be an object.
 * @param context - optional { engine } shared long-lived engine session.
 * @returns the tool result object.
 */
export async function callTool(settings, name, args, context = {}) {
  const engine = context.engine
  if (name === 'locator_search') {
    const query = requireString(args, 'query')
    return await runNameSearch(settings, query, {
      ...definedOnly([
        ['limit', optionalInteger(args, 'limit', 1, 100)],
        ['offset', optionalInteger(args, 'offset', 0, 1_000_000)],
        ['sort', optionalEnum(args, 'sort', ['name', 'path', 'size', 'mtime', 'ext'])],
        ['desc', optionalBoolean(args, 'desc')],
        ['regex', optionalBoolean(args, 'regex')],
        ['caseSensitive', optionalBoolean(args, 'caseSensitive')],
        ['wholeWord', optionalBoolean(args, 'wholeWord')],
        ['filesOnly', optionalBoolean(args, 'filesOnly')],
        ['dirsOnly', optionalBoolean(args, 'dirsOnly')],
      ]),
      ...(engine === undefined ? {} : { engine }),
    })
  }
  if (name === 'locator_find') {
    const query = requireString(args, 'query')
    const allowSessions = optionalBoolean(args, 'allowSessions') === true
    return await runFindSearch(settings, query, {
      ...definedOnly([
        ['limit', optionalInteger(args, 'limit', 1, 100)],
        ['offset', optionalInteger(args, 'offset', 0, 1_000_000)],
        ['contextLines', optionalInteger(args, 'contextLines', 0, 10)],
        ['caseSensitive', optionalBoolean(args, 'caseSensitive')],
        ['wholeWord', optionalBoolean(args, 'wholeWord')],
      ]),
      allowSessions,
    })
  }
  if (name === 'locator_status') return await runStatus(settings, engine === undefined ? {} : { engine })
  if (name === 'locator_resolve') {
    const ref = requireString(args, 'ref')
    const mode = optionalEnum(args, 'mode', ['meta', 'excerpt'])
    const maxBytes = optionalInteger(args, 'maxBytes', 1, 65536)
    return await resolveRef(settings, ref, definedOnly([
      ['mode', mode],
      ['maxBytes', maxBytes],
    ]))
  }
  if (name === 'locator_cite') {
    if (!Array.isArray(args.refs) || args.refs.length === 0) throw new ToolArgumentError('refs must be a non-empty array of ref strings')
    const refs = args.refs.filter(ref => typeof ref === 'string' && ref.trim() !== '')
    if (refs.length === 0) throw new ToolArgumentError('refs must contain at least one non-empty ref')
    return citeRefs(refs, optionalEnum(args, 'format', ['markdown', 'json', 'mention']) ?? 'markdown')
  }
  throw new RpcError(-32602, 'unknown tool: ' + name)
}

/** Whether a value is a non-array object. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

/**
 * Turn one legacy result whose ok is false into the uniform 2026-11 failure
 * envelope while keeping every legacy field (hits/warnings/path/permissions/…).
 * The historical error code is preserved in error.details.legacyCode and the
 * envelope's own error object replaces the old string/object error field.
 */
function legacyFailurePayload(toolName, value, startedAt) {
  const legacyError = value.error
  const warnings = Array.isArray(value.warnings) ? value.warnings : []
  let legacyCode = 'internal'
  let message = ''
  if (typeof legacyError === 'string') {
    legacyCode = legacyError
    message = legacyError.replace(/-/g, ' ')
  } else if (isPlainObject(legacyError)) {
    if (typeof legacyError.code === 'string' && legacyError.code !== '') legacyCode = legacyError.code
    if (typeof legacyError.message === 'string') message = legacyError.message
  } else if (warnings.length > 0) {
    legacyCode = String(warnings[0])
    message = String(warnings[0]).replace(/-/g, ' ')
  }
  const code = legacyCodeToAgentCode(legacyCode)
  const info = makeAgentErrorInfo(code, message.trim() === '' ? undefined : message, {
    legacyCode,
    ...(warnings.length === 0 ? {} : { details: { warnings: warnings.slice(0, 4) } }),
  })
  const { error: _legacyError, ok: _legacyOk, ...rest } = value
  return {
    ...rest,
    apiVersion: AGENT_API_VERSION,
    ok: false,
    tool: toolName,
    error: info,
    timing: makeAgentTiming(startedAt),
  }
}

/**
 * Render one legacy tool result as an MCP content result.
 *
 * Success results are byte-identical to the frozen legacy face. Failure
 * results carry the uniform 2026-11 failure envelope (legacy fields preserved)
 * so every isError answer has one machine-readable error shape.
 */
function toolResult(value, toolName, startedAt = Date.now()) {
  const isError = value !== null && typeof value === 'object' && value.ok === false
  const payload = isError ? legacyFailurePayload(toolName, value, startedAt) : value
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(isError || value === null || typeof value !== 'object' ? {} : { structuredContent: value }),
    isError,
  }
}

/** Render one thrown legacy failure as an isError content result. */
function toolFailure(error, toolName, startedAt = Date.now()) {
  const legacyCode = error instanceof ToolArgumentError
    ? 'invalid-arguments'
    : error && typeof error.code === 'string' && error.code !== '' ? error.code : 'internal'
  const code = legacyCodeToAgentCode(legacyCode)
  const message = error instanceof Error ? error.message : String(error)
  const envelope = agentFailureEnvelope(toolName, makeAgentErrorInfo(code, message, { legacyCode }), startedAt)
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    isError: true,
  }
}

/**
 * Render one 2026-11 tool result as an MCP content result: human-readable text
 * plus structuredContent that validates against the tool's published
 * outputSchema (success and failure envelopes both validate).
 */
function agentToolResult(envelope) {
  return {
    content: [{ type: 'text', text: renderAgentText(envelope) }],
    structuredContent: envelope,
    isError: envelope === null || typeof envelope !== 'object' || envelope.ok !== true,
  }
}

/** Execute one tool of the 2026-11 agent surface. */
export async function callAgentTool(settings, name, args, context = {}) {
  const toolContext = context.engine === undefined ? {} : { engine: context.engine }
  if (name === 'locator_find') return await runAgentFind(settings, args, toolContext)
  if (name === 'locator_read') return await runAgentRead(settings, args)
  if (name === 'locator_status') return await runAgentStatus(settings, args, toolContext)
  throw new RpcError(-32602, 'unknown tool: ' + name)
}

/**
 * Handle one decoded JSON-RPC message.
 * @param message - decoded message (request or notification).
 * @param context - mutable server context (negotiated version, settings, engine).
 * @returns the response object, or undefined for a notification.
 */
export async function handleMessage(message, context) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
  }
  const id = message.id
  const method = message.method
  if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } }
  }
  const params = message.params !== undefined && message.params !== null && typeof message.params === 'object' ? message.params : {}
  const isNotification = id === undefined || id === null
  try {
    if (method === 'initialize') {
      context.protocolVersion = negotiateProtocolVersion(params.protocolVersion)
      context.initialized = true
      if (context.engine === undefined) context.engine = createEngineSession(context.settings)
      // Start the one long-lived engine during initialize; every tools/call
      // reuses it (and its single temporary state copy) until shutdown/EOF.
      try {
        context.engine.start()
        context.engineError = undefined
      } catch (error) {
        context.engineError = error instanceof Error ? error.message : String(error)
      }
      const surface = context.surface === 'agent' ? 'agent' : 'legacy'
      const instructions = [
        'Server build: dsh-locator ' + version + ' (npm dsh-locator@' + version + '), agent API version ' + AGENT_API_VERSION + ', MCP protocol version ' + context.protocolVersion + '.',
        surface === 'agent'
          ? 'Active surface: agent API ' + AGENT_API_VERSION + ' (locator_find / locator_read / locator_status); locator_admin is never exposed and session rows/refs are hidden (files-only).'
          : 'Active surface: legacy tools (locator_search / locator_find / locator_status / locator_resolve / locator_cite). Start with --api=' + AGENT_API_VERSION + ' for the versioned find/read/status surface.',
        "Read-only local evidence search. Roots are fixed at server start (" + context.settings.roots.join(", ") + "); no tool can write files, change the index or widen the roots.",
        "The engine runs against a temporary read-only copy of the state directory; the caller state directory is never written.",
        surface === 'agent'
          ? "Every result is a uniform " + AGENT_API_VERSION + " envelope: success results carry outputSchema-validated structuredContent, failures use one of 12 closed error codes with retryable/remediation."
          : "Every hit carries a citable ref; search/find report truncated, nextOffset and a budget block. Session-log body hits are excluded unless a tool call passes allowSessions.",
      ].join(" ")
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: context.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dsh-locator', version },
          instructions,
        },
      }
    }
    if (method === 'notifications/initialized' || method === 'initialized') {
      context.initialized = true
      return undefined
    }
    if (isNotification) {
      if (method === 'exit' || method === 'notifications/exit') {
        if (context.engine !== undefined) await context.engine.close()
        if (typeof context.stop === 'function') context.stop()
      }
      return undefined
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: toolsForSurface(context.surface) } }
    if (method === 'tools/call') {
      const name = params.name
      if (typeof name !== 'string' || name === '') throw new RpcError(-32602, 'tools/call requires a tool name')
      const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments
      if (typeof args !== 'object' || Array.isArray(args)) throw new RpcError(-32602, 'tools/call arguments must be an object')
      if (context.shuttingDown === true) throw new RpcError(-32600, 'server is shutting down')
      const startedAt = Date.now()
      const agentSurface = context.surface === 'agent'
      try {
        const toolContext = context.engine === undefined ? {} : { engine: context.engine }
        if (agentSurface) {
          const result = await callAgentTool(context.settings, name, args, toolContext)
          return { jsonrpc: '2.0', id, result: agentToolResult(result) }
        }
        const result = await callTool(context.settings, name, args, toolContext)
        return { jsonrpc: '2.0', id, result: toolResult(result, name, startedAt) }
      } catch (error) {
        if (error instanceof RpcError) throw error
        if (agentSurface) {
          return { jsonrpc: '2.0', id, result: agentToolResult(agentFailureFromThrown(name, error, startedAt)) }
        }
        return { jsonrpc: '2.0', id, result: toolFailure(error, name, startedAt) }
      }
    }
    if (method === 'shutdown') {
      context.shuttingDown = true
      if (context.engine !== undefined) await context.engine.close()
      return { jsonrpc: '2.0', id, result: { ok: true } }
    }
    if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } }
    if (method === 'resources/templates/list') return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } }
    if (method === 'logging/setLevel') return { jsonrpc: '2.0', id, result: {} }
    if (method === 'completion/complete') return { jsonrpc: '2.0', id, result: { completion: { values: [], total: 0, hasMore: false } } }
    throw new RpcError(-32601, 'Method not found: ' + method)
  } catch (error) {
    if (error instanceof RpcError) {
      return { jsonrpc: '2.0', id: id ?? null, error: { code: error.code, message: error.message } }
    }
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * Start the stdio server.
 * @param options - test seams for streams, settings and a prebuilt engine session.
 * @returns a handle with close() and the fixed settings.
 */
export function startServer(options = {}) {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const settings = options.settings ?? makeSettings({})
  const engine = options.engine ?? createEngineSession(settings)
  const surface = options.surface === 'agent' || options.surface === 'legacy'
    ? options.surface
    : settings.api === AGENT_API_VERSION ? 'agent' : 'legacy'
  const context = { settings, engine, surface, protocolVersion: LATEST_PROTOCOL_VERSION, initialized: false, shuttingDown: false }
  const send = value => {
    if (value === undefined) return
    output.write(JSON.stringify(value) + '\n')
  }
  const lines = createInterface({ input })
  let queue = Promise.resolve()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { lines.close() } catch { /* already closed */ }
    try { await engine.close() } catch { /* engine already gone */ }
  }
  context.stop = () => { void close() }
  lines.on('close', () => { void close() })
  const handleLine = async line => {
    const text = line.trim()
    if (text === '') return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    if (Array.isArray(message)) {
      const responses = []
      for (const item of message) {
        const response = await handleMessage(item, context)
        if (response !== undefined) responses.push(response)
      }
      if (responses.length > 0) send(responses)
      return
    }
    send(await handleMessage(message, context))
  }
  lines.on('line', line => {
    queue = queue.then(() => handleLine(line)).catch(error => {
      process.stderr.write('locator-mcp: internal error: ' + String(error && error.message ? error.message : error) + '\n')
    })
  })
  return {
    settings,
    context,
    engine,
    /** Stop the engine, delete its temporary state copy and close the input. */
    close,
    idle: () => queue,
  }
}

/** Usage text for --help. */
export function usage() {
  return [
    'dsh-locator MCP server ' + version + ' (read-only, stdio JSON-RPC, agent API ' + AGENT_API_VERSION + ')',
    '',
    'Usage: node scripts/locator-mcp.mjs [--root DIR]... [--state DIR] [--bin FILE] [--timeout MS] [--cwd DIR] [--api legacy|' + AGENT_API_VERSION + ']',
    '',
    "Roots are fixed at startup and no tool can widen them. One long-lived engine runs",
    "against a temporary read-only copy of the state directory and is stopped on shutdown/EOF.",
    '--state without --root reads the roots recorded in <state>/meta.json (no full rescan).',
    '',
    'Default legacy surface (' + String(TOOL_DEFINITIONS.length) + ' tools):',
    ...TOOL_DEFINITIONS.map(tool => '  ' + tool.name + ' — ' + tool.description.split('.')[0]),
    '',
    'Versioned agent API surface (--api=' + AGENT_API_VERSION + ', ' + String(AGENT_TOOL_DEFINITIONS.length) + ' tools, admin never exposed):',
    ...AGENT_TOOL_DEFINITIONS.map(tool => '  ' + tool.name + ' — ' + tool.description.split('\n')[0]),
    '',
    'Environment: DSH_LOCATOR_ROOTS (path-separator separated), DSH_LOCATOR_STATE, DSH_LOCATOR_BIN.',
    'Exit codes: 0 clean EOF, 1 unexpected error, 2 usage error.',
  ].join('\n')
}

/** Build the fixed settings from the server argv. */
export function settingsFromArgv(argv, env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) throw new CliError('usage', usage(), EXIT_OK)
  const parsed = parseCliArgs(['status', ...argv])
  return settingsFromFlags(parsed.flags, env)
}

/** Stdio entrypoint; resolves with the exit code after the server starts. */
export async function main(argv = process.argv.slice(2)) {
  let settings
  try {
    settings = settingsFromArgv(argv)
  } catch (error) {
    const failure = asCliError(error, 'usage')
    process.stderr.write(failure.message + '\n')
    return failure.exitCode === EXIT_OK ? EXIT_OK : (failure.exitCode ?? EXIT_USAGE)
  }
  const surface = settings.api === AGENT_API_VERSION ? 'agent' : 'legacy'
  process.stderr.write('locator-mcp: serving ' + String(toolsForSurface(surface).length) + ' read-only ' + surface + ' tool(s) (roots: ' + settings.roots.join(', ') + ')\n')
  const server = startServer({ settings })
  const stop = exitCode => {
    void server.close().finally(() => { process.exitCode = exitCode })
  }
  process.once('SIGINT', () => stop(130))
  process.once('SIGTERM', () => stop(143))
  return EXIT_OK
}

// Run only when executed directly (tests import the module for the protocol model).
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  main().then(code => {
    if (code !== EXIT_OK) process.exitCode = code
  }).catch(error => {
    process.stderr.write('locator-mcp: fatal: ' + String(error && error.stack ? error.stack : error) + '\n')
    process.exitCode = EXIT_RUNTIME
  })
}
