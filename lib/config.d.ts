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
    /** Directory reader concurrency during scans; 0 uses the CPU count. */
    scanWorkers: number;
    /** Soft Go heap limit in MiB for the engine; 0 leaves it to GOMEMLIMIT/GOGC. */
    memoryLimitMB: number;
    /** Index text-file bodies and DSH session messages into the content database. */
    contentIndex: boolean;
    /** Maximum bytes read from one text file. */
    contentMaxFileBytes: number;
    /** Maximum text files indexed per build; 0 means no cap. */
    contentMaxFiles: number;
    /** Most recent session logs indexed; 0 means all. */
    contentMaxSessions: number;
    /** Extra session directories; empty means $DSH_HOME/sessions. */
    contentSessionDirs: string[];
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
}
/** Configuration schema; invalid values fail the profile load loudly. */
export declare const Config: Schema<Config>;
//# sourceMappingURL=config.d.ts.map