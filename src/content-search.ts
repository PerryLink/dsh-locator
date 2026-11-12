/**
 * Content FTS5 query engine: normal substring search, Notepad++-style extended
 * escaping, case-sensitive GLOB matching and whole-word post-filtering, with
 * exact or bounded counts.
 *
 * Shared by the host thread, the search worker and the combined panel search.
 * The page path is deliberately two-phase: rank the rowids first, then read the
 * few bodies and build the snippet in JS. Putting `snippet()` in the same
 * `ORDER BY rank` statement made a SQLite sorter evaluate it for every match
 * (measured 2.7 s for "the" on a 1 GB corpus; 60 ms with this split).
 * @module dsh-locator/content-search
 */

import type { DatabaseSync } from 'node:sqlite'
import type { ContentHit } from './content.ts'

/** How the query text is interpreted. */
export type ContentMatchMode = 'normal' | 'extended' | 'regex'

/** How much work the caller wants the count to spend. */
export type ContentCountMode = 'exact' | 'bounded' | 'none'

/** A match count, with its confidence. `bounded` means "at least value". */
export interface ContentCount {
  value: number
  kind: 'exact' | 'bounded' | 'unknown'
  limit?: number
}

/** Options accepted by {@link searchContent} and the content search worker. */
export interface ContentSearchOptions {
  matchMode?: ContentMatchMode
  caseSensitive?: boolean
  wholeWord?: boolean
  /** Resolved by ContentIndex from the request's sessionId. */
  sessionId?: string
  /** Session log path; set by ContentIndex after resolving sessionId. */
  sessionPath?: string | null
  count?: ContentCountMode
  countLimit?: number
}

/** Result of one content query. */
export interface ContentSearchResult {
  hits: ContentHit[]
  count: ContentCount
  warnings: string[]
  error?: string
}

/** Shortest text a trigram tokenizer can index. */
const TRIGRAM_MIN = 3
const MAX_LIMIT = 100
const DEFAULT_COUNT_LIMIT = 1000
const MAX_COUNT_LIMIT = 5000
const SNIPPET_BEFORE = 60
const SNIPPET_AFTER = 120
const SNIPPET_MAX = 400

/** Bytes that count as "inside a word", matching the name engine. */
const WORD_BYTE = /[A-Za-z0-9_]/
const CONTROL_CHARS = /[\u0000-\u001f]/

/** Text escaped for an FTS5 quoted phrase (`"` doubled). */
export function quoteFts(text: string): string {
  return '"' + text.replace(/"/g, '""') + '"'
}

/** Escape a literal for SQLite GLOB (`*`, `?`, `[`, `]`). */
export function escapeGlob(text: string): string {
  return text.replace(/[*?[\]]/g, ch => (ch === ']' ? '[]]' : '[' + ch + ']'))
}

/** Escape a literal for SQL LIKE with `ESCAPE '\'`. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, ch => '\\' + ch)
}

/** Decoded extended-mode query text. */
export interface DecodedExtended {
  ok: boolean
  text: string
  warnings: string[]
  /** `invalid-escape` when `\\xNN` is malformed. */
  error?: string
}

/**
 * Decode Notepad++-style extended escapes: `\n`, `\r`, `\t`, `\0`, `\\`,
 * `\xNN`. Unknown escapes are kept literally with a warning.
 */
export function decodeExtended(input: string): DecodedExtended {
  const warnings = new Set<string>()
  let text = ''
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (ch !== '\\') {
      text += ch
      continue
    }
    const next = input[i + 1]
    if (next === undefined) {
      warnings.add('extended-trailing-backslash')
      text += '\\'
      continue
    }
    switch (next) {
      case 'n':
        text += '\n'
        i++
        continue
      case 'r':
        text += '\r'
        i++
        continue
      case 't':
        text += '\t'
        i++
        continue
      case '0':
        text += '\0'
        warnings.add('extended-control-char')
        i++
        continue
      case '\\':
        text += '\\'
        i++
        continue
      case 'x': {
        const hex = input.slice(i + 2, i + 4)
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
          return { ok: false, text: '', warnings: [...warnings], error: 'invalid-escape' }
        }
        const code = Number.parseInt(hex, 16)
        text += String.fromCharCode(code)
        if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) warnings.add('extended-control-char')
        i += 3
        continue
      }
      default:
        warnings.add('extended-unknown-escape')
        text += '\\' + next
        i++
    }
  }
  return { ok: true, text, warnings: [...warnings] }
}

/**
 * Extended decoding for file names: names cannot contain control characters, so
 * they are dropped from the pattern and reported instead of silently matching
 * nothing.
 */
export function decodeExtendedForNames(input: string): DecodedExtended {
  const decoded = decodeExtended(input)
  if (!decoded.ok) return decoded
  const kept = decoded.text.replace(CONTROL_CHARS, '')
  if (kept !== decoded.text) decoded.warnings.push('name-extended-control-char')
  return { ...decoded, text: kept }
}

/** Whether `index` starts a whole-word occurrence of `length` bytes. */
export function isWholeWord(hay: string, index: number, length: number): boolean {
  const left = index === 0 || !WORD_BYTE.test(hay[index - 1] ?? '')
  const end = index + length
  const right = end >= hay.length || !WORD_BYTE.test(hay[end] ?? '')
  return left && right
}

/** One located match: byte offset and length. */
interface Located {
  index: number
  length: number
}

/** First whole-word (or plain) occurrence of any term, or null. */
export function locateMatch(
  body: string,
  terms: readonly string[],
  caseSensitive: boolean,
  wholeWord: boolean,
): Located | null {
  const hay = caseSensitive ? body : body.toLowerCase()
  let best: Located | null = null
  for (const term of terms) {
    if (term === '') continue
    const needle = caseSensitive ? term : term.toLowerCase()
    let from = 0
    while (from <= hay.length) {
      const index = hay.indexOf(needle, from)
      if (index < 0) break
      if (!wholeWord || isWholeWord(hay, index, needle.length)) {
        if (best === null || index < best.index) best = { index, length: needle.length }
        break
      }
      from = index + 1
    }
  }
  return best
}

/** Every term must appear as a whole word (normal mode) or the literal must
 *  have non-word edges (extended mode is a single "term"). */
function matchesWholeWord(body: string, terms: readonly string[], caseSensitive: boolean): boolean {
  for (const term of terms) {
    if (term === '') continue
    if (locateMatch(body, [term], caseSensitive, true) === null) return false
  }
  return true
}

/** 1-based line number of a byte offset. */
export function lineOf(body: string, index: number): number {
  let line = 1
  let from = 0
  for (;;) {
    const next = body.indexOf('\n', from)
    if (next < 0 || next >= index) return line
    line++
    from = next + 1
  }
}

/** Bounded, single-line snippet around the first match. */
function makeSnippet(body: string, located: Located | null): string {
  if (located === null) {
    const flat = body.replace(/\s+/g, ' ').trim()
    return flat.length > SNIPPET_MAX ? flat.slice(0, SNIPPET_MAX - 1) + '…' : flat
  }
  const start = Math.max(0, located.index - SNIPPET_BEFORE)
  const end = Math.min(body.length, located.index + located.length + SNIPPET_AFTER)
  const flat = body.slice(start, end).replace(/\s+/g, ' ')
  const text = (start > 0 ? '…' : '') + flat + (end < body.length ? '…' : '')
  return text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX - 1) + '…' : text
}

function emptyCount(mode: ContentCountMode): ContentCount {
  if (mode === 'none') return { value: 0, kind: 'unknown' }
  return { value: 0, kind: 'exact' }
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limit) ? Math.trunc(limit) : MAX_LIMIT))
}

function clampCountLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_COUNT_LIMIT
  return Math.max(1, Math.min(MAX_COUNT_LIMIT, Math.trunc(limit)))
}

/** Split a normal-mode query on whitespace, dropping empty terms. */
function splitTerms(text: string): string[] {
  return text.split(/\s+/).map(part => part.replace(/^"|"$/g, '')).filter(part => part !== '')
}

/** One query plan: the SQL WHERE fragment plus how to page/count it. */
interface QueryPlan {
  where: string
  params: Array<string | number>
  /** Literal terms used for whole-word checks and snippet location. */
  terms: string[]
  caseSensitive: boolean
  wholeWord: boolean
  /** Match the whole phrase as one literal (extended mode). */
  phrase: boolean
  rankOrder: boolean
  exactCount: boolean
  /** GLOB counts are exact only below countLimit; above it they are bounded. */
  boundedCount: boolean
}

function buildPlan(terms: readonly string[], options: {
  caseSensitive: boolean
  wholeWord: boolean
  phrase: boolean
  sessionPath: string | null
}): QueryPlan | null {
  const { caseSensitive, wholeWord, phrase, sessionPath } = options
  if (terms.length === 0) return null
  const sessionClause = sessionPath === null ? '' : ' AND rowid IN (SELECT rowid FROM docs_meta WHERE path = ?)'
  const sessionParams: Array<string | number> = sessionPath === null ? [] : [sessionPath]
  const tooShort = terms.some(term => term.length < TRIGRAM_MIN)

  if (phrase) {
    const literal = terms[0]!
    if (caseSensitive) {
      return {
        where: 'body GLOB ?' + sessionClause,
        params: ['*' + escapeGlob(literal) + '*', ...sessionParams],
        terms: [literal],
        caseSensitive,
        wholeWord,
        phrase,
        rankOrder: false,
        exactCount: true,
        boundedCount: true,
      }
    }
    if (literal.length < TRIGRAM_MIN) {
      return {
        where: "body LIKE ? ESCAPE '\\'" + sessionClause,
        params: ['%' + escapeLike(literal) + '%', ...sessionParams],
        terms: [literal],
        caseSensitive,
        wholeWord,
        phrase,
        rankOrder: false,
        exactCount: false,
        boundedCount: true,
      }
    }
    return {
      where: 'docs MATCH ?' + sessionClause,
      params: [quoteFts(literal), ...sessionParams],
      terms: [literal],
      caseSensitive,
      wholeWord,
      phrase,
      rankOrder: true,
      exactCount: true,
      boundedCount: false,
    }
  }

  if (caseSensitive) {
    return {
      where: terms.map(() => 'body GLOB ?').join(' AND ') + sessionClause,
      params: [...terms.map(term => '*' + escapeGlob(term) + '*'), ...sessionParams],
      terms: [...terms],
      caseSensitive,
      wholeWord,
      phrase,
      rankOrder: false,
      exactCount: true,
      boundedCount: true,
    }
  }
  if (tooShort) {
    return {
      where: terms.map(() => "body LIKE ? ESCAPE '\\'").join(' AND ') + sessionClause,
      params: [...terms.map(term => '%' + escapeLike(term) + '%'), ...sessionParams],
      terms: [...terms],
      caseSensitive,
      wholeWord,
      phrase,
      rankOrder: false,
      exactCount: false,
      boundedCount: true,
    }
  }
  return {
    where: 'docs MATCH ?' + sessionClause,
    params: [terms.map(quoteFts).join(' AND '), ...sessionParams],
    terms: [...terms],
    caseSensitive,
    wholeWord,
    phrase,
    rankOrder: true,
    exactCount: true,
    boundedCount: false,
  }
}

/** One document row fetched for a hit. */
interface DocRow {
  kind?: string
  path?: string
  title?: string
  session_id?: string | null
  message_id?: string | null
  body?: string
  node_key?: string | null
  score?: number
}

const DOC_SQL = `SELECT d.kind AS kind, d.path AS path, d.title AS title,
  d.session_id AS session_id, d.message_id AS message_id, d.body AS body,
  m.node_key AS node_key
  FROM docs d LEFT JOIN docs_meta m ON m.rowid = d.rowid
  WHERE d.rowid = ?`

/** Build hits from rowids: metadata, snippet, first-match line and score. */
function buildHits(db: DatabaseSync, plan: QueryPlan, rowids: readonly number[], scores: ReadonlyMap<number, number>): ContentHit[] {
  const statement = db.prepare(DOC_SQL)
  const hits: ContentHit[] = []
  for (const rowid of rowids) {
    const row = statement.get(rowid) as DocRow | undefined
    if (row === undefined || typeof row.body !== 'string') continue
    const located = locateMatch(row.body, plan.terms, plan.caseSensitive, plan.wholeWord)
    const line = located === null ? undefined : lineOf(row.body, located.index)
    const score = scores.get(rowid)
    const hit: ContentHit = {
      kind: row.kind === 'session' ? 'session' : 'file',
      path: typeof row.path === 'string' ? row.path : '',
      title: typeof row.title === 'string' ? row.title : '',
      snippet: makeSnippet(row.body, located),
      score: score === undefined ? 0 : score,
      ...(typeof row.session_id === 'string' && row.session_id !== '' ? { sessionId: row.session_id } : {}),
      ...(typeof row.message_id === 'string' && row.message_id !== '' ? { messageId: row.message_id } : {}),
      ...(typeof row.node_key === 'string' && row.node_key !== '' ? { nodeKey: row.node_key } : {}),
      ...(line === undefined ? {} : { line }),
    }
    hits.push(hit)
  }
  return hits
}

/** Candidate rowids for one page (no post-filter). */
function pageRowids(db: DatabaseSync, plan: QueryPlan, limit: number): { rowids: number[]; scores: Map<number, number> } {
  const scores = new Map<number, number>()
  const sql = plan.rankOrder
    ? `SELECT rowid AS rowid, rank AS score FROM docs WHERE ${plan.where} ORDER BY rank LIMIT ?`
    : `SELECT rowid AS rowid FROM docs WHERE ${plan.where} LIMIT ?`
  const rows = db.prepare(sql).all(...plan.params, limit) as Array<{ rowid?: number; score?: number }>
  const rowids: number[] = []
  for (const row of rows) {
    if (typeof row.rowid !== 'number') continue
    rowids.push(row.rowid)
    if (typeof row.score === 'number') scores.set(row.rowid, row.score)
  }
  return { rowids, scores }
}

/** Exact COUNT over the plan's WHERE fragment. */
function exactCount(db: DatabaseSync, plan: QueryPlan): number {
  const row = db.prepare(`SELECT count(*) AS n FROM docs WHERE ${plan.where}`).get(...plan.params) as { n?: number } | undefined
  return Number(row?.n ?? 0)
}

/** Count up to `limit + 1` rows: exact below the cap, bounded at the cap. */
function boundedCount(db: DatabaseSync, plan: QueryPlan, limit: number): ContentCount {
  const row = db
    .prepare(`SELECT count(*) AS n FROM (SELECT rowid FROM docs WHERE ${plan.where} LIMIT ?)`)
    .get(...plan.params, limit + 1) as { n?: number } | undefined
  const value = Number(row?.n ?? 0)
  if (value > limit) return { value: limit, kind: 'bounded', limit }
  return { value, kind: 'exact' }
}

/** A plan with a whole-word post-filter. */
interface WholeWordScan {
  rowids: number[]
  count: ContentCount
  warnings: string[]
}

function scanWholeWord(
  db: DatabaseSync,
  plan: QueryPlan,
  limit: number,
  countMode: ContentCountMode,
  countLimit: number,
  sessionScoped: boolean,
): WholeWordScan {
  const warnings: string[] = []
  const rowids: number[] = []
  const sql = plan.rankOrder
    ? `SELECT rowid AS rowid FROM docs WHERE ${plan.where} ORDER BY rank`
    : `SELECT rowid AS rowid FROM docs WHERE ${plan.where}`
  const iterator = db.prepare(sql).iterate(...plan.params)
  const bodyStatement = db.prepare('SELECT body FROM docs WHERE rowid = ?')
  let count = 0
  let exhausted = true
  for (const raw of iterator) {
    const rowid = (raw as { rowid?: number }).rowid
    if (typeof rowid !== 'number') continue
    const row = bodyStatement.get(rowid) as { body?: string } | undefined
    if (row === undefined || typeof row.body !== 'string') continue
    if (!matchesWholeWord(row.body, plan.terms, plan.caseSensitive)) continue
    count++
    if (rowids.length < limit) rowids.push(rowid)
    if (countMode === 'none') {
      if (rowids.length >= limit) break
    } else if (!sessionScoped && count > countLimit) {
      exhausted = false
      break
    }
  }
  let result: ContentCount
  if (countMode === 'none') {
    result = { value: 0, kind: 'unknown' }
  } else if (!exhausted || count > countLimit) {
    // Above the cap: report the known floor, never an exact count we did not
    // finish. Global whole-word counts are deliberately bounded.
    result = { value: countLimit, kind: 'bounded', limit: countLimit }
    warnings.push('bounded-count')
  } else {
    result = { value: count, kind: 'exact' }
  }
  return { rowids, count: result, warnings: [...new Set(warnings)] }
}

/**
 * Run one content query.
 *
 * Modes: `normal` (whitespace-separated substring terms), `extended`
 * (Notepad++ escapes, one literal phrase), `regex` (not executed server-side in
 * 0.9.0: returns `content-regex-not-supported`).
 */
export function searchContent(
  db: DatabaseSync,
  query: string,
  limit: number,
  options: ContentSearchOptions = {},
): ContentSearchResult {
  const text = query.trim()
  const capped = clampLimit(limit)
  const matchMode = options.matchMode ?? 'normal'
  const countMode = options.count ?? 'exact'
  const countLimit = clampCountLimit(options.countLimit)
  const warnings: string[] = []

  if (text === '') return { hits: [], count: emptyCount(countMode), warnings }
  if (matchMode === 'regex') {
    return {
      hits: [],
      count: { value: 0, kind: 'unknown' },
      warnings: ['content-regex-paused'],
      error: 'content-regex-not-supported',
    }
  }

  let terms: string[]
  let phrase = false
  if (matchMode === 'extended') {
    const decoded = decodeExtended(text)
    warnings.push(...decoded.warnings)
    if (!decoded.ok) {
      return { hits: [], count: { value: 0, kind: 'unknown' }, warnings, error: decoded.error ?? 'invalid-escape' }
    }
    phrase = true
    terms = decoded.text === '' ? [] : [decoded.text]
  } else {
    terms = splitTerms(text)
  }
  if (terms.length === 0) return { hits: [], count: emptyCount(countMode), warnings }

  const sessionPath = options.sessionPath ?? null
  const plan = buildPlan(terms, {
    caseSensitive: options.caseSensitive === true,
    wholeWord: options.wholeWord === true,
    phrase,
    sessionPath,
  })
  if (plan === null) return { hits: [], count: emptyCount(countMode), warnings }

  if (plan.wholeWord) {
    const scanned = scanWholeWord(db, plan, capped, countMode, countLimit, sessionPath !== null)
    warnings.push(...scanned.warnings)
    const hits = buildHits(db, plan, scanned.rowids, new Map())
    return { hits, count: scanned.count, warnings: [...new Set(warnings)] }
  }

  let count: ContentCount
  if (countMode === 'none') {
    count = { value: 0, kind: 'unknown' }
  } else if (countMode === 'bounded') {
    count = boundedCount(db, plan, countLimit)
    if (count.kind === 'bounded') warnings.push('bounded-count')
  } else if (plan.exactCount && !plan.boundedCount) {
    count = { value: exactCount(db, plan), kind: 'exact' }
  } else {
    // LIKE plans and very common GLOB patterns cannot count cheaply: cap the
    // work and report the known floor plus a warning.
    count = boundedCount(db, plan, countLimit)
    if (count.kind === 'bounded') warnings.push('bounded-count')
  }
  const page = pageRowids(db, plan, capped)
  const hits = buildHits(db, plan, page.rowids, page.scores)
  return { hits, count, warnings: [...new Set(warnings)] }
}
