/**
 * client.js is the single-file Web panel bundle: the host loads it as text and
 * evaluates it in the browser, so it has no module boundary to import. These
 * tests therefore treat it as text — parse it as a script, read the locale
 * dictionaries and the pure ref/mention helpers out of the source — and pin the
 * 0.19.0 panel contract (evidence inspector + official @file/@session
 * interoperability + Quick Switch) without a browser.
 *
 * Node environment only; no new dependencies and nothing here executes the
 * browser bundle.
 */
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { encodeSessionRef, fileRef, sessionEventRef } from '../src/refs.ts'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Locale order of the STRINGS object (the LANG resolver mirrors it). */
const LOCALES = ['en', 'zh', 'es', 'pt', 'hi', 'ja', 'fr', 'de', 'ru'] as const
type Locale = (typeof LOCALES)[number]
type Dictionary = Record<string, string>

/** Index of the closing brace for the literal that opens at `open`, quote-aware. */
function literalEnd(open: number): number {
  let depth = 0
  let quote = ''
  for (let index = open; index < source.length; index++) {
    const char = source.charAt(index)
    if (quote !== '') {
      if (char === '\\') {
        index++
        continue
      }
      if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth++
    if (char === '}') {
      depth--
      if (depth === 0) return index
    }
  }
  throw new Error('unbalanced literal in client.js')
}

/** Source text of the balanced `{...}` literal that follows `marker`. */
function objectLiteralAfter(marker: string): string {
  const markerStart = source.indexOf(marker)
  expect(markerStart, `missing marker: ${marker}`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf('{', markerStart + marker.length)
  expect(open, `missing object after: ${marker}`).toBeGreaterThanOrEqual(0)
  return source.slice(open, literalEnd(open) + 1)
}

/** Source text of one top-level `function name(...) {...}` declaration. */
function functionLiteral(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `missing function: ${name}`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf('{', start)
  expect(open).toBeGreaterThanOrEqual(0)
  return source.slice(start, literalEnd(open) + 1)
}

const STRINGS = new Function(`return (${objectLiteralAfter('const STRINGS =')})`)() as Record<Locale, Dictionary>
const en = STRINGS.en
const parseUrlRefInfo = new Function(`return (${functionLiteral('parseUrlRefInfo')})`)() as (ref: unknown) => { url: string; origin: string } | null
const shortUrlLabel = new Function(`return (${functionLiteral('shortUrlLabel')})`)() as (url: unknown, max?: number) => string

/** One normalized evidence record (see evidenceForHit in client.js). */
interface EvidenceModel {
  ref: string
  kind: string
  title: string
  path: string
  url: string
  sessionId: string
  sessionRef: string
  messageId: string
  hash: string
  hashShort: string
  freshness: { state: string; observedAt?: number; mtime?: number }
  permissions: { read: string; visibility: string; reason: string }
  mention: string | null
  denied: boolean
  freshnessReported: boolean
  permissionsReported: boolean
  canOpen: boolean
  canReveal: boolean
  canJump: boolean
  cite: string
}

/** Raw Quick Switch target (see parseQuickSwitch in client.js). */
interface QuickSwitchTarget {
  mode: string
  ref: string
  path?: string
  sessionId?: string
  label?: string
  url?: string
  kind?: string
}

interface ParsedRef {
  kind: string
  ref: string
  path?: string
  url?: string
  sessionId?: string
  seq?: number
  sha256?: string
}

interface ClientHelpers {
  encodeSessionRefId: (sessionId: unknown) => string | null
  decodeSessionRefId: (ref: unknown) => string | null
  fileMentionFor: (path: unknown) => string | null
  folderMentionFor: (path: unknown) => string | null
  parseFileMention: (text: unknown) => string | null
  parseSessionMention: (text: unknown) => { ref: string; sessionId: string; label: string } | null
  fileRefForPath: (path: unknown) => string | null
  parseRefUri: (ref: unknown) => ParsedRef | null
  evidenceForHit: (group: string, hit: unknown) => EvidenceModel
  parseQuickSwitch: (query: unknown) => QuickSwitchTarget | null
  createLruCache: (size: number) => LruCache
  highlightExpression: (query: unknown, cache: LruCache) => RegExp | null
  searchPhasePlan: (input: unknown) => SearchPhasePlan
  combinedBody: (input: unknown, phase: string) => Record<string, any>
  contentPlaceholderGroup: (state: unknown, matchMode: string, queryLength: number, minChars: number) => Record<string, any>
  hitIdentity: (hit: unknown) => string
  mergeNamePhase: (groups: Record<string, any> | null, data: Record<string, any>) => Record<string, any>
  mergeContentPhase: (groups: Record<string, any> | null, data: Record<string, any>) => Record<string, any>
  appendCombinedPages: (groups: Record<string, any> | null, data: Record<string, any>) => Record<string, any>
  capResultRows: (rows: unknown[], limit: number) => { rows: unknown[]; capped: boolean; total: number; limit: number }
}

/** Bounded LRU cache (see createLruCache in client.js). */
interface LruCache {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void
  has(key: string): boolean
  delete(key: string): boolean
  clear(): void
  size(): number
  keys(): string[]
}

/** Phase decision for one panel query (see searchPhasePlan in client.js). */
interface SearchPhasePlan {
  text: string
  minChars: number
  contentEnabled: boolean
  matchMode: string
  names: boolean
  content: boolean
}

/** Dependency order: each function is evaluated as a top-level declaration. */
const HELPER_FUNCTIONS = [
  'encodeSessionRefId', 'decodeSessionRefId', 'decodeSessionIdParamValue',
  'fileMentionFor', 'folderMentionFor', 'parseFileMention', 'parseSessionMention',
  'fileRefForPath', 'parseRefUri', 'baseNameOf', 'sessionMentionFor',
  'normalizeFreshness', 'normalizePermissions', 'defaultPermissionsFor',
  'markdownCitationFor', 'evidenceForHit', 'parseQuickSwitch',
  // 0.20.0 panel search pipeline (all pure; no browser globals).
  'escapeRegExp', 'queryWords', 'createLruCache', 'highlightExpression',
  'searchPhasePlan', 'combinedBody', 'contentPlaceholderGroup', 'hitIdentity',
  'mergeNamePhase', 'mergeContentPhase', 'appendCombinedPages', 'capResultRows',
] as const

const helpers = new Function(`${HELPER_FUNCTIONS.map(name => functionLiteral(name)).join('\n')}\nreturn { ${HELPER_FUNCTIONS.join(', ')} }`)() as ClientHelpers

/** Translation keys this release adds or finishes for the panel. */
const PANEL_KEYS = [
  'copyRef', 'copiedRef', 'urlRefTitle',
  'capabilityTab', 'capabilityBack', 'capabilitySearch', 'capabilityPlaceholder', 'capabilityHint',
  'capabilityGlobalHint', 'capabilityTotal', 'capabilityPreflight', 'capabilityRisk', 'capabilityApproval',
  'capabilityEmpty', 'capabilityError', 'capabilityPreflightResult', 'capabilityPreflightFailed',
  'requestFailed',
  'insertFile', 'insertSession', 'insertedSession', 'insertSessionFailed', 'mentionUnsupported',
  'copyMarkdown', 'copiedMarkdown', 'copyRefShort',
  'evidenceTitle', 'evidenceClose', 'evidenceHint', 'evidenceKind', 'evidenceRef', 'evidenceTitleField',
  'evidenceFreshness', 'evidencePermissions', 'evidenceHash', 'evidenceNoHash', 'evidenceSession',
  'evidenceMessage', 'evidenceMention', 'evidenceObserved',
  'freshnessFresh', 'freshnessStale', 'freshnessMissing', 'freshnessUnknown',
  'shortQueryFallback', 'evidenceOmittedHint',
  'permissionAllowed', 'permissionDenied',
  'evidenceStaleHint', 'evidenceMissingHint', 'evidenceDeniedHint', 'evidenceUnknownHint',
  'evidenceOpenFile', 'evidenceOpenSession', 'evidenceReveal',
  'quickSwitchTitle', 'quickSwitchHint', 'quickSwitchInvalid', 'quickSwitchUnsupported', 'openAction',
  'errorMissingTarget', 'errorOutsideRoots', 'errorNotAFile', 'openFailed', 'revealFailed',
] as const

/** Placeholder names used by a template string, e.g. `{n}` -> `n`. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '').sort()
}

describe('client.js bundle', () => {
  it('parses as a script without executing browser code', () => {
    expect(() => new Script(source, { filename: 'client.js' })).not.toThrow()
    expect(source).toContain('window.__ModuleLoader__.load(')
    expect(source).toContain('factory(require)')
  })

  it('declares all nine locale dictionaries with identical key sets', () => {
    expect(Object.keys(STRINGS)).toEqual([...LOCALES])
    const baseline = Object.keys(en).sort()
    expect(baseline.length).toBeGreaterThan(100)
    for (const locale of LOCALES) {
      const dictionary = STRINGS[locale]
      expect(Object.keys(dictionary).sort(), locale).toEqual(baseline)
      for (const [key, value] of Object.entries(dictionary)) {
        expect(typeof value, `${locale}.${key}`).toBe('string')
        expect(value.length, `${locale}.${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('translates the capability/ref-chip/evidence keys instead of falling back to English', () => {
    for (const key of PANEL_KEYS) {
      const base = en[key]
      expect(typeof base, key).toBe('string')
      expect(base?.length ?? 0, key).toBeGreaterThan(0)
      for (const locale of LOCALES) {
        if (locale === 'en') continue
        const value = STRINGS[locale][key]
        expect(value, `${locale}.${key}`).toBeTruthy()
        expect(value, `${locale}.${key} still uses the English string`).not.toBe(base)
      }
    }
  })

  it('keeps {placeholder} names aligned across every locale', () => {
    for (const locale of LOCALES) {
      for (const key of Object.keys(en)) {
        expect(placeholders(STRINGS[locale][key] ?? ''), `${locale}.${key}`).toEqual(placeholders(en[key] ?? ''))
      }
    }
  })

  it('only calls t() with keys present in the English dictionary', () => {
    const used = new Set([...source.matchAll(/\bt\('([A-Za-z][A-Za-z0-9_]*)'/g)].map(match => match[1] ?? ''))
    expect(used.size).toBeGreaterThan(100)
    expect([...used].filter(key => !(key in en))).toEqual([])
  })

  it('wires the 0.17.0 Capabilities tab and localized capability fields', () => {
    expect(source).toContain("'/dsh-locator/capabilities'")
    expect(source).toContain("'/dsh-locator/combined'")
    expect(source).toContain("t('capabilityTab')")
    expect(source).toContain("t('capabilityGlobalHint')")
    expect(source).toContain("t('capabilityRisk'")
    expect(source).toContain("t('capabilityApproval'")
    expect(source).toContain("t('capabilityEmpty')")
    // Hardcoded English labels from 0.16.0 must be gone.
    expect(source).not.toContain("'callable='")
    expect(source).not.toMatch(/'risk:'\s*\+/)
    expect(source).not.toMatch(/'approval:'\s*\+/)
  })

  it('renders URL refs as a readable label with origin/title in the tooltip', () => {
    expect(source).toContain('dsh-locator-refchip')
    expect(source).toContain('dsh-locator-refchip-url')
    expect(source).toContain("t('urlRefTitle'")
    expect(source).toContain('parseUrlRefInfo(hit.ref)')

    const url = 'https://Example.com:443/docs/a.pdf?page=1#frag'
    const ref = 'ref://url?url=' + encodeURIComponent(url) + '&sha256=' + 'a'.repeat(64)
    expect(parseUrlRefInfo(ref)).toEqual({ url, origin: 'https://example.com' })
    expect(parseUrlRefInfo('ref://url?u=' + encodeURIComponent('https://e.com/x'))).toEqual({ url: 'https://e.com/x', origin: 'https://e.com' })
    expect(parseUrlRefInfo('ref://file?path=/tmp/a.md')).toBeNull()
    expect(parseUrlRefInfo('dsh-session:abc')).toBeNull()
    expect(parseUrlRefInfo('ref://url?url=')).toBeNull()
    expect(parseUrlRefInfo(null)).toBeNull()

    expect(shortUrlLabel('https://example.com/a/b')).toBe('example.com/a/b')
    const long = shortUrlLabel('https://example.com/' + 'x'.repeat(200))
    expect(long.length).toBeLessThanOrEqual(56)
    expect(long.endsWith('…')).toBe(true)
    expect(shortUrlLabel('https://example.com/' + 'x'.repeat(50), 24)).toHaveLength(24)
  })

  it('maps the official @file grammar to ref://file and back', () => {
    expect(helpers.fileMentionFor('/tmp/a.md')).toBe('@/tmp/a.md')
    expect(helpers.fileMentionFor('/tmp/a b.md')).toBe('@"/tmp/a b.md"')
    expect(helpers.fileMentionFor('/tmp/a"b.md')).toBeNull()
    expect(helpers.fileMentionFor('/tmp/a\u0001b.md')).toBeNull()
    expect(helpers.fileMentionFor('')).toBeNull()
    expect(helpers.folderMentionFor('/tmp/dir')).toBe('@/tmp/dir/')
    expect(helpers.folderMentionFor('/tmp/my dir')).toBe('@"/tmp/my dir/"')

    expect(helpers.parseFileMention('@/tmp/a.md')).toBe('/tmp/a.md')
    expect(helpers.parseFileMention('@"/tmp/a b.md"')).toBe('/tmp/a b.md')
    expect(helpers.parseFileMention('@/tmp/a.md.')).toBe('/tmp/a.md')
    expect(helpers.parseFileMention('@')).toBeNull()
    expect(helpers.parseFileMention('@a b')).toBeNull()
    expect(helpers.parseFileMention('see @/tmp/a.md')).toBeNull()
    // @path -> ref -> @path round trip; server encoding stays canonical.
    for (const path of ['/tmp/a.md', '/tmp/a b.md', 'C:\\dir\\f.txt', 'a&b=c?.md']) {
      expect(helpers.fileRefForPath(path)).toBe(fileRef({ path }))
      expect(helpers.parseFileMention(helpers.fileMentionFor(path) ?? '')).toBe(path)
    }
    expect(helpers.parseRefUri(helpers.fileRefForPath('/tmp/a b.md') ?? '')).toEqual({ kind: 'file', ref: helpers.fileRefForPath('/tmp/a b.md'), path: '/tmp/a b.md' })
  })

  it('mirrors the host dsh-session URI for @session mentions', () => {
    for (const sessionId of ['session-123', 'a b/c', '会话🙂', 'source]']) {
      const ref = encodeSessionRef(sessionId)
      expect(helpers.encodeSessionRefId(sessionId)).toBe(ref)
      expect(helpers.decodeSessionRefId(ref)).toBe(sessionId)
      expect(helpers.parseRefUri(ref)).toEqual({ kind: 'session', ref, sessionId })
    }
    expect(helpers.decodeSessionRefId('dsh-session:abc')).toBeNull()
    expect(helpers.decodeSessionRefId('ref://file?path=x')).toBeNull()

    const ref = encodeSessionRef('session-123')
    expect(helpers.parseSessionMention(`@[Chat](${ref})`)).toEqual({ ref, sessionId: 'session-123', label: 'Chat' })
    expect(helpers.parseSessionMention(`@[a\\]b](${ref})`)?.label).toBe('a]b')
    expect(helpers.parseSessionMention('@[Chat](dsh-session:abc)')).toBeNull()
  })

  it('parses event/spill/url refs and rejects unknown schemes', () => {
    const eventRef = sessionEventRef({ sessionId: 'abc', seq: 7 })
    expect(helpers.parseRefUri(eventRef)).toEqual({ kind: 'session-event', ref: eventRef, sessionId: 'abc', seq: 7 })
    const urlRef = 'ref://url?url=' + encodeURIComponent('https://e.com/x') + '&sha256=' + 'b'.repeat(64)
    expect(helpers.parseRefUri(urlRef)).toEqual({ kind: 'url', ref: urlRef, url: 'https://e.com/x', sha256: 'b'.repeat(64) })
    const spillRef = 'ref://spill?path=' + encodeURIComponent('/tmp/spill.txt')
    expect(helpers.parseRefUri(spillRef)).toEqual({ kind: 'spill', ref: spillRef, path: '/tmp/spill.txt' })
    expect(helpers.parseRefUri('ref://nope?x=1')).toBeNull()
    expect(helpers.parseRefUri('ref:/file')).toBeNull()
    expect(helpers.parseRefUri(null)).toBeNull()
  })

  it('builds the evidence model from a hit and prefers server-reported blocks', () => {
    const filePath = '/tmp/a b.md'
    const ref = fileRef({ path: filePath, mtime: 5, size: 12 })
    const hit = { path: filePath, name: 'a b.md', size: 12, mtime: 5, ext: 'md', dir: false, ref }
    const file = helpers.evidenceForHit('files', hit)
    expect(file.kind).toBe('file')
    expect(file.title).toBe('a b.md')
    expect(file.mention).toBe('@"/tmp/a b.md"')
    expect(file.cite).toBe(`[a b.md](${ref})`)
    // No server block: an explicit unknown freshness and derived root permissions.
    expect(file.freshness).toEqual({ state: 'unknown' })
    expect(file.freshnessReported).toBe(false)
    expect(file.permissions).toEqual({ read: 'allowed', visibility: 'roots', reason: '' })
    expect(file.permissionsReported).toBe(false)
    expect(file.canOpen).toBe(true)
    expect(file.canJump).toBe(false)
    expect(file.hashShort).toBe('')

    const rich = helpers.evidenceForHit('files', {
      ...hit,
      freshness: { state: 'stale', observedAt: 10, mtime: 9 },
      permissions: { read: 'denied', visibility: 'roots', reason: 'outside roots' },
      hash: 'A'.repeat(64),
    })
    expect(rich.freshness).toEqual({ state: 'stale', observedAt: 10, mtime: 9 })
    expect(rich.freshnessReported).toBe(true)
    expect(rich.permissions).toEqual({ read: 'denied', visibility: 'roots', reason: 'outside roots' })
    expect(rich.permissionsReported).toBe(true)
    expect(rich.denied).toBe(true)
    expect(rich.hashShort).toBe('a'.repeat(12))
    expect(rich.canOpen).toBe(false)

    // A hash can also come from the ref itself (url refs carry sha256).
    const urlHit = helpers.evidenceForHit('content', { ref: 'ref://url?url=' + encodeURIComponent('https://e.com/x') + '&sha256=' + 'c'.repeat(64) })
    expect(urlHit.kind).toBe('url')
    expect(urlHit.hashShort).toBe('c'.repeat(12))
    expect(urlHit.canOpen).toBe(false)

    // Session hits keep the canonical URI, label and message anchor.
    const sessionId = 'session-123'
    const sessionRef = encodeSessionRef(sessionId)
    const session = helpers.evidenceForHit('content', { kind: 'session', path: 'sessions/x', title: 'Session title', snippet: 's', ref: sessionRef, messageId: 'm1', score: 1 })
    expect(session.kind).toBe('session')
    expect(session.canJump).toBe(true)
    expect(session.messageId).toBe('m1')
    expect(session.mention).toBe(`@[Session title](${sessionRef})`)
    expect(session.cite).toBe(`[Session title](${sessionRef})`)
    expect(session.permissions).toEqual({ read: 'allowed', visibility: 'session', reason: '' })

    // Directory hits get the folder grammar and reveal-only actions.
    const dir = helpers.evidenceForHit('dirs', { path: '/tmp/my dir', name: 'my dir', dir: true, size: 0, mtime: 0, ext: '' })
    expect(dir.kind).toBe('dir')
    expect(dir.mention).toBe('@"/tmp/my dir/"')
    expect(dir.canOpen).toBe(false)
    expect(dir.canReveal).toBe(true)
  })

  it('derives a Quick Switch target from refs and official mentions', () => {
    const path = '/tmp/a b.md'
    const ref = fileRef({ path })
    expect(helpers.parseQuickSwitch(ref)).toEqual({ mode: 'file', ref, path })
    expect(helpers.parseQuickSwitch('@/tmp/a.md')).toEqual({ mode: 'file', ref: fileRef({ path: '/tmp/a.md' }), path: '/tmp/a.md' })
    expect(helpers.parseQuickSwitch('@"/tmp/a b.md"')).toEqual({ mode: 'file', ref, path })
    expect(helpers.parseQuickSwitch('@/tmp/a b.md')).toBeNull()

    const sessionId = 'session-123'
    const sessionRef = encodeSessionRef(sessionId)
    expect(helpers.parseQuickSwitch(sessionRef)).toEqual({ mode: 'session', ref: sessionRef, sessionId, label: '' })
    expect(helpers.parseQuickSwitch(`@[Chat](${sessionRef})`)).toEqual({ mode: 'session', ref: sessionRef, sessionId, label: 'Chat' })
    const eventRef = sessionEventRef({ sessionId, seq: 3 })
    expect(helpers.parseQuickSwitch(eventRef)).toEqual({ mode: 'session', ref: eventRef, sessionId, label: '' })
    expect(helpers.parseQuickSwitch('ref://url?url=' + encodeURIComponent('https://e.com/x'))?.mode).toBe('url')
    expect(helpers.parseQuickSwitch('ref://attachment?sha256=' + 'd'.repeat(64))).toEqual({
      mode: 'unsupported', ref: 'ref://attachment?sha256=' + 'd'.repeat(64), kind: 'attachment',
    })
    expect(helpers.parseQuickSwitch('ref://nope?x=1')).toEqual({ mode: 'invalid', ref: 'ref://nope?x=1' })
    expect(helpers.parseQuickSwitch('dsh-session:abc')).toEqual({ mode: 'invalid', ref: 'dsh-session:abc' })
    // A malformed official session mention is an understandable error, not a search.
    expect(helpers.parseQuickSwitch('@[Chat](dsh-session:abc)')).toEqual({ mode: 'invalid', ref: '@[Chat](dsh-session:abc)' })
    // Ordinary queries stay ordinary searches.
    expect(helpers.parseQuickSwitch('report 2026')).toBeNull()
    expect(helpers.parseQuickSwitch('@')).toBeNull()
    expect(helpers.parseQuickSwitch('   ')).toBeNull()
  })

  it('wires the 0.19.0 evidence inspector and Quick Switch into the panel', () => {
    // Evidence inspector: click or Ctrl+I, localized states, additive data attributes.
    expect(source).toContain("t('evidenceTitle')")
    expect(source).toContain("t('evidenceHint')")
    expect(source).toContain("t('evidenceStaleHint')")
    expect(source).toContain("t('evidenceMissingHint')")
    expect(source).toContain("t('evidenceDeniedHint')")
    expect(source).toContain("t('evidenceUnknownHint')")
    expect(source).toContain("t('freshnessMissing')")
    expect(source).toContain("t('permissionDenied')")
    expect(source).toContain("t('copyMarkdown')")
    // Called through a key variable (file vs session mention), so no t('…') literal.
    expect(source).toContain("'insertedSession'")
    expect(source).toContain('dsh-locator-evidence')
    expect(source).toContain("'data-evidence-freshness'")
    expect(source).toContain("'data-evidence-permission'")
    expect(source).toContain('setEvidenceOpen(true)')
    expect(source).toContain('setEvidenceOpen(false)')
    expect(source).toContain("String(event.key).toLowerCase() === 'i'")
    expect(source).toContain('evidenceForHit(')
    // Quick Switch row and its localized errors.
    expect(source).toContain('dsh-locator-quickswitch')
    expect(source).toContain("t('quickSwitchTitle')")
    expect(source).toContain("t('quickSwitchInvalid'")
    expect(source).toContain("t('quickSwitchUnsupported'")
    expect(source).toContain("'data-quick-switch'")
    expect(source).toContain('parseQuickSwitch(query)')
    // Official mention grammars are used instead of the old quote-stripping.
    expect(source).toContain('fileMentionFor(')
    expect(source).toContain('sessionMentionFor(')
    expect(source).not.toContain(`hit.path.replace(/"/g, '')`)
    // Composer targeting prefers the host's composer seat over any text box.
    expect(source).toContain('[data-composer-seat] [data-composer-input]')
    // Open/locate/jump still go through the existing same-origin routes.
    expect(source).toContain("post('/dsh-locator/open'")
    expect(source).toContain("post('/dsh-locator/reveal'")
    expect(source).toContain('jumpToContentHit(hit, query, notify)')
    expect(source).toContain("t('openFailed'")
    expect(source).toContain("t('revealFailed'")
  })
})

/** Numeric value of one `const NAME = <digits>` declaration in client.js. */
function sourceConstant(name: string): number {
  const match = new RegExp('const ' + name + ' = (\\d+)').exec(source)
  expect(match, `missing constant: ${name}`).not.toBeNull()
  return Number(match?.[1] ?? 'NaN')
}

describe('client.js search pipeline (0.20.0 perf)', () => {
  it('plans names first and gates the body phase exactly like the content index', () => {
    const scopes = { content: true, files: true, dirs: true }
    const plan = helpers.searchPhasePlan({ query: '  the  ', scopes, contentEnabled: true, matchMode: 'normal', minChars: 3 })
    expect(plan).toMatchObject({ text: 'the', content: true, names: true, matchMode: 'normal' })
    // Shorter than the shared three-character content threshold: names only.
    expect(helpers.searchPhasePlan({ query: 'ab', scopes, contentEnabled: true, matchMode: 'normal', minChars: 3 }).content).toBe(false)
    expect(helpers.searchPhasePlan({ query: ' ab ', scopes, contentEnabled: true, matchMode: 'normal', minChars: 3 }).content).toBe(false)
    expect(helpers.searchPhasePlan({ query: '', scopes, contentEnabled: true, matchMode: 'normal', minChars: 3 }).content).toBe(false)
    // The server pauses bodies in regex mode and when the index is disabled.
    expect(helpers.searchPhasePlan({ query: 'abc', scopes, contentEnabled: true, matchMode: 'regex', minChars: 3 }).content).toBe(false)
    expect(helpers.searchPhasePlan({ query: 'abc', scopes, contentEnabled: false, matchMode: 'normal', minChars: 3 }).content).toBe(false)
    expect(helpers.searchPhasePlan({ query: 'abc', scopes: { content: false, files: true }, contentEnabled: true, matchMode: 'normal', minChars: 3 }).content).toBe(false)
    // Extended escapes still search the body index.
    expect(helpers.searchPhasePlan({ query: 'abc', scopes, contentEnabled: true, matchMode: 'extended', minChars: 3 }).content).toBe(true)
  })

  it('builds compact cheap-count typing requests and one full settled request', () => {
    const options = {
      query: 'the',
      scopes: { content: true, files: true, dirs: true },
      sort: 'mtime', desc: true, matchMode: 'normal', caseSensitive: false, wholeWord: false,
      sessionId: '', root: '', includeArchived: false,
      limit: 50, contentLimit: 30, countLimit: 1000,
      filesOffset: 0, dirsOffset: 0, contentOffset: 0,
    }
    // Phase 1: names only, compact (no evidence enrichment), no counting work.
    const names = helpers.combinedBody(options, 'names')
    expect(names).toMatchObject({ content: false, files: true, dirs: true, compact: true, count: 'none', limit: 50 })
    // Phase 2: bodies/sessions only, compact + cheap bounded count.
    const content = helpers.combinedBody(options, 'content')
    expect(content).toMatchObject({ content: true, files: false, dirs: false, compact: true, count: 'bounded', countLimit: 1000 })
    // Phase 3: everything, rich evidence and an exact count (no compact flag).
    const full = helpers.combinedBody(options, 'full')
    expect(full).toMatchObject({ content: true, files: true, dirs: true, count: 'exact' })
    expect('compact' in full).toBe(false)
    // Load-more is one extra rich page at the stored offsets.
    const more = helpers.combinedBody({ ...options, filesOffset: 50, dirsOffset: 50, contentOffset: 30 }, 'more')
    expect(more).toMatchObject({ content: true, files: true, dirs: true, count: 'none', compact: false, filesOffset: 50, dirsOffset: 50, contentOffset: 30 })
    // Scope flags are explicit; every option reaches the request unchanged.
    const scoped = helpers.combinedBody({ ...options, scopes: { content: false, files: true, dirs: false }, sessionId: 's1', root: '/r', includeArchived: true, sort: 'name', desc: false }, 'content')
    expect(scoped).toMatchObject({ content: false, files: false, dirs: false, sessionId: 's1', root: '/r', includeArchived: true, sort: 'name', desc: false })
    expect(helpers.combinedBody({ ...options, scopes: { content: true, files: true, dirs: false } }, 'names')).toMatchObject({ files: true, dirs: false })
  })

  it('bounds the phase cache at 20 entries and evicts least-recently-used keys', () => {
    const cache = helpers.createLruCache(20)
    for (let index = 0; index < 25; index++) cache.set('k' + index, index)
    expect(cache.size()).toBe(20)
    expect(cache.get('k4')).toBeUndefined()
    expect(cache.get('k5')).toBe(5)
    expect(cache.get('k24')).toBe(24)
    // get() refreshed k5 to the newest slot, so k6 is now the eviction victim.
    cache.set('k25', 25)
    expect(cache.get('k5')).toBe(5)
    expect(cache.get('k6')).toBeUndefined()
    expect(cache.size()).toBe(20)
    expect(cache.keys()).toHaveLength(20)
  })

  it('compiles one highlight expression per query and reuses it for every row', () => {
    const cache = helpers.createLruCache(8)
    const first = helpers.highlightExpression('foo Bar', cache)
    expect(first).toBeInstanceOf(RegExp)
    expect(first?.flags).toContain('g')
    expect(first?.flags).toContain('i')
    // The same object is reused: no recompile per row/per keystroke.
    expect(helpers.highlightExpression('foo Bar', cache)).toBe(first)
    expect('Foo bar foo'.split(first as RegExp)).toEqual(['', 'Foo', ' ', 'bar', ' ', 'foo', ''])
    // Filter-only queries highlight nothing, and that answer is cached too.
    expect(helpers.highlightExpression('ext:pdf size:>10mb', cache)).toBeNull()
    expect(cache.has('ext:pdf size:>10mb')).toBe(true)
    expect(helpers.highlightExpression('ext:pdf size:>10mb', cache)).toBeNull()
  })

  it('merges the body phase into the preview and keeps one row per path', () => {
    const preview = {
      content: { hits: [], returned: 0, count: { value: 0, kind: 'unknown' }, pending: true },
      files: { hits: [{ path: '/a' }, { path: '/b' }], returned: 2, total: 4, deduped: 0, count: { value: 4, kind: 'exact' } },
      dirs: { hits: [], returned: 0, total: 0, deduped: 0 },
    }
    const merged = helpers.mergeContentPhase(preview, {
      content: { hits: [{ path: '/a', snippet: 'body' }], returned: 1, count: { value: 1, kind: 'exact' } },
    })
    expect(merged.content.hits).toHaveLength(1)
    expect(merged.content.pending).toBeUndefined()
    expect(merged.files.hits.map((hit: any) => hit.path)).toEqual(['/b'])
    expect(merged.files.returned).toBe(1)
    expect(merged.files.deduped).toBe(1)
    expect(merged.dirs).toBe(preview.dirs)
    // A slow names phase arriving after the body phase must not resurrect the
    // file row that the body hit now owns.
    const late = helpers.mergeNamePhase(merged, { files: { hits: [{ path: '/a' }, { path: '/c' }], returned: 2, deduped: 0 } })
    expect(late.content.hits).toHaveLength(1)
    expect(late.files.hits.map((hit: any) => hit.path)).toEqual(['/c'])
    expect(late.files.deduped).toBe(1)
    // A body response without a content group (e.g. scope off) leaves groups alone.
    expect(helpers.mergeContentPhase(merged, {})).toBe(merged)
  })

  it('appends load-more pages without duplicates and keeps the exact count', () => {
    const first = {
      content: { hits: [{ path: '/a', messageId: 'm1' }], returned: 1, total: 9, count: { value: 9, kind: 'exact' } },
      files: { hits: [{ path: '/b' }, { path: '/c' }], returned: 2, total: 3, count: { value: 3, kind: 'exact' } },
      dirs: { hits: [], returned: 0, total: 0, count: { value: 0, kind: 'exact' } },
    }
    const page = {
      content: { hits: [{ path: '/a', messageId: 'm1' }, { path: '/d', messageId: 'm2' }], returned: 2, total: 9, count: { value: 2, kind: 'bounded' } },
      files: { hits: [{ path: '/c' }, { path: '/e' }], returned: 2, total: 3, count: { value: 3, kind: 'exact' } },
    }
    const merged = helpers.appendCombinedPages(first, page)
    expect(merged.content.hits.map((hit: any) => hit.path + '|' + hit.messageId)).toEqual(['/a|m1', '/d|m2'])
    expect(merged.content.returned).toBe(2)
    // The already shown exact count beats a fresh bounded one.
    expect(merged.content.count).toEqual({ value: 9, kind: 'exact' })
    expect(merged.files.hits.map((hit: any) => hit.path)).toEqual(['/b', '/c', '/e'])
    expect(merged.files.returned).toBe(3)
    // A group missing from the extra page keeps what was already loaded.
    expect(merged.dirs).toBe(first.dirs)
    // Cross-page invariant: a path that only now appears in content leaves files.
    const next = helpers.appendCombinedPages(merged, { content: { hits: [{ path: '/b', messageId: '' }], returned: 1 } })
    expect(next.files.hits.map((hit: any) => hit.path)).toEqual(['/c', '/e'])
  })

  it('caps rendered rows at 300 without dropping the loaded list', () => {
    const loaded = Array.from({ length: 350 }, (_, index) => ({ group: 'files', hit: { path: '/f' + index } }))
    const capped = helpers.capResultRows(loaded, 300)
    expect(capped.rows).toHaveLength(300)
    expect(capped.capped).toBe(true)
    expect(capped.total).toBe(350)
    expect(capped.limit).toBe(300)
    expect(capped.rows[0]).toBe(loaded[0])
    const small = helpers.capResultRows(loaded.slice(0, 3), 300)
    expect(small).toMatchObject({ capped: false, total: 3 })
    expect(small.rows).toHaveLength(3)
  })

  it('keeps build counters and guard errors in the preview placeholder', () => {
    const progress = { phase: 'files', scanned: 2, total: 10, path: '/x' }
    const placeholder = helpers.contentPlaceholderGroup({ enabled: true, building: true, files: 3, sessions: 1, messages: 5, truncated: false, progress }, 'normal', 5, 3)
    expect(placeholder).toMatchObject({ building: true, files: 3, sessions: 1, messages: 5, returned: 0, pending: true })
    expect(placeholder.progress).toEqual(progress)
    expect(helpers.contentPlaceholderGroup(null, 'regex', 5, 3).error).toBe('content-regex-not-supported')
    expect(helpers.contentPlaceholderGroup(null, 'normal', 2, 3).error).toBe('content-query-too-short')
    // An empty search box is the normal empty state, not a "too short" error.
    expect(helpers.contentPlaceholderGroup(null, 'normal', 0, 3).error).toBeUndefined()
    expect(helpers.contentPlaceholderGroup(null, 'normal', 5, 3).building).toBe(false)
  })

  it('tolerates compact hits (no evidence blocks) in the evidence model', () => {
    const compact = helpers.evidenceForHit('files', { path: '/tmp/x.md', name: 'x.md', size: 1, mtime: 2 })
    expect(compact.kind).toBe('file')
    expect(compact.canOpen).toBe(true)
    expect(compact.ref).toBe('')
    expect(compact.cite).toBe('')
    expect(compact.freshness).toEqual({ state: 'unknown' })
    // Compact session hits stay actionable/citable from the canonical URI.
    const session = helpers.evidenceForHit('content', { kind: 'session', sessionId: 'session-1', title: 'Chat' })
    expect(session.canJump).toBe(true)
    expect(session.cite.startsWith('[Chat](dsh-session:')).toBe(true)
  })

  it('short-circuits an empty search box without a combined request', () => {
    const marker = source.indexOf('// An empty search box is not a query')
    expect(marker).toBeGreaterThanOrEqual(0)
    const end = source.indexOf('if (!anyScope) {', marker)
    expect(end).toBeGreaterThan(marker)
    const block = source.slice(marker, end)
    // Cancels the previous generation and clears every loaded group/offset.
    expect(block).toContain('idle.generation += 1')
    expect(block).toContain('controller.abort()')
    expect(block).toContain('setGroups({})')
    expect(block).toContain('setOffsets({ files: 0, dirs: 0, content: 0 })')
    // Neither the names phase nor the settled full request may run.
    expect(block).not.toContain('/dsh-locator/combined')
    expect(block).not.toContain('combinedBody(')
    // The cleared list still shows the localized empty-query hint.
    expect(source).toContain("t('emptyQuery')")
    expect(source).toContain("rows.length === 0 && query.trim() === ''")
  })

  it('asks for evidence on the settled full phase only and clamps evidenceLimit', () => {
    const options = {
      query: 'the',
      scopes: { content: true, files: true, dirs: true },
      sort: 'mtime', desc: true, matchMode: 'normal', caseSensitive: false, wholeWord: false,
      sessionId: '', root: '', includeArchived: false,
      limit: 50, contentLimit: 30, countLimit: 1000,
      filesOffset: 0, dirsOffset: 0, contentOffset: 0,
    }
    const full = helpers.combinedBody(options, 'full')
    expect(full.evidenceLimit).toBe(10)
    // A caller may widen or disable the window (0..50 mirrors the server);
    // compact keystroke pages never ask for evidence at all.
    expect(helpers.combinedBody({ ...options, evidenceLimit: 25 }, 'full').evidenceLimit).toBe(25)
    expect(helpers.combinedBody({ ...options, evidenceLimit: 500 }, 'full').evidenceLimit).toBe(50)
    expect(helpers.combinedBody({ ...options, evidenceLimit: 0 }, 'full').evidenceLimit).toBe(0)
    for (const phase of ['names', 'content', 'more'] as const) {
      expect('evidenceLimit' in helpers.combinedBody(options, phase)).toBe(false)
    }
    // The panel sends the constant with every phase's settings object.
    expect(source).toContain('evidenceLimit: SEARCH_EVIDENCE_LIMIT')
    expect(sourceConstant('SEARCH_EVIDENCE_LIMIT')).toBe(10)
  })

  it('marks the bounded 2-character body fallback and localizes the note', () => {
    // Normal mode lowers the body threshold to 2; extended keeps the trigram floor.
    const scopes = { content: true, files: true, dirs: true }
    const short = helpers.searchPhasePlan({ query: 'ai', scopes, contentEnabled: true, matchMode: 'normal', minChars: 2 })
    expect(short).toMatchObject({ text: 'ai', content: true, names: true, minChars: 2 })
    expect(helpers.searchPhasePlan({ query: 'ai', scopes, contentEnabled: true, matchMode: 'extended', minChars: 3 }).content).toBe(false)
    expect(helpers.searchPhasePlan({ query: 'a', scopes, contentEnabled: true, matchMode: 'normal', minChars: 2 }).content).toBe(false)
    // The placeholder carries the marker the renderer turns into the note.
    const two = helpers.contentPlaceholderGroup(null, 'normal', 2, 2)
    expect(two.shortQueryFallback).toBe(true)
    expect(two.error).toBeUndefined()
    expect(helpers.contentPlaceholderGroup(null, 'normal', 3, 2).shortQueryFallback).toBe(false)
    expect(helpers.contentPlaceholderGroup(null, 'extended', 2, 3).shortQueryFallback).toBe(false)
    expect(helpers.contentPlaceholderGroup(null, 'regex', 2, 2).shortQueryFallback).toBe(false)
    // The server-reported field and its warning code map to the localized note
    // instead of leaking a raw code through the generic warning line.
    expect(source).toContain("t('shortQueryFallback')")
    expect(source).toContain('group.shortQueryFallback === true')
    expect(source).toContain("code === 'short-query-fallback'")
    expect(source).toContain("code.startsWith('content-query-short-fallback')")
    expect(sourceConstant('SEARCH_SHORT_CONTENT_CHARS')).toBe(2)
    expect(source).toContain("contentMinChars = matchMode === 'normal' ? SEARCH_SHORT_CONTENT_CHARS : SEARCH_MIN_CONTENT_CHARS")
  })

  it('renders evidence-omitted hits tolerantly and hints on demand', () => {
    // Rows past the full-request evidenceLimit lose ref/freshness/permissions.
    const omitted = helpers.evidenceForHit('files', { path: '/tmp/late.md', name: 'late.md', size: 3, mtime: 4, ext: 'md' })
    expect(omitted.ref).toBe('')
    expect(omitted.hashShort).toBe('')
    expect(omitted.freshnessReported).toBe(false)
    expect(omitted.permissionsReported).toBe(false)
    expect(omitted.canOpen).toBe(true)
    expect(omitted.mention).toBe('@/tmp/late.md')
    // Malformed evidence blocks fall back to the derived view instead of throwing.
    const messy = helpers.evidenceForHit('content', {
      path: '/tmp/x', freshness: 'stale', permissions: { read: 'maybe' }, hash: 12, title: 5, ref: 42,
    })
    expect(messy.kind).toBe('file')
    expect(messy.title).toBe('x')
    expect(messy.ref).toBe('')
    expect(messy.freshness).toEqual({ state: 'unknown' })
    expect(messy.permissions).toEqual({ read: 'allowed', visibility: 'roots', reason: '' })
    // The inspector reports the window on demand and rows expose the state.
    expect(source).toContain("t('evidenceOmittedHint', { n: SEARCH_EVIDENCE_LIMIT })")
    expect(source).toContain("'data-evidence': evidenceLoaded ? 'rich' : settled ? 'omitted' : 'pending'")
  })

  it('wires the two-phase pipeline and status-only building polling', () => {
    // Names first, bodies inside the 250-350ms pause window, settle last.
    const namesDelay = sourceConstant('SEARCH_NAMES_DELAY')
    const contentDelay = sourceConstant('SEARCH_CONTENT_DELAY')
    const settleDelay = sourceConstant('SEARCH_SETTLE_DELAY')
    expect(namesDelay).toBeGreaterThan(0)
    expect(namesDelay).toBeLessThan(contentDelay)
    expect(contentDelay).toBeGreaterThanOrEqual(250)
    expect(contentDelay).toBeLessThanOrEqual(350)
    expect(settleDelay).toBeGreaterThan(contentDelay)
    // LRU 20 phase cache; at most 300 rows in the DOM.
    expect(sourceConstant('SEARCH_CACHE_SIZE')).toBe(20)
    expect(sourceConstant('SEARCH_ROW_LIMIT')).toBe(300)
    expect(sourceConstant('SEARCH_MIN_CONTENT_CHARS')).toBe(3)
    // The three phases go through the shared body builder (compact + count flags).
    expect(source).toContain("combinedBody(settings, 'names')")
    expect(source).toContain("combinedBody(settings, 'content')")
    expect(source).toContain("combinedBody(settings, 'full')")
    expect(source).toContain('appendCombinedPages(previous, data)')
    expect(source).toContain('capResultRows(loadedRows, SEARCH_ROW_LIMIT)')
    expect(source).toContain('highlightExpression(query, highlightCache)')
    // Building/scans poll ONLY /dsh-locator/status; the old combined refresh loop
    // (re-running the whole search every 2.5s) must be gone.
    const pollStart = source.indexOf('// Building/scans poll ONLY')
    expect(pollStart).toBeGreaterThanOrEqual(0)
    const pollEnd = source.indexOf('// Two-phase search.', pollStart)
    expect(pollEnd).toBeGreaterThan(pollStart)
    const pollBlock = source.slice(pollStart, pollEnd)
    expect(pollBlock).toContain("post('/dsh-locator/status'")
    expect(pollBlock).not.toContain("post('/dsh-locator/combined'")
    expect(source).not.toContain('setTimeout(() => setRefreshTick(value => value + 1), 2500)')
    // Every keystroke cancels the previous phases.
    expect(source).toContain('new AbortController()')
    expect(source).toContain('search.controllers')
    expect(source).toContain('AbortError')
    expect(source).toContain('mergeContentPhase(')
    expect(source).toContain('retrySearch')
  })
})
