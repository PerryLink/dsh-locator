/**
 * Platform paths: engine binary lookup, default state directory and roots.
 * @module dsh-locator/paths
 */
import type { Config } from './config.ts';
/** `linux-x64`, `win32-arm64`, `darwin-arm64`, … */
export declare function platformTag(): string;
/** Engine file name for this platform. */
export declare function engineName(): string;
/** The package root, one level above the compiled `lib/` directory. */
export declare function packageRoot(): string;
/** The default snapshot directory, outside the session data tree. */
export declare function defaultStateDir(): string;
/** Absolute roots to index. An empty configuration means the home directory. */
export declare function resolveRoots(config: Config, cwd: string): string[];
/** The configured engine binary, or the bundled one for this platform. */
export declare function resolveBinary(config: Config, cwd: string): string;
/** The state directory actually used. */
export declare function resolveStateDir(config: Config, cwd: string): string;
export declare function packageVersion(): string;
/** Outcome of one {@link secureStateDir} pass. */
export interface StateDirPermissions {
    stateDir: string;
    /** The directory had to be created by this pass. */
    created: boolean;
    /** File names (and `.` for the directory) whose mode was corrected. */
    fixed: string[];
    /** Non-fatal failures; a read-only profile must not break plugin startup. */
    warnings: string[];
}
/**
 * Create the state directory (0700) and tighten the permissions of existing
 * state files (0600).
 *
 * 0.22 and older engines created the state directory 0755 and its files 0644,
 * so a profile that already has a state directory keeps leaking path listings
 * until every writer is upgraded. This pass is idempotent, best effort and a
 * no-op on Windows (where POSIX mode bits do not exist); the engine that owns
 * the directory fixes future writes itself.
 * @param stateDir - the resolved state directory.
 * @returns what was created/corrected, plus any non-fatal warnings.
 */
export declare function secureStateDir(stateDir: string): StateDirPermissions;
/**
 * A compact record of a plugin instance that booted successfully.
 *
 * It is written to the state directory only (never to the DSH profile) and is
 * used by `scripts/doctor.mjs` to print how to get back to a known-good
 * install. Recording it must never fail a boot, so the write helper reports
 * problems instead of throwing.
 */
export interface LastGoodProfile {
    /** ISO timestamp of the record. */
    recordedAt: string;
    /** Version of dsh-locator that booted. */
    packageVersion: string;
    /** Version reported by the engine, when known. */
    engineVersion?: string;
    /** The state directory the record was written into. */
    stateDir: string;
    /** `linux-x64`, `win32-arm64`, … */
    platform: string;
    /** `v24.1.0` style Node version. */
    nodeVersion: string;
    /** Indexed roots, when the caller knows them. */
    roots?: string[];
    /** Whether the content index was enabled. */
    contentIndex?: boolean;
    /** Engine/plugin warnings observed at boot. */
    warnings?: string[];
    /** Sanitized configuration snapshot, for manual recovery only. */
    config?: Record<string, unknown>;
}
/** Subset of {@link LastGoodProfile} the caller supplies. */
export type LastGoodProfileInput = Omit<LastGoodProfile, 'recordedAt' | 'stateDir' | 'platform' | 'nodeVersion'>;
/** Outcome of one {@link recordLastGoodProfile} call. */
export interface LastGoodProfileRecord {
    path: string;
    written: boolean;
    warning?: string;
}
/** Number of last-good-profile records kept (including the latest). */
export declare const LAST_GOOD_PROFILE_RETENTION: 3;
/** The paths of the retained last-good-profile records, newest first. */
export declare function lastGoodProfilePaths(stateDir: string): string[];
/**
 * Record one successful boot into `<stateDir>/last-good-profile.json`.
 *
 * Older records rotate to `last-good-profile.1.json` / `.2.json`, so up to
 * three known-good versions stay available. The file is written 0600 on POSIX
 * and atomically (temporary file plus rename). Nothing outside the state
 * directory is read or written.
 * @param stateDir - the resolved state directory.
 * @param input - the version/roots/warnings of the boot.
 * @returns the written path, or a warning when recording was skipped.
 */
export declare function recordLastGoodProfile(stateDir: string, input: LastGoodProfileInput): LastGoodProfileRecord;
/**
 * Read the retained last-good-profile records, newest first.
 *
 * Corrupt or missing records are skipped: this is recovery metadata, so a
 * damaged file must not prevent the newer records from being shown.
 * @param stateDir - the resolved state directory.
 * @returns the parseable records, newest first.
 */
export declare function readLastGoodProfiles(stateDir: string): LastGoodProfile[];
//# sourceMappingURL=paths.d.ts.map