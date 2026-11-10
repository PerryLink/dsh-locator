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
    windowsUsn: Schema.boolean().default(false),
    stateDir: Schema.string().default(''),
    binaryPath: Schema.string().default(''),
    maxResults: Schema.number().default(100),
    startupTimeoutMs: Schema.number().default(120_000),
    requestTimeoutMs: Schema.number().default(15_000),
});
//# sourceMappingURL=config.js.map