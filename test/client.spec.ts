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
}

/** Dependency order: each function is evaluated as a top-level declaration. */
const HELPER_FUNCTIONS = [
  'encodeSessionRefId', 'decodeSessionRefId', 'decodeSessionIdParamValue',
  'fileMentionFor', 'folderMentionFor', 'parseFileMention', 'parseSessionMention',
  'fileRefForPath', 'parseRefUri', 'baseNameOf', 'sessionMentionFor',
  'normalizeFreshness', 'normalizePermissions', 'defaultPermissionsFor',
  'markdownCitationFor', 'evidenceForHit', 'parseQuickSwitch',
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
