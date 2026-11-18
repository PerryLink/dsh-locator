/**
 * Plugin configuration.
 * @module dsh-locator/config
 */
import Schema from '@deepseek-ai/schemastery';
/** Locator plugin configuration. */
export interface Config {
    /** Master switch; false mounts no tools and starts no engine. */
    enabled: boolean;
    /** Directories to index. Empty means the current user's home directory. */
    roots: string[];
    /** Base-name globs to skip while scanning and watching. */
    excludes: string[];
    /** Keep the index current with filesystem notifications when supported. */
    watch: boolean;
    /**
     * Rebuild cadence used only when the platform has no native watcher (macOS
     * today). Zero disables the fallback; the index then changes only on
     * `locator_rebuild`.
     */
    refreshIntervalMs: number;
    /**
     * Periodic fallback refreshes only the roots the native watcher cannot cover
     * (incremental refresh). Default true; false restores the 0.18 behavior of
     * re-scanning every root on each fallback tick.
     */
    refreshIncremental?: boolean;
    /** Directory reader concurrency during scans; 0 uses the CPU count. */
    scanWorkers: number;
    /** Soft Go heap limit in MiB for the engine; 0 leaves it to GOMEMLIMIT/GOGC. */
    memoryLimitMB: number;
    /** Index text-file bodies and DSH session messages into the content database. */
    contentIndex: boolean;
    /**
     * Build the content index on the first content search instead of at plugin
     * start. Lazy keeps DSH startup free of content indexing; set false to build
     * eagerly in the background right after startup.
     */
    contentLazy: boolean;
    /** Maximum bytes read from one text file. */
    contentMaxFileBytes: number;
    /** Stop adding content after this many body bytes; 0 means unlimited. */
    contentMaxTotalBytes: number;
    /** Incremental content refresh cadence; 0 disables it. */
    contentRefreshMs: number;
    /** Maximum text files indexed per build; 0 means no cap. */
    contentMaxFiles: number;
    /**
     * Index assistant reasoning/thinking blocks in session messages too. Off by
     * default: reasoning is large, noisy, and may contain scratch work the user
     * does not expect to be searchable. Enabling it forces a session rebuild.
     */
    contentIndexReasoning: boolean;
    /**
     * Index tool results (`tool/result` events) as session documents too. Off by
     * default: results can be large and often duplicate file bodies. Enabling it
     * rebuilds session documents only; the file index is kept.
     */
    contentIndexToolResults: boolean;
    /**
     * Extract bodies from PDF/Office/EPUB documents into the content index
     * (default true). Turn it off to index plain text only, e.g. to keep a first
     * build cheap on a document-heavy disk.
     */
    contentExtractDocuments?: boolean;
    /** Largest document handed to the extractor in bytes (default 20 MiB; 0 unlimited). */
    contentExtractMaxBytes?: number;
    /** Index code symbols for locator_outline/locator_symbol/locator_repo_map (default true). */
    contentIndexSymbols?: boolean;
    /** Largest code file considered for symbol extraction in bytes (default 512 KiB). */
    contentSymbolMaxBytes?: number;
    /**
     * One switch for full content search: overrides both body and file caps to
     * unlimited. Off by default because a full index costs gigabytes of disk and
     * a long first build; set this instead of hand-writing two zero values.
     */
    contentFullIndex: boolean;
    /** Most recent session logs indexed; 0 means all. */
    contentMaxSessions: number;
    /**
     * Search archived sessions by default. Archived logs are indexed either way
     * (so a panel checkbox can include them per query); the default false keeps
     * them out of ordinary results.
     */
    contentIncludeArchived: boolean;
    /**
     * Let `locator_find scope:"all"` read session bodies from other workspaces.
     * Off by default: files stay searchable across roots, but session documents
     * are limited to the caller session and sessions with the same immutable cwd
     * (the DSH `tool-session-query` authorization rule).
     */
    allowCrossWorkspaceSessions: boolean;
    /**
     * Session logs modified more recently than this are skipped until they have
     * been quiet that long, so the session being written now is not re-read on
     * every background refresh.
     */
    contentActiveSessionDelayMs: number;
    /** Extra session directories; empty means $DSH_HOME/sessions. */
    contentSessionDirs: string[];
    /**
     * Path segments or substrings skipped by the content index only: dependency
     * trees and toolchains would otherwise eat the body-bytes budget before a
     * user's own documents. The name index still covers them.
     */
    contentExcludes: string[];
    /**
     * Glob patterns that must not enter the content index at all (the name index
     * keeps them). This is the "indexable" layer: document extractors (PDF,
     * Office, OCR sidecars) skip a match before reading bytes, and content hits
     * are filtered for databases built before the rule existed. Complements
     * `contentExcludes`, which stays a fast substring/segment pre-filter.
     */
    notIndexed?: string[];
    /**
     * Glob patterns never returned as hits by `locator_search`/`locator_find`.
     * The path stays indexed (and readable unless `notReadable` also matches),
     * but no result names it. This is the "searchable" layer.
     */
    notSearchable?: string[];
    /**
     * Glob patterns whose body and evidence ref must not be returned: content
     * hits are dropped, refs are stripped from name hits and ref resolution must
     * refuse them. This is the "readable" layer. See `readableDenial` in
     * `src/scope.ts` for the hook the resolve/cite tools consume.
     */
    notReadable?: string[];
    /**
     * Soft cap on the character size of one locator tool result. Hits that no
     * longer fit are dropped and the result reports `truncated`, `nextOffset`
     * and a `budget` block (JSON-serialized characters). 0 disables the budget.
     */
    outputBudgetChars?: number;
    /**
     * Optional external rerank command for content hits. Empty (the default)
     * disables it. The command is spawned without a shell and speaks JSON on
     * stdin/stdout: `{ protocol: "rerank/v1", query, hits: [{path,title,snippet,
     * score}] }` in, `{ order: number[] }` out (see `src/scope.ts`). A broken
     * hook only adds a warning; the lexical order is kept.
     */
    rerankCommand?: string;
    /**
     * Optional external OCR command for the document extraction layer. Empty
     * (the default) disables it. Spawned without a shell; stdin
     * `{ protocol: "ocr/v1", path, mime? }`, stdout `{ text: string }` (see
     * `runOcrCommand` in `src/scope.ts`).
     */
    ocrCommand?: string;
    /**
     * Let locator_resolve revalidate URL refs with one bounded conditional HTTP
     * request (5 s timeout, no crawling, no robots fetch). Off (the default)
     * keeps URL refs metadata-only: resolving never opens a network connection.
     */
    urlFreshness?: boolean;
    /**
     * Try the NTFS USN/MFT enumeration before the portable walk (Windows only,
     * requires running DSH as administrator). Falls back automatically.
     */
    windowsUsn: boolean;
    /** Snapshot directory. Empty means the platform cache directory. */
    stateDir: string;
    /** Override the engine binary path (development or custom builds). */
    binaryPath: string;
    /** Maximum hits one search returns. */
    maxResults: number;
    /** How long a cold index build may take before the plugin reports failure. */
    startupTimeoutMs: number;
    /** Per-request deadline for the engine. */
    requestTimeoutMs: number;
    /**
     * Allow the panel HTTP routes to operate without the DSH connection service,
     * relying on the host's request authentication plus the same-origin Fetch
     * metadata check. Off by default; useful on hosts where the connection
     * service is not injected during plugin boot.
     */
    httpConnectionOptional: boolean;
}
/** Configuration schema; invalid values fail the profile load loudly. */
export declare const Config: Schema<Config>;
/**
 * Effective per-tool-result character budget. Unset or invalid values fall back
 * to {@link DEFAULT_OUTPUT_BUDGET_CHARS}; 0 disables the budget.
 * @param config - validated plugin configuration.
 * @returns the soft cap in JSON-serialized characters.
 */
export declare function outputBudgetChars(config: Pick<Config, 'outputBudgetChars'>): number;
/**
 * Validate the optional external command settings. An empty command is a valid
 * "disabled" value; anything else must split into a program without a shell.
 * These are configuration problems, not query failures: `locator_status`
 * reports them as warnings and the hook is simply not run.
 * @param config - validated plugin configuration.
 * @returns human-readable problems, empty when both hooks are valid/off.
 */
export declare function validateHookCommands(config: Pick<Config, 'rerankCommand' | 'ocrCommand'>): string[];
/**
 * Effective content caps. `contentFullIndex` is the explicit one-switch full
 * mode; otherwise the two numeric caps apply (0 still means unlimited).
 * @param config - validated plugin configuration.
 * @returns limits passed to {@link ContentIndex}.
 */
export declare function contentLimits(config: Pick<Config, 'contentFullIndex' | 'contentMaxTotalBytes' | 'contentMaxFiles'>): {
    maxTotalBytes: number;
    maxFiles: number;
};
//# sourceMappingURL=config.d.ts.map