#!/usr/bin/env node
/**
 * locator-cli.mjs — public, host-free CLI and the shared core of the read-only
 * MCP server (scripts/locator-mcp.mjs imports this module).
 *
 * Two data paths, exactly like the plugin:
 *   - file names: spawn the bundled Go engine (indexd serve --no-watch) and
 *     speak its line-delimited JSON-RPC over stdio;
 *   - file bodies: open <state>/content.db with node:sqlite in read-only mode
 *     and run the same FTS5 trigram query the plugin uses.
 *
 * P0 read-only contract (0.21.1): the engine never sees the caller's state
 * directory. prepareReadOnlyState() copies index.snapshot / index.journal /
 * meta.json into a private mkdtemp directory and every engine spawn points at
 * that copy, so a search/status invocation cannot create, rewrite, append to or
 * fsync the live index. The content database is opened through SQLite's
 * immutable URI (or a temporary copy on platforms without URI support), which
 * keeps SQLite from creating -wal/-shm side files next to the caller's DB.
 *
 * The CLI never talks to a live DSH host and never mutates state: it is safe to
 * run next to (or instead of) the plugin.
 *
 * Exit codes: 0 success, 1 unexpected runtime error, 2 usage/validation error,
 * 3 index or engine unavailable.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Exit codes shared by the CLI and the MCP tool wrapper. */
export const EXIT_OK = 0
export const EXIT_RUNTIME = 1
export const EXIT_USAGE = 2
export const EXIT_UNAVAILABLE = 3

/** Structured CLI failure; carries the stable code and its exit status. */
export class CliError extends Error {
  /**
   * @param {string} code - stable machine-readable code.
   * @param {string} message - human-readable detail.
   * @param {number} exitCode - process exit status.
   */
  constructor(code, message, exitCode = EXIT_RUNTIME) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Package root (the script lives in <root>/scripts/). */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Package version, read from package.json (no dynamic import side effects). */
export const version = (() => {
  try {
    return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Platform tag used by the bundled engine directories. */
export function platformTag() {
  return process.platform + '-' + process.arch
}

/** Bundled engine file name for this platform. */
export function engineName() {
  return process.platform === 'win32' ? 'indexd.exe' : 'indexd'
}

/** Default snapshot directory, mirroring src/paths.ts. */
export function defaultStateDir() {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'dsh-locator')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'dsh-locator')
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dsh-locator')
}

/** Resolve the engine binary: explicit override, bundled build, then PATH. */
export function resolveEngineBinary(env = process.env) {
  const explicit = env.DSH_LOCATOR_BIN
  if (typeof explicit === 'string' && explicit !== '') return resolve(explicit)
  const name = engineName()
  const bundled = join(packageRoot, 'bin', platformTag(), name)
  if (existsSync(bundled)) return bundled
  const plain = join(packageRoot, 'bin', name)
  if (existsSync(plain)) return plain
  return name
}

/** Resolve the index roots: --root flags, DSH_LOCATOR_ROOTS, then the home directory. */
export function resolveRoots(flagRoots = [], env = process.env) {
  const envRoots = typeof env.DSH_LOCATOR_ROOTS === 'string' && env.DSH_LOCATOR_ROOTS !== ''
    ? env.DSH_LOCATOR_ROOTS.split(delimiter).filter(part => part !== '')
    : []
  const candidates = flagRoots.length > 0 ? flagRoots : envRoots
  const roots = candidates.length > 0 ? candidates : [homedir()]
  return roots.map(root => resolve(root))
}

/** Resolve the snapshot directory: --state flag, DSH_LOCATOR_STATE, platform default. */
export function resolveStateDir(flag, env = process.env) {
  if (typeof flag === 'string' && flag !== '') return resolve(flag)
  const fromEnv = env.DSH_LOCATOR_STATE
  if (typeof fromEnv === 'string' && fromEnv !== '') return resolve(fromEnv)
  return defaultStateDir()
}

/** Files a locator engine reads from and writes to its state directory. */
export const STATE_FILE_NAMES = Object.freeze(['index.snapshot', 'index.journal', 'meta.json'])

/** Prefix of every temporary engine-state copy (diagnostics only). */
const READ_ONLY_STATE_PREFIX = 'dsh-locator-readonly-'

/** Prefix of every temporary content-database copy. */
const CONTENT_COPY_PREFIX = 'dsh-locator-content-'

/** Default soft output budget for search/find results, in characters. */
export const DEFAULT_SEARCH_BUDGET_CHARS = 8_000

/** Maximum page size, aligned with the host locator tools (src/config.ts maxResults). */
export const MAX_SEARCH_LIMIT = 100

/* -------------------------------------------------------------------------- */
/* Agent API 2026-11 contract                                                 */
/*                                                                            */
/* One wire contract shared by the versioned MCP face (`--api=2026-11`) and   */
/* the versioned CLI output mode. The host tools declare their schemas in the  */
/* dsh-tools DSL (property-level `required: true`), which is NOT valid JSON   */
/* Schema; hostDslToJsonSchema() converts that DSL into the standard JSON      */
/* Schema published through MCP tools/list. Keep these constants in sync with  */
/* src/agent-core.ts, src/agent-find.ts, src/agent-read.ts and                 */
/* src/agent-status.ts (scripts/gen-agent-schemas.mjs --check verifies the     */
/* version and the closed error-code set when the source tree is present).     */
/* -------------------------------------------------------------------------- */

/** Version of the AI-first wire contract; bumps only on a breaking change. */
export const AGENT_API_VERSION = '2026-11'

/** Default item budget in characters (the budget counts items only). */
export const AGENT_DEFAULT_MAX_CHARS = 6_000
/** Smallest useful maxChars: below this one compact item cannot fit. */
export const AGENT_MIN_BUDGET_CHARS = 120
/** Default page size of the 2026-11 find surface. */
export const AGENT_DEFAULT_LIMIT = 10
/** Hard cap on one page of items. */
export const AGENT_MAX_LIMIT = 50

/** Detail presets: compact (default) trims items hardest, full keeps evidence. */
export const AGENT_DETAILS = Object.freeze(['compact', 'standard', 'full'])
/** Search modes understood by the 2026-11 find surface. */
export const AGENT_FIND_MODES = Object.freeze(['auto', 'name', 'body', 'symbol'])
/** Scope modes shared by the 2026-11 tools. */
export const AGENT_SCOPE_MODES = Object.freeze(['workspace', 'roots', 'all'])
/** Row kinds the 2026-11 find surface understands (sessions are never exposed). */
export const AGENT_FIND_KINDS = Object.freeze(['file', 'dir', 'session', 'symbol'])
/** Count modes understood by the 2026-11 find surface. */
export const AGENT_COUNT_MODES = Object.freeze(['exact', 'bounded', 'none'])

/** Closed machine-readable error codes of the agent envelope (12 codes). */
export const AGENT_ERROR_CODES = Object.freeze({
  invalidArgument: 'invalid-argument',
  queryTooShort: 'query-too-short',
  queryInvalid: 'query-invalid',
  scopeDenied: 'scope-denied',
  scopeEmptyWorkspace: 'scope-empty-workspace',
  notFound: 'not-found',
  indexUnavailable: 'index-unavailable',
  indexBuilding: 'index-building',
  budgetTooSmall: 'budget-too-small',
  cursorInvalid: 'cursor-invalid',
  cancelled: 'cancelled',
  internal: 'internal',
})

/** Stable list of the closed agent error codes, in host order. */
export const AGENT_ERROR_CODE_LIST = Object.freeze(Object.values(AGENT_ERROR_CODES))

/** Default retryability of each code (an explicit override wins). */
export const AGENT_ERROR_RETRYABLE = Object.freeze({
  'invalid-argument': false,
  'query-too-short': false,
  'query-invalid': false,
  'scope-denied': false,
  'scope-empty-workspace': false,
  'not-found': false,
  'index-unavailable': true,
  'index-building': true,
  'budget-too-small': false,
  'cursor-invalid': false,
  'cancelled': true,
  'internal': false,
})

/** Default human message of each code (used when no message is supplied). */
export const AGENT_ERROR_MESSAGES = Object.freeze({
  'invalid-argument': 'the tool arguments are invalid',
  'query-too-short': 'the query is too short for the content index',
  'query-invalid': 'the query is not valid',
  'scope-denied': 'the requested scope is not allowed',
  'scope-empty-workspace': 'the caller workspace has no indexed content',
  'not-found': 'the requested object was not found',
  'index-unavailable': 'the index is not available',
  'index-building': 'the index is still building its first snapshot',
  'budget-too-small': 'maxChars is too small to return one item',
  'cursor-invalid': 'the cursor is invalid for this query',
  'cancelled': 'the request was cancelled',
  'internal': 'the locator hit an internal error',
})

/** Default actionable remediation of each code. */
export const AGENT_ERROR_REMEDIATION = Object.freeze({
  'invalid-argument': 'Check the argument types and ranges declared by the tool schema.',
  'query-too-short': 'Use at least 3 characters per body term, or pass mode:"name" to search file names.',
  'query-invalid': 'Rewrite the query with the documented word/phrase syntax.',
  'scope-denied': 'The path or session is outside the configured roots or the scope rules.',
  'scope-empty-workspace': 'Pass scope:"roots" or scope:"all" to search every configured root.',
  'not-found': 'Use locator_find to locate the path or ref first.',
  'index-unavailable': 'Retry once; if it persists, check index state with locator_status.',
  'index-building': 'Retry when locator_status reports building:false; partial results may still be returned.',
  'budget-too-small': 'Raise maxChars (at least 120) or use detail:"compact".',
  'cursor-invalid': 'Re-run the query without a cursor: cursors are bound to the query, mode and scope.',
  'cancelled': 'Retry the call.',
  'internal': 'Retry once; if it persists, check locator_status.',
})

/** Default follow-up tools advertised next to each code (2026-11 surface names). */
export const AGENT_ERROR_NEXT_TOOLS = Object.freeze({
  'query-too-short': ['locator_find'],
  'query-invalid': ['locator_find'],
  'scope-denied': ['locator_status'],
  'scope-empty-workspace': ['locator_find'],
  'not-found': ['locator_find'],
  'index-unavailable': ['locator_status'],
  'index-building': ['locator_status'],
  'budget-too-small': ['locator_find'],
  'cursor-invalid': ['locator_find'],
  internal: ['locator_status'],
})

/**
 * Exit-status mapping of the 12 closed codes for `locator-cli --api=2026-11`.
 * 0 ok, 1 runtime/internal, 2 usage-class, 3 index unavailable, 4 denied/not found.
 */
export const AGENT_ERROR_EXIT_CODES = Object.freeze({
  'invalid-argument': EXIT_USAGE,
  'query-too-short': EXIT_USAGE,
  'query-invalid': EXIT_USAGE,
  'scope-denied': 4,
  'scope-empty-workspace': 4,
  'not-found': 4,
  'index-unavailable': EXIT_UNAVAILABLE,
  'index-building': EXIT_UNAVAILABLE,
  'budget-too-small': EXIT_USAGE,
  'cursor-invalid': EXIT_USAGE,
  cancelled: EXIT_RUNTIME,
  internal: EXIT_RUNTIME,
})

/** Cursor payload version of the 2026-11 surface (per-source offsets). */
export const AGENT_CURSOR_VERSION = 2
/** Above this size a cursor is treated as malformed. */
const AGENT_CURSOR_MAX_CHARS = 2_048
/** Fields a compact item keeps. */
const AGENT_COMPACT_ITEM_FIELDS = Object.freeze(['kind', 'path', 'title', 'line', 'snippet', 'why', 'sources', 'score', 'ref', 'seq', 'eventRef'])
/** Fields a standard item keeps (compact + evidence freshness). */
const AGENT_STANDARD_ITEM_FIELDS = Object.freeze(['kind', 'path', 'title', 'line', 'snippet', 'why', 'sources', 'score', 'ref', 'refStatus', 'freshness', 'language', 'symbolScope', 'seq', 'eventRef'])
/** Fields a full item keeps (standard + identity/evidence details). */
const AGENT_FULL_ITEM_FIELDS = Object.freeze([
  'kind', 'path', 'title', 'line', 'snippet', 'why', 'score', 'ref', 'refStatus', 'freshness', 'language', 'symbolScope',
  'name', 'size', 'mtime', 'modified', 'ext', 'dir', 'format', 'hash', 'permissions', 'provenance', 'sessionId', 'messageId',
  'seq', 'eventRef', 'context', 'contextStart', 'sources',
])
/** Compact snippets are cut at this many code points (the default detail). */
const COMPACT_SNIPPET_CHARS = 160
/** Standard snippets are cut at this many code points. */
const STANDARD_SNIPPET_CHARS = 240
/** Full snippets are cut at this many code points. */
const FULL_SNIPPET_CHARS = 320

/** Whether a value is a non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

/** Deterministic short hash used to bind a cursor to one query request. */
export function queryHashOf(parts) {
  let text
  try {
    text = JSON.stringify(parts) ?? String(parts)
  } catch {
    text = String(parts)
  }
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** Encode one 2026-11 cursor payload as an opaque base64url token. */
export function encodeAgentCursor(payload) {
  const offsets = {}
  for (const [source, value] of Object.entries(payload.offsets ?? {})) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) offsets[source] = value
  }
  const body = {
    v: AGENT_CURSOR_VERSION,
    mode: payload.mode,
    queryHash: payload.queryHash,
    offsets,
    ...(payload.scope === undefined ? {} : { scope: payload.scope }),
    ...(payload.generation === undefined ? {} : { generation: payload.generation }),
    ...(payload.kinds === undefined ? {} : { kinds: [...payload.kinds] }),
    ...(payload.includeArchived === true ? { includeArchived: true } : {}),
  }
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')
}

/** Encode one 0.22-compatible single-source (v1) cursor as an opaque token. */
export function encodeAgentCursorV1(payload) {
  return Buffer.from(JSON.stringify({
    v: 1,
    mode: payload.mode,
    queryHash: payload.queryHash,
    offset: Math.max(0, Math.trunc(payload.offset ?? 0)),
    ...(payload.scope === undefined ? {} : { scope: payload.scope }),
    ...(payload.generation === undefined ? {} : { generation: payload.generation }),
  }), 'utf8').toString('base64url')
}

/** Decode one opaque 2026-11 cursor, returning undefined for anything malformed. */
export function decodeAgentCursor(cursor) {
  if (typeof cursor !== 'string') return undefined
  const token = cursor.trim()
  if (token === '' || token.length > AGENT_CURSOR_MAX_CHARS) return undefined
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return undefined
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (isRecord(parsed) === false) return undefined
  if (parsed.v === 1) {
    // 0.22 host single-source cursor: { v:1, mode, queryHash, offset, scope?, generation? }.
    if (parsed.mode !== 'name' && parsed.mode !== 'body' && parsed.mode !== 'symbol') return undefined
    if (typeof parsed.queryHash !== 'string' || parsed.queryHash === '') return undefined
    if (typeof parsed.offset !== 'number' || Number.isInteger(parsed.offset) === false || parsed.offset < 0) return undefined
    const legacy = { v: 1, mode: parsed.mode, queryHash: parsed.queryHash, offsets: { [parsed.mode]: parsed.offset } }
    if (typeof parsed.scope === 'string' && AGENT_SCOPE_MODES.includes(parsed.scope)) legacy.scope = parsed.scope
    if (typeof parsed.generation === 'number' && Number.isInteger(parsed.generation) && parsed.generation > 0) legacy.generation = parsed.generation
    return legacy
  }
  if (parsed.v !== AGENT_CURSOR_VERSION) return undefined
  if (typeof parsed.mode !== 'string' || AGENT_FIND_MODES.includes(parsed.mode) === false) return undefined
  if (typeof parsed.queryHash !== 'string' || parsed.queryHash === '') return undefined
  if (isRecord(parsed.offsets) === false) return undefined
  const offsets = {}
  for (const [source, value] of Object.entries(parsed.offsets)) {
    if (!['name', 'body', 'symbol'].includes(source)) return undefined
    if (typeof value !== 'number' || Number.isInteger(value) === false || value < 0) return undefined
    offsets[source] = value
  }
  const payload = { v: AGENT_CURSOR_VERSION, mode: parsed.mode, queryHash: parsed.queryHash, offsets }
  if (typeof parsed.scope === 'string' && AGENT_SCOPE_MODES.includes(parsed.scope)) payload.scope = parsed.scope
  if (typeof parsed.generation === 'number' && Number.isInteger(parsed.generation) && parsed.generation > 0) payload.generation = parsed.generation
  if (Array.isArray(parsed.kinds) && parsed.kinds.every(kind => typeof kind === 'string')) payload.kinds = [...parsed.kinds]
  if (parsed.includeArchived === true) payload.includeArchived = true
  return payload
}

/** Whether a decoded cursor belongs to the current request (query/mode binding). */
export function agentCursorMatches(payload, expected) {
  if (payload.queryHash !== expected.queryHash) return false
  if (expected.mode === undefined || expected.mode === 'auto') return true
  return payload.mode === expected.mode
}

/* -------------------------------------------------------------------------- */
/* Host DSL -> standard JSON Schema                                           */
/* -------------------------------------------------------------------------- */

/**
 * Convert one host tool-schema DSL node into standard JSON Schema.
 *
 * The dsh-tools DSL marks required object properties with `required: true`
 * inside the property schema; JSON Schema requires a `required` array on the
 * object instead. `type: 'json'` has no JSON Schema equivalent and becomes the
 * "any value" schema. Everything else (types, enums, items, nested objects,
 * additionalProperties) passes through unchanged.
 * @param node - host DSL node (plain object/array/scalar).
 * @returns the standard JSON Schema value.
 */
export function hostDslToJsonSchema(node) {
  if (Array.isArray(node)) return node.map(item => hostDslToJsonSchema(item))
  if (isRecord(node) === false) return node
  const out = {}
  const required = []
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required' && typeof value === 'boolean') continue
    if (key === 'required' && Array.isArray(value)) { for (const name of value) required.push(name); continue }
    if (key === 'type' && value === 'json') continue
    if (key === 'properties' && isRecord(value)) {
      const properties = {}
      for (const [name, propertySchema] of Object.entries(value)) {
        if (isRecord(propertySchema) && propertySchema.required === true) required.push(name)
        properties[name] = hostDslToJsonSchema(propertySchema)
      }
      out.properties = properties
      continue
    }
    if (key === 'items' || key === 'additionalProperties' || key === 'propertyNames') {
      out[key] = hostDslToJsonSchema(value)
      continue
    }
    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      out[key] = value.map(item => hostDslToJsonSchema(item))
      continue
    }
    out[key] = hostDslToJsonSchema(value)
  }
  if (required.length > 0) out.required = [...new Set(required)]
  return out
}

const AGENT_TIMING_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tookMs: { type: 'number', required: true, description: 'Milliseconds spent inside the tool call (never negative).' },
  },
}

const AGENT_ERROR_INFO_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true, enum: [...AGENT_ERROR_CODE_LIST], description: 'Stable machine-readable error code.' },
    message: { type: 'string', required: true, description: 'Human-readable message.' },
    retryable: { type: 'boolean', required: true, description: 'True when the same call may succeed on retry.' },
    remediation: { type: 'string', description: 'One actionable sentence for the caller.' },
    nextTools: { type: 'array', items: { type: 'string' }, description: 'Follow-up tools that can unblock the caller.' },
    details: { type: 'json', description: 'Extra machine-readable context (never contains file contents).' },
  },
}

const AGENT_FRESHNESS_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', required: true, enum: ['fresh', 'stale', 'missing', 'unknown'] },
    observedAt: { type: 'integer', description: 'Epoch ms of the observation behind this state.' },
    mtime: { type: 'integer', description: 'Current on-disk mtime in epoch ms, when observed.' },
  },
}

const AGENT_PERMISSIONS_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    read: { type: 'string', required: true, enum: ['allowed', 'denied'] },
    visibility: { type: 'string', required: true, enum: ['workspace', 'roots', 'session', 'external'] },
    reason: { type: 'string' },
  },
}

const AGENT_PROVENANCE_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    origin: { type: 'string', required: true, enum: ['index', 'tool', 'session', 'web'] },
    path: { type: 'string' },
    sessionId: { type: 'string' },
    messageId: { type: 'string' },
    indexedAt: { type: 'integer', description: 'Epoch ms when the index last stored this object.' },
    url: { type: 'string' },
    callId: { type: 'string' },
  },
}

const AGENT_ITEM_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, enum: ['file', 'dir', 'session', 'symbol'] },
    path: { type: 'string', required: true },
    title: { type: 'string' },
    name: { type: 'string', description: 'Symbol declaration name (full detail only).' },
    line: { type: 'integer', description: '1-based matched/declaration line, when known.' },
    snippet: { type: 'string', description: 'Bounded matched text (compact: at most 160 code points).' },
    why: { type: 'array', items: { type: 'string' }, description: 'Why this row matched, e.g. "symbol:exact" or "body:terms".' },
    sources: { type: 'array', items: { type: 'string', enum: ['name', 'body', 'symbol'] }, description: 'Sources that contributed this row (auto mode merges several).' },
    score: { type: 'number', description: 'Relevance score (content rank; lower is better for FTS5 bm25).' },
    ref: { type: 'string', description: 'Citable evidence ref (ref://file or dsh-session:...).' },
    refStatus: { type: 'string', enum: ['fresh', 'stale', 'missing', 'tombstoned', 'unknown'], description: 'Evidence freshness label (standard/full).' },
    freshness: AGENT_FRESHNESS_DSL,
    hash: { type: 'string', description: 'sha256 of the file bytes (full detail only).' },
    permissions: AGENT_PERMISSIONS_DSL,
    provenance: AGENT_PROVENANCE_DSL,
    sessionId: { type: 'string', description: 'Session id for session rows (full detail only).' },
    messageId: { type: 'string', description: 'Message id for session rows (full detail only).' },
    seq: { type: 'integer', description: 'Indexed event sequence for session rows (full detail only).' },
    eventRef: { type: 'string', description: 'Full event ref for session rows (full detail only).' },
    size: { type: 'integer', description: 'File size in bytes (full detail only).' },
    mtime: { type: 'integer', description: 'Modification time in epoch ms (full detail only).' },
    modified: { type: 'string', description: 'ISO-8601 modification time (full detail only).' },
    ext: { type: 'string', description: 'Lower-case file extension without the dot (full detail only).' },
    dir: { type: 'boolean', description: 'True for directory rows (full detail only).' },
    format: { type: 'string', description: 'Extracted document format (full detail only).' },
    language: { type: 'string', description: 'Symbol language (standard/full).' },
    symbolScope: { type: 'string', description: 'Enclosing type/namespace of a symbol (standard/full).' },
    context: { type: 'array', items: { type: 'string' }, description: 'Surrounding source lines for a body hit (full detail only).' },
    contextStart: { type: 'integer', description: '1-based line number of context[0] (full detail only).' },
  },
}

const AGENT_PAGE_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', required: true, description: 'Effective page-size cap for this call.' },
    returned: { type: 'integer', required: true, description: 'Items on this page (after budget trimming).' },
    more: { type: 'boolean', required: true, description: 'True when paging further can return more items.' },
    nextCursor: { type: 'string', description: 'Opaque continuation token; present only when more is true.' },
  },
}

const AGENT_COVERAGE_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    indexing: { type: 'boolean', required: true, description: 'The index is still building; this page is partial.' },
    indexTruncated: { type: 'boolean', required: true, description: 'The content build dropped documents because of its size budget.' },
    notes: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string', required: true },
          severity: { type: 'string', required: true, enum: ['info', 'warn', 'error'] },
          message: { type: 'string', required: true },
        },
      },
    },
  },
}

const AGENT_BUDGET_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limitChars: { type: 'integer', required: true, description: 'Effective soft cap in characters; 0 means unlimited.' },
    usedChars: { type: 'integer', required: true, description: 'Characters the returned items serialize to.' },
    truncated: { type: 'boolean', required: true, description: 'True when items were dropped or the first item exceeds the cap.' },
    dropped: { type: 'integer', required: true, description: 'Items kept out of this page by the budget.' },
  },
}

const AGENT_SCOPE_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    requested: { type: 'string', required: true, enum: ['workspace', 'roots', 'all'], description: 'Scope the caller asked for.' },
    effective: { type: 'string', required: true, enum: ['workspace', 'roots', 'all'], description: 'Scope actually searched (after a workspace fallback).' },
    fallback: { type: 'boolean', description: 'True when the effective scope was widened from the requested one.' },
    fallbackReason: { type: 'string', description: 'Why the scope was widened.' },
  },
}

const AGENT_SUCCESS_BASE_DSL = {
  properties: {
    apiVersion: { type: 'string', required: true, description: 'Agent wire contract version.' },
    ok: { type: 'boolean', required: true },
    tool: { type: 'string', required: true, description: 'Tool that produced the result.' },
    timing: AGENT_TIMING_DSL,
  },
}

const AGENT_FAILURE_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    apiVersion: { type: 'string', required: true, description: 'Agent wire contract version.' },
    ok: { type: 'boolean', required: true },
    tool: { type: 'string', required: true, description: 'Tool that produced the failure.' },
    error: { ...AGENT_ERROR_INFO_DSL, required: true },
    timing: AGENT_TIMING_DSL,
  },
}

const FIND_COUNTS_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'integer', description: 'Primary match count when known.' },
    totalKind: { type: 'string', enum: ['exact', 'bounded', 'unknown'], description: 'Confidence of total.' },
    nameTotal: { type: 'integer', description: 'Name-index match count (name mode).' },
    bodyTotal: { type: 'integer', description: 'Content-index match count (body mode).' },
    bodyKind: { type: 'string', enum: ['exact', 'bounded', 'unknown'], description: 'Confidence of bodyTotal.' },
    symbolTotal: { type: 'integer', description: 'Symbol match count (symbol mode).' },
  },
}

/** Input parameters of the 2026-11 locator_find surface (host FIND_PARAMETERS). */
const FIND_PARAMETERS_DSL = {
  query: { type: 'string', required: true, description: 'Words/phrase, name fragment or identifier. Empty is rejected.' },
  mode: { type: 'string', enum: ['auto', 'name', 'body', 'symbol'], description: 'auto (symbol->body->name), name, body or symbol.' },
  kinds: { type: 'array', items: { type: 'string', enum: ['file', 'dir', 'session', 'symbol'] }, description: 'Row kinds to return (default all). Session rows are never returned by this MCP surface.' },
  where: {
    type: 'object',
    additionalProperties: false,
    properties: {
      pathPrefix: { type: 'string', description: 'Only rows under this directory (inside the roots).' },
      ext: { type: 'array', items: { type: 'string' }, description: 'Only these lower-case extensions (no dot).' },
      modifiedAfter: { type: 'string', description: 'ISO-8601 time or epoch-ms mtime lower bound.' },
      minSize: { type: 'integer', description: 'Minimum file size in bytes.' },
    },
    description: 'Metadata filters applied before paging.',
  },
  scope: { type: 'string', enum: ['workspace', 'roots', 'all'], description: 'workspace (--cwd), roots (all roots) or all (same as roots for this files-only surface).' },
  limit: { type: 'integer', description: 'Items per page (default 10, max 50).' },
  cursor: { type: 'string', description: 'Opaque page.nextCursor; mutually exclusive with offset.' },
  offset: { type: 'integer', description: 'Legacy row offset (prefer cursor).' },
  maxChars: { type: 'integer', description: 'Item budget in characters (default 6000; 0 = unlimited).' },
  detail: { type: 'string', enum: ['compact', 'standard', 'full'], description: 'compact (default), standard (+freshness) or full (+ids/hash/permissions).' },
  count: { type: 'string', enum: ['exact', 'bounded', 'none'], description: 'exact (default), bounded or none.' },
  includeArchived: { type: 'boolean', description: 'Include archived sessions. This files-only surface never exposes session rows; emitted as a coverage note.' },
}

/** Output of the 2026-11 locator_find surface (host FIND_OUTPUT). */
const FIND_OUTPUT_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...AGENT_SUCCESS_BASE_DSL.properties,
    query: { type: 'string' },
    mode: { type: 'string', enum: ['auto', 'name', 'body', 'symbol'] },
    resolvedMode: { type: 'string', enum: ['name', 'body', 'symbol', 'mixed'] },
    detail: { type: 'string', enum: ['compact', 'standard', 'full'] },
    scope: AGENT_SCOPE_DSL,
    items: { type: 'array', items: AGENT_ITEM_DSL },
    page: AGENT_PAGE_DSL,
    counts: FIND_COUNTS_DSL,
    coverage: AGENT_COVERAGE_DSL,
    budget: AGENT_BUDGET_DSL,
    error: AGENT_ERROR_INFO_DSL,
  },
}

/** Input parameters of the 2026-11 locator_read surface (host parameters). */
const READ_PARAMETERS_DSL = {
  ref: { type: 'string', description: 'One ref from locator_find.' },
  refs: { type: 'array', items: { type: 'string' }, description: '1-20 refs; per-ref failures appear as item.error.' },
  path: { type: 'string', description: 'File path inside the configured roots.' },
  line: { type: 'integer', description: '1-based target line (default: the ref anchor, else 1).' },
  window: { type: 'integer', description: 'Context lines per side, 0-20 (default 0).' },
  as: { type: 'string', enum: ['meta', 'excerpt', 'quote'], description: 'meta (evidence only), excerpt (default, verbatim lines), or quote (markdown blockquote + citation link + fallback).' },
  maxBytes: { type: 'integer', description: 'Per-excerpt cap in characters (default 2000, max 65536).' },
}

const READ_ITEM_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'string' },
    kind: { type: 'string', enum: ['file', 'session', 'url', 'session-event', 'spill', 'attachment'] },
    title: { type: 'string' },
    path: { type: 'string' },
    sessionId: { type: 'string' },
    messageId: { type: 'string' },
    seq: { type: 'integer' },
    line: { type: 'integer', description: '1-based target line the excerpt is centered on.' },
    startLine: { type: 'integer', description: '1-based first line actually returned.' },
    endLine: { type: 'integer', description: '1-based last line actually returned.' },
    lineCount: { type: 'integer', description: 'Total lines in the file when the read reached end of file.' },
    excerpt: { type: 'string', description: 'Verbatim whole lines; always contains the target line whole.' },
    markdown: { type: 'string', description: 'quote mode: markdown blockquote plus citation link and fallback.' },
    hash: { type: 'string' },
    size: { type: 'integer' },
    status: { type: 'string', enum: ['fresh', 'stale', 'missing', 'tombstoned', 'unknown'] },
    checkedAt: { type: 'integer' },
    truncated: { type: 'boolean', description: 'The excerpt dropped window lines or sliced long lines to fit maxBytes.' },
    anchor: {
      type: 'object',
      additionalProperties: false,
      properties: { line: { type: 'integer' }, charStart: { type: 'integer' }, charEnd: { type: 'integer' } },
    },
    freshness: AGENT_FRESHNESS_DSL,
    permissions: AGENT_PERMISSIONS_DSL,
    provenance: AGENT_PROVENANCE_DSL,
    warnings: { type: 'array', items: { type: 'string' } },
    error: AGENT_ERROR_INFO_DSL,
  },
}

/** Output of the 2026-11 locator_read surface (host READ_OUTPUT). */
const READ_OUTPUT_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...AGENT_SUCCESS_BASE_DSL.properties,
    items: { type: 'array', items: READ_ITEM_DSL },
    counts: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requested: { type: 'integer', required: true },
        returned: { type: 'integer', required: true },
        failed: { type: 'integer', required: true },
        duplicates: { type: 'integer', description: 'Duplicate ref strings collapsed before reading.' },
        linesDropped: { type: 'integer', description: 'Window lines dropped by the per-excerpt maxBytes cap.' },
      },
    },
    budget: AGENT_BUDGET_DSL,
    limits: {
      type: 'object',
      additionalProperties: false,
      description: 'Effective limits of this call.',
      properties: {
        perExcerptChars: { type: 'integer' },
        batchLimitChars: { type: 'integer' },
        maxChars: { type: 'integer' },
        maxRefs: { type: 'integer' },
      },
    },
    error: AGENT_ERROR_INFO_DSL,
  },
}

/** Input parameters of the 2026-11 locator_status surface (host parameters). */
const STATUS_PARAMETERS_DSL = {
  detail: { type: 'string', enum: ['brief', 'full'], description: 'brief (default) or full (every status field).' },
}

/** Output of the 2026-11 locator_status surface (host STATUS_OUTPUT). */
const STATUS_OUTPUT_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...AGENT_SUCCESS_BASE_DSL.properties,
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
        watchDegraded: { type: 'boolean', description: 'The watcher covers fewer roots than configured (partial refresh coverage).' },
        scanning: { type: 'boolean' },
        roots: { type: 'integer', description: 'Number of configured index roots.' },
      },
    },
    content: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        building: { type: 'boolean' },
        truncated: { type: 'boolean', description: 'The content build dropped documents because of its size budget.' },
        files: { type: 'integer' },
        sessions: { type: 'integer' },
        messages: { type: 'integer' },
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
    roots: { type: 'array', items: { type: 'string' }, description: 'detail:"brief" only: bounded list of configured roots.' },
    warning: { type: 'string', description: 'detail:"brief" only: engine/content warning, truncated to 240 characters.' },
    engineVersion: { type: 'string', description: 'detail:"brief" only: engine binary version, when reported.' },
    generation: { type: 'integer', description: 'detail:"brief" only: index generation, when reported.' },
    truncated: { type: 'array', items: { type: 'string' }, description: 'detail:"brief" only: fields of the brief payload that were truncated (warning, roots).' },
    status: { type: 'object', additionalProperties: true, description: 'detail:"full" only: every field of the legacy locator_status payload.' },
    error: AGENT_ERROR_INFO_DSL,
  },
}

/**
 * Host-shaped schema DSL of the 2026-11 surface. Materialized into standard
 * JSON Schema by buildAgentToolSchemas(); scripts/gen-agent-schemas.mjs prints
 * or checks the generated result.
 */
export const AGENT_SCHEMA_DSL = Object.freeze({
  apiVersion: AGENT_API_VERSION,
  timing: AGENT_TIMING_DSL,
  errorInfo: AGENT_ERROR_INFO_DSL,
  failure: AGENT_FAILURE_DSL,
  find: { input: FIND_PARAMETERS_DSL, output: FIND_OUTPUT_DSL },
  read: { input: READ_PARAMETERS_DSL, output: READ_OUTPUT_DSL },
  status: { input: STATUS_PARAMETERS_DSL, output: STATUS_OUTPUT_DSL },
})

/** Convert one host parameter map into a standard JSON Schema object schema. */
function parametersToJsonSchema(parameters) {
  return hostDslToJsonSchema({ type: 'object', additionalProperties: false, properties: parameters })
}

/** Build the standard JSON Schema of every 2026-11 tool surface. */
export function buildAgentToolSchemas() {
  return {
    apiVersion: AGENT_API_VERSION,
    failure: hostDslToJsonSchema(AGENT_FAILURE_DSL),
    find: { input: parametersToJsonSchema(FIND_PARAMETERS_DSL), output: hostDslToJsonSchema(FIND_OUTPUT_DSL) },
    read: { input: parametersToJsonSchema(READ_PARAMETERS_DSL), output: hostDslToJsonSchema(READ_OUTPUT_DSL) },
    status: { input: parametersToJsonSchema(STATUS_PARAMETERS_DSL), output: hostDslToJsonSchema(STATUS_OUTPUT_DSL) },
  }
}

/** Standard JSON Schema of the 2026-11 surface, materialized once. */
export const AGENT_TOOL_SCHEMAS = Object.freeze(buildAgentToolSchemas())

/** Temporary engine-state copies that still need cleanup (also cleaned on process exit). */
const liveReadOnlyStates = new Set()
let readOnlyExitHookInstalled = false

/** Copy one file, preferring a copy-on-write reflink and falling back to a byte copy. */
function copyFileForReadOnly(from, to) {
  if (typeof fsConstants.COPYFILE_FICLONE === 'number') {
    try {
      copyFileSync(from, to, fsConstants.COPYFILE_FICLONE)
      return
    } catch { /* reflink unsupported; fall through to a plain copy */ }
  }
  copyFileSync(from, to)
}

/** Remove every temporary state copy before the process disappears. */
function installReadOnlyExitHook() {
  if (readOnlyExitHookInstalled || typeof process === 'undefined' || typeof process.once !== 'function') return
  readOnlyExitHookInstalled = true
  process.once('exit', () => {
    for (const state of [...liveReadOnlyStates]) {
      try { state.cleanup() } catch { /* best effort while exiting */ }
    }
  })
}

/**
 * Build a private, read-only copy of a caller's engine state directory.
 *
 * The engine (indexd serve) needs a writable state directory: it appends
 * index.journal and rewrites index.snapshot/meta.json while it runs. Pointing
 * it at the caller's live state would mutate a running plugin's index, so the
 * three state files are copied into a fresh mkdtemp directory and the engine is
 * spawned against that copy. Nothing is ever written to sourceStateDir (it is
 * not even created when it does not exist).
 *
 * @param sourceStateDir - the caller's state directory (may not exist).
 * @returns the temporary engine state plus a cleanup function.
 */
export function prepareReadOnlyState(sourceStateDir) {
  const engineStateDir = mkdtempSync(join(tmpdir(), READ_ONLY_STATE_PREFIX))
  const copied = []
  let sourceExists = false
  try {
    sourceExists = statSync(sourceStateDir).isDirectory()
  } catch {
    sourceExists = false
  }
  try {
    if (sourceExists) {
      for (const name of STATE_FILE_NAMES) {
        const from = join(sourceStateDir, name)
        let info
        try { info = statSync(from) } catch { continue }
        if (!info.isFile()) continue
        copyFileForReadOnly(from, join(engineStateDir, name))
        copied.push(name)
      }
    }
  } catch (error) {
    try { rmSync(engineStateDir, { recursive: true, force: true }) } catch { /* best effort */ }
    throw new CliError(
      'read-only-state-failed',
      'cannot prepare a read-only copy of ' + String(sourceStateDir) + ': ' + String(error && error.message ? error.message : error),
      EXIT_UNAVAILABLE,
    )
  }
  const state = {
    sourceStateDir,
    engineStateDir,
    copied,
    readOnly: true,
    cleanup: () => {
      if (!liveReadOnlyStates.delete(state)) return
      try { rmSync(engineStateDir, { recursive: true, force: true, maxRetries: 2 }) } catch { /* best effort */ }
    },
  }
  liveReadOnlyStates.add(state)
  installReadOnlyExitHook()
  return state
}

/** Remove every still-live temporary state copy (tests and fatal paths). */
export function cleanupReadOnlyStates() {
  for (const state of [...liveReadOnlyStates]) {
    try { state.cleanup() } catch { /* best effort */ }
  }
}

/**
 * One lazy, long-lived engine session backed by a temporary read-only state
 * copy. The first request spawns the engine; every later request reuses it, so
 * a long-lived MCP server starts exactly one engine and one state copy.
 * @param settings - resolved roots/binary/timeouts (the caller's stateDir).
 * @returns a session with start/request/waitForInitialScan/close helpers.
 */
export function createEngineSession(settings) {
  let engine = null
  let prepared = null
  let closed = false
  let spawnCount = 0
  const ensure = () => {
    if (closed) throw new CliError('engine-closed', 'the read-only engine session is already closed', EXIT_UNAVAILABLE)
    if (engine === null) {
      prepared = prepareReadOnlyState(settings.stateDir)
      engine = startEngine(settings, prepared.engineStateDir)
      spawnCount++
    }
    return engine
  }
  const session = {
    /** Number of engine processes spawned by this session (0 or 1 in practice). */
    get spawnCount() { return spawnCount },
    /** The temporary state directory the engine actually uses, once started. */
    get engineStateDir() { return prepared === null ? undefined : prepared.engineStateDir },
    /** State files copied from the caller's directory. */
    get copiedFiles() { return prepared === null ? [] : prepared.copied },
    /** Spawn the engine now (the MCP server does this during initialize). */
    start() { ensure(); return session },
    /** One engine RPC, spawning the engine on first use. */
    async request(method, params = {}, timeoutMs) { return await ensure().request(method, params, timeoutMs) },
    /** Wait for the engine's first scan, spawning the engine on first use. */
    async waitForInitialScan(timeoutMs) { return await ensure().waitForInitialScan(timeoutMs) },
    /** Stop the engine and delete the temporary state copy. Idempotent. */
    async close() {
      if (closed) return
      closed = true
      const current = engine
      engine = null
      try {
        if (current !== null) await current.close()
      } finally {
        const state = prepared
        prepared = null
        if (state !== null) state.cleanup()
      }
    },
  }
  return session
}

/** Default wait for the engine's background first scan before a one-shot search. */
export const INITIAL_SCAN_TIMEOUT_MS = 10_000

/** Status-poll interval while waiting for the initial scan. */
const INITIAL_SCAN_POLL_MS = 25

/** How long one scan-status probe may take before the engine counts as unresponsive. */
const SCAN_STATUS_PROBE_TIMEOUT_MS = 1_000

/** Effective first-scan wait: DSH_LOCATOR_SCAN_TIMEOUT overrides the 10 s default. */
export function scanTimeoutFrom(env = process.env) {
  const raw = env.DSH_LOCATOR_SCAN_TIMEOUT
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : INITIAL_SCAN_TIMEOUT_MS
}

/**
 * Read the snapshot roots from a state directory's meta.json.
 *
 * The engine writes one meta.json per state directory (schema: { roots: string[]
 * }). A CLI/MCP call that only knows --state would otherwise fall back to the
 * home directory and force the engine to rescan a different root set; reading
 * the recorded roots keeps the engine on the existing snapshot (no full
 * rescan) and keeps the trust boundary identical to the plugin.
 * @param stateDir - resolved state directory.
 * @param flagRoots - explicit --root values (they always win).
 * @param env - environment (DSH_LOCATOR_ROOTS wins over meta.json).
 * @returns the validated absolute roots, or undefined when meta.json is
 * missing, unreadable, not an object or does not carry a non-empty roots array.
 */
export function rootsFromStateMeta(stateDir, flagRoots = [], env = process.env) {
  if (Array.isArray(flagRoots) && flagRoots.length > 0) return undefined
  if (typeof env.DSH_LOCATOR_ROOTS === 'string' && env.DSH_LOCATOR_ROOTS !== '') return undefined
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(stateDir, 'meta.json'), 'utf8'))
  } catch {
    return undefined
  }
  if (isRecord(parsed) === false || Array.isArray(parsed.roots) === false || parsed.roots.length === 0) return undefined
  const roots = []
  for (const root of parsed.roots) {
    if (typeof root !== 'string' || root.trim() === '') return undefined
    roots.push(resolve(root))
  }
  return roots
}

/** Build the settings object every core function takes. */
export function makeSettings(overrides = {}, env = process.env) {
  const stateDir = resolveStateDir(overrides.state ?? overrides.stateDir, env)
  const flagRoots = overrides.roots ?? []
  const metaRoots = rootsFromStateMeta(stateDir, flagRoots, env)
  return {
    roots: metaRoots ?? resolveRoots(flagRoots, env),
    stateDir,
    binary: typeof overrides.binary === 'string' && overrides.binary !== '' ? overrides.binary : resolveEngineBinary(env),
    timeoutMs: Number.isFinite(overrides.timeoutMs) ? Math.trunc(overrides.timeoutMs) : 15_000,
    scanTimeoutMs: Number.isFinite(overrides.scanTimeoutMs) ? Math.max(0, Math.trunc(overrides.scanTimeoutMs)) : scanTimeoutFrom(env),
    contentDb: join(stateDir, 'content.db'),
    workspace: typeof overrides.workspace === 'string' && overrides.workspace !== '' ? resolve(overrides.workspace) : resolve(process.cwd()),
    api: typeof overrides.api === 'string' && overrides.api !== '' ? overrides.api : 'legacy',
  }
}

/**
 * Start one engine session (name index only, watcher disabled) and return
 * request/close helpers. Ready is signalled by the engine's "ready" or "stats"
 * event; a failed spawn, an early exit or the timeout rejects it.
 *
 * engineStateDir must already exist and should be a temporary read-only copy
 * (see prepareReadOnlyState); the caller's stateDir is never created here.
 */
export function startEngine(settings, engineStateDir = settings.stateDir) {
  // Never create the caller's state directory here: the engine only ever runs
  // against the temporary copy prepared by prepareReadOnlyState() (see
  // createEngineSession), which already exists. A caller that explicitly asks
  // for a fresh state directory gets it created by the engine on first save.
  if (process.platform !== 'win32' && settings.binary.includes(sep)) {
    try { chmodSync(settings.binary, 0o755) } catch { /* read-only install */ }
  }
  const args = ['serve', '--state', engineStateDir]
  for (const root of settings.roots) args.push('--root', root)
  args.push('--no-watch')
  const child = spawn(settings.binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const pending = new Map()
  const waiterList = []
  let stderr = ''
  let nextId = 1
  let settled = false
  let resolveReady
  let rejectReady
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise
    rejectReady = rejectPromise
  })
  const settle = error => {
    if (settled) return
    settled = true
    if (error === undefined) resolveReady()
    else rejectReady(error)
  }
  const failAll = error => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
    for (const waiter of waiterList.splice(0)) waiter.reject(error)
  }
  // The engine emits ready *before* the background root scan starts, so track
  // what the events say about the first scan: 'unknown' when the engine does
  // not report a scanning flag at all (then waiting would be guesswork),
  // 'scanning' or 'idle' otherwise. waitForInitialScan() also polls status in
  // case an event is missed.
  let initialScanState = 'unknown'
  const noteEngineEvent = (event, params) => {
    if (params === null || typeof params !== 'object') return
    if (event === 'scan') {
      if (params.phase === 'done') initialScanState = 'idle'
      else if (typeof params.phase === 'string' && initialScanState !== 'idle') initialScanState = 'scanning'
      return
    }
    if (event !== 'ready' && event !== 'stats') return
    if (params.scanning === false) initialScanState = 'idle'
    else if (params.scanning === true && initialScanState !== 'idle') initialScanState = 'scanning'
  }
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const text = line.trim()
    if (text === '') return
    let message
    try { message = JSON.parse(text) } catch { return }
    if (message === null || typeof message !== 'object') return
    if (typeof message.event === 'string') {
      noteEngineEvent(message.event, message.params)
      if (message.event === 'ready' || message.event === 'stats') settle(undefined)
      return
    }
    if (typeof message.id === 'number') {
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error !== undefined && message.error !== null) {
        entry.reject(new Error(String(message.error.message ?? message.error.code ?? 'engine request failed')))
      } else {
        entry.resolve(message.result)
      }
      return
    }
  })
  child.stderr.on('data', chunk => {
    if (stderr.length < 8_192) stderr += chunk.toString('utf8')
  })
  child.once('error', error => {
    settle(new CliError('engine-unavailable', 'cannot start the locator engine: ' + error.message, EXIT_UNAVAILABLE))
    failAll(new CliError('engine-unavailable', error.message, EXIT_UNAVAILABLE))
  })
  child.once('exit', (code, signal) => {
    const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)
    const error = new CliError('engine-unavailable', 'locator engine exited (code ' + String(code ?? signal) + ')' + (detail === '' ? '' : ': ' + detail), EXIT_UNAVAILABLE)
    settle(error)
    failAll(error)
  })
  const readyTimer = setTimeout(() => {
    settle(new CliError('engine-timeout', 'locator engine did not become ready in ' + String(settings.timeoutMs) + ' ms', EXIT_UNAVAILABLE))
  }, settings.timeoutMs)
  ready.then(() => { clearTimeout(readyTimer) }, () => { clearTimeout(readyTimer) })

  /**
   * One engine request after readiness.
   * @param method - RPC method name.
   * @param params - request payload.
   * @param timeoutMs - per-request timeout (defaults to the CLI timeout).
   */
  async function request(method, params = {}, timeoutMs = settings.timeoutMs) {
    await ready
    const id = nextId++
    return await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectPromise(new CliError('engine-timeout', 'engine request ' + method + ' timed out', EXIT_UNAVAILABLE))
      }, timeoutMs)
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
      try {
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        rejectPromise(new CliError('engine-unavailable', String(error && error.message ? error.message : error), EXIT_UNAVAILABLE))
      }
    })
  }

  /**
   * Wait until the engine's background initial scan has finished.
   *
   * A one-shot search sent right after `ready` can legitimately see zero
   * entries on a slow or cold filesystem (Windows/macOS CI runners are much
   * slower than a warm Linux tmpdir), so poll the `status` RPC until
   * `scanning` is false instead of trusting event timing. Resolves false on
   * timeout (the caller then returns a partial result plus a warning) and when
   * the engine dies (the search that follows reports the real failure).
   * @param timeoutMs - maximum wait; defaults to the configured scan timeout.
   * @returns true when the scan finished, false when the wait timed out/aborted.
   */
  async function waitForInitialScan(timeoutMs = settings.scanTimeoutMs ?? INITIAL_SCAN_TIMEOUT_MS) {
    try {
      await ready
    } catch {
      return false
    }
    // An engine that does not report a scanning flag cannot be waited for;
    // answer from whatever it returns instead of stalling every custom engine.
    if (initialScanState === 'idle' || initialScanState === 'unknown') return true
    const deadline = Date.now() + Math.max(0, timeoutMs)
    for (;;) {
      const remaining = deadline - Date.now()
      try {
        const status = await request('status', {}, Math.max(1, Math.min(SCAN_STATUS_PROBE_TIMEOUT_MS, remaining)))
        if (status === null || typeof status !== 'object' || status.scanning !== true) {
          initialScanState = 'idle'
          return true
        }
      } catch {
        return false
      }
      if (Date.now() >= deadline) return false
      await new Promise(resolvePromise => setTimeout(resolvePromise, INITIAL_SCAN_POLL_MS))
    }
  }

  /** Ask the engine to shut down and wait for the process to exit. */
  async function close() {
    if (child.exitCode !== null) return
    try { child.stdin.write(JSON.stringify({ id: 0, method: 'shutdown', params: {} }) + '\n') } catch { /* pipe already gone */ }
    await new Promise(resolvePromise => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        resolvePromise()
      }, 1_000)
      child.once('exit', () => { clearTimeout(timer); resolvePromise() })
    })
  }
  return { request, close, child, waitForInitialScan }
}

/** Build a canonical ref://file URI (mirrors src/refs.ts fileRef). */
export function fileRefOf(input) {
  const params = new URLSearchParams()
  params.set('path', input.path)
  if (typeof input.mtime === 'number' && Number.isFinite(input.mtime)) params.set('mtime', String(Math.trunc(input.mtime)))
  if (typeof input.size === 'number' && Number.isFinite(input.size)) params.set('size', String(Math.trunc(input.size)))
  if (typeof input.line === 'number' && Number.isInteger(input.line) && input.line > 0) params.set('line', String(input.line))
  return 'ref://file?' + params.toString()
}

/** Build the canonical dsh-session: URI for one session id (mirrors src/refs.ts). */
export function sessionRefOf(sessionId) {
  return 'dsh-session:' + Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')
}

/** Apply the additive output budget block to one page of hits (mirrors src/scope.ts). */
export function applyHitBudget(items, limitChars) {
  const limit = typeof limitChars === 'number' && Number.isFinite(limitChars) ? Math.trunc(limitChars) : 0
  if (limit <= 0) return { items: [...items], budget: { limitChars: limit, usedChars: 0, truncated: false, dropped: 0 } }
  const kept = []
  let used = 0
  for (const item of items) {
    const size = JSON.stringify(item)?.length ?? 0
    if (kept.length > 0 && used + size > limit) break
    kept.push(item)
    used += size
  }
  const dropped = items.length - kept.length
  return { items: kept, budget: { limitChars: limit, usedChars: used, truncated: dropped > 0 || used > limit, dropped } }
}

/** Add the citable ref / freshness / permissions fields AI clients expect. */
function decorateNameHit(hit, observedAt) {
  if (hit === null || typeof hit !== 'object') return hit
  const path = typeof hit.path === 'string' ? hit.path : ''
  if (path === '') return hit
  const mtime = typeof hit.mtime === 'number' && Number.isFinite(hit.mtime) ? hit.mtime : undefined
  const size = typeof hit.size === 'number' && Number.isFinite(hit.size) ? hit.size : undefined
  const decorated = { ...hit, kind: hit.dir === true ? 'dir' : 'file' }
  if (hit.dir !== true) decorated.ref = fileRefOf({ path, ...(mtime === undefined ? {} : { mtime }), ...(size === undefined ? {} : { size }) })
  decorated.freshness = { state: 'unknown', observedAt, ...(mtime === undefined ? {} : { mtime }) }
  decorated.refStatus = 'unknown'
  decorated.permissions = { read: 'allowed', visibility: 'roots', reason: 'name hits come from the configured index roots' }
  return decorated
}

/** Run a name search through a shared read-only engine session. */
export async function runNameSearch(settings, query, options = {}) {
  const limit = clampInt(options.limit, 1, MAX_SEARCH_LIMIT, 50)
  const offset = clampInt(options.offset, 0, 1_000_000, 0)
  const budgetChars = clampInt(options.budgetChars, 0, 10_000_000, DEFAULT_SEARCH_BUDGET_CHARS)
  const engine = options.engine ?? createEngineSession(settings)
  const ownsEngine = options.engine === undefined
  const started = Date.now()
  try {
    // Wait for the engine's first scan before querying. `ready` is emitted
    // before the scan starts, so an immediate search could return zero hits on
    // a slow/cold filesystem (observed on Windows and macOS CI runners). On
    // timeout the search still runs and the result carries a warning.
    const scanComplete = await engine.waitForInitialScan()
    const result = await engine.request('search', {
      query,
      limit,
      offset,
      sort: options.sort ?? 'name',
      desc: options.desc === true,
      regex: options.regex === true,
      case: options.caseSensitive === true,
      wholeWord: options.wholeWord === true,
      filesOnly: options.filesOnly === true,
      dirsOnly: options.dirsOnly === true,
    })
    const observedAt = Date.now()
    const hits = (Array.isArray(result.hits) ? result.hits : []).map(hit => decorateNameHit(hit, observedAt))
    const budgeted = applyHitBudget(hits, budgetChars)
    const lossy = budgeted.budget.dropped > 0
    const hasTotal = typeof result.total === 'number'
    const total = hasTotal ? result.total : hits.length
    const truncated = result.truncated === true || (hasTotal ? total > offset + hits.length : hits.length >= limit) || lossy
    const nextOffset = truncated ? offset + (lossy ? hits.length : budgeted.items.length) : undefined
    return {
      ok: true,
      command: 'search',
      mode: 'names',
      query,
      limit,
      offset: typeof result.offset === 'number' ? result.offset : offset,
      total,
      totalCount: total,
      returned: budgeted.items.length,
      truncated,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      budget: budgeted.budget,
      indexing: result.indexing === true || !scanComplete,
      ...(scanComplete ? {} : { warnings: ['initial-scan-incomplete'] }),
      tookMs: Date.now() - started,
      hits: budgeted.items,
    }
  } catch (error) {
    throw asCliError(error, 'name-search-failed')
  } finally {
    if (ownsEngine) await engine.close()
  }
}

/**
 * Open a SQLite database with the immutable URI, which tells SQLite the file
 * will not change and therefore forbids it from creating -wal/-shm side files
 * next to the caller's database. Returns a read-only connection.
 */
function openImmutableContent(path) {
  // A file: URL keeps spaces / '%' / '#' in the path safe; SQLite accepts the
  // URL when the URI filename flag is enabled (node:sqlite sets it).
  return new DatabaseSync(pathToFileURL(path).href + '?immutable=1', { readOnly: true })
}

/** Copy content.db (+ its WAL, if present) into a temporary read-only directory. */
function openCopiedContent(path) {
  let dir
  try {
    dir = mkdtempSync(join(tmpdir(), CONTENT_COPY_PREFIX))
    copyFileForReadOnly(path, join(dir, 'content.db'))
    const wal = path + '-wal'
    if (existsSync(wal)) {
      try { if (statSync(wal).size > 0) copyFileForReadOnly(wal, join(dir, 'content.db-wal')) } catch { /* a vanished WAL is not fatal */ }
    }
    const db = new DatabaseSync(join(dir, 'content.db'), { readOnly: true })
    db.prepare('SELECT count(*) AS n FROM docs').get()
    return {
      db,
      path,
      readOnly: 'copy',
      walIgnored: false,
      close: () => {
        try { db.close() } catch { /* already closed */ }
        try { rmSync(dir, { recursive: true, force: true, maxRetries: 2 }) } catch { /* best effort */ }
      },
    }
  } catch (error) {
    if (dir !== undefined) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 2 }) } catch { /* best effort */ }
    }
    throw error
  }
}

/**
 * Read-only handle to <state>/content.db with a schema sanity probe.
 *
 * The caller's content directory is never written: the primary path opens the
 * database through SQLite's immutable URI (no -wal/-shm side files), and the
 * fallback copies the database into a temporary directory for SQLite builds
 * that do not accept URI filenames. Callers must use the returned close().
 */
export function openContentDb(stateDir) {
  const path = join(stateDir, 'content.db')
  if (!existsSync(path)) {
    throw new CliError('content-index-missing', 'content index not found: ' + path + ' (run a content search once in DSH)', EXIT_UNAVAILABLE)
  }
  let walIgnored = false
  try {
    const wal = path + '-wal'
    walIgnored = existsSync(wal) && statSync(wal).size > 0
  } catch { walIgnored = false }
  try {
    const db = openImmutableContent(path)
    db.prepare('SELECT count(*) AS n FROM docs').get()
    return {
      db,
      path,
      readOnly: 'immutable',
      walIgnored,
      close: () => { try { db.close() } catch { /* already closed */ } },
    }
  } catch (immutableError) {
    try {
      return openCopiedContent(path)
    } catch (copyError) {
      const detail = error => String(error && error.message ? error.message : error)
      throw new CliError('content-index-unreadable', 'cannot read ' + path + ': ' + detail(immutableError) + ' / ' + detail(copyError), EXIT_UNAVAILABLE)
    }
  }
}

/** Split a content query into trigram terms, rejecting shorter ones. */
export function contentTerms(query) {
  const terms = query.trim().split(/\s+/).filter(term => term !== '').map(term => term.replace(/^"|"$/g, ''))
  if (terms.length === 0) throw new CliError('content-query-empty', 'content query is empty', EXIT_USAGE)
  const short = terms.filter(term => Array.from(term).length < 3)
  if (short.length > 0) {
    throw new CliError('content-query-too-short', 'content search needs terms of at least 3 characters (got: ' + short.join(', ') + ')', EXIT_USAGE)
  }
  return terms
}

/** Escape one term as an FTS5 quoted phrase. */
function quoteFts(term) {
  return '"' + term.replace(/"/g, '""') + '"'
}

/** First line number and a bounded snippet around the first term occurrence. */
function snippetOf(body, terms) {
  const hay = body.toLowerCase()
  let best = -1
  let bestLength = 0
  for (const term of terms) {
    const index = hay.indexOf(term.toLowerCase())
    if (index < 0) continue
    if (best === -1 || index < best) { best = index; bestLength = term.length }
  }
  if (best === -1) {
    const flat = body.replace(/\s+/g, ' ').trim()
    return { snippet: flat.length > 240 ? flat.slice(0, 239) + '…' : flat, line: 1 }
  }
  const start = Math.max(0, best - 80)
  const end = Math.min(body.length, best + bestLength + 120)
  const flat = body.slice(start, end).replace(/\s+/g, ' ')
  const snippet = (start > 0 ? '…' : '') + flat + (end < body.length ? '…' : '')
  let line = 1
  for (let index = 0; index < best; index++) if (body.charCodeAt(index) === 10) line++
  return { snippet: snippet.length > 320 ? snippet.slice(0, 319) + '…' : snippet, line }
}

/** Escape LIKE metacharacters so a root path matches literally. */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, character => '\\' + character)
}

/** Trim trailing separators, keeping filesystem roots like "/" or "C:\\" intact. */
function trimTrailingSeparators(value) {
  if (value === '/' || /^[A-Za-z]:[\\/]$/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+$/.test(value)) return value
  return value.replace(/[\\/]+$/, '')
}

/**
 * SQL prefilter for the configured roots. Paths are compared lexically here;
 * the canonical containment check (resolveWithinRoots) still runs on every
 * returned row, so this is a performance aid and never the trust boundary.
 */
function contentPathScope(roots) {
  const prefixes = new Set()
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') continue
    for (const candidate of [root, resolve(root)]) prefixes.add(candidate)
    const canonical = realPathOf(root)
    if (canonical !== undefined) prefixes.add(canonical.path)
  }
  const clauses = []
  const params = []
  for (const prefix of prefixes) {
    const base = trimTrailingSeparators(prefix)
    if (base === '') continue
    clauses.push('docs.path = ?')
    params.push(base)
    for (const suffix of new Set([sep, '/', '\\'])) {
      clauses.push("docs.path LIKE ? ESCAPE '\\'")
      params.push(escapeLike(base + suffix) + '%')
    }
  }
  return { sql: clauses.length === 0 ? '0' : '(' + clauses.join(' OR ') + ')', params }
}

/** Look up the workspace cwd recorded for one indexed session log (schema v4 sources). */
function sessionWorkspaceOf(db, path, cache) {
  if (cache.has(path)) return cache.get(path)
  let cwd
  try {
    const row = db.prepare('SELECT cwd FROM sources WHERE path = ?').get(path)
    if (row !== undefined && row !== null && typeof row.cwd === 'string' && row.cwd !== '') cwd = row.cwd
  } catch { cwd = undefined }
  cache.set(path, cwd)
  return cwd
}

/** Canonical roots/session boundary for one content hit. */
function contentHitAllowed(hit, settings, allowSessions, db, cwdCache) {
  if (typeof hit.path !== 'string' || hit.path === '') return false
  if (resolveWithinRoots(hit.path, settings.roots) === undefined) return false
  if (hit.kind !== 'session') return true
  if (!allowSessions) return false
  const cwd = sessionWorkspaceOf(db, hit.path, cwdCache)
  if (cwd !== undefined && resolveWithinRoots(cwd, settings.roots) === undefined) return false
  return true
}

/** Map one content.db row into a hit carrying the AI contract fields. */
function toContentHit(row, terms, observedAt) {
  const body = typeof row.body === 'string' ? row.body : ''
  const snippet = snippetOf(body, terms)
  const kind = row.kind === 'session' ? 'session' : 'file'
  const path = typeof row.path === 'string' ? row.path : ''
  const sessionId = typeof row.session_id === 'string' && row.session_id !== '' ? row.session_id : undefined
  const hit = {
    kind,
    path,
    ...(typeof row.title === 'string' && row.title !== '' ? { title: row.title } : {}),
    snippet: snippet.snippet,
    line: snippet.line,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(typeof row.message_id === 'string' && row.message_id !== '' ? { messageId: row.message_id } : {}),
  }
  if (path !== '') {
    hit.ref = kind === 'session' && sessionId !== undefined ? sessionRefOf(sessionId) : fileRefOf({ path, line: snippet.line })
    hit.freshness = { state: 'unknown', observedAt }
    hit.refStatus = 'unknown'
    hit.permissions = kind === 'session'
      ? { read: 'allowed', visibility: 'session', reason: 'session log is inside the configured roots' }
      : { read: 'allowed', visibility: 'roots', reason: 'file is inside the configured roots' }
  }
  return hit
}

/**
 * Run one body query against content.db (read-only, roots/session bounded).
 *
 * Trust boundary: file hits are restricted to the configured roots; session
 * documents are omitted by default and only returned with allowSessions plus a
 * canonical path check (and, when the database records it, a workspace cwd
 * check). The SQL prefilter is not the boundary: every returned row is checked
 * again through resolveWithinRoots.
 */
export function runContentSearch(settings, query, options = {}) {
  const terms = contentTerms(query)
  const limit = clampInt(options.limit, 1, MAX_SEARCH_LIMIT, 30)
  const offset = clampInt(options.offset, 0, 100_000, 0)
  const allowSessions = options.allowSessions === true
  const { db, path, close, walIgnored } = openContentDb(settings.stateDir)
  try {
    const match = terms.map(quoteFts).join(' AND ')
    const scope = contentPathScope(settings.roots)
    const where = 'WHERE docs MATCH ?' + (allowSessions ? '' : " AND docs.kind = 'file'") + (scope.sql === '0' ? ' AND 0' : ' AND ' + scope.sql)
    const rows = db.prepare(
      'SELECT rowid AS rowid, kind AS kind, path AS path, title AS title, body AS body, session_id AS session_id, message_id AS message_id FROM docs ' + where + ' ORDER BY rank LIMIT ? OFFSET ?',
    ).all(match, ...scope.params, limit, offset)
    const observedAt = Date.now()
    const cwdCache = new Map()
    const hits = []
    let scopeDropped = 0
    for (const row of rows) {
      const hit = toContentHit(row, terms, observedAt)
      if (!contentHitAllowed(hit, settings, allowSessions, db, cwdCache)) { scopeDropped++; continue }
      hits.push(hit)
    }
    let total
    if (options.countMode !== 'none') {
      try {
        total = Number(db.prepare('SELECT count(*) AS n FROM docs ' + where).get(match, ...scope.params).n)
      } catch {
        total = undefined
      }
    }
    const budgetChars = clampInt(options.budgetChars, 0, 10_000_000, 0)
    const budgeted = budgetChars > 0 ? applyHitBudget(hits, budgetChars) : { items: hits, budget: undefined }
    const lossy = scopeDropped > 0 || (budgeted.budget !== undefined && budgeted.budget.dropped > 0)
    const pageFull = rows.length >= limit
    const truncated = pageFull || lossy || (total !== undefined && total > offset + rows.length)
    const nextOffset = truncated ? offset + (lossy ? rows.length : budgeted.items.length) : undefined
    const warnings = []
    if (scopeDropped > 0) warnings.push('scope-filtered:' + String(scopeDropped))
    if (walIgnored === true) warnings.push('content-wal-not-visible')
    return {
      ok: true,
      command: 'content-search',
      mode: 'content',
      query,
      db: path,
      limit,
      offset,
      ...(total === undefined ? {} : { total }),
      returned: budgeted.items.length,
      truncated,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      ...(budgeted.budget === undefined ? {} : { budget: budgeted.budget }),
      ...(warnings.length === 0 ? {} : { warnings }),
      hits: budgeted.items,
    }
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError('content-query-failed', String(error && error.message ? error.message : error), EXIT_RUNTIME)
  } finally {
    close()
  }
}

/** Add surrounding source lines to file hits (find mode). */
export async function withContext(hits, contextLines) {
  if (contextLines <= 0) return hits
  return await Promise.all(hits.map(async hit => {
    if (hit.kind !== 'file' || typeof hit.line !== 'number') return hit
    try {
      const info = statSync(hit.path)
      if (!info.isFile() || info.size > 4 * 1024 * 1024) return hit
      const text = await readFile(hit.path, 'utf8')
      const all = text.split('\n')
      const center = Math.min(all.length, hit.line)
      const start = Math.max(1, center - contextLines)
      const end = Math.min(all.length, center + contextLines)
      return { ...hit, context: all.slice(start - 1, end).map(line => line.replace(/\r$/, '')), contextStart: start }
    } catch {
      return hit
    }
  }))
}

/** locator_find equivalent: body search plus context lines and the output budget. */
export async function runFindSearch(settings, query, options = {}) {
  const result = runContentSearch(settings, query, { ...options, budgetChars: 0 })
  const contextLines = clampInt(options.contextLines, 0, 10, 0)
  const hits = await withContext(result.hits, contextLines)
  const budgetChars = clampInt(options.budgetChars, 0, 10_000_000, DEFAULT_SEARCH_BUDGET_CHARS)
  const budgeted = applyHitBudget(hits, budgetChars)
  const lossy = budgeted.budget.dropped > 0
  const pageFull = result.hits.length >= result.limit
  const truncated = pageFull || lossy || (result.total !== undefined && result.total > result.offset + result.hits.length)
  const nextOffset = truncated ? result.offset + (lossy ? result.hits.length : budgeted.items.length) : undefined
  result.hits = budgeted.items
  result.returned = budgeted.items.length
  result.truncated = truncated
  result.budget = budgeted.budget
  if (nextOffset === undefined) delete result.nextOffset
  else result.nextOffset = nextOffset
  result.command = 'find'
  return result
}

/** Column names of one SQLite table, or an empty set when it does not exist. */
function tableColumns(db, table) {
  const names = new Set()
  try {
    for (const column of db.prepare('PRAGMA table_info(' + table + ')').all()) {
      if (column !== null && typeof column.name === 'string') names.add(column.name)
    }
  } catch { /* missing table */ }
  return names
}

/** Content-database counts with schema-v4 semantics (files / sessions / messages). */
function contentCounts(db) {
  const counts = { files: 0, sessions: 0, messages: 0 }
  const metaColumns = tableColumns(db, 'docs_meta')
  if (metaColumns.has('kind_id')) {
    for (const row of db.prepare('SELECT kind_id AS kindId, count(*) AS n FROM docs_meta GROUP BY kind_id').all()) {
      const kindId = Number(row.kindId)
      if (kindId === 0) counts.files = Number(row.n)
      else if (kindId === 1) counts.messages = Number(row.n)
    }
  } else {
    // Legacy pre-v4 database: the kind text lives on the docs row.
    for (const row of db.prepare('SELECT kind AS kind, count(*) AS n FROM docs GROUP BY kind').all()) {
      if (row.kind === 'file') counts.files = Number(row.n)
      else if (row.kind === 'session') counts.messages = Number(row.n)
    }
  }
  // v4 stores one sources row per indexed session log. A database written by
  // the plugin always has a sources row for every session document; a
  // hand-built or partially migrated database may not, so fall back to distinct
  // session ids only in that (empty-sources) case.
  try {
    counts.sessions = Number(db.prepare('SELECT count(*) AS n FROM sources').get().n)
  } catch { counts.sessions = 0 }
  if (counts.sessions === 0 && counts.messages > 0) {
    try {
      counts.sessions = Number(db.prepare("SELECT count(DISTINCT session_id) AS n FROM docs WHERE kind = 'session' AND session_id IS NOT NULL").get().n)
    } catch { /* keep the sources-derived zero */ }
  }
  return counts
}

/** Aggregate status: engine stats plus read-only content.db counts. */
export async function runStatus(settings, options = {}) {
  const session = options.engine ?? createEngineSession(settings)
  const ownsSession = options.engine === undefined
  const result = {
    ok: true,
    command: 'status',
    readOnly: true,
    roots: settings.roots,
    stateDir: settings.stateDir,
    binary: settings.binary,
    engine: { ok: false },
    content: { available: false },
    warnings: [],
  }
  try {
    try {
      const stats = await session.request('status')
      result.engine = {
        ok: true,
        readOnly: true,
        version: typeof stats.version === 'string' ? stats.version : '',
        platform: typeof stats.platform === 'string' ? stats.platform : '',
        entries: Number(stats.entries ?? 0),
        files: Number(stats.files ?? 0),
        dirs: Number(stats.dirs ?? 0),
        watching: stats.watching === true,
        scanning: stats.scanning === true,
        usn: stats.usn === true,
        stateDir: settings.stateDir,
      }
      if (Array.isArray(stats.roots) && stats.roots.length > 0) result.roots = stats.roots
      if (session.copiedFiles.length > 0) result.copiedStateFiles = session.copiedFiles
    } catch (error) {
      result.engine = { ok: false, error: error && error.code ? error.code + ': ' + error.message : String(error) }
      result.warnings.push('engine-unavailable')
    }
  } finally {
    if (ownsSession) {
      try { await session.close() } catch { /* already gone */ }
    }
  }
  try {
    if (!existsSync(join(settings.stateDir, 'content.db'))) {
      result.content = { available: false, reason: 'missing' }
    } else {
      const { db, close, readOnly, walIgnored } = openContentDb(settings.stateDir)
      try {
        const counts = contentCounts(db)
        let refs = 0
        try { refs = Number(db.prepare('SELECT count(*) AS n FROM refs').get().n) } catch { refs = 0 }
        result.content = { available: true, ...counts, refs, readOnly }
        if (walIgnored === true) result.warnings.push('content-wal-not-visible')
      } finally {
        close()
      }
    }
  } catch (error) {
    result.content = { available: false, reason: error && error.code ? error.code : 'unreadable' }
    result.warnings.push('content-index-unavailable')
  }
  return result
}

/** Canonical real path of a target or its nearest existing ancestor. */
export function realPathOf(target) {
  if (typeof target !== 'string' || target === '' || !isAbsolute(target)) return undefined
  const absolute = resolve(target)
  const missing = []
  let current = absolute
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return { path: missing.length === 0 ? real : join(real, ...missing.reverse()), exists: missing.length === 0 }
    } catch (error) {
      if (!(error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) return undefined
      const parent = dirname(current)
      if (parent === current) return undefined
      missing.push(basename(current))
      current = parent
    }
  }
}

/** Authorize one path against the configured roots on canonical paths. */
export function resolveWithinRoots(target, roots) {
  const real = realPathOf(target)
  if (real === undefined) return undefined
  for (const root of roots) {
    const canonical = realPathOf(root)
    if (canonical === undefined) continue
    const rel = relative(canonical.path, real.path)
    if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep) && !rel.startsWith('../'))) {
      return real
    }
  }
  return undefined
}

/** Decode a base64url JSON string (session ids in refs). */
function decodeBase64Json(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    return typeof parsed === 'string' && parsed !== '' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Parse any ref this release understands (mirrors src/refs.ts). */
export function parseRef(ref) {
  if (typeof ref !== 'string' || ref.trim() === '') return undefined
  const text = ref.trim()
  if (text.startsWith('dsh-session:')) {
    const sessionId = decodeBase64Json(text.slice('dsh-session:'.length))
    return sessionId === undefined ? undefined : { kind: 'session', ref: text, sessionId }
  }
  if (!text.startsWith('ref://')) return undefined
  let url
  try { url = new URL(text) } catch { return undefined }
  if (url.host === 'file') {
    const path = url.searchParams.get('path')
    if (path === null || path === '') return undefined
    const mtime = Number(url.searchParams.get('mtime') ?? '')
    const sha256 = url.searchParams.get('sha256') ?? undefined
    return { kind: 'file', ref: text, path, ...(Number.isFinite(mtime) && mtime > 0 ? { mtime: Math.trunc(mtime) } : {}), ...(sha256 ? { sha256 } : {}) }
  }
  if (url.host === 'url') {
    const target = url.searchParams.get('url') ?? url.searchParams.get('u')
    return target === null || target === '' ? undefined : { kind: 'url', ref: text, url: target }
  }
  if (url.host === 'session-event') {
    const sessionId = decodeBase64Json(url.searchParams.get('sid'))
    const seq = Number(url.searchParams.get('seq') ?? '')
    return sessionId === undefined || !Number.isInteger(seq) || seq < 0 ? undefined : { kind: 'session-event', ref: text, sessionId, seq }
  }
  if (url.host === 'spill') {
    const path = url.searchParams.get('path')
    if (path === null || path === '') return undefined
    const sessionId = decodeBase64Json(url.searchParams.get('sid'))
    return { kind: 'spill', ref: text, path, ...(sessionId === undefined ? {} : { sessionId }) }
  }
  if (url.host === 'attachment') {
    const sha256 = (url.searchParams.get('sha256') ?? '').toLowerCase()
    return /^[0-9a-f]{64}$/.test(sha256) ? { kind: 'attachment', ref: text, sha256 } : undefined
  }
  return undefined
}

/** Read the head of a file for an excerpt (bounded). */
async function readHead(path, maxBytes) {
  try {
    const info = statSync(path)
    if (!info.isFile()) return undefined
    const buffer = await readFile(path)
    return buffer.subarray(0, Math.min(maxBytes, buffer.length)).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Find the indexed log path for one session id.
 *
 * Schema v4 keeps one `sources` row per session log (the session id is the log
 * directory name); older databases are answered from the docs/docs_meta rows.
 * @returns the log path plus the mtime the index recorded, or undefined.
 */
function findSessionLog(db, sessionId) {
  try {
    for (const row of db.prepare('SELECT path, mtime FROM sources').all()) {
      if (typeof row.path !== 'string' || row.path === '') continue
      if (basename(dirname(row.path)) !== sessionId) continue
      return { path: row.path, ...(typeof row.mtime === 'number' ? { mtime: Math.trunc(row.mtime) } : {}) }
    }
  } catch { /* no sources table (legacy schema) */ }
  const metaColumns = tableColumns(db, 'docs_meta')
  try {
    if (metaColumns.has('path_id') && tableColumns(db, 'paths').has('path')) {
      const row = db.prepare('SELECT p.path AS path, m.mtime AS mtime FROM docs_meta m JOIN paths p ON p.id = m.path_id JOIN docs d ON d.rowid = m.rowid WHERE m.kind_id = 1 AND d.session_id = ? LIMIT 1').get(sessionId)
      if (row !== undefined && row !== null && typeof row.path === 'string') {
        return { path: row.path, ...(typeof row.mtime === 'number' ? { mtime: Math.trunc(row.mtime) } : {}) }
      }
    } else if (metaColumns.has('path')) {
      const row = db.prepare("SELECT m.path AS path, m.mtime AS mtime FROM docs_meta m JOIN docs d ON d.rowid = m.rowid WHERE d.kind = 'session' AND d.session_id = ? LIMIT 1").get(sessionId)
      if (row !== undefined && row !== null && typeof row.path === 'string') {
        return { path: row.path, ...(typeof row.mtime === 'number' ? { mtime: Math.trunc(row.mtime) } : {}) }
      }
    }
  } catch { /* fall through to the docs row */ }
  try {
    const row = db.prepare("SELECT path FROM docs WHERE kind = 'session' AND session_id = ? LIMIT 1").get(sessionId)
    if (row !== undefined && row !== null && typeof row.path === 'string' && row.path !== '') return { path: row.path }
  } catch { /* no usable docs row */ }
  return undefined
}

/** Resolve one evidence ref to metadata (read-only, roots-authorized). */
export async function resolveRef(settings, ref, options = {}) {
  const parsed = parseRef(ref)
  if (parsed === undefined) throw new CliError('invalid-ref', 'unsupported or malformed ref: ' + String(ref).slice(0, 120), EXIT_USAGE)
  const observedAt = Date.now()
  const mode = options.mode === 'excerpt' ? 'excerpt' : 'meta'
  const maxBytes = clampInt(options.maxBytes, 1, 65536, 2048)
  const denied = path => ({
    ok: false,
    ref: parsed.ref,
    kind: parsed.kind,
    error: 'content-path-denied',
    warnings: ['path-outside-roots'],
    permissions: { read: 'denied', visibility: 'roots', reason: 'path is outside every configured root' },
    path,
  })
  if (parsed.kind === 'file' || parsed.kind === 'spill') {
    const authorized = resolveWithinRoots(parsed.path, settings.roots)
    if (authorized === undefined) return denied(parsed.path)
    let info
    try { info = statSync(authorized.path) } catch { info = undefined }
    if (info === undefined) {
      return {
        ok: true,
        ref: parsed.ref,
        kind: parsed.kind,
        path: authorized.path,
        title: basename(authorized.path),
        freshness: { state: 'missing', observedAt },
        permissions: { read: 'allowed', visibility: 'roots', reason: 'path is inside the configured roots' },
        warnings: ['file-missing'],
      }
    }
    const hash = info.size <= 8 * 1024 * 1024
      ? createHash('sha256').update(await readFile(authorized.path)).digest('hex')
      : undefined
    const referenceMtime = typeof parsed.mtime === 'number' ? parsed.mtime : undefined
    const state = referenceMtime === undefined ? (parsed.sha256 !== undefined && hash !== undefined ? (hash === parsed.sha256 ? 'fresh' : 'stale') : 'fresh') : (Math.abs(info.mtimeMs - referenceMtime) < 1 ? 'fresh' : 'stale')
    const excerpt = mode === 'excerpt' ? await readHead(authorized.path, maxBytes) : undefined
    return {
      ok: true,
      ref: parsed.ref,
      kind: parsed.kind,
      path: authorized.path,
      title: basename(authorized.path),
      size: info.size,
      ...(hash === undefined ? {} : { hash }),
      freshness: { state, observedAt, mtime: Math.trunc(info.mtimeMs) },
      permissions: { read: 'allowed', visibility: 'roots', reason: 'path is inside the configured roots' },
      ...(excerpt === undefined ? {} : { excerpt }),
    }
  }
  if (parsed.kind === 'url') {
    return {
      ok: true,
      ref: parsed.ref,
      kind: 'url',
      title: parsed.url,
      provenance: { origin: 'web', url: parsed.url },
      freshness: { state: 'unknown', observedAt },
      permissions: { read: 'allowed', visibility: 'external', reason: 'external URL metadata; no network read' },
      warnings: ['url-not-fetched'],
    }
  }
  if (parsed.kind === 'session' || parsed.kind === 'session-event') {
    const sessionId = parsed.sessionId
    // Resolve the session log path from the read-only content database and
    // require it to live inside the allowed roots; no session body is exposed
    // without that containment.
    let sessionPath
    let indexedAt
    try {
      const { db, close } = openContentDb(settings.stateDir)
      try {
        const log = findSessionLog(db, sessionId)
        sessionPath = log === undefined ? undefined : log.path
        indexedAt = log === undefined ? undefined : log.mtime
      } finally {
        close()
      }
    } catch {
      sessionPath = undefined
    }
    if (sessionPath === undefined) {
      return {
        ok: false,
        ref: parsed.ref,
        kind: parsed.kind,
        error: 'content-index-unavailable',
        warnings: ['session-log-not-found'],
        permissions: { read: 'denied', visibility: 'session', reason: 'session log is not present in the local content index' },
      }
    }
    const authorized = resolveWithinRoots(sessionPath, settings.roots)
    if (authorized === undefined) {
      return {
        ok: false,
        ref: parsed.ref,
        kind: parsed.kind,
        error: 'content-scope-denied',
        warnings: ['session-outside-roots'],
        permissions: { read: 'denied', visibility: 'session', reason: 'session log is outside the configured roots' },
      }
    }
    let currentMtime
    try { currentMtime = statSync(authorized.path).mtimeMs } catch { currentMtime = undefined }
    const state = currentMtime === undefined ? 'missing' : indexedAt === undefined || Math.abs(currentMtime - indexedAt) < 1 ? 'fresh' : 'stale'
    return {
      ok: true,
      ref: parsed.ref,
      kind: parsed.kind,
      path: authorized.path,
      title: 'session ' + sessionId.slice(0, 12),
      ...(indexedAt === undefined ? {} : { provenance: { origin: 'index', sessionId, indexedAt: Math.trunc(indexedAt) } }),
      freshness: { state, observedAt, ...(currentMtime === undefined ? {} : { mtime: Math.trunc(currentMtime) }) },
      permissions: { read: 'allowed', visibility: 'session', reason: 'session log is inside the configured roots' },
      warnings: ['session-body-read-only'],
    }
  }
  // attachment: identity is a digest in the local attachment store.
  const home = process.env.DSH_HOME
  const root = join(home === undefined || home === '' ? join(homedir(), '.dsh') : home, 'attachments', 'v1')
  const prefix = parsed.sha256.slice(0, 2)
  for (const candidate of [join(root, 'objects', prefix, parsed.sha256), join(root, 'file-objects', prefix, parsed.sha256)]) {
    if (!existsSync(candidate)) continue
    if (resolveWithinRoots(candidate, settings.roots) === undefined) return denied(candidate)
    const info = statSync(candidate)
    return {
      ok: true,
      ref: parsed.ref,
      kind: 'attachment',
      path: candidate,
      title: 'attachment ' + parsed.sha256.slice(0, 12),
      size: info.size,
      freshness: { state: 'fresh', observedAt, mtime: Math.trunc(info.mtimeMs) },
      permissions: { read: 'allowed', visibility: 'roots', reason: 'attachment object is inside the configured roots' },
    }
  }
  throw new CliError('ref-not-found', 'no local object for ref: ' + parsed.ref, EXIT_UNAVAILABLE)
}

/** Render citations for one ref list (mirrors locator_cite). */
export function citeRefs(refs, format = 'markdown') {
  if (!Array.isArray(refs) || refs.length === 0) throw new CliError('usage', 'cite needs at least one ref', EXIT_USAGE)
  const citations = []
  for (const raw of refs.slice(0, 20)) {
    const parsed = parseRef(raw)
    if (parsed === undefined) throw new CliError('invalid-ref', 'unsupported or malformed ref: ' + String(raw).slice(0, 120), EXIT_USAGE)
    if (parsed.kind === 'session') {
      const label = 'session ' + parsed.sessionId.slice(0, 12)
      const mention = '@[' + label + '](' + parsed.ref + ')'
      citations.push({ ref: parsed.ref, kind: parsed.kind, label, markdown: mention, mention })
      continue
    }
    if (parsed.kind === 'url') {
      citations.push({ ref: parsed.ref, kind: parsed.kind, label: parsed.url, markdown: '[' + parsed.url + '](' + parsed.ref + ')' })
      continue
    }
    if (parsed.kind === 'attachment') {
      const label = 'attachment ' + parsed.sha256.slice(0, 12)
      citations.push({ ref: parsed.ref, kind: parsed.kind, label, markdown: '[' + label + '](' + parsed.ref + ')' })
      continue
    }
    const label = parsed.kind === 'session-event' ? 'session ' + parsed.sessionId.slice(0, 12) + ' event ' + String(parsed.seq) : basename(parsed.path)
    citations.push({ ref: parsed.ref, kind: parsed.kind, label, markdown: '[' + label + '](' + parsed.ref + ')' })
  }
  return { ok: true, command: 'cite', format, citations }
}

/* -------------------------------------------------------------------------- */
/* Agent error envelopes                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Map one legacy CLI/MCP error code (the historical dialect) onto the closed
 * 2026-11 code set. Unknown codes become "internal" so the envelope always
 * carries a declared code.
 */
export const LEGACY_ERROR_CODE_MAP = Object.freeze({
  usage: 'invalid-argument',
  'invalid-arguments': 'invalid-argument',
  'invalid-argument': 'invalid-argument',
  'query-invalid': 'query-invalid',
  'content-query-empty': 'query-too-short',
  'content-query-too-short': 'query-too-short',
  'query-too-short': 'query-too-short',
  'budget-too-small': 'budget-too-small',
  'cursor-invalid': 'cursor-invalid',
  'scope-denied': 'scope-denied',
  'content-path-denied': 'scope-denied',
  'content-scope-denied': 'scope-denied',
  'session-outside-roots': 'scope-denied',
  'scope-empty-workspace': 'scope-empty-workspace',
  'invalid-ref': 'invalid-argument',
  'ref-not-found': 'not-found',
  'not-found': 'not-found',
  'content-index-missing': 'index-unavailable',
  'content-index-unreadable': 'index-unavailable',
  'content-index-unavailable': 'index-unavailable',
  'engine-unavailable': 'index-unavailable',
  'engine-timeout': 'index-unavailable',
  'read-only-state-failed': 'index-unavailable',
  'index-unavailable': 'index-unavailable',
  'index-building': 'index-building',
  cancelled: 'cancelled',
  internal: 'internal',
})

/** Map one legacy dialect code onto the closed 12-code set. */
export function legacyCodeToAgentCode(code) {
  if (typeof code !== 'string' || code === '') return 'internal'
  return LEGACY_ERROR_CODE_MAP[code] ?? 'internal'
}

/** Build one structured agent error block with the per-code defaults. */
export function makeAgentErrorInfo(code, message, options = {}) {
  const known = AGENT_ERROR_CODE_LIST.includes(code) ? code : 'internal'
  const info = {
    code: known,
    message: typeof message === 'string' && message.trim() !== '' ? message : AGENT_ERROR_MESSAGES[known],
    retryable: options.retryable ?? AGENT_ERROR_RETRYABLE[known],
  }
  const remediation = options.remediation ?? AGENT_ERROR_REMEDIATION[known]
  if (typeof remediation === 'string' && remediation !== '') info.remediation = remediation
  const nextTools = options.nextTools ?? AGENT_ERROR_NEXT_TOOLS[known]
  if (Array.isArray(nextTools) && nextTools.length > 0) info.nextTools = [...nextTools]
  const details = { ...(isRecord(options.details) ? options.details : {}) }
  if (typeof options.legacyCode === 'string' && options.legacyCode !== '' && options.legacyCode !== known) {
    details.legacyCode = options.legacyCode
  }
  if (Object.keys(details).length > 0) info.details = details
  return info
}

/** One timing block for an agent envelope. */
export function makeAgentTiming(startedAt) {
  const started = typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : Date.now()
  return { tookMs: Math.max(0, Date.now() - started) }
}

/** Build the uniform 2026-11 success envelope. */
export function agentSuccessEnvelope(tool, fields, startedAt) {
  return { apiVersion: AGENT_API_VERSION, ok: true, tool, ...fields, timing: makeAgentTiming(startedAt) }
}

/** Build the uniform 2026-11 failure envelope. */
export function agentFailureEnvelope(tool, error, startedAt) {
  return { apiVersion: AGENT_API_VERSION, ok: false, tool, error, timing: makeAgentTiming(startedAt) }
}

/** Build a failure envelope directly from a code and message. */
export function agentFailure(tool, code, message, options = {}) {
  return agentFailureEnvelope(tool, makeAgentErrorInfo(code, message, options), options.startedAt)
}

/**
 * Convert one thrown failure (CliError or any Error) into the uniform failure
 * envelope, mapping the historical CLI dialect onto the closed 12-code set.
 */
export function agentFailureFromThrown(tool, error, startedAt) {
  const failure = asCliError(error, 'internal')
  const code = legacyCodeToAgentCode(failure.code)
  return agentFailureEnvelope(tool, makeAgentErrorInfo(code, failure.message, { legacyCode: failure.code }), startedAt)
}

/* -------------------------------------------------------------------------- */
/* Agent find: shared value helpers                                           */
/* -------------------------------------------------------------------------- */

/** Lower-case extension of a path without the dot (empty when none). */
function extensionOfPath(path) {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/** Whether a path lives under one prefix (separator-normalized). */
function underPathPrefix(path, prefix) {
  const normalizedPath = String(path).replace(/\\/g, '/')
  const normalizedPrefix = String(prefix).replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalizedPrefix === '') return false
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(normalizedPrefix + '/')
}

/**
 * Whether the query can be an exact symbol identifier (auto-mode probe).
 *
 * Aligned with the host 0.23 rule: a bare all-lowercase word (config, search,
 * read) is too common to be a symbol probe and must fall through to body/name,
 * so the query also needs an uppercase letter, a digit, an underscore or a $.
 */
function isIdentifierLike(query) {
  if (Array.from(query).length < 2) return false
  if (/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(query) === false) return false
  return /[A-Z0-9_$]/.test(query) || /\p{Lu}/u.test(query)
}

/** Whether the query has a term the trigram body index can serve (3+ chars). */
function hasBodyTerm(query) {
  return /[\p{L}\p{N}_]{3,}/u.test(query)
}

/** Parse an ISO-8601 time or an epoch-millisecond string; undefined when invalid. */
function parseModifiedAfter(value) {
  const text = value.trim()
  if (text === '') return undefined
  if (/^\d{10,16}$/.test(text)) {
    const numeric = Number(text)
    return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Read one path's size/mtime, memoized per tool call. */
async function fileMetadata(path, cache) {
  if (cache.has(path)) return cache.get(path)
  let value
  try {
    const info = await stat(path)
    value = { size: info.size, mtime: info.mtimeMs }
  } catch {
    value = undefined
  }
  cache.set(path, value)
  return value
}

/** Whether one row passes the where filters (size/mtime need metadata). */
function whereMatches(path, meta, where) {
  if (where.pathPrefix !== undefined && !underPathPrefix(path, where.pathPrefix)) return false
  if (where.ext !== undefined && where.ext.includes(extensionOfPath(path)) === false) return false
  if (where.minSize !== undefined && (meta === undefined || meta.size < where.minSize)) return false
  if (where.modifiedAfter !== undefined && (meta === undefined || meta.mtime < where.modifiedAfter)) return false
  return true
}

/** Whether a where filter needs on-disk size/mtime metadata. */
function whereNeedsStat(where) {
  return where.minSize !== undefined || where.modifiedAfter !== undefined
}

/* -------------------------------------------------------------------------- */
/* Agent items: detail projection and budget                                  */
/* -------------------------------------------------------------------------- */

/** Cut a snippet to the detail preset cap (code-point safe, appends an ellipsis). */
export function trimAgentSnippet(text, detail = 'compact') {
  const limit = detail === 'full' ? FULL_SNIPPET_CHARS : detail === 'standard' ? STANDARD_SNIPPET_CHARS : COMPACT_SNIPPET_CHARS
  const points = Array.from(text)
  if (points.length <= limit) return text
  return points.slice(0, limit - 1).join('') + '\u2026'
}

/** Project one item onto the detail preset's field set (never mutates the input). */
export function trimAgentItem(item, detail = 'compact') {
  const fields = detail === 'full' ? AGENT_FULL_ITEM_FIELDS : detail === 'standard' ? AGENT_STANDARD_ITEM_FIELDS : AGENT_COMPACT_ITEM_FIELDS
  const out = {}
  for (const field of fields) {
    const value = item[field]
    if (value === undefined) continue
    if (field === 'snippet' && typeof value === 'string') {
      out.snippet = trimAgentSnippet(value, detail)
      continue
    }
    if (Array.isArray(value) && value.length === 0) continue
    out[field] = value
  }
  return out
}

/** Serialized cost estimate of one trimmed item, in characters. */
export function estimateAgentItemChars(item) {
  const serialized = JSON.stringify(item)
  return serialized === undefined ? 0 : serialized.length
}

/** Trim an item list so its serialized items stay inside maxChars. */
export function applyAgentItemBudget(items, maxChars) {
  const limitChars = Number.isFinite(maxChars) ? Math.max(0, Math.trunc(maxChars)) : 0
  if (limitChars <= 0) {
    let used = 0
    for (const item of items) used += estimateAgentItemChars(item)
    return { items: [...items], budget: { limitChars: 0, usedChars: used, truncated: false, dropped: 0 }, dropped: 0 }
  }
  const kept = []
  let used = 0
  for (const item of items) {
    const size = estimateAgentItemChars(item)
    if (kept.length > 0 && used + size > limitChars) break
    kept.push(item)
    used += size
  }
  const dropped = items.length - kept.length
  return {
    items: kept,
    budget: { limitChars, usedChars: used, truncated: dropped > 0 || used > limitChars, dropped },
    dropped,
  }
}

/** Build one coverage note. */
function agentNote(code, message, severity = 'info') {
  return { code, message, severity }
}

/** Deduplicate coverage notes by (code, message), preserving order. */
function dedupeAgentNotes(notes) {
  const seen = new Set()
  const out = []
  for (const note of notes) {
    const key = note.code + '\u0000' + note.message
    if (seen.has(key)) continue
    seen.add(key)
    out.push(note)
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Agent find: data-layer sources                                             */
/* -------------------------------------------------------------------------- */

/** Persisted symbol-kind integer codes (schema v4), in on-disk order. */
const SYMBOL_KIND_BY_CODE = Object.freeze([
  'function', 'method', 'class', 'struct', 'interface', 'trait', 'enum', 'type',
  'constant', 'variable', 'module', 'namespace', 'heading', 'macro', 'property',
  'union', 'object', 'impl',
])
/** Persisted symbol-language integer codes (schema v4), in on-disk order. */
const SYMBOL_LANGUAGE_BY_CODE = Object.freeze([
  'go', 'typescript', 'javascript', 'python', 'rust', 'java', 'c', 'cpp',
  'csharp', 'php', 'ruby', 'kotlin', 'swift', 'markdown',
])
/** How many symbol rows one search may inspect (mirrors the host store cap). */
const AGENT_SYMBOL_MAX_MATCHES = 200

/** SQL prefilter for the configured roots on one arbitrary path column. */
function rootPathScope(roots, column) {
  const prefixes = new Set()
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') continue
    for (const candidate of [root, resolve(root)]) prefixes.add(candidate)
    const canonical = realPathOf(root)
    if (canonical !== undefined) prefixes.add(canonical.path)
  }
  const clauses = []
  const params = []
  for (const prefix of prefixes) {
    const base = trimTrailingSeparators(prefix)
    if (base === '') continue
    clauses.push(column + ' = ?')
    params.push(base)
    for (const suffix of new Set([sep, '/', '\\'])) {
      clauses.push(column + " LIKE ? ESCAPE '\\'")
      params.push(escapeLike(base + suffix) + '%')
    }
  }
  return { sql: clauses.length === 0 ? '0' : '(' + clauses.join(' OR ') + ')', params }
}

/** Build the one agent item for a name-index hit (mirrors the host builder). */
function agentNameItem(hit, query, observedAt, visibility) {
  const dir = hit.dir === true
  const item = {
    kind: dir ? 'dir' : 'file',
    path: hit.path,
    title: typeof hit.name === 'string' && hit.name !== '' ? hit.name : basename(hit.path),
    why: [nameWhy(query, String(hit.name ?? basename(hit.path)))],
    ...(typeof hit.size === 'number' ? { size: hit.size } : {}),
    ...(typeof hit.mtime === 'number' ? { mtime: hit.mtime } : {}),
    dir,
    refStatus: 'unknown',
    freshness: { state: 'unknown', observedAt, ...(typeof hit.mtime === 'number' ? { mtime: hit.mtime } : {}) },
    permissions: { read: 'allowed', visibility, reason: 'name hits come from the configured index roots' },
  }
  const extension = extensionOfPath(hit.path)
  if (extension !== '') item.ext = extension
  if (!dir) item.ref = fileRefOf({ path: hit.path, ...(typeof hit.mtime === 'number' ? { mtime: hit.mtime } : {}), ...(typeof hit.size === 'number' ? { size: hit.size } : {}) })
  if (hit.mtime !== undefined) item.modified = new Date(hit.mtime).toISOString()
  return item
}

/** Why one name row matched: prefix vs substring. */
function nameWhy(query, name) {
  const needle = query.trim().toLowerCase()
  return needle !== '' && name.toLowerCase().startsWith(needle) ? 'name:prefix' : 'name:substring'
}

/** Why one symbol row matched. */
function symbolWhy(query, name) {
  if (name === query) return 'symbol:exact'
  return name.toLowerCase().startsWith(query.toLowerCase()) ? 'symbol:prefix' : 'symbol:substring'
}

/** Build the one agent item for a content-index hit (mirrors the host builder). */
function agentBodyItem(hit, observedAt) {
  const kind = hit.kind === 'session' ? 'session' : 'file'
  const item = {
    kind,
    path: hit.path,
    title: typeof hit.title === 'string' && hit.title !== '' ? hit.title : basename(hit.path),
    why: ['body:terms'],
    ...(typeof hit.snippet === 'string' && hit.snippet !== '' ? { snippet: hit.snippet } : {}),
    ...(typeof hit.line === 'number' ? { line: hit.line } : {}),
    ...(typeof hit.ref === 'string' ? { ref: hit.ref } : {}),
    ...(typeof hit.refStatus === 'string' ? { refStatus: hit.refStatus } : {}),
    ...(isRecord(hit.freshness) ? { freshness: hit.freshness } : {}),
    ...(isRecord(hit.permissions) ? { permissions: hit.permissions } : {}),
    ...(typeof hit.sessionId === 'string' ? { sessionId: hit.sessionId } : {}),
    ...(typeof hit.messageId === 'string' ? { messageId: hit.messageId } : {}),
  }
  const extension = extensionOfPath(hit.path)
  if (extension !== '') item.ext = extension
  return item
}

/** Build the one agent item for a symbol row (mirrors the host builder). */
function agentSymbolItem(row, query) {
  const kind = typeof row.kind === 'number' && row.kind >= 0 && row.kind < SYMBOL_KIND_BY_CODE.length ? SYMBOL_KIND_BY_CODE[row.kind] : 'symbol'
  const language = typeof row.language === 'number' && row.language >= 0 && row.language < SYMBOL_LANGUAGE_BY_CODE.length ? SYMBOL_LANGUAGE_BY_CODE[row.language] : ''
  return {
    kind: 'symbol',
    path: row.path,
    title: row.name,
    name: row.name,
    line: row.line,
    why: [symbolWhy(query, row.name)],
    ...(language === '' ? {} : { language }),
    ...(typeof row.scope === 'string' && row.scope !== '' ? { symbolScope: row.scope } : {}),
    ref: fileRefOf({ path: row.path }),
  }
}

/** Fetch symbol rows matching a query, restricted to the configured roots. */
function fetchAgentSymbols(settings, query) {
  const { db, close } = openContentDb(settings.stateDir)
  try {
    const scope = rootPathScope(settings.roots, 'p.path')
    if (scope.sql === '0') return []
    const select = 'SELECT p.path AS path, s.name AS name, s.kind AS kind, s.line AS line, s.language AS language, s.scope AS scope FROM symbols s JOIN paths p ON p.id = s.path_id WHERE '
    const matches = []
    const seen = new Set()
    const collect = rows => {
      for (const row of rows) {
        if (typeof row.path !== 'string' || row.path === '') continue
        const key = row.path + '\u0000' + String(row.line) + '\u0000' + String(row.name)
        if (seen.has(key)) continue
        seen.add(key)
        matches.push({ path: row.path, name: String(row.name), kind: row.kind, line: Number(row.line), ...(row.language === null || row.language === undefined ? {} : { language: row.language }), ...(row.scope === null || row.scope === undefined ? {} : { scope: String(row.scope) }) })
        if (matches.length >= AGENT_SYMBOL_MAX_MATCHES) return
      }
    }
    collect(db.prepare(select + scope.sql + ' AND s.name = ? ORDER BY p.path, s.line LIMIT ?').all(...scope.params, query, AGENT_SYMBOL_MAX_MATCHES))
    if (matches.length < AGENT_SYMBOL_MAX_MATCHES) {
      collect(db.prepare(select + scope.sql + ' AND s.name > ? AND s.name < ? ORDER BY s.name, p.path, s.line LIMIT ?').all(...scope.params, query, query + '\uFFFF', AGENT_SYMBOL_MAX_MATCHES - matches.length))
    }
    if (matches.length < AGENT_SYMBOL_MAX_MATCHES) {
      const escaped = escapeLike(query)
      const candidateLimit = Math.max(AGENT_SYMBOL_MAX_MATCHES * 4, 200)
      const covering = db.prepare("SELECT rowid FROM symbols WHERE name LIKE ? ESCAPE '\\' LIMIT ?").all('%' + escaped + '%', candidateLimit)
      const rowids = []
      for (const row of covering) {
        const rowid = Number(row.rowid ?? 0)
        if (rowid > 0) rowids.push(rowid)
      }
      if (rowids.length > 0) {
        const placeholders = rowids.map(() => '?').join(', ')
        collect(db.prepare(select + scope.sql + ' AND s.rowid IN (' + placeholders + ')').all(...scope.params, ...rowids))
      }
    }
    return matches
  } finally {
    close()
  }
}

/**
 * Resolve the effective scope of one 2026-11 find request.
 *
 * workspace: the --cwd workspace when it is inside a configured root, else
 * every root with an explicit fallback note (host behaviour). roots/all: every
 * configured root (this files-only surface has no cross-workspace sessions).
 */
function resolveAgentScope(settings, requested) {
  if (requested !== 'workspace') return { effective: requested, fallback: false }
  const workspace = settings.workspace
  if (typeof workspace === 'string' && workspace !== '' && resolveWithinRoots(workspace, settings.roots) !== undefined) {
    return { effective: 'workspace', fallback: false }
  }
  return { effective: 'roots', fallback: true, fallbackReason: 'workspace-not-indexed; searched every configured root' }
}

/** Sources one normalized find request reads from, in priority order. */
function agentSourcesFor(request) {
  if (request.mode === 'name') return request.kinds.has('file') || request.kinds.has('dir') ? ['name'] : []
  if (request.mode === 'body') return request.kinds.has('file') ? ['body'] : []
  if (request.mode === 'symbol') return request.kinds.has('symbol') ? ['symbol'] : []
  const sources = []
  const onlySymbol = request.kinds.size === 1 && request.kinds.has('symbol')
  if (request.kinds.has('symbol') && (onlySymbol || isIdentifierLike(request.query))) sources.push('symbol')
  if (request.kinds.has('file') && hasBodyTerm(request.query)) sources.push('body')
  if (request.kinds.has('file') || request.kinds.has('dir')) sources.push('name')
  return sources
}

/** Project a raw source row into the agent item superset, or undefined when filtered. */
async function sourceItem(source, row, request, settings, observedAt, metaCache) {
  let item
  if (source === 'name') item = agentNameItem(row, request.query, observedAt, request.effectiveScope === 'workspace' ? 'workspace' : 'roots')
  else if (source === 'body') item = agentBodyItem(row, observedAt)
  else item = agentSymbolItem(row, request.query)
  if (item.kind === 'session') return undefined
  if (request.kinds.has(item.kind) === false) return undefined
  if (request.effectiveScope === 'workspace' && typeof settings.workspace === 'string' && settings.workspace !== '' && !underPathPrefix(item.path, settings.workspace)) return undefined
  const meta = source === 'name' && typeof row.size === 'number' && typeof row.mtime === 'number'
    ? { size: row.size, mtime: row.mtime }
    : whereNeedsStat(request.where) ? await fileMetadata(item.path, metaCache) : undefined
  if (!whereMatches(item.path, meta, request.where)) return undefined
  return item
}

/* -------------------------------------------------------------------------- */
/* Agent find: one page over a set of sources                                 */
/* -------------------------------------------------------------------------- */

/** Batch size one source fetch asks the data layer for. */
function agentFetchSize(request) {
  return Math.min(MAX_SEARCH_LIMIT, Math.max(request.limit * 3, 20))
}

/** Rank tier of one item (lower is better) for the cross-source merge. */
function agentItemTier(item) {
  const why = Array.isArray(item.why) ? item.why : []
  if (why.includes('symbol:exact')) return 0
  if (why.includes('body:terms')) return 1
  if (why.includes('symbol:prefix')) return 2
  if (why.includes('symbol:substring')) return 3
  if (why.includes('name:prefix')) return 4
  return 5
}

/** Compare two merge candidates; 0 keeps the current source order. */
function compareAgentCandidates(a, b) {
  const tierDiff = agentItemTier(a.item) - agentItemTier(b.item)
  if (tierDiff !== 0) return tierDiff
  const scoreA = typeof a.item.score === 'number' ? a.item.score : Number.MAX_SAFE_INTEGER
  const scoreB = typeof b.item.score === 'number' ? b.item.score : Number.MAX_SAFE_INTEGER
  if (scoreA !== scoreB) return scoreA - scoreB
  return 0
}

/** Dedupe key of one agent item (files merge across sources, symbols stay distinct). */
function agentItemKey(item) {
  if (item.kind === 'symbol') return 'symbol\u0000' + item.path + '\u0000' + String(item.line ?? '') + '\u0000' + String(item.title ?? '')
  return 'file\u0000' + item.path
}

/**
 * Fetch one batch from one source.
 * @returns {rows, rawCount, total, totalKind, exhausted, notes}
 */
async function fetchAgentSourceBatch(settings, request, source, offset, engine, metaCache, observedAt) {
  const batch = agentFetchSize(request)
  if (source === 'name') {
    const result = await runNameSearch(settings, request.query, {
      limit: batch,
      offset,
      sort: 'name',
      filesOnly: request.kinds.has('file') && request.kinds.has('dir') === false,
      dirsOnly: request.kinds.has('dir') && request.kinds.has('file') === false,
      engine,
      budgetChars: 0,
    })
    const rows = []
    for (const hit of result.hits) {
      const item = await sourceItem('name', hit, request, settings, observedAt, metaCache)
      if (item !== undefined) rows.push(item)
    }
    const total = typeof result.total === 'number' ? result.total : undefined
    const exhausted = result.hits.length < batch || (total !== undefined && offset + result.hits.length >= total)
    return { rows, rawCount: result.hits.length, total, totalKind: 'exact', exhausted, notes: result.indexing === true ? [agentNote('index-building', 'The name index is still scanning; this page is partial.', 'warn')] : [] }
  }
  if (source === 'body') {
    const result = runContentSearch(settings, request.query, {
      limit: batch,
      offset,
      allowSessions: false,
      budgetChars: 0,
      countMode: request.countMode,
    })
    const rows = []
    for (const hit of result.hits) {
      const item = await sourceItem('body', hit, request, settings, observedAt, metaCache)
      if (item !== undefined) rows.push(item)
    }
    const total = typeof result.total === 'number' ? result.total : undefined
    const notes = []
    if (Array.isArray(result.warnings)) for (const warning of result.warnings.slice(0, 4)) notes.push(agentNote('content-warning', warning, 'info'))
    // With count:'none' the data layer does not report a total; a full batch
    // means more rows may follow.
    const exhausted = result.hits.length < batch || (total !== undefined && offset + result.hits.length >= total)
    return { rows, rawCount: result.hits.length, total, totalKind: 'exact', exhausted, notes }
  }
  // Symbol source: the store caps one search at 200 rows, so the whole visible
  // list is fetched once and sliced by the caller.
  const matches = fetchAgentSymbols(settings, request.query)
  const rows = []
  for (const row of matches) {
    // The auto-mode symbol probe must not be hijacked by markdown headings.
    if (request.mode === 'auto' && row.kind === 12) continue
    const item = await sourceItem('symbol', row, request, settings, observedAt, metaCache)
    if (item !== undefined) rows.push(item)
  }
  const totalKind = matches.length >= AGENT_SYMBOL_MAX_MATCHES ? 'bounded' : 'exact'
  const notes = matches.length >= AGENT_SYMBOL_MAX_MATCHES
    ? [agentNote('symbol-cap', 'Symbol matches are capped at ' + String(AGENT_SYMBOL_MAX_MATCHES) + '; narrow the query for exact coverage.', 'info')]
    : []
  return { rows, rawCount: rows.length, total: rows.length, totalKind, exhausted: true, notes }
}

/**
 * Build one page of the 2026-11 find surface from the configured sources.
 * @returns the page fields (items, page, counts, coverage, budget) or a failure envelope.
 */
async function buildAgentFindPage(settings, request, sources, startOffsets, engine) {
  const startedAt = Date.now()
  const observedAt = Date.now()
  const metaCache = new Map()
  const notes = [...request.notes]
  const state = {}
  for (const source of sources) {
    state[source] = {
      offset: startOffsets[source] ?? 0,
      consumed: startOffsets[source] ?? 0,
      buffer: [],
      done: false,
      total: undefined,
      totalKind: 'unknown',
      rawFetched: 0,
    }
  }
  const pull = async source => {
    const current = state[source]
    if (current.done || current.buffer.length > 0) return
    let batch
    const fetchOffset = source === 'symbol' ? 0 : current.offset
    try {
      batch = await fetchAgentSourceBatch(settings, request, source, fetchOffset, engine, metaCache, observedAt)
    } catch (error) {
      if (request.mode === 'auto') {
        current.done = true
        current.total = undefined
        notes.push(agentNote('auto-' + source + '-unavailable', 'The ' + source + ' source is unavailable: ' + asCliError(error).message, 'warn'))
        return
      }
      throw error
    }
    current.buffer = batch.rows.map((item, index) => ({ item, pos: fetchOffset + index }))
    current.offset += batch.rawCount
    current.rawFetched += batch.rawCount
    current.total = batch.total
    current.totalKind = batch.totalKind
    for (const note of batch.notes) notes.push(note)
    if (batch.exhausted || batch.rawCount === 0) current.done = true
    // Symbol source is fetched whole; paging happens over the filtered list.
    if (source === 'symbol') {
      const wanted = startOffsets[source] ?? 0
      const available = current.buffer.length
      if (wanted > 0) current.buffer = current.buffer.slice(Math.min(wanted, available))
      current.consumed = Math.min(wanted, available)
      current.done = true
    }
  }
  const emitted = []
  const seen = new Map()
  let budgetDropped = []
  for (;;) {
    if (emitted.length >= request.limit) break
    let bestSource = undefined
    let best = undefined
    for (const source of sources) {
      const current = state[source]
      if (current.buffer.length === 0 && current.done === false) await pull(source)
      const candidate = current.buffer[0]
      if (candidate === undefined) continue
      if (best === undefined || compareAgentCandidates(candidate, best) < 0) {
        best = candidate
        bestSource = source
      }
    }
    if (best === undefined) break
    state[bestSource].buffer.shift()
    state[bestSource].consumed = best.pos + 1
    const key = agentItemKey(best.item)
    if (request.mode === 'auto') best.item.sources = [...new Set([...(best.item.sources ?? []), bestSource])]
    const existing = seen.get(key)
    if (existing !== undefined) {
      existing.item.why = [...new Set([...(existing.item.why ?? []), ...(best.item.why ?? [])])]
      existing.item.sources = [...new Set([...(existing.item.sources ?? []), ...(best.item.sources ?? []), bestSource])]
      if (existing.item.snippet === undefined && best.item.snippet !== undefined) {
        existing.item.snippet = best.item.snippet
        if (best.item.line !== undefined) existing.item.line = best.item.line
      }
      continue
    }
    seen.set(key, { item: best.item })
    emitted.push({ item: best.item, pos: best.pos, source: bestSource })
  }
  const resolvedSources = [...new Set(emitted.flatMap(entry => entry.item.sources ?? [entry.source]))]
  const trimmed = emitted.map(entry => ({ ...entry, trimmed: trimAgentItem(entry.item, request.detail) }))
  const budgeted = applyAgentItemBudget(trimmed.map(entry => entry.trimmed), request.maxChars)
  const kept = budgeted.items.length
  budgetDropped = trimmed.slice(kept)
  // Budget-deferred rows must not be lost: rewind the per-source cursor to the
  // first deferred row so the next page refetches it.
  for (const entry of budgetDropped) {
    const current = state[entry.source]
    if (current !== undefined) current.consumed = Math.min(current.consumed, entry.pos)
  }
  const items = budgeted.items
  let more = false
  if (budgetDropped.length > 0) more = true
  else if (emitted.length >= request.limit) {
    more = sources.some(source => {
      const current = state[source]
      return current.buffer.length > 0 || current.done === false
    })
  }
  const cursorOffsets = {}
  for (const source of sources) {
    const current = state[source]
    if (current === undefined) continue
    cursorOffsets[source] = current.consumed
  }
  // Host parity: auto pages issue cursor v2 (per-source offsets); single-source
  // modes keep issuing the 0.22-compatible v1 cursor. Both are accepted back.
  const nextCursor = more
    ? (request.mode === 'auto'
      ? encodeAgentCursor({ mode: 'auto', queryHash: request.queryHash, offsets: cursorOffsets, scope: request.effectiveScope, kinds: [...request.kinds].sort() })
      : encodeAgentCursorV1({ mode: request.mode, queryHash: request.queryHash, offset: cursorOffsets[sources[0]] ?? 0, scope: request.effectiveScope }))
    : undefined
  const counts = buildAgentFindCounts(request, state, sources, notes)
  const page = { limit: request.limit, returned: items.length, more, ...(nextCursor === undefined ? {} : { nextCursor }) }
  if (budgetDropped.length > 0) notes.push(agentNote('budget-truncated', String(budgetDropped.length) + ' item(s) deferred by maxChars; continue with page.nextCursor.', 'info'))
  if (items.length === 0) {
    notes.push(more
      ? agentNote('empty-page-more', 'This page is empty but more candidates exist; follow page.nextCursor.', 'info')
      : agentNote('no-matches', 'No matches for this query in the searched scope.', 'info'))
  }
  const indexing = notes.some(note => note.code === 'index-building')
  const coverage = { indexing, indexTruncated: notes.some(note => note.code === 'symbol-cap'), notes: dedupeAgentNotes(notes) }
  return { items, page, counts, coverage, budget: budgeted.budget, resolvedSources }
}

/** Build the counts block of one 2026-11 find page. */
function buildAgentFindCounts(request, state, sources, notes) {
  if (request.countMode === 'none') return {}
  const counts = {}
  let total = 0
  let totalKnown = true
  let totalKind = 'exact'
  for (const source of sources) {
    const current = state[source]
    if (current === undefined || current.total === undefined) { totalKnown = false; continue }
    if (source === 'name') counts.nameTotal = current.total
    else if (source === 'body') { counts.bodyTotal = current.total; counts.bodyKind = current.totalKind }
    else counts.symbolTotal = current.total
    total += current.total
    if (current.totalKind === 'bounded') totalKind = 'bounded'
  }
  if (request.countMode === 'bounded' && totalKind === 'exact') totalKind = 'bounded'
  if (totalKnown) { counts.total = total; counts.totalKind = totalKind }
  if (sources.length > 1 && request.countMode === 'exact') {
    notes.push(agentNote('counts-approximate', 'counts.total sums the per-source match counts (deduplicated rows are not subtracted).', 'info'))
    if (counts.totalKind === 'exact') counts.totalKind = 'bounded'
  }
  if (counts.total !== undefined && (request.where.pathPrefix !== undefined || request.where.ext !== undefined || request.where.modifiedAfter !== undefined || request.where.minSize !== undefined)) {
    notes.push(agentNote('counts-ignore-where', 'counts are the index match count; where filters are applied after counting.', 'info'))
  }
  return counts
}

/* -------------------------------------------------------------------------- */
/* Agent find: request validation and entry point                             */
/* -------------------------------------------------------------------------- */

/**
 * Validate one raw 2026-11 find argument object.
 * @returns {request} on success, {error} (an AgentErrorInfo) on failure.
 */
function validateAgentFindArgs(rawArgs, settings) {
  const raw = isRecord(rawArgs) ? rawArgs : {}
  const query = typeof raw.query === 'string' ? raw.query.trim() : ''
  if (query === '') return { error: makeAgentErrorInfo('invalid-argument', 'query is required and must be a non-empty string') }
  const queryLength = Array.from(query).length
  if (queryLength > 512) return { error: makeAgentErrorInfo('query-invalid', 'query is longer than 512 characters') }
  const mode = raw.mode === undefined ? 'auto' : AGENT_FIND_MODES.includes(raw.mode) ? raw.mode : undefined
  if (mode === undefined) return { error: makeAgentErrorInfo('invalid-argument', 'mode must be one of auto, name, body, symbol') }
  if ((mode === 'body' || mode === 'auto') && queryLength > 256) return { error: makeAgentErrorInfo('query-invalid', 'body queries are limited to 256 characters') }
  const scopeRequested = raw.scope === undefined ? 'workspace' : AGENT_SCOPE_MODES.includes(raw.scope) ? raw.scope : undefined
  if (scopeRequested === undefined) return { error: makeAgentErrorInfo('invalid-argument', 'scope must be one of workspace, roots, all') }
  const detail = raw.detail === undefined ? 'compact' : AGENT_DETAILS.includes(raw.detail) ? raw.detail : undefined
  if (detail === undefined) return { error: makeAgentErrorInfo('invalid-argument', 'detail must be one of compact, standard, full') }
  const countMode = raw.count === undefined ? 'exact' : AGENT_COUNT_MODES.includes(raw.count) ? raw.count : undefined
  if (countMode === undefined) return { error: makeAgentErrorInfo('invalid-argument', 'count must be one of exact, bounded, none') }
  const allKinds = [...AGENT_FIND_KINDS]
  let kinds = allKinds
  if (raw.kinds !== undefined) {
    if (Array.isArray(raw.kinds) === false) return { error: makeAgentErrorInfo('invalid-argument', 'kinds must be an array of file/dir/session/symbol') }
    const selected = []
    for (const entry of raw.kinds) {
      if (typeof entry !== 'string' || allKinds.includes(entry) === false) return { error: makeAgentErrorInfo('invalid-argument', 'kinds may only contain file, dir, session or symbol') }
      if (selected.includes(entry) === false) selected.push(entry)
    }
    if (selected.length === 0) return { error: makeAgentErrorInfo('invalid-argument', 'kinds must not be empty') }
    kinds = selected
  }
  if (kinds.includes('session')) {
    // This serialized read-only surface is files-only: session rows are never
    // returned, so drop the kind and say so in the coverage notes.
    kinds = kinds.filter(kind => kind !== 'session')
    if (kinds.length === 0) {
      return { error: makeAgentErrorInfo('invalid-argument', 'this files-only surface does not expose session rows; kinds must include file, dir or symbol', { remediation: 'Use the host locator_find for session evidence.' }) }
    }
  }
  const where = {}
  if (raw.where !== undefined) {
    if (isRecord(raw.where) === false) return { error: makeAgentErrorInfo('invalid-argument', 'where must be an object') }
    if (raw.where.pathPrefix !== undefined) {
      if (typeof raw.where.pathPrefix !== 'string' || raw.where.pathPrefix.trim() === '') return { error: makeAgentErrorInfo('invalid-argument', 'where.pathPrefix must be a non-empty directory path') }
      const prefix = resolve(raw.where.pathPrefix.trim())
      if (resolveWithinRoots(prefix, settings.roots) === undefined) return { error: makeAgentErrorInfo('scope-denied', 'where.pathPrefix is outside the configured index roots', { remediation: 'The path must be inside the configured index roots.' }) }
      where.pathPrefix = prefix
    }
    if (raw.where.ext !== undefined) {
      if (Array.isArray(raw.where.ext) === false) return { error: makeAgentErrorInfo('invalid-argument', 'where.ext must be an array of extensions') }
      const extensions = []
      for (const entry of raw.where.ext) {
        if (typeof entry !== 'string') return { error: makeAgentErrorInfo('invalid-argument', 'where.ext may only contain strings') }
        const extension = entry.trim().toLowerCase().replace(/^\./, '')
        if (extension !== '' && extensions.includes(extension) === false) extensions.push(extension)
      }
      if (extensions.length === 0) return { error: makeAgentErrorInfo('invalid-argument', 'where.ext must contain at least one extension') }
      extensions.sort()
      where.ext = extensions
    }
    if (raw.where.modifiedAfter !== undefined) {
      if (typeof raw.where.modifiedAfter !== 'string') return { error: makeAgentErrorInfo('invalid-argument', 'where.modifiedAfter must be an ISO-8601 time or epoch-millisecond string') }
      const modifiedAfter = parseModifiedAfter(raw.where.modifiedAfter)
      if (modifiedAfter === undefined) return { error: makeAgentErrorInfo('invalid-argument', 'where.modifiedAfter is not a valid ISO-8601 time or epoch-millisecond string') }
      where.modifiedAfter = modifiedAfter
    }
    if (raw.where.minSize !== undefined) {
      if (typeof raw.where.minSize !== 'number' || Number.isInteger(raw.where.minSize) === false || raw.where.minSize < 0) return { error: makeAgentErrorInfo('invalid-argument', 'where.minSize must be a non-negative integer') }
      where.minSize = raw.where.minSize
    }
  }
  if (raw.limit !== undefined && (typeof raw.limit !== 'number' || Number.isInteger(raw.limit) === false || raw.limit < 1)) {
    return { error: makeAgentErrorInfo('invalid-argument', 'limit must be an integer of at least 1') }
  }
  const limit = clampInt(raw.limit, 1, AGENT_MAX_LIMIT, AGENT_DEFAULT_LIMIT)
  const hasCursor = raw.cursor !== undefined
  const hasOffset = raw.offset !== undefined
  if (hasCursor) {
    if (typeof raw.cursor !== 'string' || raw.cursor.trim() === '') return { error: makeAgentErrorInfo('invalid-argument', 'cursor must be a non-empty opaque cursor string') }
    if (hasOffset) return { error: makeAgentErrorInfo('invalid-argument', 'cursor and offset are mutually exclusive') }
  }
  let offset
  if (hasOffset) {
    if (typeof raw.offset !== 'number' || Number.isInteger(raw.offset) === false || raw.offset < 0) return { error: makeAgentErrorInfo('invalid-argument', 'offset must be a non-negative integer') }
    offset = raw.offset
  }
  let maxChars = AGENT_DEFAULT_MAX_CHARS
  if (raw.maxChars !== undefined) {
    if (typeof raw.maxChars !== 'number' || Number.isInteger(raw.maxChars) === false || raw.maxChars < 0) return { error: makeAgentErrorInfo('invalid-argument', 'maxChars must be a non-negative integer (0 disables the budget)') }
    maxChars = raw.maxChars
  }
  if (maxChars > 0 && maxChars < AGENT_MIN_BUDGET_CHARS) {
    return { error: makeAgentErrorInfo('budget-too-small', 'maxChars is too small for one result item (minimum ' + String(AGENT_MIN_BUDGET_CHARS) + ')', { remediation: 'Raise maxChars to at least ' + String(AGENT_MIN_BUDGET_CHARS) + ' or use detail:"compact".' }) }
  }
  if (mode === 'symbol' && kinds.includes('symbol') === false) return { error: makeAgentErrorInfo('invalid-argument', 'mode symbol requires kinds to include symbol') }
  if (mode === 'body' && kinds.includes('file') === false) return { error: makeAgentErrorInfo('invalid-argument', 'mode body requires kinds to include file (session rows are not exposed)') }
  if (mode === 'name' && kinds.includes('file') === false && kinds.includes('dir') === false) return { error: makeAgentErrorInfo('invalid-argument', 'mode name requires kinds to include file or dir') }
  const includeArchived = raw.includeArchived === true
  const notes = []
  if (raw.includeArchived === true) notes.push(agentNote('include-archived-unsupported', 'includeArchived is accepted for host parity but this files-only surface has no archived session rows.', 'info'))
  if (Array.isArray(raw.kinds) && raw.kinds.includes('session')) notes.push(agentNote('session-hidden', 'Session rows are hidden on this files-only surface.', 'info'))
  return {
    request: { query, mode, kinds: new Set(kinds), where, scopeRequested, limit, detail, countMode, maxChars, includeArchived, notes, ...(offset === undefined ? {} : { offset }), ...(hasCursor ? { cursor: raw.cursor.trim() } : {}) },
  }
}

/**
 * Run one 2026-11 locator_find call against the read-only CLI data layer.
 * @param settings - resolved roots/state/binary/workspace.
 * @param rawArgs - raw tool arguments.
 * @param options - optional { engine } long-lived engine session.
 * @returns the success or failure envelope.
 */
export async function runAgentFind(settings, rawArgs, options = {}) {
  const startedAt = Date.now()
  const validated = validateAgentFindArgs(rawArgs, settings)
  if (validated.error !== undefined) return agentFailureEnvelope('locator_find', validated.error, startedAt)
  const request = validated.request
  const engine = options.engine ?? createEngineSession(settings)
  const ownsEngine = options.engine === undefined
  try {
    const scope = resolveAgentScope(settings, request.scopeRequested)
    request.effectiveScope = scope.effective
    const sources = agentSourcesFor(request)
    if (sources.length === 0) {
      return agentFailure('locator_find', 'invalid-argument', 'no data source can answer this mode/kinds/query combination', { startedAt, remediation: 'Pass kinds including file/dir for name search or symbol for symbol search.' })
    }
    if (request.mode === 'auto') {
      if (sources.includes('body') === false && request.kinds.has('file')) request.notes.push(agentNote('body-skipped', 'The query has no 3+ character term for the body index; searched names/symbols only.', 'info'))
      if (request.kinds.has('symbol') && isIdentifierLike(request.query) === false) request.notes.push(agentNote('symbol-skipped', 'The query is not identifier-shaped; skipped the symbol source.', 'info'))
      if (sources.length > 1) request.notes.push(agentNote('auto-cross-source', 'auto merged the ' + sources.join('/') + ' sources (simplified CLI merge; ranking may differ from the host locator_find).', 'info'))
    }
    const requestHash = queryHashOf({ query: request.query, mode: request.mode, scope: request.scopeRequested, kinds: [...request.kinds].sort(), where: request.where })
    request.queryHash = requestHash
    request.resolvedModeGuess = request.mode === 'auto' ? (sources.includes('body') ? 'body' : sources.includes('symbol') ? 'symbol' : 'name') : request.mode
    let startOffsets = {}
    if (request.cursor !== undefined) {
      const payload = decodeAgentCursor(request.cursor)
      if (payload === undefined || agentCursorMatches(payload, { queryHash: requestHash, mode: request.mode }) === false) {
        return agentFailure('locator_find', 'cursor-invalid', 'the cursor does not belong to this query, mode or scope', { startedAt })
      }
      if (payload.v === 1 && request.mode === 'auto') {
        return agentFailure('locator_find', 'cursor-invalid', 'v1 cursors belong to single-source modes; auto mode only issues v2 cursors', { startedAt })
      }
      if (payload.kinds !== undefined && [...payload.kinds].sort().join(',') !== [...request.kinds].sort().join(',')) {
        return agentFailure('locator_find', 'cursor-invalid', 'the cursor was issued for different kinds filters', { startedAt })
      }
      startOffsets = { ...payload.offsets }
    } else if (request.offset !== undefined) {
      if (request.mode === 'auto' && sources.length > 1) request.notes.push(agentNote('offset-approximate', 'offset applies to every source independently in cross-source auto mode; prefer page.nextCursor.', 'info'))
      for (const source of sources) startOffsets[source] = request.offset
    }
    const page = await buildAgentFindPage(settings, request, sources, startOffsets, engine)
    const contributing = Array.isArray(page.resolvedSources) ? page.resolvedSources : []
    const resolvedMode = request.mode === 'auto'
      ? (contributing.length === 0 ? request.resolvedModeGuess : contributing.length === 1 ? contributing[0] : 'mixed')
      : request.mode
    const scopeEcho = {
      requested: request.scopeRequested,
      effective: request.effectiveScope,
      fallback: scope.fallback,
      ...(scope.fallbackReason === undefined ? {} : { fallbackReason: scope.fallbackReason }),
    }
    if (scope.fallback) request.notes.push(agentNote('scope-fallback', scope.fallbackReason ?? 'searched every configured root', 'info'))
    return agentSuccessEnvelope('locator_find', {
      query: request.query,
      mode: request.mode,
      resolvedMode,
      detail: request.detail,
      scope: scopeEcho,
      items: page.items,
      page: page.page,
      counts: page.counts,
      coverage: page.coverage,
      budget: page.budget,
    }, startedAt)
  } catch (error) {
    return agentFailureFromThrown('locator_find', error, startedAt)
  } finally {
    if (ownsEngine) await engine.close()
  }
}

/* -------------------------------------------------------------------------- */
/* Agent read: 2026-11 locator_read over the CLI evidence layer               */
/* -------------------------------------------------------------------------- */

/** Hard cap on refs[] per call (the schema cap is advisory on model input). */
export const AGENT_READ_MAX_REFS = 20
/** Hard cap on window (lines added on each side of the target line). */
export const AGENT_READ_MAX_WINDOW = 20
/** Default and hard caps for one excerpt's text budget, in characters. */
export const AGENT_READ_DEFAULT_MAX_BYTES = 2_000
export const AGENT_READ_MAX_BYTES = 65_536
/** One line is never returned longer than this (mirrors locator_resolve). */
const AGENT_READ_MAX_LINE_CHARS = 65_536
/** Bytes one streamed read asks for at a time. */
const AGENT_READ_CHUNK_BYTES = 64 * 1024
/** Map one locator_resolve failure onto a declared agent error. */
function agentResolveFailure(resolved) {
  const legacyCode = typeof resolved.error === 'string' ? resolved.error : 'internal'
  const code = legacyCodeToAgentCode(legacyCode)
  const message = typeof resolved.message === 'string' && resolved.message !== ''
    ? resolved.message
    : code === 'scope-denied' ? 'the ref is not authorized for this read-only surface'
      : code === 'index-unavailable' ? 'the local content index is unavailable'
        : 'the evidence could not be resolved'
  return makeAgentErrorInfo(code, message, { legacyCode })
}

/** Copy one resolved evidence block into a 2026-11 read row. */
function agentReadItemFromResolved(resolved) {
  const freshness = isRecord(resolved.freshness) ? resolved.freshness : undefined
  const item = {
    ...(typeof resolved.ref === 'string' ? { ref: resolved.ref } : {}),
    ...(typeof resolved.kind === 'string' ? { kind: resolved.kind } : {}),
    ...(typeof resolved.title === 'string' ? { title: resolved.title } : {}),
    ...(typeof resolved.path === 'string' ? { path: resolved.path } : {}),
    ...(typeof resolved.size === 'number' ? { size: resolved.size } : {}),
    ...(typeof resolved.hash === 'string' ? { hash: resolved.hash } : {}),
    ...(freshness !== undefined && typeof freshness.state === 'string' ? { status: freshness.state === 'missing' ? 'missing' : freshness.state === 'stale' ? 'stale' : freshness.state === 'unknown' ? 'unknown' : 'fresh' } : {}),
    checkedAt: Date.now(),
    ...(freshness === undefined ? {} : { freshness }),
    ...(isRecord(resolved.permissions) ? { permissions: resolved.permissions } : {}),
    ...(isRecord(resolved.provenance) ? { provenance: resolved.provenance } : {}),
    ...(Array.isArray(resolved.warnings) && resolved.warnings.length > 0 ? { warnings: [...resolved.warnings] } : {}),
  }
  return item
}

/**
 * Read one bounded whole-line window around a target line by streaming the
 * file (mirrors src/agent-read.ts readLineWindow). The target line is always
 * present whole; neighbours are added only while they fit maxBytes.
 */
function readAgentLineWindow(path, center, window, maxBytes) {
  const start = Math.max(1, center - window)
  const end = center + window
  let fd
  try {
    fd = openSync(path, 'r')
  } catch {
    return { ok: false, reason: 'read-failed' }
  }
  const decoder = new StringDecoder('utf8')
  const buffer = Buffer.alloc(AGENT_READ_CHUNK_BYTES)
  const collected = new Map()
  let carry = ''
  let lineNo = 0
  let eof = false
  let slicedLine = false
  try {
    scan: for (;;) {
      let read = 0
      try {
        read = readSync(fd, buffer, 0, buffer.length, null)
      } catch {
        return { ok: false, reason: 'read-failed' }
      }
      if (read <= 0) { eof = true; break }
      const chunk = carry + decoder.write(buffer.subarray(0, read))
      const parts = chunk.split('\n')
      carry = parts.pop() ?? ''
      for (const raw of parts) {
        lineNo += 1
        if (lineNo >= start && lineNo <= end) {
          const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
          const capped = text.length > AGENT_READ_MAX_LINE_CHARS ? text.slice(0, AGENT_READ_MAX_LINE_CHARS) : text
          if (capped.length !== text.length) slicedLine = true
          collected.set(lineNo, capped)
        }
        if (lineNo >= end) break scan
      }
    }
    if (eof) {
      const tail = carry + decoder.end()
      if (tail !== '') {
        lineNo += 1
        if (lineNo >= start && lineNo <= end) {
          const text = tail.endsWith('\r') ? tail.slice(0, -1) : tail
          const capped = text.length > AGENT_READ_MAX_LINE_CHARS ? text.slice(0, AGENT_READ_MAX_LINE_CHARS) : text
          if (capped.length !== text.length) slicedLine = true
          collected.set(lineNo, capped)
        }
      }
    }
  } finally {
    closeSync(fd)
  }
  if (lineNo < center) return eof ? { ok: false, reason: 'line-out-of-range', lineCount: lineNo } : { ok: false, reason: 'line-out-of-range' }
  const centerLine = collected.get(center)
  if (centerLine === undefined) return { ok: false, reason: 'line-out-of-range', ...(eof ? { lineCount: lineNo } : {}) }
  const availableEnd = eof ? Math.min(end, lineNo) : end
  const requested = Math.max(1, availableEnd - start + 1)
  let startLine = center
  let endLine = center
  let bytes = centerLine.length
  const lines = [centerLine]
  for (let line = center + 1; line <= availableEnd; line++) {
    const text = collected.get(line)
    if (text === undefined) break
    if (bytes + 1 + text.length > maxBytes) break
    lines.push(text)
    endLine = line
    bytes += 1 + text.length
  }
  for (let line = center - 1; line >= start; line--) {
    const text = collected.get(line)
    if (text === undefined) break
    if (bytes + 1 + text.length > maxBytes) break
    lines.unshift(text)
    startLine = line
    bytes += 1 + text.length
  }
  const included = endLine - startLine + 1
  const dropped = Math.max(0, requested - included)
  const truncated = slicedLine || dropped > 0 || centerLine.length > maxBytes
  return {
    ok: true,
    window: {
      startLine,
      endLine,
      lines,
      dropped,
      truncated,
      ...(eof ? { lineCount: lineNo } : {}),
    },
  }
}

/** Markdown blockquote plus a citation link for one read row (quote mode). */
function agentQuoteMarkdown(lines, ref, fallback) {
  let link = '[' + basename(fallback ?? ref) + '](' + ref + ')'
  try {
    const cited = citeRefs([ref], 'markdown')
    const markdown = cited.citations?.[0]?.markdown
    if (typeof markdown === 'string' && markdown !== '') link = markdown
  } catch { /* fall back to the local link */ }
  return [lines.map(line => '> ' + line).join('\n'), link].join('\n\n')
}

/** Read one authorized file and shape one 2026-11 read row. */
function readAgentFile(resolved, target, mode, window, maxBytes) {
  if (resolved.status === 'missing') {
    return { error: makeAgentErrorInfo('not-found', 'evidence file is missing: ' + target.path, { legacyCode: 'ref-not-found', remediation: 'The file moved or was deleted after indexing; search again with locator_find.' }) }
  }
  const result = readAgentLineWindow(target.path, target.line, window, maxBytes)
  if (result.ok !== true) {
    if (result.reason === 'line-out-of-range') {
      return { error: makeAgentErrorInfo('not-found', 'line ' + String(target.line) + ' is beyond the end of the file' + (result.lineCount === undefined ? '' : ' (' + String(result.lineCount) + ' lines)'), { legacyCode: 'line-out-of-range', remediation: 'Use a line inside the file, or omit line to read from line 1.' }) }
    }
    return { error: makeAgentErrorInfo('internal', 'could not read the file', { retryable: false, remediation: 'The file may be unreadable; check its permissions.', details: { path: target.path } }) }
  }
  const found = result.window
  const warnings = [...(Array.isArray(resolved.warnings) ? resolved.warnings : [])]
  if (found.truncated && !warnings.includes('excerpt-truncated')) warnings.push('excerpt-truncated')
  const item = {
    ...agentReadItemFromResolved(resolved),
    ref: target.ref,
    path: target.path,
    line: target.line,
    startLine: found.startLine,
    endLine: found.endLine,
    ...(found.lineCount === undefined ? {} : { lineCount: found.lineCount }),
    excerpt: found.lines.join('\n'),
    ...(found.truncated ? { truncated: true } : {}),
    ...(warnings.length === 0 ? {} : { warnings }),
  }
  if (mode === 'quote') item.markdown = agentQuoteMarkdown(found.lines, target.ref, target.path)
  return { item, dropped: found.dropped }
}

/** Resolve and read one ref target (files-only surface). */
async function readAgentRef(settings, rawRef, mode, lineArg, window, maxBytes) {
  const ref = rawRef.trim()
  const parsed = parseRef(ref)
  if (parsed === undefined) {
    return { error: makeAgentErrorInfo('invalid-argument', 'unsupported or malformed ref: ' + ref.slice(0, 120), { legacyCode: 'invalid-ref', remediation: 'Pass a ref returned by locator_find (ref://file?... or dsh-session:...).' }) }
  }
  if (parsed.kind === 'session' || parsed.kind === 'session-event') {
    return { error: makeAgentErrorInfo('scope-denied', 'session refs are hidden on this files-only surface', { legacyCode: 'files-only-session', remediation: 'Use the host locator_read (or the legacy resolve command) for session evidence; this surface only exposes files under the configured roots.' }) }
  }
  if (parsed.kind === 'url' && mode !== 'meta') {
    return { error: makeAgentErrorInfo('invalid-argument', 'URL refs are metadata-only: they have no local content to excerpt', { legacyCode: 'url-meta-only', remediation: 'Use as: "meta" for a URL ref.' }) }
  }
  let resolved
  try {
    resolved = await resolveRef(settings, ref, { mode: mode === 'meta' ? 'meta' : 'meta' })
  } catch (error) {
    return { error: agentFailureFromThrown('locator_read', error, Date.now()).error }
  }
  if (resolved === null || typeof resolved !== 'object') return { error: makeAgentErrorInfo('internal', 'locator_resolve returned no value for this ref') }
  if (resolved.ok !== true) return { error: agentResolveFailure(resolved) }
  const base = agentReadItemFromResolved(resolved)
  if (mode === 'meta') return { item: base, dropped: 0 }
  if (parsed.kind === 'url') return { item: base, dropped: 0 }
  const path = typeof resolved.path === 'string' && resolved.path !== '' ? resolved.path : parsed.path
  if (typeof path !== 'string' || path === '') return { error: makeAgentErrorInfo('internal', 'file ref resolved without a path') }
  const line = lineArg ?? (typeof parsed.line === 'number' && parsed.line > 0 ? parsed.line : 1)
  return readAgentFile({ ...resolved, ...base }, { ref, path, line }, mode, window, maxBytes)
}

/** Authorize and read one workspace file path target. */
async function readAgentPath(settings, rawPath, mode, lineArg, window, maxBytes) {
  const input = rawPath.trim()
  const absolute = isAbsolute(input) ? input : resolve(process.cwd(), input)
  const authorized = resolveWithinRoots(absolute, settings.roots)
  if (authorized === undefined) {
    return { error: makeAgentErrorInfo('scope-denied', 'path is outside every indexed root: ' + input, { legacyCode: 'content-path-denied', remediation: 'Use an absolute path under one of the configured index roots (locator_status reports roots).' }) }
  }
  if (authorized.exists !== true) return { error: makeAgentErrorInfo('not-found', 'file does not exist: ' + authorized.path) }
  let info
  try {
    info = statSync(authorized.path)
  } catch {
    return { error: makeAgentErrorInfo('not-found', 'file could not be read: ' + authorized.path) }
  }
  if (info.isFile() !== true) return { error: makeAgentErrorInfo('invalid-argument', 'path is not a regular file: ' + authorized.path) }
  const line = lineArg ?? 1
  const ref = fileRefOf({ path: authorized.path, mtime: Math.trunc(info.mtimeMs), size: info.size, line })
  const observedAt = Date.now()
  const resolved = {
    ok: true,
    ref,
    kind: 'file',
    path: authorized.path,
    title: basename(authorized.path),
    size: info.size,
    freshness: { state: 'fresh', observedAt, mtime: Math.trunc(info.mtimeMs) },
    permissions: { read: 'allowed', visibility: 'roots', reason: 'path is inside the configured roots' },
  }
  if (mode === 'meta') return { item: agentReadItemFromResolved(resolved), dropped: 0 }
  return readAgentFile(resolved, { ref, path: authorized.path, line }, mode, window, maxBytes)
}

/**
 * Run one 2026-11 locator_read call.
 * @param settings - resolved roots/state.
 * @param rawArgs - raw tool arguments (ref | refs[] | path; as; line; window; maxBytes).
 * @returns the success or failure envelope.
 */
export async function runAgentRead(settings, rawArgs) {
  const startedAt = Date.now()
  const raw = isRecord(rawArgs) ? rawArgs : {}
  const mode = raw.as === 'meta' || raw.as === 'quote' ? raw.as : 'excerpt'
  const refArg = typeof raw.ref === 'string' ? raw.ref.trim() : ''
  const pathArg = typeof raw.path === 'string' ? raw.path.trim() : ''
  const refsArg = Array.isArray(raw.refs) ? raw.refs.map(ref => typeof ref === 'string' ? ref.trim() : '').filter(ref => ref !== '') : undefined
  const provided = (refArg === '' ? 0 : 1) + (refsArg === undefined ? 0 : 1) + (pathArg === '' ? 0 : 1)
  if (provided !== 1) {
    return agentFailure('locator_read', 'invalid-argument', 'provide exactly one of ref, refs[], or path', { startedAt, remediation: 'ref reads one ref, refs[] reads up to ' + String(AGENT_READ_MAX_REFS) + ', path reads a workspace file without a ref.' })
  }
  if (raw.window !== undefined && (typeof raw.window !== 'number' || Number.isInteger(raw.window) === false || raw.window < 0 || raw.window > AGENT_READ_MAX_WINDOW)) {
    return agentFailure('locator_read', 'invalid-argument', 'window must be an integer between 0 and ' + String(AGENT_READ_MAX_WINDOW), { startedAt })
  }
  if (raw.line !== undefined && (typeof raw.line !== 'number' || Number.isInteger(raw.line) === false || raw.line < 1)) {
    return agentFailure('locator_read', 'invalid-argument', 'line must be a positive integer', { startedAt })
  }
  const requestedMaxBytes = typeof raw.maxBytes === 'number' && Number.isFinite(raw.maxBytes) ? Math.trunc(raw.maxBytes) : AGENT_READ_DEFAULT_MAX_BYTES
  if (requestedMaxBytes < 1) return agentFailure('locator_read', 'invalid-argument', 'maxBytes must be a positive integer', { startedAt })
  const maxBytes = Math.min(AGENT_READ_MAX_BYTES, requestedMaxBytes)
  const window = raw.window ?? 0
  const targets = refsArg === undefined
    ? [refArg === '' ? { kind: 'path', path: pathArg } : { kind: 'ref', ref: refArg }]
    : refsArg.map(ref => ({ kind: 'ref', ref }))
  if (targets.length === 0) return agentFailure('locator_read', 'invalid-argument', 'refs must contain 1-' + String(AGENT_READ_MAX_REFS) + ' refs', { startedAt })
  if (targets.length > AGENT_READ_MAX_REFS) return agentFailure('locator_read', 'invalid-argument', 'too many refs: ' + String(targets.length) + ' (at most ' + String(AGENT_READ_MAX_REFS) + ')', { startedAt, remediation: 'Split the batch; locator_find returns refs in pages.' })
  // Collapse duplicate ref strings before reading (host parity): counts.duplicates
  // reports how many were folded away.
  const seenRefs = new Set()
  const uniqueTargets = []
  let duplicates = 0
  for (const target of targets) {
    if (target.kind === 'ref') {
      if (seenRefs.has(target.ref)) { duplicates += 1; continue }
      seenRefs.add(target.ref)
    }
    uniqueTargets.push(target)
  }
  const outcomes = []
  for (const target of uniqueTargets) {
    outcomes.push(target.kind === 'ref'
      ? await readAgentRef(settings, target.ref, mode, raw.line, window, maxBytes)
      : await readAgentPath(settings, target.path, mode, raw.line, window, maxBytes))
  }
  const failed = outcomes.filter(outcome => outcome.error !== undefined)
  const single = refsArg === undefined
  if (single && failed.length === 1) {
    return agentFailureEnvelope('locator_read', failed[0].error, startedAt)
  }
  if (failed.length === outcomes.length && outcomes.length > 0) {
    const first = failed[0].error
    return agentFailureEnvelope('locator_read', makeAgentErrorInfo(first.code, String(failed.length) + '/' + String(outcomes.length) + ' targets failed; first error: ' + first.message, {
      retryable: first.retryable,
      ...(first.remediation === undefined ? {} : { remediation: first.remediation }),
      details: { codes: failed.map(outcome => outcome.error.code) },
    }), startedAt)
  }
  const items = outcomes.map((outcome, index) => {
    if (outcome.error === undefined) return outcome.item
    const target = uniqueTargets[index]
    return {
      ...(target?.kind === 'ref' ? { ref: target.ref } : { path: target?.path }),
      error: outcome.error,
    }
  })
  const dropped = outcomes.reduce((total, outcome) => total + (outcome.error === undefined ? (outcome.dropped ?? 0) : 0), 0)
  let usedChars = 0
  for (const item of items) usedChars += (item.excerpt?.length ?? 0) + (item.markdown?.length ?? 0)
  return agentSuccessEnvelope('locator_read', {
    items,
    counts: {
      requested: uniqueTargets.length,
      returned: outcomes.length - failed.length,
      failed: failed.length,
      duplicates,
      linesDropped: dropped,
    },
    budget: {
      limitChars: maxBytes * Math.max(1, outcomes.length),
      usedChars,
      truncated: dropped > 0 || items.some(item => item.truncated === true),
      dropped,
    },
    limits: {
      perExcerptChars: maxBytes,
      batchLimitChars: maxBytes * Math.max(1, outcomes.length),
      maxChars: AGENT_READ_MAX_BYTES,
      maxRefs: AGENT_READ_MAX_REFS,
    },
  }, startedAt)
}

/* -------------------------------------------------------------------------- */
/* Agent status: 2026-11 locator_status                                       */
/* -------------------------------------------------------------------------- */

/** Serialized size target of the brief status payload (host parity). */
export const AGENT_STATUS_BRIEF_MAX_CHARS = 600

/** Finite non-negative integer copy of one optional counter. */
function agentCountOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

/** Build the one-line status summary shared by brief and full. */
function agentStatusSummary(legacy) {
  const engine = legacy.engine ?? {}
  const content = legacy.content ?? {}
  const parts = []
  parts.push(engine.ok === true ? 'engine running' : 'engine stopped')
  parts.push(String(agentCountOf(engine.entries)) + ' entries (' + String(agentCountOf(engine.files)) + ' files / ' + String(agentCountOf(engine.dirs)) + ' dirs)')
  parts.push(engine.watching === true ? 'watcher active' : 'watcher inactive')
  parts.push('roots ' + String(Array.isArray(legacy.roots) ? legacy.roots.length : 0))
  if (engine.scanning === true) parts.push('scanning')
  parts.push(content.available === true ? 'content ' + String(agentCountOf(content.files)) + ' files / ' + String(agentCountOf(content.messages)) + ' messages' : 'content off')
  return parts.join(' \u00b7 ')
}

/**
 * Run one 2026-11 locator_status call (brief or full).
 * @param settings - resolved roots/state/binary.
 * @param rawArgs - raw tool arguments ({ detail }).
 * @param options - optional { engine } long-lived engine session.
 * @returns the success or failure envelope.
 */
export async function runAgentStatus(settings, rawArgs, options = {}) {
  const startedAt = Date.now()
  const raw = isRecord(rawArgs) ? rawArgs : {}
  const detail = raw.detail === 'full' ? 'full' : raw.detail === undefined || raw.detail === 'brief' ? 'brief' : undefined
  if (detail === undefined) return agentFailure('locator_status', 'invalid-argument', 'detail must be brief or full', { startedAt })
  let legacy
  try {
    legacy = await runStatus(settings, options)
  } catch (error) {
    return agentFailureFromThrown('locator_status', error, startedAt)
  }
  const engine = legacy.engine ?? {}
  if (engine.ok !== true) {
    const cause = typeof engine.error === 'string' ? engine.error : 'the locator engine is unavailable'
    return agentFailure('locator_status', 'index-unavailable', cause, {
      startedAt,
      retryable: true,
      remediation: 'The engine may still be starting: retry once, then check the index state.',
      nextTools: [],
      details: { legacyCode: 'engine-unavailable' },
    })
  }
  const content = legacy.content ?? {}
  const summary = agentStatusSummary(legacy)
  const allRoots = Array.isArray(legacy.roots) ? legacy.roots.filter(root => typeof root === 'string') : []
  const warnings = Array.isArray(legacy.warnings) ? legacy.warnings.filter(warning => typeof warning === 'string') : []
  const warningText = warnings.length === 0 ? undefined : warnings.join(', ')
  const briefTruncated = []
  const roots = allRoots.slice(0, 8)
  if (allRoots.length > roots.length) briefTruncated.push('roots')
  let warning = warningText
  if (warning !== undefined && warning.length > 240) {
    warning = warning.slice(0, 239) + '\u2026'
    briefTruncated.push('warning')
  }
  if (detail === 'full') {
    return agentSuccessEnvelope('locator_status', { detail: 'full', summary, status: legacy }, startedAt)
  }
  const engineVersion = typeof engine.version === 'string' && engine.version !== '' ? engine.version : undefined
  const generation = typeof engine.generation === 'number' && Number.isInteger(engine.generation) && engine.generation > 0 ? engine.generation : undefined
  return agentSuccessEnvelope('locator_status', {
    detail: 'brief',
    summary,
    index: {
      running: engine.ok === true,
      entries: agentCountOf(engine.entries),
      files: agentCountOf(engine.files),
      dirs: agentCountOf(engine.dirs),
      watching: engine.watching === true,
      scanning: engine.scanning === true,
      roots: allRoots.length,
    },
    content: {
      enabled: content.available === true,
      building: false,
      truncated: content.truncated === true,
      files: agentCountOf(content.files),
      sessions: agentCountOf(content.sessions),
      messages: agentCountOf(content.messages),
    },
    scope: {
      activeRules: 0,
      outputBudgetChars: DEFAULT_SEARCH_BUDGET_CHARS,
      rerank: false,
      ocr: false,
    },
    ...(roots.length === 0 ? {} : { roots }),
    ...(warning === undefined ? {} : { warning }),
    ...(engineVersion === undefined ? {} : { engineVersion }),
    ...(generation === undefined ? {} : { generation }),
    ...(briefTruncated.length === 0 ? {} : { truncated: briefTruncated }),
  }, startedAt)
}

/* -------------------------------------------------------------------------- */
/* Agent text rendering (MCP text content and CLI human text)                 */
/* -------------------------------------------------------------------------- */

/** Render one 2026-11 envelope as a compact human-readable summary. */
export function renderAgentText(envelope) {
  if (envelope === null || typeof envelope !== 'object') return String(envelope)
  const name = typeof envelope.tool === 'string' ? envelope.tool : 'locator'
  if (envelope.ok !== true) {
    const error = envelope.error ?? {}
    const lines = [name + ' failed: ' + String(error.code ?? 'internal') + ': ' + String(error.message ?? 'unknown error')]
    if (typeof error.remediation === 'string') lines.push('  \u2192 ' + error.remediation)
    return lines.join('\n')
  }
  if (name === 'locator_find') {
    const page = envelope.page ?? {}
    const counts = envelope.counts ?? {}
    const lines = [name + ': ' + String(page.returned ?? 0) + ' item(s)' + (counts.total === undefined ? '' : ' of ' + String(counts.total)) + ' \u00b7 mode ' + String(envelope.resolvedMode ?? envelope.mode ?? '') + ' \u00b7 scope ' + String(envelope.scope?.effective ?? '') + (page.more ? ' (more)' : '')]
    for (const item of envelope.items ?? []) {
      const location = item.kind === 'symbol' ? item.path + ':' + String(item.line ?? '') : item.kind === 'dir' ? item.path + '/' : item.path
      lines.push('[' + item.kind + '] ' + location + (item.title === undefined || item.title === basename(item.path) ? '' : ' \u2014 ' + item.title) + (item.snippet === undefined ? '' : ' \u2014 ' + item.snippet))
      if (item.ref !== undefined) lines.push('  ref ' + item.ref)
    }
    for (const note of envelope.coverage?.notes ?? []) lines.push('note ' + note.code + ': ' + note.message)
    return lines.join('\n')
  }
  if (name === 'locator_read') {
    const counts = envelope.counts ?? {}
    const header = name + ': ' + String(counts.returned ?? 0) + ' item(s)' + (counts.failed === 0 || counts.failed === undefined ? '' : ', ' + String(counts.failed) + ' failed') + (envelope.budget?.truncated === true ? ' (truncated)' : '')
    const blocks = [header]
    let index = 0
    for (const item of envelope.items ?? []) {
      index += 1
      if (item.error !== undefined) {
        blocks.push(String(index) + '. [' + String(item.ref ?? item.path ?? 'target') + '] ' + item.error.code + ': ' + item.error.message + (item.error.remediation === undefined ? '' : '\n   \u2192 ' + item.error.remediation))
        continue
      }
      const location = item.startLine === undefined || item.endLine === undefined
        ? item.line === undefined ? '' : ' (line ' + String(item.line) + ')'
        : ' (lines ' + String(item.startLine) + '-' + String(item.endLine) + ')'
      blocks.push(String(index) + '. [' + String(item.kind ?? 'ref') + '] ' + String(item.title ?? item.path ?? item.ref ?? '') + location + (item.status === undefined ? '' : ' \u00b7 ' + item.status))
      if (item.ref !== undefined) blocks.push('   ref ' + item.ref)
      if (typeof item.markdown === 'string') blocks.push('', item.markdown)
      else if (typeof item.excerpt === 'string') {
        blocks.push('   ---')
        for (const line of item.excerpt.split('\n')) blocks.push('   ' + line)
      }
      if (Array.isArray(item.warnings) && item.warnings.length > 0) blocks.push('   warnings: ' + item.warnings.join(', '))
    }
    if (envelope.budget !== undefined) blocks.push('(budget: ' + String(envelope.budget.usedChars) + '/' + String(envelope.budget.limitChars) + ' chars' + (envelope.budget.dropped === 0 ? '' : ', ' + String(envelope.budget.dropped) + ' line(s) dropped') + ')')
    return blocks.join('\n')
  }
  if (name === 'locator_status') {
    const summary = typeof envelope.summary === 'string' ? envelope.summary : ''
    if (envelope.detail === 'full') return name + ' (full): ' + summary + '\n' + JSON.stringify(envelope.status, null, 2)
    return name + ' (brief): ' + summary
  }
  return JSON.stringify(envelope)
}

/* -------------------------------------------------------------------------- */
/* CLI: --api=2026-11 command runner                                          */
/* -------------------------------------------------------------------------- */

/** Parse one JSON object flag (e.g. --where). Throws a usage CliError. */
function parseJsonFlag(value, flagName) {
  if (value === undefined) return undefined
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new CliError('usage', flagName + ' must be valid JSON object', EXIT_USAGE)
  }
  if (isRecord(parsed) === false) throw new CliError('usage', flagName + ' must be a JSON object', EXIT_USAGE)
  return parsed
}

/** Split one comma-separated flag value into trimmed non-empty parts. */
function parseListFlag(value) {
  if (value === undefined) return undefined
  return String(value).split(',').map(part => part.trim()).filter(part => part !== '')
}

/**
 * Run one CLI command in the versioned 2026-11 output mode.
 * Always returns a uniform envelope (never throws for tool-level failures).
 */
export async function runAgentApiCommand(parsed, env = process.env) {
  const startedAt = Date.now()
  const settings = settingsFromFlags(parsed.flags, env)
  const tool = parsed.command === 'read' ? 'locator_read' : parsed.command === 'status' ? 'locator_status' : 'locator_find'
  if (parsed.command === 'find') {
    const query = parsed.positional.join(' ').trim()
    let where
    try {
      where = parseJsonFlag(parsed.flags.where, '--where')
    } catch (error) {
      const failure = asCliError(error, 'usage')
      return agentFailureEnvelope('locator_find', makeAgentErrorInfo('invalid-argument', failure.message, { legacyCode: failure.code }), startedAt)
    }
    return await runAgentFind(settings, {
      query,
      ...(parsed.flags.mode === undefined ? {} : { mode: parsed.flags.mode }),
      ...(parsed.flags.kinds === undefined ? {} : { kinds: parseListFlag(parsed.flags.kinds) }),
      ...(where === undefined ? {} : { where }),
      ...(parsed.flags.scope === undefined ? {} : { scope: parsed.flags.scope }),
      ...(parsed.flags.limit === undefined ? {} : { limit: parsed.flags.limit }),
      ...(parsed.flags.offset === undefined ? {} : { offset: parsed.flags.offset }),
      ...(parsed.flags.cursor === undefined ? {} : { cursor: parsed.flags.cursor }),
      ...(parsed.flags.detail === undefined ? {} : { detail: parsed.flags.detail }),
      ...(parsed.flags.maxChars === undefined ? {} : { maxChars: parsed.flags.maxChars }),
      ...(parsed.flags.count === undefined ? {} : { count: parsed.flags.count }),
      ...(parsed.flags.includeArchived === undefined ? {} : { includeArchived: parsed.flags.includeArchived }),
    })
  }
  if (parsed.command === 'read') {
    const refsFlag = parseListFlag(parsed.flags.refs)
    const positional = parsed.positional.join(' ').trim()
    let args
    if (parsed.flags.ref !== undefined) args = { ref: parsed.flags.ref }
    else if (parsed.flags.path !== undefined) args = { path: parsed.flags.path }
    else if (refsFlag !== undefined) args = { refs: refsFlag }
    else if (positional !== '') args = parseRef(positional) === undefined ? { path: positional } : { ref: positional }
    else args = {}
    return await runAgentRead(settings, {
      ...args,
      ...(parsed.flags.as === undefined ? {} : { as: parsed.flags.as }),
      ...(parsed.flags.line === undefined ? {} : { line: parsed.flags.line }),
      ...(parsed.flags.window === undefined ? {} : { window: parsed.flags.window }),
      ...(parsed.flags.maxBytes === undefined ? {} : { maxBytes: parsed.flags.maxBytes }),
    })
  }
  if (parsed.command === 'status') {
    return await runAgentStatus(settings, { ...(parsed.flags.detail === undefined ? {} : { detail: parsed.flags.detail }) })
  }
  return agentFailureEnvelope(tool, makeAgentErrorInfo('invalid-argument', '--api=2026-11 supports find, read and status (got: ' + parsed.command + ')', { legacyCode: 'usage' }), startedAt)
}

/** Clamp a numeric option to an integer range. */
export function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Normalize an unknown failure to a CliError. */
export function asCliError(error, fallbackCode = 'failed') {
  if (error instanceof CliError) return error
  return new CliError(fallbackCode, String(error && error.message ? error.message : error), EXIT_RUNTIME)
}

/** One parsed command line. */
const USAGE = [
  'dsh-locator CLI ' + version,
  '',
  'Usage:',
  '  locator-cli search <query> [--json] [--limit N] [--offset N] [--mode names|content] [--allow-sessions] [--sort name|path|size|mtime|ext] [--desc] [--regex] [--case-sensitive] [--whole-word] [--files-only] [--dirs-only]',
  '  locator-cli find <query> [--json] [--limit N] [--offset N] [--context N] [--allow-sessions]',
  '  locator-cli status [--json]',
  '  locator-cli resolve <ref> [--json] [--excerpt]',
  '  locator-cli cite <ref...> [--json] [--format markdown|json|mention]',
  '  locator-cli version | help',
  '',
  'Options:',
  '  --root <dir>     index root to query (repeatable; default DSH_LOCATOR_ROOTS or home)',
  '  --state <dir>    snapshot directory (default DSH_LOCATOR_STATE or the platform cache)',
  '  --bin <path>     engine binary (default DSH_LOCATOR_BIN or the bundled build)',
  '  --json           machine-readable JSON on stdout',
  '  --limit <n>      page size, clamped to 1..100 (the host tools use the same cap)',
  '  --timeout <ms>   engine request timeout (default 15000)',
  '  --budget <chars>  soft output budget for search/find hits (default 8000)',
  '  --allow-sessions  include session-log body hits (default: files only; path and recorded workspace must be inside the roots)',
  '',
  'Read-only: the engine runs against a temporary copy of index.snapshot/index.journal/meta.json;',
  'the caller state directory is never created or written.',
  '',
  'Environment: DSH_LOCATOR_STATE, DSH_LOCATOR_ROOTS (path-separator separated), DSH_LOCATOR_BIN, DSH_LOCATOR_SCAN_TIMEOUT (ms).',
  'Exit codes: 0 ok, 1 runtime error, 2 usage error, 3 index/engine unavailable.',
  '',
  'Versioned AI surface (--api=2026-11, one JSON envelope, admin never exposed):',
  '  locator-cli find <query> --api=2026-11 [--mode auto|name|body|symbol] [--kinds file,dir,symbol] [--where JSON] [--scope workspace|roots|all] [--limit N] [--cursor TOKEN] [--detail compact|standard|full] [--max-chars N] [--count exact|bounded|none]',
  '  locator-cli read <ref|path> --api=2026-11 [--ref R] [--path P] [--refs R1,R2] [--as meta|excerpt|quote] [--line N] [--window N] [--max-bytes N]',
  '  locator-cli status --api=2026-11 [--detail brief|full]',
  '  --cwd defines the workspace scope; --state without --root reads the roots recorded in <state>/meta.json.',
  '  2026-11 exit codes: 0 ok, 1 internal, 2 usage, 3 index unavailable, 4 denied/not found.',
].join('\n')

/** Throw a usage error. */
function usage(message) {
  throw new CliError('usage', message, EXIT_USAGE)
}

/** Parse one argv into the command, positional query/refs and typed flags. */
export function parseCliArgs(argv) {
  const flags = { json: false, roots: [] }
  const positional = []
  const booleanFlags = new Map([
    ['--json', 'json'],
    ['--desc', 'desc'],
    ['--regex', 'regex'],
    ['--case-sensitive', 'caseSensitive'],
    ['--whole-word', 'wholeWord'],
    ['--files-only', 'filesOnly'],
    ['--dirs-only', 'dirsOnly'],
    ['--excerpt', 'excerpt'],
    ['--allow-sessions', 'allowSessions'],
    ['--include-archived', 'includeArchived'],
  ])
  const valueFlags = new Map([
    ['--limit', 'limit'],
    ['--offset', 'offset'],
    ['--context', 'contextLines'],
    ['--sort', 'sort'],
    ['--mode', 'mode'],
    ['--state', 'state'],
    ['--bin', 'binary'],
    ['--timeout', 'timeoutMs'],
    ['--format', 'format'],
    ['--root', 'root'],
    ['--budget', 'budgetChars'],
    ['--api', 'api'],
    ['--cwd', 'cwd'],
    ['--cursor', 'cursor'],
    ['--detail', 'detail'],
    ['--max-chars', 'maxChars'],
    ['--max-bytes', 'maxBytes'],
    ['--scope', 'scope'],
    ['--where', 'where'],
    ['--kinds', 'kinds'],
    ['--count', 'count'],
    ['--as', 'as'],
    ['--line', 'line'],
    ['--window', 'window'],
    ['--ref', 'ref'],
    ['--path', 'path'],
    ['--refs', 'refs'],
  ])
  for (let index = 0; index < argv.length; index++) {
    let argument = argv[index]
    // Support the common --flag=value spelling as well as --flag value.
    let inlineValue
    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=')
      if (equals > 2) {
        inlineValue = argument.slice(equals + 1)
        argument = argument.slice(0, equals)
      }
    }
    if (argument === '--help' || argument === '-h') return { command: 'help', positional: [], flags }
    if (argument === '--version' || argument === '-V') return { command: 'version', positional: [], flags }
    const boolean = booleanFlags.get(argument)
    if (boolean !== undefined) {
      if (inlineValue !== undefined) usage(argument + ' does not take a value')
      flags[boolean] = true
      continue
    }
    const valueName = valueFlags.get(argument)
    if (valueName !== undefined) {
      const value = inlineValue !== undefined ? inlineValue : argv[++index]
      if (value === undefined) usage(argument + ' needs a value')
      if (valueName === 'root') flags.roots.push(value)
      else if (['limit', 'offset', 'contextLines', 'timeoutMs', 'budgetChars', 'maxChars', 'maxBytes', 'line', 'window'].includes(valueName)) {
        if (!/^\d+$/.test(value)) usage(argument + ' needs a non-negative integer')
        flags[valueName] = Number(value)
      } else flags[valueName] = value
      continue
    }
    if (argument.startsWith('-')) usage('unknown option: ' + argument)
    positional.push(argument)
  }
  const command = positional.shift() ?? 'help'
  return { command, positional, flags }
}

/** Build settings from parsed flags (CLI and MCP share it). */
export function settingsFromFlags(flags = {}, env = process.env) {
  if (flags.api !== undefined && flags.api !== 'legacy' && flags.api !== AGENT_API_VERSION) {
    throw new CliError('usage', 'unknown --api value: ' + String(flags.api) + ' (expected legacy or ' + AGENT_API_VERSION + ')', EXIT_USAGE)
  }
  return makeSettings({
    roots: flags.roots ?? [],
    state: flags.state,
    binary: flags.binary,
    timeoutMs: flags.timeoutMs,
    ...(flags.cwd === undefined ? {} : { workspace: flags.cwd }),
    ...(flags.api === undefined ? {} : { api: flags.api }),
  }, env)
}

/** Render a result as human text (the CLI default). */
export function renderText(result) {
  /** One trailing "(truncated; nextOffset N; ...)" note shared by search and find. */
  const pageNote = value => {
    if (value.truncated !== true && value.nextOffset === undefined) return ''
    const bits = []
    if (value.nextOffset !== undefined) bits.push('nextOffset ' + String(value.nextOffset))
    if (value.budget !== undefined && value.budget.dropped > 0) bits.push(String(value.budget.dropped) + ' hit(s) over the ' + String(value.budget.limitChars ?? 0) + '-char budget')
    return ' (truncated' + (bits.length === 0 ? '' : '; ' + bits.join('; ')) + ')'
  }
  if (result.command === 'search') {
    const lines = [String(result.returned) + ' of ' + String(result.total ?? '?') + ' match(es) for ' + JSON.stringify(result.query) + pageNote(result)]
    for (const hit of result.hits) lines.push(hit.path + (hit.dir ? '/' : ''))
    if (Array.isArray(result.warnings) && result.warnings.length > 0) lines.push('warnings: ' + result.warnings.join(', '))
    return lines.join('\n')
  }
  if (result.command === 'content-search' || result.command === 'find') {
    const lines = [String(result.returned) + ' content hit(s)' + (result.total === undefined ? '' : ' of ' + String(result.total)) + ' for ' + JSON.stringify(result.query) + pageNote(result)]
    for (const hit of result.hits) {
      const location = hit.kind === 'session' ? 'session ' + (hit.sessionId ?? '') : hit.path + (hit.line === undefined ? '' : ':' + String(hit.line))
      lines.push('[' + hit.kind + '] ' + location + ' — ' + hit.snippet)
      if (Array.isArray(hit.context)) lines.push('  ' + hit.context.map((line, index) => String((hit.contextStart ?? 1) + index) + ': ' + line).join('\n  '))
    }
    if (Array.isArray(result.warnings) && result.warnings.length > 0) lines.push('warnings: ' + result.warnings.join(', '))
    return lines.join('\n')
  }
  if (result.command === 'status') {
    const engine = result.engine ?? {}
    const content = result.content ?? {}
    return [
      'engine: ' + (engine.ok ? 'ok ' + String(engine.version ?? '') + ' · ' + String(engine.entries ?? 0) + ' entries (' + String(engine.files ?? 0) + ' files, ' + String(engine.dirs ?? 0) + ' dirs)' : 'unavailable' + (engine.error === undefined ? '' : ': ' + engine.error)),
      '  roots: ' + (result.roots ?? []).join(', '),
      '  state: ' + result.stateDir + (result.readOnly === true ? ' (read-only; engine uses a temporary copy)' : ''),
      '  binary: ' + result.binary,
      'content: ' + (content.available ? String(content.files ?? 0) + ' files / ' + String(content.sessions ?? 0) + ' sessions / ' + String(content.messages ?? 0) + ' messages / ' + String(content.refs ?? 0) + ' refs' : 'unavailable (' + String(content.reason ?? 'missing') + ')'),
      ...(result.warnings.length === 0 ? [] : ['warnings: ' + result.warnings.join(', ')]),
    ].join('\n')
  }
  if (result.command === 'resolve') {
    return JSON.stringify(result, null, 2)
  }
  if (result.command === 'cite') {
    return (result.citations ?? []).map(citation => citation.markdown).join('\n')
  }
  return JSON.stringify(result, null, 2)
}

/** Run one parsed CLI command and return its result object. */
export async function runCliCommand(parsed, env = process.env) {
  const settings = settingsFromFlags(parsed.flags, env)
  if (parsed.command === 'help' || parsed.command === 'version') return { ok: true, command: parsed.command }
  if (parsed.flags.api === AGENT_API_VERSION) return await runAgentApiCommand(parsed, env)
  if (parsed.command === 'status') return await runStatus(settings)
  const query = parsed.positional.join(' ').trim()
  if (parsed.command === 'search') {
    if (query === '') usage('search needs a query')
    if (parsed.flags.mode === 'content') {
      return runContentSearch(settings, query, {
        ...parsed.flags,
        allowSessions: parsed.flags.allowSessions === true,
        budgetChars: parsed.flags.budgetChars ?? DEFAULT_SEARCH_BUDGET_CHARS,
      })
    }
    if (parsed.flags.mode !== undefined && parsed.flags.mode !== 'names') usage('--mode must be names or content')
    return await runNameSearch(settings, query, parsed.flags)
  }
  if (parsed.command === 'find') {
    if (query === '') usage('find needs a query')
    return await runFindSearch(settings, query, {
      ...parsed.flags,
      allowSessions: parsed.flags.allowSessions === true,
      budgetChars: parsed.flags.budgetChars ?? DEFAULT_SEARCH_BUDGET_CHARS,
    })
  }
  if (parsed.command === 'resolve') {
    if (query === '') usage('resolve needs a ref')
    const result = await resolveRef(settings, query, parsed.flags)
    result.command = 'resolve'
    return result
  }
  if (parsed.command === 'cite') {
    const refs = parsed.positional
    if (refs.length === 0) usage('cite needs at least one ref')
    return citeRefs(refs, parsed.flags.format ?? 'markdown')
  }
  usage('unknown command: ' + parsed.command)
}

/** CLI entrypoint; returns the process exit code. */
export async function main(argv = process.argv.slice(2), env = process.env, io = process) {
  let parsed
  try {
    parsed = parseCliArgs(argv)
  } catch (error) {
    const failure = asCliError(error, 'usage')
    io.stderr.write(failure.message + '\n\n' + USAGE + '\n')
    return failure.exitCode
  }
  const apiMode = parsed.flags.api === AGENT_API_VERSION
  try {
    if (parsed.command === 'help') {
      io.stdout.write(USAGE + '\n')
      return EXIT_OK
    }
    if (parsed.command === 'version') {
      io.stdout.write(version + '\n')
      return EXIT_OK
    }
    const result = await runCliCommand(parsed, env)
    io.stdout.write((parsed.flags.json === true || apiMode ? JSON.stringify(result, null, 2) : renderText(result)) + '\n')
    if (apiMode && result !== null && typeof result === 'object' && result.ok === false) {
      const code = result.error?.code
      return AGENT_ERROR_EXIT_CODES[code] ?? EXIT_RUNTIME
    }
    return EXIT_OK
  } catch (error) {
    const failure = asCliError(error)
    if (apiMode) {
      const tool = parsed.command === 'read' ? 'locator_read' : parsed.command === 'status' ? 'locator_status' : 'locator_find'
      const envelope = agentFailureFromThrown(tool, error, Date.now())
      io.stdout.write(JSON.stringify(envelope, null, 2) + '\n')
      return AGENT_ERROR_EXIT_CODES[envelope.error.code] ?? EXIT_RUNTIME
    }
    if (parsed.flags.json === true) {
      io.stdout.write(JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } }, null, 2) + '\n')
    } else {
      io.stderr.write('locator-cli: ' + failure.code + ': ' + failure.message + '\n')
    }
    return failure.exitCode
  } finally {
    cleanupReadOnlyStates()
  }
}

// Run only when executed directly (the MCP server imports this module).
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  // Ctrl+C / termination must not leak a temporary state copy.
  const stop = code => {
    cleanupReadOnlyStates()
    process.exit(code)
  }
  process.once('SIGINT', () => stop(130))
  process.once('SIGTERM', () => stop(143))
  main().then(code => { process.exitCode = code }).catch(error => {
    process.stderr.write('locator-cli: fatal: ' + String(error && error.stack ? error.stack : error) + '\n')
    process.exitCode = EXIT_RUNTIME
  })
}
