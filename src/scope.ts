/**
 * Scope rules, result budgets and opt-in external command hooks.
 *
 * Three layers of ignore semantics keep "indexed", "searchable" and "readable"
 * separate, the same split Cursor/Devin-style ignore files and the host's own
 * file tools use:
 *
 *  - notIndexed  — must not enter the content index (extractors skip it).
 *  - notSearchable — still indexed, but never returned as a hit.
 *  - notReadable  — may be named (path/size), but its body/ref must not be
 *    returned and ref resolution has to refuse it.
 *
 * Patterns are gitignore-flavored globs over absolute paths:
 *  - no slash: matches any path segment (node_modules, *.min.js);
 *  - a slash: matches a trailing path suffix (build/**, docs/private/*);
 *  - leading '/': anchored at the path root;
 *  - '*' stays inside one segment, '**' spans segments, '?' is one character;
 *  - '!' negates an earlier match (last matching pattern wins);
 *  - matching is case-insensitive on Windows (the filesystem is), exact on
 *    macOS/Linux.
 *
 * The same module also holds the two cross-cutting primitives the tools share:
 * the output budget that keeps one tool result inside outputBudgetChars, and the
 * opt-in external command hooks (rerankCommand, ocrCommand). Hooks run without a
 * shell: the configured string is split into argv (quotes supported) and spawned
 * directly, so a config value can never inject a shell pipeline. Both are
 * disabled by default (empty string); a broken rerank hook produces a warning,
 * never a failed query.
 * @module dsh-locator/scope
 */

import { spawn } from 'node:child_process'

/** The three configured pattern layers. */
export interface ScopeRules {
  /** Globs never returned as name or content hits. */
  notSearchable: readonly string[]
  /** Globs whose body/ref must not be returned or resolved. */
  notReadable: readonly string[]
  /** Globs that must not enter the content index (name index keeps them). */
  notIndexed: readonly string[]
}

/** A public summary of the effective scope rules (status output). */
export interface ScopeDescription {
  notSearchable: string[]
  notReadable: string[]
  notIndexed: string[]
  /** Number of distinct glob patterns in force. */
  activeRules: number
}

/** Anything with a path can be filtered by a scope rule. */
export interface Pathed {
  path: string
}

const WINDOWS = process.platform === 'win32'

/** Options for the glob matcher; tests pin the platform behavior explicitly. */
export interface GlobOptions {
  /** Compare case-insensitively (defaults to the platform filesystem rule). */
  caseInsensitive?: boolean
}

/**
 * Normalize one path for glob matching: forward slashes, no trailing slash,
 * lowercased when the comparison is case-insensitive.
 * @param path - raw absolute path.
 * @param caseInsensitive - lowercase the result (Windows by default).
 * @returns the normalized path.
 */
export function normalizeGlobPath(path: string, caseInsensitive = WINDOWS): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

/** Whether one pattern is a negation (!pattern). */
function isNegated(pattern: string): boolean {
  return pattern.startsWith('!') && pattern.length > 1
}

interface CompiledPattern {
  negated: boolean
  /** No slash: every path segment is a candidate. */
  basenameOnly: boolean
  /** Leading slash: match from the first segment. */
  absolute: boolean
  segments: readonly string[]
}

/** Compile one glob into its segment form; undefined for empty/comment-ish input. */
function compilePattern(raw: string): CompiledPattern | undefined {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '!' || trimmed.startsWith('#')) return undefined
  const negated = isNegated(trimmed)
  const pattern = (negated ? trimmed.slice(1) : trimmed).replace(/\\/g, '/')
  const absolute = pattern.startsWith('/')
  const body = absolute ? pattern.slice(1) : pattern
  const segments = body.split('/').filter(segment => segment !== '')
  if (segments.length === 0) return undefined
  return {
    negated,
    basenameOnly: !absolute && segments.length === 1,
    absolute,
    segments,
  }
}

/** Escape one literal character for a regular expression. */
function escapeRegExp(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch
}

/** Regex for one glob segment; '*' and '?' never cross the segment boundary. */
function segmentRegExp(segment: string, caseInsensitive: boolean): RegExp {
  let source = ''
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (ch === '*') {
      // Collapse a run of stars inside one segment; '**' is handled above.
      while (segment[i + 1] === '*') i++
      source += '[^/]*'
      continue
    }
    if (ch === '?') {
      source += '[^/]'
      continue
    }
    if (ch === '[') {
      const end = segment.indexOf(']', i + 1)
      if (end > i + 1) {
        const body = segment.slice(i + 1, end)
        source += '[' + body.replace(/\\/g, '\\\\') + ']'
        i = end
        continue
      }
      source += '\\['
      continue
    }
    if (ch === '\\' && i + 1 < segment.length) {
      source += escapeRegExp(segment[i + 1]!)
      i++
      continue
    }
    source += escapeRegExp(ch)
  }
  return new RegExp('^' + source + '$', caseInsensitive ? 'i' : '')
}

const SEGMENT_CACHE = new Map<string, RegExp>()

/** One compiled segment regex per (case mode, segment) pair. */
function cachedSegmentRegExp(segment: string, caseInsensitive: boolean): RegExp {
  const key = (caseInsensitive ? 'i:' : 's:') + segment
  const existing = SEGMENT_CACHE.get(key)
  if (existing !== undefined) return existing
  const compiled = segmentRegExp(segment, caseInsensitive)
  SEGMENT_CACHE.set(key, compiled)
  return compiled
}

/** Whether a compiled segment list matches a path segment window. */
function matchSegments(
  pattern: readonly string[],
  path: readonly string[],
  offset: number,
  caseInsensitive: boolean,
): boolean {
  const memo = new Map<string, boolean>()
  const visit = (pi: number, hi: number): boolean => {
    const key = String(pi) + ':' + String(hi)
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    let result: boolean
    if (pi === pattern.length) {
      result = hi === path.length
    } else {
      const segment = pattern[pi]!
      if (segment === '**') {
        result = visit(pi + 1, hi) || (hi < path.length && visit(pi, hi + 1))
      } else {
        result = hi < path.length && cachedSegmentRegExp(segment, caseInsensitive).test(path[hi]!) && visit(pi + 1, hi + 1)
      }
    }
    memo.set(key, result)
    return result
  }
  return visit(0, offset)
}

/**
 * Compile a pattern list into one predicate (gitignore order; '!' undoes an
 * earlier match, so the last matching pattern wins).
 * @param patterns - configured glob strings.
 * @param options - matching options.
 * @returns a predicate over absolute paths.
 */
export function compileGlobMatcher(patterns: readonly string[], options: GlobOptions = {}): (path: string) => boolean {
  const caseInsensitive = options.caseInsensitive ?? WINDOWS
  const compiled: CompiledPattern[] = []
  for (const raw of patterns) {
    const pattern = compilePattern(raw)
    if (pattern !== undefined) compiled.push(pattern)
  }
  if (compiled.length === 0) return () => false
  return (path: string): boolean => {
    const normalized = normalizeGlobPath(path, caseInsensitive)
    if (normalized === '') return false
    const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.')
    if (segments.length === 0) return false
    let matched = false
    for (const pattern of compiled) {
      if (!patternMatches(pattern, segments, caseInsensitive)) continue
      matched = !pattern.negated
    }
    return matched
  }
}

/** Whether one compiled pattern matches one normalized path. */
function patternMatches(pattern: CompiledPattern, segments: readonly string[], caseInsensitive: boolean): boolean {
  if (pattern.basenameOnly) {
    const regex = cachedSegmentRegExp(pattern.segments[0]!, caseInsensitive)
    return segments.some(segment => regex.test(segment))
  }
  if (pattern.absolute) return matchSegments(pattern.segments, segments, 0, caseInsensitive)
  // A relative multi-segment pattern is a trailing suffix: try every start.
  for (let start = 0; start < segments.length; start++) {
    if (matchSegments(pattern.segments, segments, start, caseInsensitive)) return true
  }
  return false
}

/** Whether any pattern matches (negations applied in order). */
export function matchesAnyGlob(path: string, patterns: readonly string[], options: GlobOptions = {}): boolean {
  return compileGlobMatcher(patterns, options)(path)
}

/** One-shot glob test (compiles on every call; prefer compileGlobMatcher). */
export function matchesGlob(path: string, pattern: string, options: GlobOptions = {}): boolean {
  return matchesAnyGlob(path, [pattern], options)
}

/** One matched path and the layer that refused it. */
export type ScopeLayer = 'searchable' | 'readable' | 'indexed'

/** Result of filtering a hit list through the scope. */
export interface ScopeFilterResult<T> {
  hits: T[]
  /** Hits removed by a not* rule. */
  dropped: number
  /** Which layers removed something (for a bounded warning code). */
  layers: ScopeLayer[]
}

/** The default (empty) scope: everything is searchable, readable and indexable. */
export const EMPTY_SCOPE_RULES: ScopeRules = { notSearchable: [], notReadable: [], notIndexed: [] }

/**
 * Layered ignore scope: one matcher per layer, plus list filters the tools use
 * before building their output.
 */
export class Scope {
  readonly rules: ScopeRules
  private readonly searchableMatcher: (path: string) => boolean
  private readonly readableMatcher: (path: string) => boolean
  private readonly indexedMatcher: (path: string) => boolean

  constructor(rules: ScopeRules, caseInsensitive = WINDOWS) {
    this.rules = {
      notSearchable: [...rules.notSearchable],
      notReadable: [...rules.notReadable],
      notIndexed: [...rules.notIndexed],
    }
    this.searchableMatcher = compileGlobMatcher(this.rules.notSearchable, { caseInsensitive })
    this.readableMatcher = compileGlobMatcher(this.rules.notReadable, { caseInsensitive })
    this.indexedMatcher = compileGlobMatcher(this.rules.notIndexed, { caseInsensitive })
  }

  /** Whether a path may appear in any hit list. */
  isSearchable(path: string): boolean {
    return !this.searchableMatcher(path)
  }

  /** Whether a path's body/ref may be returned or resolved. */
  isReadable(path: string): boolean {
    return !this.readableMatcher(path)
  }

  /** Whether a path may enter the content index at all. */
  isIndexable(path: string): boolean {
    return !this.indexedMatcher(path)
  }

  /** Whether a content hit for this path may be shown (all three layers). */
  contentVisible(path: string): boolean {
    return this.isSearchable(path) && this.isReadable(path) && this.isIndexable(path)
  }

  /**
   * The read permission block for one path, ready for a hit/resolve output.
   * Ref-tools should call this before reading a file body; a denied path must
   * answer content-path-denied instead of leaking bytes.
   */
  readability(path: string): { read: 'allowed' | 'denied'; reason: string } {
    return this.isReadable(path)
      ? { read: 'allowed', reason: 'path is readable under the configured scope rules' }
      : { read: 'denied', reason: 'path matches a configured notReadable glob' }
  }

  /** Drop non-searchable name/content hits. */
  filterSearchable<T extends Pathed>(hits: readonly T[]): ScopeFilterResult<T> {
    const kept: T[] = []
    const layers = new Set<ScopeLayer>()
    for (const hit of hits) {
      if (this.isSearchable(hit.path)) kept.push(hit)
      else layers.add('searchable')
    }
    return { hits: kept, dropped: hits.length - kept.length, layers: [...layers] }
  }

  /** Drop content hits that are not searchable, readable or indexable. */
  filterContent<T extends Pathed>(hits: readonly T[]): ScopeFilterResult<T> {
    const kept: T[] = []
    const layers = new Set<ScopeLayer>()
    for (const hit of hits) {
      if (!this.isSearchable(hit.path)) { layers.add('searchable'); continue }
      if (!this.isIndexable(hit.path)) { layers.add('indexed'); continue }
      if (!this.isReadable(hit.path)) { layers.add('readable'); continue }
      kept.push(hit)
    }
    return { hits: kept, dropped: hits.length - kept.length, layers: [...layers] }
  }

  /** Bounded, JSON-safe summary for locator_status and the HTTP status route. */
  describe(): ScopeDescription {
    const active = new Set(
      [...this.rules.notSearchable, ...this.rules.notReadable, ...this.rules.notIndexed]
        .map(rule => rule.trim())
        .filter(rule => rule !== '' && rule !== '!'),
    )
    return {
      notSearchable: [...this.rules.notSearchable],
      notReadable: [...this.rules.notReadable],
      notIndexed: [...this.rules.notIndexed],
      activeRules: active.size,
    }
  }
}

/** The empty scope shared by callers that did not configure any rule. */
export const NO_SCOPE = new Scope(EMPTY_SCOPE_RULES)

/** Build a scope from the plugin configuration (all fields are optional). */
export function scopeFromConfig(config: Partial<ScopeRules>): Scope {
  return new Scope({
    notSearchable: config.notSearchable ?? [],
    notReadable: config.notReadable ?? [],
    notIndexed: config.notIndexed ?? [],
  })
}

/**
 * Whether a scope refuses to read one path. Exported as the public hook the
 * ref/resolve layer consumes: a denied path must answer content-path-denied
 * with permissions.read = "denied" and must not read any bytes.
 */
export function readableDenial(scope: Scope, path: string): string | undefined {
  return scope.isReadable(path) ? undefined : 'path matches a configured notReadable glob'
}

/** One tool-result budget report; mirrors the additive output schema field. */
export interface OutputBudget {
  limitChars: number
  usedChars: number
  truncated: boolean
  dropped: number
}

/** Default per-tool-result character budget; overridable through config. */
export const DEFAULT_OUTPUT_BUDGET_CHARS = 8_000

/**
 * Trim a hit list so its serialized payload stays inside limitChars.
 *
 * The first item is always kept: an empty result because a single snippet is
 * long would be worse than one oversized preview, and the caller still sees
 * truncated: true. limitChars <= 0 disables the budget (config semantics).
 * @param items - hits/refs in result order.
 * @param limitChars - soft cap in characters (JSON-serialized length).
 * @returns the kept prefix plus its budget report.
 */
export function applyOutputBudget<T>(items: readonly T[], limitChars: number): { items: T[]; budget: OutputBudget } {
  if (!Number.isFinite(limitChars) || limitChars <= 0) {
    return { items: [...items], budget: { limitChars, usedChars: 0, truncated: false, dropped: 0 } }
  }
  const limit = Math.trunc(limitChars)
  const kept: T[] = []
  let used = 0
  for (const item of items) {
    const size = JSON.stringify(item)?.length ?? 0
    if (kept.length > 0 && used + size > limit) break
    kept.push(item)
    used += size
  }
  const dropped = items.length - kept.length
  return {
    items: kept,
    budget: { limitChars: limit, usedChars: used, truncated: dropped > 0 || used > limit, dropped },
  }
}

/** Parsed external command line: executable plus argv tail. */
export interface ParsedCommand {
  file: string
  args: string[]
}

/**
 * Split a configured command string into argv without invoking a shell.
 *
 * Quoting rules: single and double quotes group whitespace, a double-quoted
 * backslash-quote is a literal quote, and backslashes outside quotes are
 * literal (so a Windows path survives). An unbalanced quote is invalid.
 * @param input - configured command string.
 * @returns argv, or undefined for an unbalanced quote / empty program.
 */
export function parseCommandLine(input: string): ParsedCommand | undefined {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let hasToken = false
  const push = (): void => {
    if (!hasToken) return
    tokens.push(current)
    current = ''
    hasToken = false
  }
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quote === "'") {
      if (ch === "'") quote = undefined
      else current += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') { quote = undefined; continue }
      if (ch === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\')) {
        current += input[++i]!
        continue
      }
      current += ch
      continue
    }
    if (ch === "'") { quote = "'"; hasToken = true; continue }
    if (ch === '"') { quote = '"'; hasToken = true; continue }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { push(); continue }
    current += ch
    hasToken = true
  }
  if (quote !== undefined) return undefined
  push()
  const file = tokens.shift()
  if (file === undefined || file === '') return undefined
  return { file, args: tokens }
}

/**
 * Validate one command hook config value. Empty means "disabled" and is valid;
 * a non-empty value must parse into a program. Hooks are never run through a
 * shell, so shell metacharacters are ordinary argv bytes and need no rejection
 * beyond a NUL byte the OS could not pass anyway.
 * @param input - configured command string.
 * @returns an error message for an invalid value, otherwise undefined.
 */
export function validateExternalCommand(input: string): string | undefined {
  const trimmed = input.trim()
  if (trimmed === '') return undefined
  if (trimmed.includes('\u0000')) return 'command must not contain NUL bytes'
  return parseCommandLine(trimmed) === undefined ? 'command has an unbalanced quote or no program' : undefined
}

/** Options shared by both external hooks. */
export interface HookOptions {
  /** Process timeout; the hook is killed and reported as failed after it. */
  timeoutMs?: number
  /** Maximum captured stdout bytes. */
  maxOutputBytes?: number
}

/** Result of running one JSON-speaking external command. */
export type CommandResult =
  | { ok: true; json: unknown }
  | { ok: false; error: string }

const DEFAULT_HOOK_TIMEOUT_MS = 10_000
const DEFAULT_HOOK_MAX_BYTES = 2 * 1024 * 1024

/**
 * Run one external JSON hook: write the payload as JSON on stdin, read the
 * complete stdout, enforce a timeout and an output cap.
 * @param command - configured command string (already validated or not).
 * @param payload - JSON-serializable stdin value.
 * @param options - timeout/output caps.
 * @returns the parsed JSON stdout, or a stable error code.
 */
export async function runJsonCommand(command: string, payload: unknown, options: HookOptions = {}): Promise<CommandResult> {
  const parsed = parseCommandLine(command.trim())
  if (parsed === undefined) return { ok: false, error: 'invalid-command' }
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0 ? Math.trunc(options.timeoutMs!) : DEFAULT_HOOK_TIMEOUT_MS
  const maxBytes = Number.isFinite(options.maxOutputBytes) && (options.maxOutputBytes ?? 0) > 0 ? Math.trunc(options.maxOutputBytes!) : DEFAULT_HOOK_MAX_BYTES
  return await new Promise<CommandResult>(resolve => {
    let settled = false
    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const child = spawn(parsed.file, parsed.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const stdout: Buffer[] = []
    let outBytes = 0
    let stderr = ''
    let overflow = false
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ ok: false, error: 'hook-timeout' })
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      if (overflow) return
      outBytes += chunk.length
      if (outBytes > maxBytes) { overflow = true; return }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_192) stderr += chunk.toString('utf8')
    })
    child.once('error', () => finish({ ok: false, error: 'hook-spawn-failed' }))
    child.once('close', (code, signal) => {
      if (overflow) { finish({ ok: false, error: 'hook-output-too-large' }); return }
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)
        finish({ ok: false, error: 'hook-exit-' + String(code ?? signal) + (detail === '' ? '' : ': ' + detail) })
        return
      }
      const text = Buffer.concat(stdout).toString('utf8').trim()
      if (text === '') { finish({ ok: false, error: 'hook-output-empty' }); return }
      try {
        finish({ ok: true, json: JSON.parse(text) })
      } catch {
        finish({ ok: false, error: 'hook-output-not-json' })
      }
    })
    try {
      child.stdin.end(JSON.stringify(payload ?? null))
    } catch {
      finish({ ok: false, error: 'hook-stdin-failed' })
    }
  })
}

/** One candidate passed to a rerank hook. */
export interface RerankCandidate {
  path: string
  title?: string
  snippet?: string
  score?: number
}

/**
 * The rerank protocol: stdin { query, hits: RerankCandidate[] }; stdout
 * { "order": number[] } with indices into hits (unlisted indices keep their
 * original relative order after the listed ones). A broken hook is a warning,
 * never a failed search: the original order is returned unchanged.
 */
export const RERANK_PROTOCOL = 'rerank/v1'

/**
 * Reorder hits through the configured rerank command.
 * @param command - configured command (empty disables the hook).
 * @param query - the user query the hits answer.
 * @param hits - ranked content hits.
 * @param options - hook timeout/output caps.
 * @returns reordered hits plus warnings (never throws for hook failures).
 */
export async function rerankHits<T extends Pathed>(
  command: string,
  query: string,
  hits: readonly T[],
  options: HookOptions = {},
): Promise<{ hits: T[]; warnings: string[] }> {
  if (command.trim() === '' || hits.length === 0) return { hits: [...hits], warnings: [] }
  const payload = {
    protocol: RERANK_PROTOCOL,
    query,
    hits: hits.map(hit => {
      const candidate = hit as T & { title?: string; snippet?: string; score?: number }
      return {
        path: candidate.path,
        ...(typeof candidate.title === 'string' ? { title: candidate.title } : {}),
        ...(typeof candidate.snippet === 'string' ? { snippet: candidate.snippet } : {}),
        ...(typeof candidate.score === 'number' ? { score: candidate.score } : {}),
      }
    }),
  }
  const result = await runJsonCommand(command, payload, options)
  if (!result.ok) return { hits: [...hits], warnings: ['rerank-failed:' + result.error] }
  const order = rerankOrder(result.json, hits.length)
  if (order === undefined) return { hits: [...hits], warnings: ['rerank-invalid-output'] }
  const reordered: T[] = []
  const seen = new Set<number>()
  for (const index of order) {
    if (seen.has(index)) continue
    seen.add(index)
    reordered.push(hits[index]!)
  }
  for (let index = 0; index < hits.length; index++) {
    if (!seen.has(index)) reordered.push(hits[index]!)
  }
  return { hits: reordered, warnings: [] }
}

/** Validate a rerank hook's { order: number[] } reply. */
function rerankOrder(json: unknown, count: number): number[] | undefined {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined
  const record = json as Record<string, unknown>
  const raw = Array.isArray(record.order) ? record.order : Array.isArray(record.indices) ? record.indices : undefined
  if (raw === undefined) return undefined
  const order: number[] = []
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= count) return undefined
    order.push(value)
  }
  return order
}

/** One OCR request passed to the configured command. */
export interface OcrRequest {
  path: string
  mime?: string
}

/**
 * The OCR protocol: stdin { path, mime? }; stdout { "text": string } (or a bare
 * JSON string). The extraction layer calls this for scanned documents and
 * images; the command is empty by default, so nothing runs unless an operator
 * installs one.
 */
export const OCR_PROTOCOL = 'ocr/v1'

/**
 * Run the optional OCR command for one file.
 * @param command - configured command (empty disables OCR).
 * @param request - file path plus optional MIME hint.
 * @param options - hook caps plus maxChars for the returned text.
 * @returns extracted text, or a stable error code.
 */
export async function runOcrCommand(
  command: string,
  request: OcrRequest,
  options: HookOptions & { maxChars?: number } = {},
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (command.trim() === '') return { ok: false, error: 'ocr-disabled' }
  const payload = {
    protocol: OCR_PROTOCOL,
    path: request.path,
    ...(request.mime === undefined ? {} : { mime: request.mime }),
  }
  const result = await runJsonCommand(command, payload, options)
  if (!result.ok) return { ok: false, error: result.error }
  const json = result.json
  const text = typeof json === 'string'
    ? json
    : typeof json === 'object' && json !== null && typeof (json as { text?: unknown }).text === 'string'
      ? (json as { text: string }).text
      : undefined
  if (text === undefined) return { ok: false, error: 'ocr-output-invalid' }
  const maxChars = Math.max(1, Math.trunc(options.maxChars ?? 200_000))
  return { ok: true, text: text.length > maxChars ? text.slice(0, maxChars) + '…' : text }
}
