/**
 * client.js is the single-file Web panel bundle: the host loads it as text and
 * evaluates it in the browser, so it has no module boundary to import. These
 * tests therefore treat it as text — parse it as a script, read the locale
 * dictionaries and the URL-ref helpers out of the source — and pin the 0.17.0
 * panel contract (Capabilities tab + evidence-ref chip) without a browser.
 *
 * Node environment only; no new dependencies and nothing here executes the
 * browser bundle.
 */
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'

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

/** Translation keys this release adds or finishes for the panel. */
const PANEL_KEYS = [
  'copyRef', 'copiedRef', 'urlRefTitle',
  'capabilityTab', 'capabilityBack', 'capabilitySearch', 'capabilityPlaceholder', 'capabilityHint',
  'capabilityGlobalHint', 'capabilityTotal', 'capabilityPreflight', 'capabilityRisk', 'capabilityApproval',
  'capabilityEmpty', 'capabilityError', 'capabilityPreflightResult', 'capabilityPreflightFailed',
  'requestFailed',
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

  it('translates the capability/ref-chip keys instead of falling back to English', () => {
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
})
