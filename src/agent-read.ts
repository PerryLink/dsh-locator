/**
 * locator_read — the AI-first read/citation tool of the 0.22.0 interface.
 *
 * It resolves one ref (or a bounded batch of refs, or a workspace file path)
 * through the same evidence layer as locator_resolve/locator_cite and returns
 * verbatim, whole-line excerpts plus the citation-ready quote form. The shared
 * envelope contract (apiVersion "2026-11", closed error codes) is imported from
 * src/agent-core.ts.
 * @module dsh-locator/agent-read
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve as resolvePath } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'

import {
  AGENT_BUDGET_SCHEMA,
  AGENT_ERROR_CODES,
  AGENT_ERROR_INFO_SCHEMA,
  AGENT_SUCCESS_BASE_SCHEMA,
  agentFailure,
  agentSuccess,
  makeError,
  makeTiming,
  type AgentBudget,
  type AgentErrorCode,
  type AgentErrorInfo,
  type AgentTiming,
} from './agent-core.ts'
import type { ContentIndex } from './content.ts'
import { fileRef, parseRef, type RefFreshness, type RefPermissions, type RefProvenance, type RefStatus } from './refs.ts'
import { makeCiteTool, makeResolveTool } from './ref-tools.ts'
import { resolveWithinRoots } from './reveal.ts'
import type { LocatorRuntime } from './runtime.ts'

/**
 * Build one structured error block with the shared per-code defaults; the
 * contract builder fills retryability/remediation/nextTools, and embedding
 * tools reuse the block inside per-item errors or agentFailure envelopes.
 */
function errorInfo(
  code: AgentErrorCode,
  message: string,
  extra: { retryable?: boolean; remediation?: string; nextTools?: string[]; details?: Record<string, unknown> } = {},
): AgentErrorInfo {
  return makeError(code, message, extra).error
}

// ---------------------------------------------------------------------------
// locator_read
// ---------------------------------------------------------------------------

/** Emit one failure envelope (bridges the contract builder to the schema type). */
function fail(code: AgentErrorCode, message: string, options: Parameters<typeof makeError>[2] = {}): never {
  return makeError(code, message, options) as never
}

/** Emit an already-built failure envelope. */
function failureEnvelope(tool: string, error: AgentErrorInfo, timing: AgentTiming): never {
  return agentFailure(tool, error, timing) as never
}

/** Emit one success envelope (fields are validated by the declared schema). */
function succeed(tool: string, fields: Record<string, unknown>, timing: AgentTiming): never {
  return agentSuccess(tool, fields, timing) as never
}
const TOOL = 'locator_read'

/** Hard cap on refs[] per call (the schema cap is advisory on model input). */
export const READ_MAX_REFS = 20
/** Hard cap on window (lines added on each side of the target line). */
export const READ_MAX_WINDOW = 20
/** Default and hard caps for one excerpt's text budget. */
export const READ_DEFAULT_MAX_BYTES = 2_000
export const READ_MAX_BYTES = 65_536
/** One line is never returned longer than this (mirrors locator_resolve). */
export const READ_MAX_LINE_CHARS = 65_536

const READ_CHUNK_BYTES = 64 * 1024
const READ_MODES = ['meta', 'excerpt', 'quote'] as const
type ReadMode = (typeof READ_MODES)[number]

const REF_KINDS = ['file', 'session', 'url', 'session-event', 'spill', 'attachment'] as const
type ReadRefKind = (typeof REF_KINDS)[number]

const REF_STATUSES = ['fresh', 'stale', 'missing', 'tombstoned', 'unknown'] as const
const FRESHNESS_STATES = ['fresh', 'stale', 'missing', 'unknown'] as const
const VISIBILITIES = ['workspace', 'roots', 'session', 'external'] as const
const READ_PERMISSIONS = ['allowed', 'denied'] as const
const PROVENANCE_ORIGINS = ['index', 'tool', 'session', 'web'] as const

/** Options accepted by the read factory (reserved for embedder wiring). */
export interface AgentReadOptions {
  /** Override the maximum refs accepted in one call (tests/embedders only). */
  maxRefs?: number
}

/** One read row: evidence metadata plus (for excerpt/quote) verbatim text. */
interface ReadItem {
  ref?: string
  kind?: ReadRefKind
  title?: string
  path?: string
  sessionId?: string
  messageId?: string
  seq?: number
  line?: number
  startLine?: number
  endLine?: number
  lineCount?: number
  excerpt?: string
  markdown?: string
  hash?: string
  size?: number
  status?: RefStatus
  checkedAt?: number
  truncated?: boolean
  anchor?: { line?: number; charStart?: number; charEnd?: number }
  freshness?: RefFreshness
  permissions?: RefPermissions
  provenance?: RefProvenance
  warnings?: string[]
  error?: AgentErrorInfo
}

/** The locator_resolve result view this module consumes. */
interface ResolvedView {
  ok: boolean
  ref?: string
  kind?: ReadRefKind
  title?: string
  excerpt?: string
  hash?: string
  size?: number
  status?: RefStatus
  checkedAt?: number
  anchor?: { line?: number; charStart?: number; charEnd?: number }
  freshness?: RefFreshness
  permissions?: RefPermissions
  provenance?: RefProvenance
  error?: string
  warnings?: string[]
}

/** The locator_cite result view this module consumes. */
interface CiteView {
  ok?: boolean
  citations?: Array<{ markdown?: string; exact?: string; fallback?: string }>
  error?: string
}

const READ_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'string' },
    kind: { type: 'string', enum: REF_KINDS },
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
    status: { type: 'string', enum: REF_STATUSES },
    checkedAt: { type: 'integer' },
    truncated: { type: 'boolean', description: 'The excerpt dropped window lines or sliced long lines to fit maxBytes.' },
    anchor: {
      type: 'object',
      additionalProperties: false,
      properties: { line: { type: 'integer' }, charStart: { type: 'integer' }, charEnd: { type: 'integer' } },
    },
    freshness: {
      type: 'object',
      additionalProperties: false,
      properties: {
        state: { type: 'string', enum: FRESHNESS_STATES },
        observedAt: { type: 'integer' },
        mtime: { type: 'integer' },
      },
    },
    permissions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        read: { type: 'string', enum: READ_PERMISSIONS },
        visibility: { type: 'string', enum: VISIBILITIES },
        reason: { type: 'string' },
      },
    },
    provenance: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string', enum: PROVENANCE_ORIGINS },
        path: { type: 'string' },
        sessionId: { type: 'string' },
        messageId: { type: 'string' },
        url: { type: 'string' },
        indexedAt: { type: 'integer' },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    error: AGENT_ERROR_INFO_SCHEMA,
  },
} as const

const READ_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...AGENT_SUCCESS_BASE_SCHEMA.properties,
    items: { type: 'array', items: READ_ITEM_SCHEMA },
    counts: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requested: { type: 'integer', required: true },
        returned: { type: 'integer', required: true },
        failed: { type: 'integer', required: true },
      },
    },
    budget: AGENT_BUDGET_SCHEMA,
    error: AGENT_ERROR_INFO_SCHEMA,
  },
} as const

/** One target accepted by locator_read. */
type ReadTarget = { kind: 'ref'; ref: string } | { kind: 'path'; path: string }

/** Outcome of one target: a row plus dropped-line count, or one error block. */
type TargetOutcome =
  | { ok: true; item: ReadItem; dropped: number }
  | { ok: false; targetKind: 'ref' | 'path'; target: string; error: AgentErrorInfo }

/** One line window read from a file. */
interface LineWindow {
  startLine: number
  endLine: number
  lines: string[]
  lineCount?: number
  dropped: number
  truncated: boolean
}

type LineWindowResult =
  | { ok: true; window: LineWindow }
  | { ok: false; reason: 'line-out-of-range' | 'read-failed'; lineCount?: number }

/** Caller identity and helpers one read needs. */
interface ReadContext {
  roots: readonly string[]
  cwd?: string
  exec: ToolRunContext
  resolveTool: ReturnType<typeof makeResolveTool>
  citeTool: ReturnType<typeof makeCiteTool>
}

/** Read one target and return its row or a structured error. */
async function readTarget(target: ReadTarget, mode: ReadMode, line: number | undefined, window: number, maxBytes: number, ctx: ReadContext): Promise<TargetOutcome> {
  const outcome = target.kind === 'ref'
    ? await readRef(target.ref, mode, line, window, maxBytes, ctx)
    : await readPath(target.path, mode, line, window, maxBytes, ctx)
  return outcome
}

/** Read one parsed ref: authorize through locator_resolve, then read bytes. */
async function readRef(rawRef: string, mode: ReadMode, lineArg: number | undefined, window: number, maxBytes: number, ctx: ReadContext): Promise<TargetOutcome> {
  const ref = rawRef.trim()
  const parsed = parseRef(ref)
  if (parsed === undefined) {
    return {
      ok: false,
      targetKind: 'ref',
      target: ref,
      error: errorInfo(AGENT_ERROR_CODES.invalidArgument, 'unsupported or malformed ref: ' + ref.slice(0, 120), {
        remediation: 'Pass a ref returned by locator_find (ref://file?... / ref://session-event?... or dsh-session:...).',
      }),
    }
  }
  // Metadata-only ref kinds are rejected before resolution, so the error does
  // not depend on whether a content index happens to be configured.
  if (mode !== 'meta' && parsed.kind === 'url') {
    return {
      ok: false,
      targetKind: 'ref',
      target: ref,
      error: errorInfo(AGENT_ERROR_CODES.invalidArgument, 'URL refs are metadata-only: they have no local content to excerpt', {
        remediation: 'Use as: "meta" for a URL ref, or read the page with web_fetch.',
      }),
    }
  }
  if (mode !== 'meta' && parsed.kind === 'session') {
    return {
      ok: false,
      targetKind: 'ref',
      target: ref,
      error: errorInfo(AGENT_ERROR_CODES.invalidArgument, 'a session-level ref has no single message body to excerpt', {
        remediation: 'Read the ref://session-event?sid=...&seq=N value that locator_find returns as eventRef, or pass as: "meta".',
      }),
    }
  }
  const resolved = await resolveView(ctx, ref)
  if (resolved === undefined) {
    return { ok: false, targetKind: 'ref', target: ref, error: errorInfo(AGENT_ERROR_CODES.internal, 'locator_resolve returned no value for this ref') }
  }
  if (resolved.ok !== true) return { ok: false, targetKind: 'ref', target: ref, error: resolveFailure(resolved) }
  const base = itemFromResolved(resolved, { ref })
  if (mode === 'meta') return { ok: true, item: base, dropped: 0 }
  if (parsed.kind === 'session-event') {
    const citation = await citeView(ctx, [ref], 'exact', maxBytes)
    const exact = citation?.citations?.[0]?.exact
    if (typeof exact !== 'string' || exact === '') {
      return { ok: false, targetKind: 'ref', target: ref, error: errorInfo(AGENT_ERROR_CODES.notFound, 'the session event has no readable text', { remediation: 'The event log may be unavailable; call locator_status to check the content index.' }) }
    }
    const markdown = citation?.citations?.[0]?.markdown
    const item: ReadItem = {
      ...base,
      ...(parsed.seq === undefined ? {} : { seq: parsed.seq }),
      ...(resolved.provenance?.sessionId === undefined ? {} : { sessionId: resolved.provenance.sessionId }),
      excerpt: exact,
      ...(mode === 'quote'
        ? { markdown: typeof markdown === 'string' && markdown !== '' ? markdown : quoteMarkdown(exact.split('\n'), '[' + ref + '](' + ref + ')', undefined) }
        : {}),
    }
    return { ok: true, item, dropped: 0 }
  }
  if (parsed.kind === 'spill') {
    if (resolved.status === 'missing') {
      return { ok: false, targetKind: 'ref', target: ref, error: errorInfo(AGENT_ERROR_CODES.notFound, 'the spill file is missing: ' + parsed.path, { remediation: 'The tool-output spill was removed; use locator_find to locate the evidence again.' }) }
    }
    return await readFileContent(resolved, { ref, path: parsed.path, line: lineArg ?? 1, fallback: parsed.path }, mode, window, maxBytes, ctx)
  }
  if (parsed.kind === 'attachment') {
    const citation = await citeView(ctx, [ref], 'exact', maxBytes)
    const found = citation?.citations?.[0]?.fallback
    if (typeof found !== 'string' || found === '') {
      return { ok: false, targetKind: 'ref', target: ref, error: errorInfo(AGENT_ERROR_CODES.notFound, 'the attachment file is missing', { remediation: 'The attachment object was removed from the local store.' }) }
    }
    return await readFileContent(resolved, { ref, path: found, line: lineArg ?? 1, fallback: found }, mode, window, maxBytes, ctx)
  }
  // Unreachable after the pre-resolution mode checks, but it narrows the
  // parsed ref to a file for the remaining code path.
  if (parsed.kind === 'url' || parsed.kind === 'session') {
    return { ok: false, targetKind: 'ref', target: ref, error: errorInfo(AGENT_ERROR_CODES.invalidArgument, 'this ref kind has no readable content') }
  }
  // File refs: the canonical authorized path comes back in provenance.
  const path = resolved.provenance?.path
  if (typeof path !== 'string' || path === '') {
    return { ok: false, targetKind: 'ref', target: ref, error: errorInfo(AGENT_ERROR_CODES.internal, 'file ref resolved without a path') }
  }
  return await readFileContent(resolved, { ref, path, line: lineArg ?? parsed.line ?? 1, fallback: path }, mode, window, maxBytes, ctx)
}

/** Read one workspace file path: authorize it, build its ref, then read the ref. */
async function readPath(rawPath: string, mode: ReadMode, lineArg: number | undefined, window: number, maxBytes: number, ctx: ReadContext): Promise<TargetOutcome> {
  const input = rawPath.trim()
  const cwd = ctx.cwd ?? process.cwd()
  const absolute = isAbsolute(input) ? input : resolvePath(cwd, input)
  const authorized = resolveWithinRoots(absolute, ctx.roots)
  if (authorized === undefined) {
    return {
      ok: false,
      targetKind: 'path',
      target: input,
      error: errorInfo(AGENT_ERROR_CODES.scopeDenied, 'path is outside every indexed root: ' + input, {
        remediation: 'Use an absolute path under one of the configured index roots (locator_status reports roots).',
      }),
    }
  }
  if (!authorized.exists) {
    return { ok: false, targetKind: 'path', target: input, error: errorInfo(AGENT_ERROR_CODES.notFound, 'file does not exist: ' + authorized.path) }
  }
  let mtime = 0
  let size = 0
  try {
    const info = statSync(authorized.path)
    if (!info.isFile()) {
      return { ok: false, targetKind: 'path', target: input, error: errorInfo(AGENT_ERROR_CODES.invalidArgument, 'path is not a regular file: ' + authorized.path) }
    }
    mtime = info.mtimeMs
    size = info.size
  } catch {
    return { ok: false, targetKind: 'path', target: input, error: errorInfo(AGENT_ERROR_CODES.notFound, 'file could not be read: ' + authorized.path) }
  }
  const line = lineArg ?? 1
  const ref = fileRef({ path: authorized.path, mtime, size, line })
  return await readRef(ref, mode, line, window, maxBytes, ctx)
}

/** Read a whole-line window around the target line and shape one row. */
async function readFileContent(
  resolved: ResolvedView,
  target: { ref: string; path: string; line: number; fallback?: string },
  mode: ReadMode,
  window: number,
  maxBytes: number,
  ctx: ReadContext,
): Promise<TargetOutcome> {
  if (resolved.status === 'missing') {
    return { ok: false, targetKind: 'ref', target: target.ref, error: errorInfo(AGENT_ERROR_CODES.notFound, 'evidence file is missing: ' + target.path, { remediation: 'The file moved or was deleted after indexing; search again with locator_find.' }) }
  }
  const result = readLineWindow(target.path, target.line, window, maxBytes)
  if (!result.ok) {
    return result.reason === 'line-out-of-range'
      ? {
          ok: false,
          targetKind: 'ref',
          target: target.ref,
          error: errorInfo(AGENT_ERROR_CODES.notFound, 'line ' + String(target.line) + ' is beyond the end of ' + target.path + (result.lineCount === undefined ? '' : ' (' + String(result.lineCount) + ' lines)'), {
            remediation: 'Use a line inside the file, or omit line to read from line 1.',
          }),
        }
      : {
          ok: false,
          targetKind: 'ref',
          target: target.ref,
          error: errorInfo(AGENT_ERROR_CODES.internal, 'could not read ' + target.path, { remediation: 'The file may be unreadable; check its permissions.' }),
        }
  }
  const found = result.window
  const excerpt = found.lines.join('\n')
  const warnings = [...(resolved.warnings ?? [])]
  if (found.truncated && !warnings.includes('excerpt-truncated')) warnings.push('excerpt-truncated')
  const item: ReadItem = {
    ...itemFromResolved(resolved, {}),
    ref: target.ref,
    path: target.path,
    line: target.line,
    startLine: found.startLine,
    endLine: found.endLine,
    ...(found.lineCount === undefined ? {} : { lineCount: found.lineCount }),
    excerpt,
    ...(found.truncated ? { truncated: true } : {}),
    ...(warnings.length === 0 ? {} : { warnings }),
  }
  if (mode !== 'quote') return { ok: true, item, dropped: found.dropped }
  const link = await compactCitation(ctx, target.ref, target.path)
  return { ok: true, item: { ...item, markdown: quoteMarkdown(found.lines, link, target.fallback) }, dropped: found.dropped }
}

/** Compact citation link for one ref, with a local fallback if cite fails. */
async function compactCitation(ctx: ReadContext, ref: string, path: string): Promise<string> {
  const view = await citeView(ctx, [ref], 'compact', 1)
  const markdown = view?.citations?.[0]?.markdown
  return typeof markdown === 'string' && markdown !== '' ? markdown : '[' + basename(path) + '](' + ref + ')'
}

/** Markdown quote block plus citation link and fallback (mirrors locator_cite). */
function quoteMarkdown(lines: readonly string[], link: string, fallback: string | undefined): string {
  const blocks = [lines.map(line => '> ' + line).join('\n'), link]
  if (fallback !== undefined && fallback !== '') {
    blocks.push(/^https?:\/\//.test(fallback) ? '[fallback](' + fallback + ')' : 'fallback: ' + fallback)
  }
  return blocks.join('\n\n')
}

/** Copy the resolved evidence block into a read row, then apply one override. */
function itemFromResolved(resolved: ResolvedView, extra: ReadItem): ReadItem {
  return {
    ...(resolved.ref === undefined ? {} : { ref: resolved.ref }),
    ...(resolved.kind === undefined ? {} : { kind: resolved.kind }),
    ...(resolved.title === undefined ? {} : { title: resolved.title }),
    ...(resolved.size === undefined ? {} : { size: resolved.size }),
    ...(resolved.hash === undefined ? {} : { hash: resolved.hash }),
    ...(resolved.status === undefined ? {} : { status: resolved.status }),
    ...(resolved.checkedAt === undefined ? {} : { checkedAt: resolved.checkedAt }),
    ...(resolved.anchor === undefined ? {} : { anchor: resolved.anchor }),
    ...(resolved.freshness === undefined ? {} : { freshness: resolved.freshness }),
    ...(resolved.permissions === undefined ? {} : { permissions: resolved.permissions }),
    ...(resolved.provenance === undefined ? {} : { provenance: resolved.provenance }),
    ...(resolved.warnings === undefined || resolved.warnings.length === 0 ? {} : { warnings: [...resolved.warnings] }),
    ...extra,
  }
}

const RESOLVE_FAILURES: Readonly<Record<string, AgentErrorInfo>> = {
  'content-path-denied': errorInfo(AGENT_ERROR_CODES.scopeDenied, 'path is outside every indexed root', {
    remediation: 'Read a path under one of the configured index roots (locator_status reports them).',
  }),
  'content-scope-denied': errorInfo(AGENT_ERROR_CODES.scopeDenied, 'the ref is not authorized from this workspace', {
    remediation: 'Use a ref produced inside this workspace/session.',
  }),
  'content-index-unavailable': errorInfo(AGENT_ERROR_CODES.indexUnavailable, 'the content index is unavailable in this profile', {
    retryable: false,
    remediation: 'Read a file ref instead, or enable the content index in the plugin configuration.',
  }),
  'invalid-ref': errorInfo(AGENT_ERROR_CODES.invalidArgument, 'unsupported or malformed ref', {
    remediation: 'Pass a ref returned by locator_find.',
  }),
}

/** Map a locator_resolve failure onto the closed agent error set. */
function resolveFailure(resolved: ResolvedView): AgentErrorInfo {
  const known = resolved.error === undefined ? undefined : RESOLVE_FAILURES[resolved.error]
  if (known !== undefined) return known
  return errorInfo(AGENT_ERROR_CODES.internal, resolved.error === undefined ? 'locator_resolve failed without a message' : 'locator_resolve failed: ' + resolved.error)
}

/** Invoke the locator_resolve tool without letting a thrown error escape. */
async function resolveView(ctx: ReadContext, ref: string): Promise<ResolvedView | undefined> {
  try {
    const value = await ctx.resolveTool.execute({ ref }, ctx.exec)
    return typeof value === 'object' && value !== null ? value as ResolvedView : undefined
  } catch {
    return undefined
  }
}

/** Invoke the locator_cite tool for one ref set. */
async function citeView(ctx: ReadContext, refs: string[], detail: 'exact' | 'compact', maxBytes: number): Promise<CiteView | undefined> {
  try {
    const value = await ctx.citeTool.execute({ refs, format: 'markdown', detail, maxBytes }, ctx.exec)
    return typeof value === 'object' && value !== null ? value as CiteView : undefined
  } catch {
    return undefined
  }
}

/**
 * Read one bounded line window by streaming the file, then assemble the
 * excerpt: the target line is always present whole, neighbours are added only
 * while they fit maxBytes.
 */
function readLineWindow(path: string, center: number, window: number, maxBytes: number): LineWindowResult {
  const start = Math.max(1, center - window)
  const end = center + window
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
  } catch {
    return { ok: false, reason: 'read-failed' }
  }
  const decoder = new StringDecoder('utf8')
  const buffer = Buffer.alloc(READ_CHUNK_BYTES)
  const collected = new Map<number, string>()
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
      if (read <= 0) {
        eof = true
        break
      }
      const chunk = carry + decoder.write(buffer.subarray(0, read))
      const parts = chunk.split('\n')
      carry = parts.pop() ?? ''
      for (const raw of parts) {
        lineNo += 1
        if (lineNo >= start && lineNo <= end) {
          const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
          const capped = text.length > READ_MAX_LINE_CHARS ? text.slice(0, READ_MAX_LINE_CHARS) : text
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
          const capped = text.length > READ_MAX_LINE_CHARS ? text.slice(0, READ_MAX_LINE_CHARS) : text
          if (capped.length !== text.length) slicedLine = true
          collected.set(lineNo, capped)
        }
      }
    }
  } finally {
    closeSync(fd)
  }
  if (lineNo < center) {
    return eof ? { ok: false, reason: 'line-out-of-range', lineCount: lineNo } : { ok: false, reason: 'line-out-of-range' }
  }
  const centerLine = collected.get(center)
  if (centerLine === undefined) return { ok: false, reason: 'line-out-of-range', ...(eof ? { lineCount: lineNo } : {}) }
  const availableEnd = eof ? Math.min(end, lineNo) : end
  const requested = Math.max(1, availableEnd - start + 1)
  let startLine = center
  let endLine = center
  let bytes = centerLine.length
  const lines: string[] = [centerLine]
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

/** Aggregate the shared budget block from the rows and dropped-line count. */
function readBudget(items: readonly ReadItem[], dropped: number, maxBytes: number, requested: number): AgentBudget {
  let usedChars = 0
  for (const item of items) usedChars += (item.excerpt?.length ?? 0) + (item.markdown?.length ?? 0)
  return {
    limitChars: maxBytes * Math.max(1, requested),
    usedChars,
    truncated: dropped > 0 || items.some(item => item.truncated === true),
    dropped,
  }
}

/** Format a byte-ish size for the text rendering. */
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

/** Build the locator_read tool. */
export function makeAgentReadTool(rt: LocatorRuntime, content?: ContentIndex, options: AgentReadOptions = {}) {
  const maxRefs = Math.max(1, Math.min(READ_MAX_REFS, Math.trunc(options.maxRefs ?? READ_MAX_REFS)))
  const resolveTool = makeResolveTool(rt, content)
  const citeTool = makeCiteTool({ ...(content === undefined ? {} : { content }), roots: rt.roots })
  return defineTool({
    name: TOOL,
    description: [
      'Read a file/session ref from locator_find, a batch of refs, or a file path (dsh-locator).',
      '',
      'Pass exactly one of ref, refs[] (1-20), or path (inside configured roots). as: meta = evidence only; excerpt (default) = verbatim whole lines around line; quote = markdown blockquote + citation link + fallback. window (0-20) adds context; maxBytes caps each excerpt (default 2000, max 65536).',
      '',
      'Use it instead of shell cat/head when the answer needs exact cited lines; every item keeps ref/status/freshness.',
    ].join('\n'),
    parameters: {
      ref: { type: 'string', description: 'One ref from locator_find.' },
      refs: { type: 'array', items: { type: 'string' }, description: '1-20 refs; per-ref failures appear as item.error.' },
      path: { type: 'string', description: 'File path inside the configured roots.' },
      line: { type: 'integer', description: '1-based target line (default: the ref anchor, else 1).' },
      window: { type: 'integer', description: 'Context lines per side, 0-20 (default 0).' },
      as: { type: 'string', enum: READ_MODES, description: 'meta (evidence only), excerpt (default, verbatim lines), or quote (markdown blockquote + citation link + fallback).' },
      maxBytes: { type: 'integer', description: 'Per-excerpt cap in characters (default 2000, max 65536).' },
    },
    output: {
      schema: READ_OUTPUT,
      render: (args, value) => {
        const v = value as { ok: boolean; items?: ReadItem[]; counts?: { requested: number; returned: number; failed: number }; budget?: AgentBudget; error?: AgentErrorInfo }
        if (v.ok !== true) {
          const err = v.error
          const detail = err === undefined ? '' : ' — ' + (err.remediation ?? '')
          return [{ type: 'text', text: 'locator_read failed: ' + (err?.code ?? 'internal') + ': ' + (err?.message ?? 'unknown error') + detail }]
        }
        const mode = args.as ?? 'excerpt'
        const counts = v.counts
        const header = 'locator_read: ' + String(counts?.returned ?? 0) + ' item(s)' + (counts === undefined || counts.failed === 0 ? '' : ', ' + String(counts.failed) + ' failed') + (v.budget?.truncated === true ? ' (truncated)' : '')
        const blocks: string[] = [header]
        const items = v.items ?? []
        for (let index = 0; index < items.length; index++) {
          const item = items[index]
          if (item === undefined) continue
          if (item.error !== undefined) {
            blocks.push(String(index + 1) + '. [' + (item.ref ?? item.path ?? 'target') + '] ' + item.error.code + ': ' + item.error.message + (item.error.remediation === undefined ? '' : '\n   → ' + item.error.remediation))
            continue
          }
          const title = item.title ?? item.path ?? item.ref ?? ''
          const location = item.startLine === undefined || item.endLine === undefined
            ? item.line === undefined ? '' : ' (line ' + String(item.line) + ')'
            : ' (lines ' + String(item.startLine) + '-' + String(item.endLine) + ')'
          blocks.push(String(index + 1) + '. [' + (item.kind ?? 'ref') + '] ' + title + location + (item.status === undefined ? '' : ' · ' + item.status))
          if (item.ref !== undefined) blocks.push('   ref ' + item.ref)
          if (item.size !== undefined) blocks.push('   size ' + formatSize(item.size))
          if (mode === 'quote' && item.markdown !== undefined) {
            blocks.push('', item.markdown)
          } else if (item.excerpt !== undefined) {
            blocks.push('   ---')
            for (const line of item.excerpt.split('\n')) blocks.push('   ' + line)
          }
          if (item.warnings !== undefined && item.warnings.length > 0) blocks.push('   warnings: ' + item.warnings.join(', '))
        }
        if (v.budget !== undefined) {
          blocks.push('(budget: ' + String(v.budget.usedChars) + '/' + String(v.budget.limitChars) + ' chars' + (v.budget.dropped === 0 ? '' : ', ' + String(v.budget.dropped) + ' line(s) dropped') + ')')
        }
        return [{ type: 'text', text: blocks.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const startedAt = Date.now()
      const timing = makeTiming(startedAt)
      const mode: ReadMode = args.as === 'meta' || args.as === 'quote' ? args.as : 'excerpt'
      const refArg = typeof args.ref === 'string' ? args.ref.trim() : ''
      const pathArg = typeof args.path === 'string' ? args.path.trim() : ''
      const refsArg = Array.isArray(args.refs) ? args.refs.map(ref => ref.trim()).filter(ref => ref !== '') : undefined
      const provided = (refArg === '' ? 0 : 1) + (refsArg === undefined ? 0 : 1) + (pathArg === '' ? 0 : 1)
      if (provided !== 1) {
        return fail(AGENT_ERROR_CODES.invalidArgument, 'provide exactly one of ref, refs[], or path', {
          tool: TOOL,
          timing,
          remediation: 'ref reads one ref, refs[] reads up to ' + String(maxRefs) + ', path reads a workspace file without a ref.',
        })
      }
      if (args.window !== undefined && (!Number.isInteger(args.window) || args.window < 0 || args.window > READ_MAX_WINDOW)) {
        return fail(AGENT_ERROR_CODES.invalidArgument, 'window must be an integer between 0 and ' + String(READ_MAX_WINDOW), { tool: TOOL, timing })
      }
      if (args.line !== undefined && (!Number.isInteger(args.line) || args.line < 1)) {
        return fail(AGENT_ERROR_CODES.invalidArgument, 'line must be a positive integer', { tool: TOOL, timing })
      }
      const requestedMaxBytes = typeof args.maxBytes === 'number' && Number.isFinite(args.maxBytes) ? Math.trunc(args.maxBytes) : READ_DEFAULT_MAX_BYTES
      if (requestedMaxBytes < 1) {
        return fail(AGENT_ERROR_CODES.invalidArgument, 'maxBytes must be a positive integer', { tool: TOOL, timing })
      }
      const maxBytes = Math.min(READ_MAX_BYTES, requestedMaxBytes)
      const targetWindow = args.window ?? 0
      const targets: ReadTarget[] = refsArg === undefined
        ? [refArg === '' ? { kind: 'path' as const, path: pathArg } : { kind: 'ref' as const, ref: refArg }]
        : refsArg.map(ref => ({ kind: 'ref' as const, ref }))
      if (targets.length === 0) {
        return fail(AGENT_ERROR_CODES.invalidArgument, 'refs must contain 1-' + String(maxRefs) + ' refs', { tool: TOOL, timing })
      }
      if (targets.length > maxRefs) {
        return fail(AGENT_ERROR_CODES.invalidArgument, 'too many refs: ' + String(targets.length) + ' (at most ' + String(maxRefs) + ')', {
          tool: TOOL,
          timing,
          remediation: 'Split the batch or raise its focus; locator_find returns refs in pages.',
        })
      }
      const cwd = exec?.agent?.session?.header?.cwd
      const ctx: ReadContext = {
        roots: rt.roots,
        ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
        exec,
        resolveTool,
        citeTool,
      }
      const outcomes: TargetOutcome[] = []
      for (const target of targets) outcomes.push(await readTarget(target, mode, args.line, targetWindow, maxBytes, ctx))
      const failed = outcomes.filter(outcome => !outcome.ok)
      const single = refsArg === undefined
      if (single && failed.length === 1) {
        const failure = failed[0]
        if (failure !== undefined && !failure.ok) return failureEnvelope(TOOL, failure.error, timing)
      }
      if (failed.length === outcomes.length && outcomes.length > 0) {
        const first = failed[0]
        const error = first !== undefined && !first.ok ? first.error : errorInfo(AGENT_ERROR_CODES.internal, 'all targets failed')
        return fail(error.code, String(failed.length) + '/' + String(outcomes.length) + ' targets failed; first error: ' + error.message, {
          tool: TOOL,
          timing,
          ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
          details: { codes: failed.map(outcome => outcome.ok ? '' : outcome.error.code) },
        })
      }
      const items: ReadItem[] = outcomes.map(outcome => outcome.ok
        ? outcome.item
        : {
            ...(outcome.targetKind === 'ref' ? { ref: outcome.target } : { path: outcome.target }),
            error: outcome.error,
          })
      const dropped = outcomes.reduce((total, outcome) => total + (outcome.ok ? outcome.dropped : 0), 0)
      return succeed(TOOL, {
        items,
        counts: { requested: outcomes.length, returned: outcomes.length - failed.length, failed: failed.length },
        budget: readBudget(items, dropped, maxBytes, outcomes.length),
      }, timing)
    },
  })
}

export { READ_MODES }
