/**
 * Best-effort body extraction for PDF, Word, Excel, PowerPoint and EPUB files.
 *
 * Everything heavy is loaded lazily through `import()`: a profile that never
 * indexes a document must not pay pdfjs's parse cost at startup, and a missing
 * or broken optional dependency degrades to "not extracted" plus a stable
 * warning code instead of breaking the plugin. Extractors return plain text in
 * reading order; exact layout is best-effort by design.
 * @module dsh-locator/extract
 */

import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'

/** Document formats {@link extractDocument} understands. */
export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'epub'

const DOCUMENT_FORMATS = new Map<string, DocumentFormat>([
  ['.pdf', 'pdf'],
  ['.docx', 'docx'],
  ['.xlsx', 'xlsx'],
  ['.pptx', 'pptx'],
  ['.epub', 'epub'],
])

/**
 * Extractable document format of a path or bare file name.
 * @param pathOrName - absolute path or base name.
 * @returns the format, or null for anything that is not a supported document.
 */
export function documentFormat(pathOrName: string): DocumentFormat | null {
  return DOCUMENT_FORMATS.get(extname(pathOrName).toLowerCase()) ?? null
}

/** Options for {@link extractDocument}. */
export interface ExtractOptions {
  /** Files larger than this many bytes are refused without being parsed; 0 means unlimited. */
  maxBytes: number
  /** Hard cap on returned characters (default 8 MiB). */
  maxChars?: number
  /**
   * Non-fatal problem sink. Codes are stable and bounded:
   * `document-too-large`, `document-text-empty`,
   * `document-extract-failed:<format>`.
   */
  onWarning?: (warning: string) => void
}

/** Extracted document body plus its format. */
export interface ExtractedDocument {
  text: string
  format: DocumentFormat
  /** Page count, when the format exposes one (PDF). */
  pages?: number
  /** Set when the body was extracted with a non-fatal caveat. */
  warning?: string
}

/** Warning code: the file is over `maxBytes` and was skipped. */
export const DOCUMENT_TOO_LARGE = 'document-too-large'
/** Warning code: the document parsed but contained no text (for example a scan). */
export const DOCUMENT_TEXT_EMPTY = 'document-text-empty'
/** Warning code: parsing threw; the format is spelled out (e.g. `pdf`). */
export function documentExtractFailed(format: DocumentFormat): string {
  return `document-extract-failed:${format}`
}

const DEFAULT_MAX_CHARS = 8_000_000
/** One decompressed zip member may not exceed this (zip-bomb guard). */
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024
/** Total decompressed zip bytes per document (zip-bomb guard). */
const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024
/** Zip members examined per document (zip-bomb guard). */
const MAX_ZIP_ENTRIES = 20_000

/** Cached promise per lazily imported optional dependency. */
const lazyModules = new Map<string, Promise<unknown>>()

/**
 * Import one optional dependency exactly once, only when a document needs it.
 * A non-literal specifier keeps these packages out of the static module graph
 * (so a text-only profile never resolves them) and keeps TypeScript from
 * requiring declarations for optional runtime dependencies.
 */
async function lazyImport<T>(specifier: string): Promise<T> {
  const cached = lazyModules.get(specifier)
  if (cached !== undefined) return cached as Promise<T>
  const loading = import(specifier)
  lazyModules.set(specifier, loading)
  try {
    return await loading as T
  } catch (error) {
    // A failed optional import must not poison later attempts.
    if (lazyModules.get(specifier) === loading) lazyModules.delete(specifier)
    throw error
  }
}

/** Report one stable warning code; a broken sink never breaks extraction. */
function warn(options: ExtractOptions, warning: string): void {
  try { options.onWarning?.(warning) } catch { /* warnings are best-effort */ }
}

/**
 * Extract the plain-text body of one PDF/Office/EPUB document.
 *
 * Failures never throw: an unreadable, oversized, corrupt or unsupported file
 * returns null and reports a stable warning code through `onWarning`.
 * @param path - absolute document path.
 * @param options - size cap, character cap and warning sink.
 * @returns the extracted body, or null when nothing could be read.
 */
export async function extractDocument(path: string, options: ExtractOptions): Promise<ExtractedDocument | null> {
  const format = documentFormat(path)
  if (format === null) return null
  let size: number
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    size = info.size
  } catch {
    return null
  }
  const maxBytes = options.maxBytes > 0 ? options.maxBytes : Number.POSITIVE_INFINITY
  if (size > maxBytes) {
    warn(options, DOCUMENT_TOO_LARGE)
    return null
  }
  let data: Buffer
  try { data = await readFile(path) } catch { return null }
  if (data.length > maxBytes) {
    warn(options, DOCUMENT_TOO_LARGE)
    return null
  }
  const maxChars = options.maxChars !== undefined && options.maxChars > 0 ? options.maxChars : DEFAULT_MAX_CHARS
  try {
    const extracted = await extractByFormat(format, data, maxChars)
    let text = extracted.text
    if (text.length > maxChars) text = text.slice(0, maxChars)
    text = text.trim()
    if (text === '') {
      warn(options, DOCUMENT_TEXT_EMPTY)
      return null
    }
    if (extracted.warning !== undefined) warn(options, extracted.warning)
    return {
      text,
      format,
      ...(extracted.pages === undefined ? {} : { pages: extracted.pages }),
      ...(extracted.warning === undefined ? {} : { warning: extracted.warning }),
    }
  } catch {
    warn(options, documentExtractFailed(format))
    return null
  }
}

/** One extractor's raw result before the shared size cap is applied. */
interface FormatExtraction {
  text: string
  pages?: number
  warning?: string
}

async function extractByFormat(format: DocumentFormat, data: Buffer, maxChars: number): Promise<FormatExtraction> {
  switch (format) {
    case 'pdf': return await extractPdf(data, maxChars)
    case 'docx': return await extractDocx(data)
    case 'xlsx': return await extractXlsx(data)
    case 'pptx': return await extractPptx(data)
    case 'epub': return await extractEpub(data)
  }
}

/** Shape of the small part of pdfjs-dist we consume (loaded dynamically). */
interface PdfLoadingTask {
  promise: Promise<PdfDocument>
  destroy: () => Promise<void>
}

interface PdfDocument {
  numPages: number
  getPage: (index: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>
}

interface PdfjsModule {
  getDocument: (options: Record<string, unknown>) => PdfLoadingTask
}

/** Extract text page by page; stop reading once the character cap is reached. */
async function extractPdf(data: Buffer, maxChars: number): Promise<FormatExtraction> {
  const pdfjs = await lazyImport<PdfjsModule>('pdfjs-dist/legacy/build/pdf.mjs')
  if (typeof pdfjs.getDocument !== 'function') throw new Error('pdfjs-dist getDocument is unavailable')
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    // A Node host has no DOM: skip evaluation and font loading, text only.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
    verbosity: 0,
  })
  try {
    const document = await task.promise
    const pages: string[] = []
    let characters = 0
    for (let index = 1; index <= document.numPages; index++) {
      const content = await (await document.getPage(index)).getTextContent()
      const text = pdfPageText(content.items)
      pages.push(text)
      characters += text.length
      if (characters >= maxChars) break
    }
    return { text: cleanPdfText(pages.join('\n\n')), pages: document.numPages }
  } finally {
    try { await task.destroy() } catch { /* the loading task may already be gone */ }
  }
}

interface PdfTextItem {
  str?: unknown
  hasEOL?: unknown
}

/**
 * Flatten one page's text items. Items are usually word/run sized, so a space
 * is inserted between chunks unless the chunk already carries whitespace or the
 * boundary is CJK (CJK text has no spaces and pdfjs may split it per glyph).
 */
function pdfPageText(items: readonly unknown[]): string {
  const parts: string[] = []
  for (const raw of items) {
    const item = raw as PdfTextItem
    if (typeof item.str !== 'string' || item.str === '') continue
    const previous = parts.length === 0 ? '' : parts[parts.length - 1] ?? ''
    const hasEOL = item.hasEOL === true
    if (!hasEOL && previous !== '' && !/\s$/.test(previous) && !/^\s/.test(item.str) && !cjkBoundary(previous, item.str)) {
      parts.push(' ')
    }
    parts.push(item.str)
    if (hasEOL) parts.push('\n')
  }
  return parts.join('')
}

/** CJK ranges that must not get an inserted space at a chunk boundary. */
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/

function cjkBoundary(previous: string, next: string): boolean {
  const left = [...previous].pop() ?? ''
  const right = [...next][0] ?? ''
  return CJK.test(left) || CJK.test(right)
}

/** Collapse the spacing pdfjs emits between runs while keeping line breaks. */
function cleanPdfText(text: string): string {
  return sanitizeText(text, true)
}

interface MammothModule {
  extractRawText: (input: { buffer: Buffer }) => Promise<{ value?: unknown }>
}

async function extractDocx(data: Buffer): Promise<FormatExtraction> {
  const imported = await lazyImport<MammothModule & { default?: MammothModule }>('mammoth')
  const mammoth = imported.default ?? imported
  if (typeof mammoth.extractRawText !== 'function') throw new Error('mammoth extractRawText is unavailable')
  const result = await mammoth.extractRawText({ buffer: data })
  return { text: sanitizeText(typeof result.value === 'string' ? result.value : '', false) }
}

/** Shape of the small part of fflate we consume (loaded dynamically). */
interface UnzipFileInfoLike {
  name: string
  originalSize: number
}

interface FflateModule {
  unzipSync: (data: Uint8Array, options?: { filter?: (file: UnzipFileInfoLike) => boolean }) => Record<string, Uint8Array>
  strFromU8: (data: Uint8Array) => string
}

/** One unzipped OOXML/EPUB package with bounded decompression. */
interface UnzippedDocument {
  files: Record<string, Uint8Array>
  text: (name: string) => string | undefined
  names: () => string[]
}

async function unzipDocument(data: Buffer): Promise<UnzippedDocument> {
  const fflate = await lazyImport<FflateModule>('fflate')
  if (typeof fflate.unzipSync !== 'function' || typeof fflate.strFromU8 !== 'function') {
    throw new Error('fflate unzip API is unavailable')
  }
  let entries = 0
  let total = 0
  const files = fflate.unzipSync(new Uint8Array(data), {
    filter: (file) => {
      entries++
      if (entries > MAX_ZIP_ENTRIES) return false
      const size = Number.isFinite(file.originalSize) ? file.originalSize : 0
      if (size > MAX_ZIP_ENTRY_BYTES || total + size > MAX_ZIP_TOTAL_BYTES) return false
      total += size
      return true
    },
  })
  return {
    files,
    text: name => {
      const entry = files[name]
      return entry === undefined ? undefined : fflate.strFromU8(entry)
    },
    names: () => Object.keys(files),
  }
}

/** Decode the XML entities that appear in OOXML/EPUB text runs. */
function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match: string, entity: string) => {
    if (entity.length > 1 && (entity[0] === '#')) {
      const hex = entity[1] === 'x' || entity[1] === 'X'
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code)
      return match
    }
    switch (entity) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      case 'nbsp': return ' '
      default: return match
    }
  })
}

/** Concatenate every `<tag>…</tag>` run inside one XML fragment, in order. */
function collectTagText(xml: string, tag: string): string {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g')
  let text = ''
  for (const match of xml.matchAll(pattern)) text += decodeXmlEntities(match[1] ?? '')
  return text
}

/** Shared string table of an xlsx workbook (`<si><t>…</t></si>`). */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) out.push(collectTagText(match[1] ?? '', 't'))
  return out
}

/** Worksheet names in workbook order, when `xl/workbook.xml` is present. */
function workbookSheetNames(xml: string | undefined): string[] {
  if (xml === undefined) return []
  const names: string[] = []
  for (const match of xml.matchAll(/<sheet\b[^>]*?\bname="([^"]*)"/g)) names.push(decodeXmlEntities(match[1] ?? ''))
  return names
}

/** One worksheet as tab-separated rows, resolving shared and inline strings. */
function parseWorksheet(xml: string, shared: readonly string[]): string[] {
  const lines: string[] = []
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const cell of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1] ?? ''
      const inner = cell[2] ?? ''
      const type = /(?:^|\s)t="([^"]*)"/.exec(attributes)?.[1] ?? ''
      let value: string | undefined
      if (type === 'inlineStr') {
        value = collectTagText(inner, 't')
      } else {
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1]
        if (raw !== undefined) {
          const decoded = decodeXmlEntities(raw)
          value = type === 's' ? shared[Number(decoded)] : decoded
        }
      }
      if (value !== undefined && value.trim() !== '') cells.push(value.trim())
    }
    if (cells.length > 0) lines.push(cells.join('\t'))
  }
  return lines
}

function sheetNumber(name: string): number {
  const match = /sheet(\d+)\.xml$/i.exec(name)
  return match?.[1] === undefined ? 0 : Number(match[1])
}

function buildXlsxText(document: UnzippedDocument): string {
  const sharedXml = document.text('xl/sharedStrings.xml')
  const shared = sharedXml === undefined ? [] : parseSharedStrings(sharedXml)
  const sheetNames = workbookSheetNames(document.text('xl/workbook.xml'))
  const sheets = document.names()
    .filter(name => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((left, right) => sheetNumber(left) - sheetNumber(right))
  const lines: string[] = []
  sheets.forEach((sheet, index) => {
    const xml = document.text(sheet)
    if (xml === undefined) return
    lines.push(`## ${sheetNames[index] ?? `Sheet${String(index + 1)}`}`)
    lines.push(...parseWorksheet(xml, shared))
  })
  return lines.join('\n')
}

/** Extract each slide's paragraphs in order (`<a:t>` runs, `</a:p>` breaks). */
function buildPptxText(document: UnzippedDocument): string {
  const slides = document.names()
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => sheetNumber(left) - sheetNumber(right))
  const lines: string[] = []
  slides.forEach((slide, index) => {
    const xml = document.text(slide)
    if (xml === undefined) return
    lines.push(`## Slide ${String(index + 1)}`)
    for (const paragraph of xml.split('</a:p>')) {
      const text = collectTagText(paragraph, 'a:t').trim()
      if (text !== '') lines.push(text)
    }
  })
  return lines.join('\n')
}

/** Strip XHTML/HTML markup from one EPUB chapter into readable text. */
function stripMarkup(xml: string): string {
  let text = xml
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  text = text
    .replace(/<br\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|section|article|blockquote|pre|title)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeXmlEntities(text)
}

/** Follow the EPUB spine when its OPF is readable, else filename order. */
function epubChapters(document: UnzippedDocument): string[] {
  const names = document.names()
  const chapters = names.filter(name => /\.(?:xhtml|html|htm)$/i.test(name)).sort((left, right) => left.localeCompare(right))
  const out: string[] = []
  for (const chapter of chapters) {
    const xml = document.text(chapter)
    if (xml === undefined) continue
    const text = stripMarkup(xml)
    if (text.trim() !== '') out.push(text)
  }
  return out
}

async function extractXlsx(data: Buffer): Promise<FormatExtraction> {
  return { text: sanitizeText(buildXlsxText(await unzipDocument(data)), false) }
}

async function extractPptx(data: Buffer): Promise<FormatExtraction> {
  return { text: sanitizeText(buildPptxText(await unzipDocument(data)), false) }
}

async function extractEpub(data: Buffer): Promise<FormatExtraction> {
  const document = await unzipDocument(data)
  return { text: sanitizeText(epubChapters(document).join('\n\n'), false) }
}

/**
 * Normalize extracted text: unify newlines, drop NULs, optionally collapse the
 * run-level spacing PDF extraction inserts, and bound blank-line runs.
 */
function sanitizeText(text: string, collapseSpaces: boolean): string {
  let value = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').replace(/\f/g, '\n')
  if (collapseSpaces) value = value.replace(/[^\S\n]+/g, ' ')
  value = value
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
  value = value.replace(/\n{3,}/g, '\n\n')
  return value.trim()
}
