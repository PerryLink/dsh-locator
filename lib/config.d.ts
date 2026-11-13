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
     * One switch for full content search: overrides both body and file caps to
     * unlimited. Off by default because a full index costs gigabytes of disk and
     * a long first build; set this instead of hand-writing two zero values.
     */
    contentFullIndex: boolean;
    /** Most recent session logs indexed; 0 means all. */
    contentMaxSessions: number;
    /** Index archived sessions too; the default leaves them out. */
    contentIncludeArchived: boolean;
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