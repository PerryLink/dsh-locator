/**
 * Plugin configuration.
 * @module dsh-locator/config
 */
import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_OUTPUT_BUDGET_CHARS, validateExternalCommand } from "./scope.js";
/** Configuration schema; invalid values fail the profile load loudly. */
export const Config = Schema.object({
    enabled: Schema.boolean().default(true),
    roots: Schema.array(Schema.string()).default([]),
    excludes: Schema.array(Schema.string()).default([
        'node_modules',
        '.git',
        '.hg',
        '.svn',
        '.cache',
        '__pycache__',
        '.venv',
        'venv',
        '.next',
    ]),
    watch: Schema.boolean().default(true),
    refreshIntervalMs: Schema.number().default(1_800_000),
    refreshIncremental: Schema.boolean().default(true),
    unwatchedRefreshIntervalMs: Schema.number().default(300_000),
    scanWorkers: Schema.number().default(0),
    memoryLimitMB: Schema.number().default(0),
    includeCaches: Schema.boolean().default(false),
    watchMaxDirs: Schema.number().default(120_000),
    snapshotCompression: Schema.union(['none', 'zstd']).default('none'),
    contentIndex: Schema.boolean().default(true),
    contentLazy: Schema.boolean().default(true),
    contentMaxFileBytes: Schema.number().default(1_000_000),
    contentMaxTotalBytes: Schema.number().default(1_600_000_000),
    contentRefreshMs: Schema.number().default(300_000),
    contentMaxFiles: Schema.number().default(200_000),
    contentIndexReasoning: Schema.boolean().default(false),
    contentIndexToolResults: Schema.boolean().default(false),
    contentExtractDocuments: Schema.boolean().default(true),
    contentExtractMaxBytes: Schema.number().default(8_000_000),
    contentEvict: Schema.boolean().default(true),
    contentSymbolsPerFile: Schema.number().default(500),
    contentMaxDbBytes: Schema.number().default(8_000_000_000),
    contentRankAdaptive: Schema.boolean().default(true),
    contentQueryCacheSize: Schema.number().default(64),
    contentQueryCacheTtlMs: Schema.number().default(60_000),
    contentSessionMaxBytes: Schema.number().default(67_108_864),
    contentRefreshAdaptive: Schema.boolean().default(true),
    /** Parallel file read/decode/symbol extraction workers during a full content build (1 disables). */
    contentParallelPrefetch: Schema.number().default(4),
    /** Sniff extensionless files for text content (default true; raises coverage). */
    contentTextSniff: Schema.boolean().default(true),
    /** Allow a bounded LIKE fallback for 2-character queries (default true). */
    contentShortQueryFallback: Schema.boolean().default(true),
    contentIndexSymbols: Schema.boolean().default(true),
    contentSymbolMaxBytes: Schema.number().default(524_288),
    contentFullIndex: Schema.boolean().default(false),
    contentMaxSessions: Schema.number().default(1000),
    contentIncludeArchived: Schema.boolean().default(false),
    allowCrossWorkspaceSessions: Schema.boolean().default(false),
    contentActiveSessionDelayMs: Schema.number().default(120_000),
    contentSessionDirs: Schema.array(Schema.string()).default([]),
    contentExcludes: Schema.array(Schema.string()).default([
        'node_modules',
        '.git',
        '.hg',
        '.svn',
        '.cache',
        '__pycache__',
        '.venv',
        'venv',
        '.next',
        '.turbo',
        '.yarn',
        '.pnpm',
        '.npm',
        '.cargo',
        '.rustup',
        '.bun',
        '.gradle',
        '.m2',
        '.nuget',
        '.nvm',
        '.pyenv',
        '.conda',
        '.asdf',
        'toolchain',
        'site-packages',
        'dist-packages',
        '/.local/lib/',
        '/.local/share/pnpm/',
        '/go/pkg/mod/',
    ]),
    notIndexed: Schema.array(Schema.string()).default([
        '_key.*',
        '发布令牌*',
        '.env',
        '.env.*',
        '*.pem',
        '*.key',
        '*.p12',
        '*.pfx',
        'id_rsa*',
        'id_ed25519*',
    ]),
    notSearchable: Schema.array(Schema.string()).default([]),
    notReadable: Schema.array(Schema.string()).default([]),
    outputBudgetChars: Schema.number().default(8000),
    rerankCommand: Schema.string().default(''),
    ocrCommand: Schema.string().default(''),
    urlFreshness: Schema.boolean().default(false),
    windowsUsn: Schema.boolean().default(false),
    stateDir: Schema.string().default(''),
    binaryPath: Schema.string().default(''),
    maxResults: Schema.number().default(100),
    startupTimeoutMs: Schema.number().default(120_000),
    requestTimeoutMs: Schema.number().default(15_000),
    prewarm: Schema.boolean().default(true),
    combinedBudgetChars: Schema.number().default(0),
    combinedEnrichConcurrency: Schema.number().default(8),
    combinedHashMaxHits: Schema.number().default(5),
    resourcePreset: Schema.union(['balanced', 'eco', 'performance']).default('balanced'),
    httpConnectionOptional: Schema.boolean().default(false),
});
/**
 * Effective per-tool-result character budget. Unset or invalid values fall back
 * to {@link DEFAULT_OUTPUT_BUDGET_CHARS}; 0 disables the budget.
 * @param config - validated plugin configuration.
 * @returns the soft cap in JSON-serialized characters.
 */
export function outputBudgetChars(config) {
    const value = config.outputBudgetChars;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : DEFAULT_OUTPUT_BUDGET_CHARS;
}
/**
 * Validate the optional external command settings. An empty command is a valid
 * "disabled" value; anything else must split into a program without a shell.
 * These are configuration problems, not query failures: `locator_status`
 * reports them as warnings and the hook is simply not run.
 * @param config - validated plugin configuration.
 * @returns human-readable problems, empty when both hooks are valid/off.
 */
export function validateHookCommands(config) {
    const problems = [];
    for (const name of ['rerankCommand', 'ocrCommand']) {
        const value = config[name];
        if (typeof value !== 'string')
            continue;
        const problem = validateExternalCommand(value);
        if (problem !== undefined)
            problems.push(name + ': ' + problem);
    }
    return problems;
}
/**
 * Effective content caps. `contentFullIndex` is the explicit one-switch full
 * mode; otherwise the two numeric caps apply (0 still means unlimited).
 * @param config - validated plugin configuration.
 * @returns limits passed to {@link ContentIndex}.
 */
export function contentLimits(config) {
    if (config.contentFullIndex)
        return { maxTotalBytes: 0, maxFiles: 0 };
    return { maxTotalBytes: config.contentMaxTotalBytes, maxFiles: config.contentMaxFiles };
}
const MIB = 1024 * 1024;
/** Resource presets layered on top of the explicit configuration. */
export function applyResourcePreset(config) {
    const preset = config.resourcePreset ?? 'balanced';
    if (preset === 'balanced')
        return config;
    if (preset === 'eco') {
        return {
            ...config,
            memoryLimitMB: 256,
            watchMaxDirs: Math.min(config.watchMaxDirs ?? 120_000, 60_000),
            contentMaxTotalBytes: Math.min(config.contentMaxTotalBytes, 256 * MIB),
            contentMaxFiles: Math.min(config.contentMaxFiles, 50_000),
            contentExtractDocuments: false,
            contentIndexSymbols: false,
            contentRefreshMs: Math.max(config.contentRefreshMs, 1_800_000),
            refreshIntervalMs: Math.max(config.refreshIntervalMs, 21_600_000),
            unwatchedRefreshIntervalMs: Math.max(config.unwatchedRefreshIntervalMs ?? 600_000, 3_600_000),
            combinedHashMaxHits: 0,
            contentQueryCacheSize: Math.min(config.contentQueryCacheSize ?? 64, 32),
        };
    }
    return {
        ...config,
        memoryLimitMB: Math.max(config.memoryLimitMB, 1024),
        watchMaxDirs: Math.max(config.watchMaxDirs ?? 120_000, 200_000),
        contentMaxTotalBytes: Math.max(config.contentMaxTotalBytes, 2_000_000_000),
        contentMaxFiles: Math.max(config.contentMaxFiles, 500_000),
        contentRefreshMs: Math.min(config.contentRefreshMs, 300_000),
        refreshIntervalMs: Math.min(config.refreshIntervalMs, 600_000),
        unwatchedRefreshIntervalMs: Math.min(config.unwatchedRefreshIntervalMs ?? 300_000, 120_000),
        contentSymbolsPerFile: Math.max(config.contentSymbolsPerFile ?? 500, 1_000),
        combinedHashMaxHits: Math.max(config.combinedHashMaxHits ?? 5, 20),
        contentQueryCacheSize: Math.max(config.contentQueryCacheSize ?? 64, 256),
    };
}
//# sourceMappingURL=config.js.map