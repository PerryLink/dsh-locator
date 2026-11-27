/**
 * Platform paths: engine binary lookup, default state directory and roots.
 * @module dsh-locator/paths
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/** `linux-x64`, `win32-arm64`, `darwin-arm64`, … */
export function platformTag() {
    return `${process.platform}-${process.arch}`;
}
/** Engine file name for this platform. */
export function engineName() {
    return process.platform === 'win32' ? 'indexd.exe' : 'indexd';
}
/** The package root, one level above the compiled `lib/` directory. */
export function packageRoot() {
    return resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
}
/** The default snapshot directory, outside the session data tree. */
export function defaultStateDir() {
    if (process.platform === 'win32') {
        const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
        return join(base, 'dsh-locator');
    }
    if (process.platform === 'darwin') {
        return join(homedir(), 'Library', 'Application Support', 'dsh-locator');
    }
    return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dsh-locator');
}
/** Absolute roots to index. An empty configuration means the home directory. */
export function resolveRoots(config, cwd) {
    const roots = config.roots.length > 0 ? config.roots : [homedir()];
    return roots.map(root => resolve(cwd, root));
}
/** The configured engine binary, or the bundled one for this platform. */
export function resolveBinary(config, cwd) {
    if (config.binaryPath !== '')
        return resolve(cwd, config.binaryPath);
    const name = engineName();
    const bundled = join(packageRoot(), 'bin', platformTag(), name);
    if (existsSync(bundled))
        return bundled;
    // A development build may live directly under bin/.
    const plain = join(packageRoot(), 'bin', name);
    if (existsSync(plain))
        return plain;
    // Fall back to PATH: `indexd` on Unix and `indexd.exe` on Windows.
    return name;
}
/** The state directory actually used. */
export function resolveStateDir(config, cwd) {
    return config.stateDir === '' ? defaultStateDir() : resolve(cwd, config.stateDir);
}
/**
 * The version of this package (package.json), read once.
 *
 * The engine copy below the state directory is keyed by this version, so a
 * Windows in-place upgrade can never spawn a half-overwritten executable: each
 * package version gets its own copy and the old ones are removed.
 * @returns the package version, or `'0.0.0'` when package.json is unreadable.
 */
let cachedPackageVersion;
export function packageVersion() {
    if (cachedPackageVersion !== undefined)
        return cachedPackageVersion;
    let version = '0.0.0';
    try {
        const parsed = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8'));
        if (typeof parsed.version === 'string' && parsed.version !== '')
            version = parsed.version;
    }
    catch {
        // A bundled/stripped install may not ship package.json next to the code.
    }
    cachedPackageVersion = version;
    return version;
}
/** State-directory files that must be owner-only on POSIX platforms. */
const PRIVATE_STATE_FILES = [
    'index.snapshot',
    'index.journal',
    'meta.json',
    'content.db',
    'content.db-wal',
    'content.db-shm',
    'engine.lock',
];
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
export function secureStateDir(stateDir) {
    const result = { stateDir, created: false, fixed: [], warnings: [] };
    if (process.platform === 'win32') {
        // Windows has no POSIX modes; the state directory lives under %LOCALAPPDATA%
        // and inherits the user's ACLs.
        try {
            if (!existsSync(stateDir)) {
                mkdirSync(stateDir, { recursive: true });
                result.created = true;
            }
        }
        catch (error) {
            result.warnings.push(`cannot create ${stateDir}: ${messageOf(error)}`);
        }
        return result;
    }
    try {
        if (!existsSync(stateDir)) {
            mkdirSync(stateDir, { recursive: true, mode: 0o700 });
            result.created = true;
        }
    }
    catch (error) {
        result.warnings.push(`cannot create ${stateDir}: ${messageOf(error)}`);
        return result;
    }
    tighten(stateDir, '.', 0o700, result);
    for (const name of PRIVATE_STATE_FILES) {
        const path = join(stateDir, name);
        if (!existsSync(path))
            continue;
        tighten(path, name, 0o600, result);
    }
    return result;
}
/** One best-effort chmod, recording a correction or a warning. */
function tighten(path, label, mode, result) {
    try {
        if ((statSync(path).mode & 0o777) === mode)
            return;
        chmodSync(path, mode);
        result.fixed.push(label);
    }
    catch (error) {
        result.warnings.push(`cannot chmod ${path}: ${messageOf(error)}`);
    }
}
/** Latest last-good-profile file, plus its two rotated predecessors. */
const LAST_GOOD_NAMES = ['last-good-profile.json', 'last-good-profile.1.json', 'last-good-profile.2.json'];
/** Number of last-good-profile records kept (including the latest). */
export const LAST_GOOD_PROFILE_RETENTION = LAST_GOOD_NAMES.length;
/** The paths of the retained last-good-profile records, newest first. */
export function lastGoodProfilePaths(stateDir) {
    return LAST_GOOD_NAMES.map(name => join(stateDir, name));
}
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
export function recordLastGoodProfile(stateDir, input) {
    const latest = join(stateDir, LAST_GOOD_NAMES[0]);
    const record = {
        ...input,
        recordedAt: new Date().toISOString(),
        stateDir,
        platform: platformTag(),
        nodeVersion: process.version,
    };
    try {
        secureStateDir(stateDir);
        // Rotate: .2 is dropped, .1 -> .2, latest -> .1. Missing files are fine.
        try {
            rmSync(join(stateDir, LAST_GOOD_NAMES[2]), { force: true });
        }
        catch { /* best effort */ }
        try {
            renameSync(join(stateDir, LAST_GOOD_NAMES[1]), join(stateDir, LAST_GOOD_NAMES[2]));
        }
        catch { /* first records */ }
        try {
            renameSync(latest, join(stateDir, LAST_GOOD_NAMES[1]));
        }
        catch { /* first record */ }
        const tmp = latest + '.tmp';
        writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
        if (process.platform !== 'win32') {
            try {
                chmodSync(tmp, 0o600);
            }
            catch { /* recorded as a warning below if it matters */ }
        }
        renameSync(tmp, latest);
        return { path: latest, written: true };
    }
    catch (error) {
        return { path: latest, written: false, warning: `cannot record last-good profile: ${messageOf(error)}` };
    }
}
/**
 * Read the retained last-good-profile records, newest first.
 *
 * Corrupt or missing records are skipped: this is recovery metadata, so a
 * damaged file must not prevent the newer records from being shown.
 * @param stateDir - the resolved state directory.
 * @returns the parseable records, newest first.
 */
export function readLastGoodProfiles(stateDir) {
    const records = [];
    for (const path of lastGoodProfilePaths(stateDir)) {
        try {
            const parsed = JSON.parse(readFileSync(path, 'utf8'));
            if (typeof parsed !== 'object' || parsed === null)
                continue;
            if (typeof parsed.recordedAt !== 'string' || typeof parsed.packageVersion !== 'string')
                continue;
            records.push(parsed);
        }
        catch {
            // Missing or corrupt rotation slot: skip it.
        }
    }
    return records;
}
/** Message of an unknown thrown value. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=paths.js.map