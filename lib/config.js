/**
 * Plugin configuration.
 * @module dsh-locator/config
 */
import Schema from '@deepseek-ai/schemastery';
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
    scanWorkers: Schema.number().default(0),
    memoryLimitMB: Schema.number().default(0),
    contentIndex: Schema.boolean().default(true),
    contentLazy: Schema.boolean().default(true),
    contentMaxFileBytes: Schema.number().default(1_000_000),
    contentMaxTotalBytes: Schema.number().default(1_000_000_000),
    contentRefreshMs: Schema.number().default(300_000),
    contentMaxFiles: Schema.number().default(200_000),
    contentFullIndex: Schema.boolean().default(false),
    contentMaxSessions: Schema.number().default(100),
    contentIncludeArchived: Schema.boolean().default(false),
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
    windowsUsn: Schema.boolean().default(false),
    stateDir: Schema.string().default(''),
    binaryPath: Schema.string().default(''),
    maxResults: Schema.number().default(100),
    startupTimeoutMs: Schema.number().default(120_000),
    requestTimeoutMs: Schema.number().default(15_000),
});
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
//# sourceMappingURL=config.js.map