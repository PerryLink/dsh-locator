#!/usr/bin/env node
/**
 * locator-mcp.mjs — a read-only MCP stdio server in front of dsh-locator.
 *
 * Protocol subset: JSON-RPC 2.0 over newline-delimited stdio, implementing
 * initialize, ping, tools/list, tools/call and the empty resources listings.
 * There are no write tools, no network calls and no live-host dependency: the
 * server reads the local name index (one short-lived engine session) and the
 * content database in read-only mode, and every file/session ref it resolves
 * must live inside the configured roots.
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
  CliError,
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  asCliError,
  citeRefs,
  makeSettings,
  parseCliArgs,
  resolveRef,
  runFindSearch,
  runNameSearch,
  runStatus,
  settingsFromFlags,
  version,
} from './locator-cli.mjs'

/** MCP protocol versions this server understands (newest first). */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

/** Every tool is read-only; the client can trust the annotations. */
const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
})

const SEARCH_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'Everything-style file-name query.' },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
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
    description: 'Search the local file-name index (dsh-locator) read-only. Returns names, sizes and modification times from the configured roots; no workspace needed.',
    inputSchema: SEARCH_INPUT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'locator_find',
    description: 'Search file bodies in the local content index (dsh-locator) read-only. Every term needs 3+ characters (FTS5 trigram); optional context lines.',
    inputSchema: FIND_INPUT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'locator_status',
    description: 'Report the local index status read-only: roots, entry counts, state directory, engine binary and content-index counts.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'locator_resolve',
    description: 'Resolve one evidence ref (ref://file or dsh-session:) read-only. Paths must stay inside the configured roots; session refs are metadata-only.',
    inputSchema: RESOLVE_INPUT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'locator_cite',
    description: 'Render markdown/mention citations for up to 20 evidence refs, read-only. Does not read file bodies.',
    inputSchema: CITE_INPUT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS,
  },
])

/** Look up one tool definition by name. */
export function toolByName(name) {
  return TOOL_DEFINITIONS.find(tool => tool.name === name)
}

/** Pick the newest protocol version both sides understand. */
export function negotiateProtocolVersion(requested) {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : '2024-11-05'
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


/**
 * Execute one tool call against the read-only core.
 * @param settings - fixed roots/state/binary snapshot taken at startup.
 * @param name - tool name.
 * @param args - tool arguments already checked to be an object.
 * @returns the tool result object.
 */
export async function callTool(settings, name, args) {
  if (name === 'locator_search') {
    const query = requireString(args, 'query')
    return await runNameSearch(settings, query, {
      ...(optionalInteger(args, 'limit', 1, 1000) === undefined ? {} : { limit: args.limit }),
      ...(optionalInteger(args, 'offset', 0, 1_000_000) === undefined ? {} : { offset: args.offset }),
      ...(optionalEnum(args, 'sort', ['name', 'path', 'size', 'mtime', 'ext']) === undefined ? {} : { sort: args.sort }),
      ...(optionalBoolean(args, 'desc') === undefined ? {} : { desc: args.desc }),
      ...(optionalBoolean(args, 'regex') === undefined ? {} : { regex: args.regex }),
      ...(optionalBoolean(args, 'caseSensitive') === undefined ? {} : { caseSensitive: args.caseSensitive }),
      ...(optionalBoolean(args, 'wholeWord') === undefined ? {} : { wholeWord: args.wholeWord }),
      ...(optionalBoolean(args, 'filesOnly') === undefined ? {} : { filesOnly: args.filesOnly }),
      ...(optionalBoolean(args, 'dirsOnly') === undefined ? {} : { dirsOnly: args.dirsOnly }),
    })
  }
  if (name === 'locator_find') {
    const query = requireString(args, 'query')
    return await runFindSearch(settings, query, {
      ...(optionalInteger(args, 'limit', 1, 100) === undefined ? {} : { limit: args.limit }),
      ...(optionalInteger(args, 'offset', 0, 1_000_000) === undefined ? {} : { offset: args.offset }),
      ...(optionalInteger(args, 'contextLines', 0, 10) === undefined ? {} : { contextLines: args.contextLines }),
      ...(optionalBoolean(args, 'caseSensitive') === undefined ? {} : { caseSensitive: args.caseSensitive }),
      ...(optionalBoolean(args, 'wholeWord') === undefined ? {} : { wholeWord: args.wholeWord }),
    })
  }
  if (name === 'locator_status') return await runStatus(settings)
  if (name === 'locator_resolve') {
    const ref = requireString(args, 'ref')
    const mode = optionalEnum(args, 'mode', ['meta', 'excerpt'])
    return await resolveRef(settings, ref, {
      ...(mode === undefined ? {} : { mode }),
      ...(optionalInteger(args, 'maxBytes', 1, 65536) === undefined ? {} : { maxBytes: args.maxBytes }),
    })
  }
  if (name === 'locator_cite') {
    if (!Array.isArray(args.refs) || args.refs.length === 0) throw new ToolArgumentError('refs must be a non-empty array of ref strings')
    const refs = args.refs.filter(ref => typeof ref === 'string' && ref.trim() !== '')
    if (refs.length === 0) throw new ToolArgumentError('refs must contain at least one non-empty ref')
    return citeRefs(refs, optionalEnum(args, 'format', ['markdown', 'json', 'mention']) ?? 'markdown')
  }
  throw new RpcError(-32602, 'unknown tool: ' + name)
}

/** Render one tool result as an MCP content result. */
function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    isError: false,
  }
}

/** Render one tool failure as an isError content result. */
function toolFailure(error) {
  const failure = error instanceof ToolArgumentError
    ? { code: 'invalid-arguments', message: error.message }
    : { code: error && error.code ? error.code : 'tool-failed', message: error instanceof Error ? error.message : String(error) }
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: failure }) }],
    isError: true,
  }
}

/**
 * Handle one decoded JSON-RPC message.
 * @param message - decoded message (request or notification).
 * @param context - mutable server context (negotiated version, settings).
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
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: context.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dsh-locator', version },
          instructions: 'Read-only local evidence search. Roots are fixed at server start (' + context.settings.roots.join(', ') + '); no tool can write files, change the index or widen the roots.',
        },
      }
    }
    if (method === 'notifications/initialized' || method === 'initialized') {
      context.initialized = true
      return undefined
    }
    if (isNotification) return undefined
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } }
    if (method === 'tools/call') {
      const name = params.name
      if (typeof name !== 'string' || name === '') throw new RpcError(-32602, 'tools/call requires a tool name')
      const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments
      if (typeof args !== 'object' || Array.isArray(args)) throw new RpcError(-32602, 'tools/call arguments must be an object')
      try {
        const result = await callTool(context.settings, name, args)
        return { jsonrpc: '2.0', id, result: toolResult(result) }
      } catch (error) {
        if (error instanceof RpcError) throw error
        return { jsonrpc: '2.0', id, result: toolFailure(error) }
      }
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
 * @param options - test seams for streams and settings.
 * @returns a handle with close() and the fixed settings.
 */
export function startServer(options = {}) {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const settings = options.settings ?? makeSettings({})
  const context = { settings, protocolVersion: '2024-11-05', initialized: false }
  const send = value => {
    if (value === undefined) return
    output.write(JSON.stringify(value) + '\n')
  }
  const lines = createInterface({ input })
  let queue = Promise.resolve()
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
    close: () => { lines.close() },
    idle: () => queue,
  }
}

/** Usage text for --help. */
export function usage() {
  return [
    'dsh-locator MCP server ' + version + ' (read-only, stdio JSON-RPC)',
    '',
    'Usage: node scripts/locator-mcp.mjs [--root DIR]... [--state DIR] [--bin FILE] [--timeout MS]',
    '',
    'Roots are fixed at startup and no tool can widen them. Tools:',
    ...TOOL_DEFINITIONS.map(tool => '  ' + tool.name + ' — ' + tool.description.split('.')[0]),
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

/** Stdio entrypoint; resolves with the exit code after stdin reaches EOF. */
export async function main(argv = process.argv.slice(2)) {
  let settings
  try {
    settings = settingsFromArgv(argv)
  } catch (error) {
    const failure = asCliError(error, 'usage')
    process.stderr.write(failure.message + '\n')
    return failure.exitCode === EXIT_OK ? EXIT_OK : (failure.exitCode ?? EXIT_USAGE)
  }
  process.stderr.write('locator-mcp: serving ' + String(TOOL_DEFINITIONS.length) + ' read-only tools (roots: ' + settings.roots.join(', ') + ')\n')
  startServer({ settings })
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
