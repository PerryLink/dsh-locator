/**
 * Dependency-free code-symbol extraction for the repository map and outline.
 *
 * This is a light, line-oriented heuristic: comments and string literals are
 * stripped, then declaration shapes are matched per language. It never builds
 * an AST, so exotic syntax may be missed, but it is fast enough to run over
 * every indexed code file and stable across the languages an agent is likely
 * to meet in a workspace (Go, TypeScript/JavaScript, Python, Rust, Java, C,
 * C++, C#, PHP, Ruby, Kotlin, Swift and Markdown headings).
 * @module dsh-locator/symbols
 */
/** Symbol kinds the extractor can report. */
export type SymbolKind = 'function' | 'method' | 'class' | 'struct' | 'interface' | 'trait' | 'enum' | 'type' | 'constant' | 'variable' | 'module' | 'namespace' | 'heading' | 'macro' | 'property' | 'union' | 'object' | 'impl';
/** One symbol extracted from a source file. */
export interface CodeSymbol {
    /** Bare symbol name (Go/Ruby punctuation such as "!" and "?" is kept). */
    name: string;
    kind: SymbolKind;
    /** 1-based line number of the declaration. */
    line: number;
    /** Enclosing type/namespace, when the extractor could determine one. */
    scope?: string;
    /** Language id: "go", "typescript", "python", "markdown", ... */
    language: string;
}
/** Options for {@link extractSymbols}. */
export interface ExtractSymbolsOptions {
    /** Cap on returned symbols (default 2000). */
    maxSymbols?: number;
}
/** Language ids {@link extractSymbols} understands. */
export declare const SYMBOL_LANGUAGES: readonly string[];
/**
 * Language id of a file path, by extension.
 * @param path - file path or bare name.
 * @returns the language id, or null when the file is not a supported source.
 */
export declare function languageForPath(path: string): string | null;
/**
 * Extract symbols from one source text.
 * @param text - full source text.
 * @param language - language id, as returned by {@link languageForPath}.
 * @param options - optional symbol cap.
 * @returns symbols ordered by line; empty for unsupported languages.
 */
export declare function extractSymbols(text: string, language: string, options?: ExtractSymbolsOptions): CodeSymbol[];
/** Extract symbols from a file path plus its text. */
export declare function extractSymbolsForPath(path: string, text: string, options?: ExtractSymbolsOptions): CodeSymbol[];
/**
 * Rough token cost of one repo-map entry (about characters / 4). Used to fit
 * the repository map into an agent's token budget without loading a tokenizer.
 * @param path - file path shown in the map.
 * @param symbols - symbols kept for the file.
 * @returns estimated tokens, at least 1.
 */
export declare function estimateSymbolTokens(path: string, symbols: readonly Pick<CodeSymbol, 'name' | 'kind' | 'line'>[]): number;
//# sourceMappingURL=symbols.d.ts.map