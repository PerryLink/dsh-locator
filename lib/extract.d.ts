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
/** Document formats {@link extractDocument} understands. */
export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'epub';
/**
 * Extractable document format of a path or bare file name.
 * @param pathOrName - absolute path or base name.
 * @returns the format, or null for anything that is not a supported document.
 */
export declare function documentFormat(pathOrName: string): DocumentFormat | null;
/** Options for {@link extractDocument}. */
export interface ExtractOptions {
    /** Files larger than this many bytes are refused without being parsed; 0 means unlimited. */
    maxBytes: number;
    /** Hard cap on returned characters (default 8 MiB). */
    maxChars?: number;
    /**
     * Non-fatal problem sink. Codes are stable and bounded:
     * `document-too-large`, `document-text-empty`,
     * `document-extract-failed:<format>`.
     */
    onWarning?: (warning: string) => void;
}
/** Extracted document body plus its format. */
export interface ExtractedDocument {
    text: string;
    format: DocumentFormat;
    /** Page count, when the format exposes one (PDF). */
    pages?: number;
    /** Set when the body was extracted with a non-fatal caveat. */
    warning?: string;
}
/** Warning code: the file is over `maxBytes` and was skipped. */
export declare const DOCUMENT_TOO_LARGE = "document-too-large";
/** Warning code: the document parsed but contained no text (for example a scan). */
export declare const DOCUMENT_TEXT_EMPTY = "document-text-empty";
/** Warning code: parsing threw; the format is spelled out (e.g. `pdf`). */
export declare function documentExtractFailed(format: DocumentFormat): string;
/**
 * Extract the plain-text body of one PDF/Office/EPUB document.
 *
 * Failures never throw: an unreadable, oversized, corrupt or unsupported file
 * returns null and reports a stable warning code through `onWarning`.
 * @param path - absolute document path.
 * @param options - size cap, character cap and warning sink.
 * @returns the extracted body, or null when nothing could be read.
 */
export declare function extractDocument(path: string, options: ExtractOptions): Promise<ExtractedDocument | null>;
//# sourceMappingURL=extract.d.ts.map