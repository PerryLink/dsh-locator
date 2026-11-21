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

// ---------------------------------------------------------------------------
// AI-facing result contract (0.21.1): page sizing, page advances, truncation
// reporting, structured errors/warnings and compact evidence.
//
// These helpers are pure and shared by locator_search, locator_find and the
// HTTP search route, so every surface reports the same paging arithmetic. The
// invariant they enforce: a page's nextOffset points at the first raw store row
// that was NOT consumed by this page, so consecutive pages never lose a hit and
// never return a duplicate. Rows the scope rules removed (or the caller's
// workspace narrowing) never have to be fetched again; rows the output budget
// removed are valid hits and stay reachable on the next page.
// ---------------------------------------------------------------------------

/** Parse and clamp the shared page-size arguments (min of limit/headLimit wins). */
export function pageSize(limit: number | undefined, headLimit: number | undefined, max: number, fallback = 10): number {
  const candidates = [limit, headLimit].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const requested = candidates.length === 0 ? fallback : Math.min(...candidates)
  return Math.max(1, Math.min(max, Math.trunc(requested)))
}

/** Effective soft output budget: the caller argument overrides the configured default; 0 disables. */
export function outputBudgetOf(requested: number | undefined, fallback: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return fallback
  return Math.max(0, Math.trunc(requested))
}

/** Row-level detail requested by the caller; full keeps the evidence fields. */
export type HitDetail = 'full' | 'compact'

/** Default evidence-bearing rows: the rest of a long page keeps only the cheap fields. */
export const DEFAULT_EVIDENCE_LIMIT = 10
/** Hard cap for a caller-provided evidenceLimit. */
export const MAX_EVIDENCE_LIMIT = 50

/** Resolve the effective evidenceLimit (compact mode never carries evidence). */
export function evidenceLimitOf(detail: HitDetail, requested: number | undefined, fallback = DEFAULT_EVIDENCE_LIMIT): number {
  if (detail === 'compact') return 0
  if (requested === undefined) return fallback
  // Internal callers that need every row enriched (locator_explore's merged
  // digest) request an unbounded limit; the host schema caps model input at 50.
  if (requested === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY
  if (!Number.isFinite(requested)) return fallback
  return Math.max(0, Math.min(MAX_EVIDENCE_LIMIT, Math.trunc(requested)))
}

/** Whether the hit at this page position still carries evidence fields. */
export function evidenceVisible(index: number, detail: HitDetail, evidenceLimit: number): boolean {
  return detail === 'full' && index < evidenceLimit
}

/** Evidence-only fields (ref is the citable identity and is always kept). */
const EVIDENCE_FIELDS = ['hash', 'provenance', 'freshness', 'permissions', 'refStatus', 'modified', 'seq', 'eventRef'] as const

/** Drop the evidence-only fields from one hit; compact mode and surplus evidence rows. */
export function stripHitEvidence<T extends Record<string, unknown>>(hit: T): T {
  const copy: Record<string, unknown> = { ...hit }
  for (const field of EVIDENCE_FIELDS) delete copy[field]
  return copy as T
}

/** Stable machine-readable error codes (additive errorInfo.code values). */
export const ERROR_CODES = {
  invalidArguments: 'invalid-arguments',
  queryEmpty: 'query-empty',
  queryInvalid: 'query-invalid',
  contentIndexUnavailable: 'content-index-unavailable',
  nameIndexUnavailable: 'name-index-unavailable',
  contentIndexBuilding: 'content-index-building',
  contentIndexError: 'content-index-error',
  contentPathDenied: 'content-path-denied',
  contentScopeDenied: 'content-scope-denied',
  sessionNotAuthorized: 'session-not-authorized',
  queryTooShort: 'content-query-too-short',
  queryTooLong: 'content-query-too-long',
  queryTooManyTerms: 'content-query-too-many-terms',
  queryCancelled: 'content-search-cancelled',
  engineError: 'engine-error',
  indexError: 'index-error',
  contentBuildRunning: 'content-build-running',
  requestFailed: 'request-failed',
  requestAborted: 'request-aborted',
  invalidJson: 'invalid-json',
  bodyTooLarge: 'body-too-large',
  unsupportedMediaType: 'unsupported-media-type',
  methodNotAllowed: 'method-not-allowed',
} as const

/** Union of the stable error codes this plugin emits. */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** Structured error detail carried next to the legacy error string. */
export interface ErrorInfo {
  /** Stable machine-readable code (see ERROR_CODES). */
  code: string
  /** Human-readable message (mirrors the legacy error string). */
  message: string
  /** True when the same call may succeed on retry. */
  retryable?: boolean
  /** One actionable sentence for the caller. */
  hint?: string
}

/** Known code hints: retryability plus one actionable sentence. */
const ERROR_HINTS: Readonly<Record<string, { retryable?: boolean; hint: string }>> = {
  [ERROR_CODES.contentIndexUnavailable]: {
    retryable: false,
    hint: 'The content index is disabled in this profile; use mode "names" or enable the content index.',
  },
  [ERROR_CODES.nameIndexUnavailable]: {
    retryable: true,
    hint: 'The name index is not ready yet; retry once and check locator_status if it persists.',
  },
  [ERROR_CODES.contentIndexBuilding]: {
    retryable: true,
    hint: 'The content index is still building; retry when locator_status reports building: false.',
  },
  [ERROR_CODES.contentIndexError]: {
    retryable: true,
    hint: 'The content index failed; check content.error and content.warnings in locator_status.',
  },
  [ERROR_CODES.contentPathDenied]: {
    retryable: false,
    hint: 'The path must be inside the configured index roots.',
  },
  [ERROR_CODES.contentScopeDenied]: {
    retryable: false,
    hint: 'A configured notSearchable/notReadable/notIndexed scope rule excludes this path.',
  },
  [ERROR_CODES.sessionNotAuthorized]: {
    retryable: false,
    hint: 'Session ids must belong to the caller workspace or its authorized session set.',
  },
  [ERROR_CODES.queryTooShort]: {
    retryable: false,
    hint: 'Every content query term must be at least 3 code points; a 2-character query only works through contentShortQueryFallback.',
  },
  [ERROR_CODES.queryTooLong]: {
    retryable: false,
    hint: 'Shorten the query to at most 256 code points.',
  },
  [ERROR_CODES.queryTooManyTerms]: {
    retryable: false,
    hint: 'Use at most 32 terms per content query.',
  },
  [ERROR_CODES.queryCancelled]: {
    retryable: true,
    hint: 'The content query was cancelled; retry it.',
  },
  [ERROR_CODES.engineError]: {
    retryable: true,
    hint: 'The index engine failed; retry once and check locator_status if the error persists.',
  },
  [ERROR_CODES.indexError]: {
    retryable: true,
    hint: 'The index returned an error; retry once and check locator_status if it persists.',
  },
  [ERROR_CODES.contentBuildRunning]: {
    retryable: true,
    hint: 'A content build is already running; retry when locator_status reports building: false.',
  },
  [ERROR_CODES.requestFailed]: {
    retryable: true,
    hint: 'Retry the request; for 4xx responses check the JSON body and content-type.',
  },
  [ERROR_CODES.requestAborted]: {
    retryable: true,
    hint: 'The client disconnected and cancelled the request; retry it.',
  },
  [ERROR_CODES.invalidJson]: {
    retryable: false,
    hint: 'Send one JSON object body with content-type application/json.',
  },
  [ERROR_CODES.bodyTooLarge]: {
    retryable: false,
    hint: 'Send a request body below the documented cap (64 KiB for tool routes).',
  },
  [ERROR_CODES.unsupportedMediaType]: {
    retryable: false,
    hint: 'Use content-type: application/json.',
  },
  [ERROR_CODES.methodNotAllowed]: {
    retryable: false,
    hint: 'Use the HTTP method listed in the Allow response header.',
  },
  [ERROR_CODES.queryEmpty]: {
    retryable: false,
    hint: 'Pass a non-empty query.',
  },
  [ERROR_CODES.queryInvalid]: {
    retryable: false,
    hint: 'Rewrite the query with the documented Everything-style syntax.',
  },
  [ERROR_CODES.invalidArguments]: {
    retryable: false,
    hint: 'Check the argument types and ranges declared by the tool schema.',
  },
}

/** Build the additive structured error block for one failed call. */
export function errorInfoOf(code: string, message?: string, overrides?: { retryable?: boolean; hint?: string }): ErrorInfo {
  const known = ERROR_HINTS[code]
  const retryable = overrides?.retryable ?? known?.retryable
  const hint = overrides?.hint ?? known?.hint
  return {
    code,
    message: message === undefined || message === '' ? code : message,
    ...(retryable === undefined ? {} : { retryable }),
    ...(hint === undefined ? {} : { hint }),
  }
}

/** Hint per warning code; keeps the legacy string warnings while adding the actionable sentence. */
export const WARNING_HINTS: Readonly<Record<string, string>> = {
  'workspace-empty': 'No matches under the caller workspace. Pass scope:"all" to search every configured root.',
  'query-degraded': 'The query was answered by the bounded short-query fallback; this page is approximate. Use a longer query (at least 3 characters per term) for exact results.',
  'bounded-count': 'The count is a lower bound. Raise countLimit (max 5000) or narrow the query for an exact count.',
  'total-is-global': 'total/totalCount are match counts across all configured roots, not the filtered workspace subset.',
  'scope-filtered': 'Rows were removed by the configured notSearchable/notReadable/notIndexed scope rules.',
  'content-index-building': 'The content index is still building; results and counts grow until it finishes.',
  'context-lines-ignored-in-names-mode': 'contextLines only applies to content mode; names mode returns names and paths only.',
}

/** Look up hints for the warning codes present in one result. */
export function warningHintsOf(codes: Iterable<string>): Record<string, string> | undefined {
  const hints: Record<string, string> = {}
  for (const code of codes) {
    const hint = WARNING_HINTS[code]
    if (hint !== undefined && hints[code] === undefined) hints[code] = hint
  }
  return Object.keys(hints).length === 0 ? undefined : hints
}

/** Declared errorInfo block for output schemas. */
export const ERROR_INFO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true, description: 'Stable machine-readable error code.' },
    message: { type: 'string', required: true, description: 'Human-readable message (same as the legacy error string).' },
    retryable: { type: 'boolean', description: 'True when the same call may succeed on retry.' },
    hint: { type: 'string', description: 'One actionable sentence for the caller.' },
  },
} as const

/** Declared warningHints block for output schemas (warning code -> hint). */
export const WARNING_HINTS_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: 'One actionable hint per warning code present in warnings (code -> hint).',
} as const

/** Why a page was truncated: more rows, the output budget, or the scope filter. */
export interface PageTruncation {
  /** Primary reason this page stopped before the caller asked it to. */
  reason: 'page' | 'budget' | 'scope' | 'maxRefs'
  /** Raw rows dropped or deferred by this page (scope + budget). */
  dropped: number
  /** Raw store rows consumed by this page (nextOffset - offset). */
  consumed: number
}

/** Paging arithmetic for one page: next cursor, hasMore and the truncation block. */
export interface PageAdvance {
  /** Offset of the next page; absent when this page exhausted the result set. */
  nextOffset?: number
  /** True when paging further can still return rows. */
  hasMore: boolean
  /** Raw store rows consumed by this page. */
  consumed: number
  /** True when more rows exist beyond what was returned (same as hasMore). */
  truncated: boolean
  /** Present only when the page was truncated. */
  truncation?: PageTruncation
}

/** One raw row removed from a page, with the reason it is not returned. */
export interface PageDrop {
  /** Position of the row in the store's original ordering. */
  index: number
  /** scope: can never be returned under the current scope; budget: valid but deferred. */
  reason: 'scope' | 'budget'
}

/** Inputs for pageAdvance. */
export interface PageAdvanceInput {
  /** Requested offset of the page. */
  offset: number
  /** Raw rows the store returned for this page. */
  fetchedRows: number
  /** Original store positions of the rows actually returned, ascending. */
  keptIndices: readonly number[]
  /** Rows removed by the scope rules, the workspace narrowing or the budget. */
  dropped: readonly PageDrop[]
  /** True when rows exist beyond the fetched window, or valid fetched rows were left unscanned. */
  more: boolean
}

/** Declared truncation block for output schemas. */
export const TRUNCATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: { type: 'string', enum: ['page', 'budget', 'scope', 'maxRefs'], description: 'Primary reason this page was truncated.' },
    dropped: { type: 'integer', description: 'Raw rows dropped or deferred by this page (scope + budget).' },
    consumed: { type: 'integer', description: 'Raw store rows this page consumed (nextOffset - offset).' },
  },
} as const

/**
 * Compute the next cursor for one page so consecutive pages never lose a hit
 * and never duplicate one.
 *
 * The cursor lands after the last returned row. Rows the scope removed
 * immediately after it are skipped (they can never be returned in this scope);
 * a budget-dropped row stops the skip because it is a valid hit the next page
 * must still deliver. When valid rows remain unscanned (more), the cursor
 * points at the first of them.
 * @param input - page offset, rows returned/dropped and whether more rows exist.
 * @returns the page advance contract (nextOffset/hasMore/consumed/truncation).
 */
export function pageAdvance(input: PageAdvanceInput): PageAdvance {
  const offset = Math.max(0, Math.trunc(input.offset))
  const fetchedRows = Math.max(0, Math.trunc(input.fetchedRows))
  const keptIndices = input.keptIndices.filter(index => Number.isInteger(index) && index >= offset)
  const lastKept = keptIndices.length > 0 ? keptIndices[keptIndices.length - 1]! : offset - 1
  const dropByIndex = new Map<number, PageDrop['reason']>()
  for (const drop of input.dropped) dropByIndex.set(drop.index, drop.reason)
  let boundary = lastKept + 1
  // Rows the scope permanently removed right after the page are consumed too:
  // fetching them again would only burn a request per dropped row.
  while (dropByIndex.get(boundary) === 'scope') boundary += 1
  const budgetPending = dropByIndex.get(boundary) === 'budget'
  let hasMore = input.more || budgetPending
  if (hasMore && boundary <= offset) {
    // Defensive: a store that claims more rows but returned none must not loop.
    if (fetchedRows === 0) hasMore = false
    else boundary = offset + fetchedRows
  }
  const consumed = hasMore ? boundary - offset : fetchedRows
  const dropped = input.dropped.length
  const reason: PageTruncation['reason'] = input.dropped.some(entry => entry.reason === 'budget')
    ? 'budget'
    : dropped > 0
      ? 'scope'
      : 'page'
  return {
    hasMore,
    truncated: hasMore,
    consumed,
    ...(hasMore ? { nextOffset: offset + consumed, truncation: { reason, dropped, consumed } } : {}),
  }
}

/** One page selected from a raw store page. */
export interface SelectedPage<T> {
  /** Rows actually returned (scope-filtered, limit-sliced and budget-trimmed). */
  items: T[]
  /** Original store positions of items, ascending. */
  keptIndices: number[]
  /** Rows removed by the scope filter or deferred by the output budget. */
  dropped: PageDrop[]
  /** Budget report for the returned rows. */
  budget: OutputBudget
  /** Valid rows beyond the limit that were not scanned (paging still has more). */
  unscanned: number
}

/**
 * Select one final page from a raw store page: drop rows outside the scope,
 * slice to the page size, then trim to the JSON output budget.
 * @param raw - raw store rows in result order.
 * @param limit - maximum rows this page may return (final slice).
 * @param limitChars - soft JSON budget; 0/negative disables it.
 * @param keep - scope predicate: false rows can never be returned.
 * @returns the kept rows, their raw positions, drop details and the budget report.
 */
export function selectPage<T>(raw: readonly T[], limit: number, limitChars: number, keep: (item: T) => boolean): SelectedPage<T> {
  const pageLimit = Math.max(1, Math.trunc(limit))
  const candidates: T[] = []
  const keptIndices: number[] = []
  const dropped: PageDrop[] = []
  let unscanned = 0
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index]!
    if (!keep(item)) {
      dropped.push({ index, reason: 'scope' })
      continue
    }
    if (candidates.length >= pageLimit) {
      unscanned += 1
      continue
    }
    candidates.push(item)
    keptIndices.push(index)
  }
  const budgeted = applyOutputBudget(candidates, limitChars)
  for (let index = budgeted.items.length; index < candidates.length; index++) {
    dropped.push({ index: keptIndices[index]!, reason: 'budget' })
  }
  return {
    items: budgeted.items,
    keptIndices: keptIndices.slice(0, budgeted.items.length),
    dropped,
    budget: budgeted.budget,
    unscanned,
  }
}

/** Which role one raw name-index hit plays in a workspace page. */
export type NameKeepDecision = 'keep' | 'narrow' | 'scope'

/** Structural name hit accepted by fetchNamePage. */
export interface NamePageHit {
  path: string
}

/** Structural name page accepted by fetchNamePage. */
export interface NamePageResult<H extends NamePageHit> {
  total: number
  truncated?: boolean
  indexing?: boolean
  tookNs?: number
  hits: H[]
}

/** Options for fetchNamePage. */
export interface NamePageOptions<H extends NamePageHit> {
  /** Requested raw offset (pagination). */
  offset: number
  /** Maximum hits this page may return (final slice). */
  limit: number
  /** Classify one hit: keep it, drop it for workspace narrowing, or drop it for a scope rule. */
  keep: (hit: H) => NameKeepDecision
  /** First window size (the caller sizes this from limit and maxResults). */
  fetchSize: number
  /** Upper bound of raw rows fetched by one tool call (default 250). */
  maxRows?: number
  /** Follow-up window size once the first window did not fill the page (default max(100, 2*fetchSize)). */
  followSize?: number
}

/** One workspace page filled from one or more name-index windows. */
export interface NamePageSelection<H extends NamePageHit> {
  /** Hits kept by the scope/narrowing predicates, sliced to the page limit. */
  items: H[]
  /** Original store positions of items, ascending (paging/cursor math). */
  indices: number[]
  total: number
  indexing?: boolean
  /** Wall-clock cost of the windows fetched for this page, in ms. */
  tookMs: number
  /** Hits dropped by the workspace/pathPrefix narrowing (not by scope rules). */
  narrowed: number
  /** Hits dropped by the configured scope rules. */
  scopeDropped: number
  /** True when the store reports more rows beyond this page. */
  more: boolean
  /** Raw store rows fetched while filling this page. */
  rawConsumed: number
  /** Raw rows removed by the scope rules/narrowing (positions in the store order). */
  dropped: PageDrop[]
}

/**
 * Fetch one workspace page from the name index, filling the page past rows the
 * cwd/pathPrefix narrowing drops. A page that cannot be filled within the row
 * bound returns what it found; the caller applies the output budget to its
 * mapped rows and computes the cursor with pageAdvance, so the budget measures
 * the payload actually returned.
 * @param fetch - one name-index query (usually the runtime's search).
 * @param options - offset/limit, keep classifier and window sizing.
 * @returns the filled page plus the raw positions/drop details the cursor needs.
 */
export async function fetchNamePage<H extends NamePageHit>(
  fetch: (args: { limit: number; offset: number }) => Promise<NamePageResult<H>>,
  options: NamePageOptions<H>,
): Promise<NamePageSelection<H>> {
  const limit = Math.max(1, Math.trunc(options.limit))
  const maxRows = Math.max(limit, Math.trunc(options.maxRows ?? 250))
  const firstSize = Math.max(1, Math.min(Math.trunc(options.fetchSize), maxRows))
  const followSize = Math.max(
    firstSize,
    Math.min(maxRows, Math.trunc(options.followSize ?? Math.max(firstSize * 2, 100))),
  )
  const candidates: H[] = []
  const candidateIndices: number[] = []
  const dropped: PageDrop[] = []
  let narrowed = 0
  let scopeDropped = 0
  let unscanned = 0
  let cursor = Math.max(0, Math.trunc(options.offset))
  let consumedRows = 0
  let more = true
  let total = 0
  let indexing: boolean | undefined
  let tookMs = 0
  let calls = 0
  while (candidates.length < limit && consumedRows < maxRows && more) {
    const remaining = maxRows - consumedRows
    const size = calls === 0 ? Math.min(firstSize, remaining) : Math.min(followSize, remaining)
    calls += 1
    if (size <= 0) break
    const page = await fetch({ limit: size, offset: cursor })
    if (typeof page.total === 'number' && Number.isFinite(page.total)) total = page.total
    if (page.indexing === true) indexing = true
    if (typeof page.tookNs === 'number' && Number.isFinite(page.tookNs)) tookMs += page.tookNs / 1e6
    more = page.truncated === true
    const hits = Array.isArray(page.hits) ? page.hits : []
    if (hits.length === 0) {
      more = false
      break
    }
    for (let index = 0; index < hits.length; index++) {
      const hit = hits[index]!
      const decision = options.keep(hit)
      if (decision !== 'keep') {
        if (decision === 'narrow') narrowed += 1
        else scopeDropped += 1
        dropped.push({ index: cursor + index, reason: 'scope' })
        continue
      }
      if (candidates.length >= limit) {
        unscanned += 1
        continue
      }
      candidates.push(hit)
      candidateIndices.push(cursor + index)
    }
    cursor += hits.length
    consumedRows += hits.length
  }
  return {
    items: candidates,
    indices: candidateIndices,
    total,
    ...(indexing === undefined ? {} : { indexing }),
    tookMs,
    narrowed,
    scopeDropped,
    more: more || unscanned > 0,
    rawConsumed: consumedRows,
    dropped,
  }
}
