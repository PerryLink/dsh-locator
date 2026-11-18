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
/** The three configured pattern layers. */
export interface ScopeRules {
    /** Globs never returned as name or content hits. */
    notSearchable: readonly string[];
    /** Globs whose body/ref must not be returned or resolved. */
    notReadable: readonly string[];
    /** Globs that must not enter the content index (name index keeps them). */
    notIndexed: readonly string[];
}
/** A public summary of the effective scope rules (status output). */
export interface ScopeDescription {
    notSearchable: string[];
    notReadable: string[];
    notIndexed: string[];
    /** Number of distinct glob patterns in force. */
    activeRules: number;
}
/** Anything with a path can be filtered by a scope rule. */
export interface Pathed {
    path: string;
}
/** Options for the glob matcher; tests pin the platform behavior explicitly. */
export interface GlobOptions {
    /** Compare case-insensitively (defaults to the platform filesystem rule). */
    caseInsensitive?: boolean;
}
/**
 * Normalize one path for glob matching: forward slashes, no trailing slash,
 * lowercased when the comparison is case-insensitive.
 * @param path - raw absolute path.
 * @param caseInsensitive - lowercase the result (Windows by default).
 * @returns the normalized path.
 */
export declare function normalizeGlobPath(path: string, caseInsensitive?: boolean): string;
/**
 * Compile a pattern list into one predicate (gitignore order; '!' undoes an
 * earlier match, so the last matching pattern wins).
 * @param patterns - configured glob strings.
 * @param options - matching options.
 * @returns a predicate over absolute paths.
 */
export declare function compileGlobMatcher(patterns: readonly string[], options?: GlobOptions): (path: string) => boolean;
/** Whether any pattern matches (negations applied in order). */
export declare function matchesAnyGlob(path: string, patterns: readonly string[], options?: GlobOptions): boolean;
/** One-shot glob test (compiles on every call; prefer compileGlobMatcher). */
export declare function matchesGlob(path: string, pattern: string, options?: GlobOptions): boolean;
/** One matched path and the layer that refused it. */
export type ScopeLayer = 'searchable' | 'readable' | 'indexed';
/** Result of filtering a hit list through the scope. */
export interface ScopeFilterResult<T> {
    hits: T[];
    /** Hits removed by a not* rule. */
    dropped: number;
    /** Which layers removed something (for a bounded warning code). */
    layers: ScopeLayer[];
}
/** The default (empty) scope: everything is searchable, readable and indexable. */
export declare const EMPTY_SCOPE_RULES: ScopeRules;
/**
 * Layered ignore scope: one matcher per layer, plus list filters the tools use
 * before building their output.
 */
export declare class Scope {
    readonly rules: ScopeRules;
    private readonly searchableMatcher;
    private readonly readableMatcher;
    private readonly indexedMatcher;
    constructor(rules: ScopeRules, caseInsensitive?: boolean);
    /** Whether a path may appear in any hit list. */
    isSearchable(path: string): boolean;
    /** Whether a path's body/ref may be returned or resolved. */
    isReadable(path: string): boolean;
    /** Whether a path may enter the content index at all. */
    isIndexable(path: string): boolean;
    /** Whether a content hit for this path may be shown (all three layers). */
    contentVisible(path: string): boolean;
    /**
     * The read permission block for one path, ready for a hit/resolve output.
     * Ref-tools should call this before reading a file body; a denied path must
     * answer content-path-denied instead of leaking bytes.
     */
    readability(path: string): {
        read: 'allowed' | 'denied';
        reason: string;
    };
    /** Drop non-searchable name/content hits. */
    filterSearchable<T extends Pathed>(hits: readonly T[]): ScopeFilterResult<T>;
    /** Drop content hits that are not searchable, readable or indexable. */
    filterContent<T extends Pathed>(hits: readonly T[]): ScopeFilterResult<T>;
    /** Bounded, JSON-safe summary for locator_status and the HTTP status route. */
    describe(): ScopeDescription;
}
/** The empty scope shared by callers that did not configure any rule. */
export declare const NO_SCOPE: Scope;
/** Build a scope from the plugin configuration (all fields are optional). */
export declare function scopeFromConfig(config: Partial<ScopeRules>): Scope;
/**
 * Whether a scope refuses to read one path. Exported as the public hook the
 * ref/resolve layer consumes: a denied path must answer content-path-denied
 * with permissions.read = "denied" and must not read any bytes.
 */
export declare function readableDenial(scope: Scope, path: string): string | undefined;
/** One tool-result budget report; mirrors the additive output schema field. */
export interface OutputBudget {
    limitChars: number;
    usedChars: number;
    truncated: boolean;
    dropped: number;
}
/** Default per-tool-result character budget; overridable through config. */
export declare const DEFAULT_OUTPUT_BUDGET_CHARS = 8000;
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
export declare function applyOutputBudget<T>(items: readonly T[], limitChars: number): {
    items: T[];
    budget: OutputBudget;
};
/** Parsed external command line: executable plus argv tail. */
export interface ParsedCommand {
    file: string;
    args: string[];
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
export declare function parseCommandLine(input: string): ParsedCommand | undefined;
/**
 * Validate one command hook config value. Empty means "disabled" and is valid;
 * a non-empty value must parse into a program. Hooks are never run through a
 * shell, so shell metacharacters are ordinary argv bytes and need no rejection
 * beyond a NUL byte the OS could not pass anyway.
 * @param input - configured command string.
 * @returns an error message for an invalid value, otherwise undefined.
 */
export declare function validateExternalCommand(input: string): string | undefined;
/** Options shared by both external hooks. */
export interface HookOptions {
    /** Process timeout; the hook is killed and reported as failed after it. */
    timeoutMs?: number;
    /** Maximum captured stdout bytes. */
    maxOutputBytes?: number;
}
/** Result of running one JSON-speaking external command. */
export type CommandResult = {
    ok: true;
    json: unknown;
} | {
    ok: false;
    error: string;
};
/**
 * Run one external JSON hook: write the payload as JSON on stdin, read the
 * complete stdout, enforce a timeout and an output cap.
 * @param command - configured command string (already validated or not).
 * @param payload - JSON-serializable stdin value.
 * @param options - timeout/output caps.
 * @returns the parsed JSON stdout, or a stable error code.
 */
export declare function runJsonCommand(command: string, payload: unknown, options?: HookOptions): Promise<CommandResult>;
/** One candidate passed to a rerank hook. */
export interface RerankCandidate {
    path: string;
    title?: string;
    snippet?: string;
    score?: number;
}
/**
 * The rerank protocol: stdin { query, hits: RerankCandidate[] }; stdout
 * { "order": number[] } with indices into hits (unlisted indices keep their
 * original relative order after the listed ones). A broken hook is a warning,
 * never a failed search: the original order is returned unchanged.
 */
export declare const RERANK_PROTOCOL = "rerank/v1";
/**
 * Reorder hits through the configured rerank command.
 * @param command - configured command (empty disables the hook).
 * @param query - the user query the hits answer.
 * @param hits - ranked content hits.
 * @param options - hook timeout/output caps.
 * @returns reordered hits plus warnings (never throws for hook failures).
 */
export declare function rerankHits<T extends Pathed>(command: string, query: string, hits: readonly T[], options?: HookOptions): Promise<{
    hits: T[];
    warnings: string[];
}>;
/** One OCR request passed to the configured command. */
export interface OcrRequest {
    path: string;
    mime?: string;
}
/**
 * The OCR protocol: stdin { path, mime? }; stdout { "text": string } (or a bare
 * JSON string). The extraction layer calls this for scanned documents and
 * images; the command is empty by default, so nothing runs unless an operator
 * installs one.
 */
export declare const OCR_PROTOCOL = "ocr/v1";
/**
 * Run the optional OCR command for one file.
 * @param command - configured command (empty disables OCR).
 * @param request - file path plus optional MIME hint.
 * @param options - hook caps plus maxChars for the returned text.
 * @returns extracted text, or a stable error code.
 */
export declare function runOcrCommand(command: string, request: OcrRequest, options?: HookOptions & {
    maxChars?: number;
}): Promise<{
    ok: true;
    text: string;
} | {
    ok: false;
    error: string;
}>;
//# sourceMappingURL=scope.d.ts.map