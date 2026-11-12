/**
 * `locator_export` — write a read-only SQLite mirror of the index.
 *
 * The engine keeps its compact snapshot; this tool streams the index page by
 * page and writes a normal SQLite database so external tools can query it.
 * `node:sqlite` is loaded lazily: hosts below Node 22.5 get a clear error
 * instead of a plugin that fails to load.
 *
 * The export is a *controlled* write, not an arbitrary filesystem write:
 * - the target must live inside the plugin state directory unless the caller
 *   explicitly opts into an outside path (`allowOutsideStateDir`), and a
 *   relative path always resolves inside the state directory;
 * - an existing target is only replaced when it is a database this tool
 *   created (SQLite header + our `user_version` marker + the `entries`
 *   schema), so `overwrite` can never clobber an unrelated file;
 * - the database is built in a sibling temporary file and moved into place
 *   with an atomic rename, so a failed export never leaves a half-written
 *   database at the requested path.
 * @module dsh-locator/export
 */
import type { LocatorRuntime } from './runtime.ts';
/** `PRAGMA user_version` stamped into every database this tool creates. */
export declare const EXPORT_DB_USER_VERSION = 1;
/** Default file name inside the state directory when `path` is omitted. */
export declare const DEFAULT_EXPORT_NAME = "locator-export.sqlite";
/** Minimal shape of `node:sqlite` used here (the real typings are platform-dependent). */
interface SqliteDatabaseLike {
    exec(sql: string): unknown;
    prepare(sql: string): {
        run(...parameters: unknown[]): unknown;
        get(...parameters: unknown[]): unknown;
    };
    close(): void;
}
/** The lazily imported `node:sqlite` module slice. */
export interface SqliteModuleLike {
    DatabaseSync: new (path: string, options?: {
        readOnly?: boolean;
    }) => SqliteDatabaseLike;
}
/** Authorization result for one export target. */
export type ExportTargetResult = {
    ok: true;
    path: string;
} | {
    ok: false;
    error: string;
};
/**
 * Authorize the requested export path.
 *
 * With no `path`, the export goes to `<stateDir>/locator-export.sqlite`. A
 * relative path resolves inside the state directory (and may not escape it by
 * `..`). An absolute path is accepted only inside the state directory unless
 * the caller explicitly passes `allowOutsideStateDir`.
 * @param requested - raw `path` argument, if any.
 * @param stateDir - the plugin's state directory.
 * @param allowOutsideStateDir - explicit opt-in for an absolute path elsewhere.
 * @returns the absolute output path, or a refusal message.
 */
export declare function resolveExportTarget(requested: string | undefined, stateDir: string, allowOutsideStateDir: boolean): ExportTargetResult;
/**
 * Whether `target` is a SQLite database produced by this tool: it must open,
 * carry our `user_version` marker and expose the exported `entries` schema.
 * An arbitrary SQLite file (even with a parent directory deliberately named
 * like an export) is refused, so `overwrite` cannot destroy user data.
 * @param sqlite - the `node:sqlite` module.
 * @param target - existing file to inspect.
 */
export declare function isOwnExportDatabase(sqlite: SqliteModuleLike, target: string): boolean;
/** Build the locator_export tool. */
export declare function makeExportTool(rt: LocatorRuntime): import("@deepseek-ai/dsh-tools").ToolDefinition;
export {};
//# sourceMappingURL=export.d.ts.map