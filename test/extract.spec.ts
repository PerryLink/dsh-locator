import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterAll, describe, expect, it } from 'vitest'
import { DOCUMENT_TEXT_EMPTY, DOCUMENT_TOO_LARGE, documentExtractFailed, documentFormat, extractDocument } from '../src/extract.ts'

const cleanups: Array<() => void> = []
afterAll(() => { for (const cleanup of cleanups.reverse()) cleanup() })

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFixture(dir: string, name: string, data: Uint8Array | string): string {
  const path = join(dir, name)
  writeFileSync(path, typeof data === 'string' ? Buffer.from(data) : data)
  return path
}

function warningSink(): { codes: string[]; onWarning: (warning: string) => void } {
  const codes: string[] = []
  return { codes, onWarning: (warning: string) => { codes.push(warning) } }
}

/** Escape a string for a PDF literal string object. */
function pdfString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** Small well-formed PDF with one Helvetica text line per page. */
function minimalPdf(pages: readonly string[]): Buffer {
  const objects = new Map<number, string>()
  const pageIds: number[] = []
  let next = 4
  for (let index = 0; index < pages.length; index++) {
    pageIds.push(next)
    next += 2
  }
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  objects.set(2, '<< /Type /Pages /Kids [' + pageIds.map(id => String(id) + ' 0 R').join(' ') + '] /Count ' + String(pages.length) + ' >>')
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  pages.forEach((text, index) => {
    const pageId = pageIds[index] ?? 0
    const contentId = pageId + 1
    const stream = 'BT /F1 12 Tf 72 720 Td (' + pdfString(text) + ') Tj ET'
    objects.set(pageId, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ' + String(contentId) + ' 0 R /Resources << /Font << /F1 3 0 R >> >> >>')
    objects.set(contentId, '<< /Length ' + String(stream.length) + ' >>\nstream\n' + stream + '\nendstream')
  })
  const maxId = Math.max(...objects.keys())
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id <= maxId; id++) {
    offsets.push(out.length)
    out += String(id) + ' 0 obj\n' + (objects.get(id) ?? 'null') + '\nendobj\n'
  }
  const xref = out.length
  out += 'xref\n0 ' + String(maxId + 1) + '\n0000000000 65535 f \n'
  for (const offset of offsets) out += String(offset).padStart(10, '0') + ' 00000 n \n'
  out += 'trailer\n<< /Size ' + String(maxId + 1) + ' /Root 1 0 R >>\nstartxref\n' + String(xref) + '\n%%EOF\n'
  return Buffer.from(out, 'latin1')
}

function minimalDocx(text: string): Uint8Array {
  const wordNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="' + wordNs + '"><w:body>'
    + text.split('\n').map(paragraph => '<w:p><w:r><w:t>' + paragraph + '</w:t></w:r></w:p>').join('')
    + '</w:body></w:document>'
  const contentTypes = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  const relationships = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(relationships),
    'word/document.xml': strToU8(document),
  })
}

function minimalXlsx(): Uint8Array {
  const shared = '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>alpha marker</t></si><si><t>beta marker</t></si></sst>'
  const workbook = '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'
  const sheet = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
    + '<row r="2"><c r="A2"><v>42</v></c><c r="B2" t="inlineStr"><is><t>inline &amp; text</t></is></c></row>'
    + '</sheetData></worksheet>'
  return zipSync({
    'xl/sharedStrings.xml': strToU8(shared),
    'xl/workbook.xml': strToU8(workbook),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  })
}

function minimalPptx(): Uint8Array {
  const slide = (parts: readonly string[]): string => '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>'
    + parts.map(paragraph => '<a:p><a:r><a:t>' + paragraph + '</a:t></a:r></a:p>').join('')
    + '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
  return zipSync({
    'ppt/slides/slide1.xml': strToU8(slide(['Slide one marker', 'after break'])),
    'ppt/slides/slide2.xml': strToU8(slide(['Slide two marker'])),
  })
}

function minimalEpub(): Uint8Array {
  const chapter = (heading: string, body: string): string => '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>' + heading + '</title></head><body><h1>' + heading + '</h1><p>' + body + '</p></body></html>'
  return zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'OEBPS/chapter1.xhtml': strToU8(chapter('Chapter One', 'romance &amp; intrigue marker')),
    'OEBPS/chapter2.xhtml': strToU8(chapter('Chapter Two', 'second chapter marker')),
  })
}

describe('documentFormat', () => {
  it('recognizes the extractable extensions and nothing else', () => {
    expect(documentFormat('/tmp/a.PDF')).toBe('pdf')
    expect(documentFormat('report.docx')).toBe('docx')
    expect(documentFormat('/tmp/book.xlsx')).toBe('xlsx')
    expect(documentFormat('/tmp/deck.pptx')).toBe('pptx')
    expect(documentFormat('/tmp/book.epub')).toBe('epub')
    expect(documentFormat('/tmp/notes.md')).toBeNull()
    expect(documentFormat('/tmp/legacy.doc')).toBeNull()
  })
})

describe('extractDocument', () => {
  it('extracts PDF text and the page count with the lazy pdfjs build', async () => {
    const dir = tempDir('locator-extract-pdf-')
    const path = writeFixture(dir, 'sample.pdf', minimalPdf(['hello locator pdf marker']))
    const sink = warningSink()
    const result = await extractDocument(path, { maxBytes: 10 * 1024 * 1024, onWarning: sink.onWarning })
    expect(result).not.toBeNull()
    expect(result?.format).toBe('pdf')
    expect(result?.pages).toBe(1)
    expect(result?.text).toContain('hello locator pdf marker')
    expect(sink.codes).toEqual([])
  })

  it('extracts every PDF page', async () => {
    const dir = tempDir('locator-extract-pdf-pages-')
    const path = writeFixture(dir, 'pages.pdf', minimalPdf(['first page marker', 'second page marker']))
    const result = await extractDocument(path, { maxBytes: 10 * 1024 * 1024 })
    expect(result?.pages).toBe(2)
    expect(result?.text).toContain('first page marker')
    expect(result?.text).toContain('second page marker')
  })

  it('extracts DOCX paragraphs through mammoth', async () => {
    const dir = tempDir('locator-extract-docx-')
    const path = writeFixture(dir, 'sample.docx', minimalDocx('Hello locator docx marker\nSecond paragraph'))
    const result = await extractDocument(path, { maxBytes: 10 * 1024 * 1024 })
    expect(result?.format).toBe('docx')
    expect(result?.text).toContain('Hello locator docx marker')
    expect(result?.text).toContain('Second paragraph')
  })

  it('extracts XLSX shared strings, numbers and inline strings', async () => {
    const dir = tempDir('locator-extract-xlsx-')
    const path = writeFixture(dir, 'book.xlsx', minimalXlsx())
    const result = await extractDocument(path, { maxBytes: 10 * 1024 * 1024 })
    expect(result?.format).toBe('xlsx')
    expect(result?.text).toContain('## Data')
    expect(result?.text).toContain('alpha marker')
    expect(result?.text).toContain('beta marker')
    expect(result?.text).toContain('42')
    expect(result?.text).toContain('inline & text')
  })

  it('extracts PPTX slide paragraphs', async () => {
    const dir = tempDir('locator-extract-pptx-')
    const path = writeFixture(dir, 'deck.pptx', minimalPptx())
    const result = await extractDocument(path, { maxBytes: 10 * 1024 * 1024 })
    expect(result?.format).toBe('pptx')
    expect(result?.text).toContain('## Slide 1')
    expect(result?.text).toContain('## Slide 2')
    expect(result?.text).toContain('Slide one marker')
    expect(result?.text).toContain('after break')
    expect(result?.text).toContain('Slide two marker')
  })

  it('extracts EPUB chapters and decodes XML entities', async () => {
    const dir = tempDir('locator-extract-epub-')
    const path = writeFixture(dir, 'book.epub', minimalEpub())
    const result = await extractDocument(path, { maxBytes: 10 * 1024 * 1024 })
    expect(result?.format).toBe('epub')
    expect(result?.text).toContain('Chapter One')
    expect(result?.text).toContain('romance & intrigue marker')
    expect(result?.text).toContain('second chapter marker')
  })

  it('refuses files over maxBytes and reports document-too-large', async () => {
    const dir = tempDir('locator-extract-large-')
    const path = writeFixture(dir, 'big.pdf', minimalPdf(['too large to read']))
    const sink = warningSink()
    const result = await extractDocument(path, { maxBytes: 10, onWarning: sink.onWarning })
    expect(result).toBeNull()
    expect(sink.codes).toEqual([DOCUMENT_TOO_LARGE])
  })

  it('truncates extracted text to maxChars', async () => {
    const dir = tempDir('locator-extract-chars-')
    const path = writeFixture(dir, 'long.docx', minimalDocx('x'.repeat(500)))
    const result = await extractDocument(path, { maxBytes: 10 * 1024 * 1024, maxChars: 20 })
    expect(result).not.toBeNull()
    expect((result?.text.length ?? 0)).toBeLessThanOrEqual(20)
  })

  it('reports an empty document instead of storing a blank body', async () => {
    const dir = tempDir('locator-extract-empty-')
    const path = writeFixture(dir, 'empty.docx', minimalDocx(''))
    const sink = warningSink()
    const result = await extractDocument(path, { maxBytes: 10 * 1024 * 1024, onWarning: sink.onWarning })
    expect(result).toBeNull()
    expect(sink.codes).toContain(DOCUMENT_TEXT_EMPTY)
  })

  it('returns null with a warning for corrupt documents instead of throwing', async () => {
    const dir = tempDir('locator-extract-corrupt-')
    const cases: Array<[string, string]> = [
      ['broken.pdf', documentExtractFailed('pdf')],
      ['broken.docx', documentExtractFailed('docx')],
      ['broken.xlsx', documentExtractFailed('xlsx')],
      ['broken.pptx', documentExtractFailed('pptx')],
      ['broken.epub', documentExtractFailed('epub')],
    ]
    for (const [name, expected] of cases) {
      const path = writeFixture(dir, name, 'this is definitely not a document')
      const sink = warningSink()
      const result = await extractDocument(path, { maxBytes: 10 * 1024 * 1024, onWarning: sink.onWarning })
      expect(result).toBeNull()
      expect(sink.codes).toContain(expected)
    }
  })

  it('returns null without a warning for paths that are not documents', async () => {
    const dir = tempDir('locator-extract-unknown-')
    const path = writeFixture(dir, 'notes.txt', 'plain text')
    const sink = warningSink()
    expect(await extractDocument(path, { maxBytes: 1000, onWarning: sink.onWarning })).toBeNull()
    expect(sink.codes).toEqual([])
  })

  it('returns null for a missing file', async () => {
    const dir = tempDir('locator-extract-missing-')
    expect(await extractDocument(join(dir, 'missing.pdf'), { maxBytes: 1000 })).toBeNull()
  })
})