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
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveWithinRoots } from "./reveal.js";
/** `PRAGMA user_version` stamped into every database this tool creates. */
export const EXPORT_DB_USER_VERSION = 1;
/** Default file name inside the state directory when `path` is omitted. */
export const DEFAULT_EXPORT_NAME = 'locator-export.sqlite';
const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true },
        path: { type: 'string' },
        rows: { type: 'integer' },
        bytes: { type: 'integer' },
        tookMs: { type: 'number' },
        error: { type: 'string' },
    },
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
export function resolveExportTarget(requested, stateDir, allowOutsideStateDir) {
    const state = resolve(stateDir);
    const raw = typeof requested === 'string' ? requested.trim() : '';
    if (raw === '')
        return { ok: true, path: resolve(state, DEFAULT_EXPORT_NAME) };
    const candidate = isAbsolute(raw) ? resolve(raw) : resolve(state, raw);
    if (isAbsolute(raw) && !allowOutsideStateDir) {
        const inside = resolveWithinRoots(candidate, [state]);
        if (inside === undefined) {
            return {
                ok: false,
                error: `path must stay inside the plugin state directory (${state}); pass allowOutsideStateDir: true to export elsewhere`,
            };
        }
        return { ok: true, path: inside.path };
    }
    if (!isAbsolute(raw)) {
        // A relative path is resolved against the state directory; containment is
        // still checked so `..` cannot turn the default into an escape hatch.
        const inside = resolveWithinRoots(candidate, [state]);
        if (inside === undefined) {
            return { ok: false, error: `relative path escapes the plugin state directory (${state})` };
        }
        return { ok: true, path: inside.path };
    }
    return { ok: true, path: candidate };
}
/**
 * Whether `target` is a SQLite database produced by this tool: it must open,
 * carry our `user_version` marker and expose the exported `entries` schema.
 * An arbitrary SQLite file (even with a parent directory deliberately named
 * like an export) is refused, so `overwrite` cannot destroy user data.
 * @param sqlite - the `node:sqlite` module.
 * @param target - existing file to inspect.
 */
export function isOwnExportDatabase(sqlite, target) {
    let db;
    try {
        db = new sqlite.DatabaseSync(target, { readOnly: true });
    }
    catch {
        return false;
    }
    try {
        const version = db.prepare('PRAGMA user_version').get();
        const value = typeof version === 'object' && version !== null
            ? Number(version.user_version)
            : Number.NaN;
        if (value !== EXPORT_DB_USER_VERSION)
            return false;
        // Prepares (and thereby validates) the documented schema without rows.
        db.prepare('SELECT path, name, dir, size, mtime_ms, ext FROM entries LIMIT 0').get();
        return true;
    }
    catch {
        return false;
    }
    finally {
        try {
            db.close();
        }
        catch {
            // A read-only handle that already failed to close does not change the verdict.
        }
    }
}
/** Build the locator_export tool. */
export function makeExportTool(rt) {
    return defineTool({
        name: 'locator_export',
        description: [
            'Export the local file index as a read-only SQLite database (dsh-locator).',
            '',
            'The database has one table, `entries(path TEXT PRIMARY KEY, name TEXT, dir INTEGER, size INTEGER, mtime_ms INTEGER, ext TEXT)`. It is a snapshot: run the tool again to refresh it. The index itself stays in its compact binary form; this is for external SQL tools, dashboards or scripts.',
            '',
            'The output path must stay inside the plugin state directory: omit `path` for `<stateDir>/locator-export.sqlite`, use a relative `path`, or pass an absolute path under the reported state directory. Set `allowOutsideStateDir: true` to export somewhere else deliberately. `overwrite` only replaces a database this tool created; any other existing file is left untouched and the call fails. Writes are atomic (temporary file + rename).',
            '',
            'Use it when the user asks for a queryable copy of their file index, wants to run SQL against it, or needs the data in another program. It is expensive on a million-entry index (tens of seconds and a large file), so do not call it routinely.',
        ].join('\n'),
        parameters: {
            path: {
                type: 'string',
                description: 'Output .sqlite/.db file. Defaults to <stateDir>/locator-export.sqlite; relative paths resolve inside the state directory, absolute paths must be inside it unless allowOutsideStateDir is true.',
            },
            overwrite: { type: 'boolean', description: 'Replace an existing file created by this tool (default false). Any other existing file is never overwritten.' },
            allowOutsideStateDir: { type: 'boolean', description: 'Allow an absolute path outside the plugin state directory (explicit opt-in, default false).' },
            pageSize: { type: 'integer', description: 'Rows per engine request (default 5000, max 10000).' },
        },
        timeoutMs: 180_000,
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => {
                const v = value;
                if (!v.ok)
                    return [{ type: 'text', text: `locator_export failed: ${v.error ?? 'unknown error'}` }];
                return [{
                        type: 'text',
                        text: `locator_export: ${String(v.rows ?? 0)} rows -> ${v.path ?? ''} (${formatSize(v.bytes ?? 0)}, ${((v.tookMs ?? 0) / 1000).toFixed(1)} s)`,
                    }];
            },
        },
        async execute(args) {
            const started = Date.now();
            const target = resolveExportTarget(args.path, rt.stateDir, args.allowOutsideStateDir === true);
            if (!target.ok)
                return { ok: false, error: target.error };
            const output = target.path;
            const existed = existsSync(output);
            if (existed && args.overwrite !== true) {
                return { ok: false, error: `refusing to overwrite ${output}; pass overwrite: true` };
            }
            let sqlite;
            try {
                sqlite = await import('node:sqlite');
            }
            catch {
                return { ok: false, error: 'node:sqlite is unavailable; Node 22.5 or newer is required' };
            }
            // Overwrite is a deletion: only this tool's own database may be deleted.
            if (existed && !isOwnExportDatabase(sqlite, output)) {
                return { ok: false, error: `refusing to overwrite ${output}: not a database created by locator_export` };
            }
            const pageSize = Math.min(10_000, Math.max(100, args.pageSize ?? 5000));
            try {
                mkdirSync(dirname(output), { recursive: true });
            }
            catch (error) {
                return { ok: false, error: messageOf(error) };
            }
            // Build in a sibling temp file so the destination is only ever the old
            // complete database or the new complete one, never a partial write.
            const temporary = temporaryPathFor(output);
            let rows = 0;
            try {
                rows = await writeDatabase(sqlite, rt, temporary, pageSize);
            }
            catch (error) {
                rmSync(temporary, { force: true });
                return { ok: false, error: messageOf(error) };
            }
            try {
                replaceWithRename(sqlite, temporary, output);
            }
            catch (error) {
                rmSync(temporary, { force: true });
                return { ok: false, error: messageOf(error) };
            }
            return {
                ok: true,
                path: output,
                rows,
                bytes: statSync(output).size,
                tookMs: Date.now() - started,
            };
        },
    });
}
/** Stream the index dump into a fresh database at `temporary`; returns the row count. */
async function writeDatabase(sqlite, rt, temporary, pageSize) {
    rt.start();
    const db = new sqlite.DatabaseSync(temporary);
    let rows = 0;
    try {
        db.exec('PRAGMA journal_mode = MEMORY');
        db.exec('PRAGMA synchronous = OFF');
        db.exec(`CREATE TABLE entries (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      dir INTEGER NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      ext TEXT NOT NULL
    ) WITHOUT ROWID`);
        db.exec('CREATE INDEX entries_mtime ON entries(mtime_ms)');
        // Ownership marker: only a database carrying it can be replaced later.
        db.exec(`PRAGMA user_version = ${String(EXPORT_DB_USER_VERSION)}`);
        const insert = db.prepare('INSERT OR REPLACE INTO entries (path, name, dir, size, mtime_ms, ext) VALUES (?, ?, ?, ?, ?, ?)');
        db.exec('BEGIN');
        let after = 0;
        for (;;) {
            const page = await rt.dump(after, pageSize);
            for (const entry of page.entries) {
                insert.run(entry.path, entry.name, entry.dir ? 1 : 0, entry.size, entry.mtime, entry.ext);
                rows++;
            }
            after = page.next;
            if (page.done || page.entries.length === 0)
                break;
            await new Promise(resolve => setImmediate(resolve));
        }
        db.exec('COMMIT');
        return rows;
    }
    catch (error) {
        try {
            db.exec('ROLLBACK');
        }
        catch {
            // The transaction may already be closed; the temp file is removed by the caller.
        }
        throw error;
    }
    finally {
        try {
            db.close();
        }
        catch {
            // Closing a failed build must not mask the real error.
        }
    }
}
/**
 * Move the finished temp database over the destination. POSIX `rename`
 * replaces atomically; on Windows the replace can be refused while the old
 * database is briefly open, in which case the (re-validated) old file is
 * removed first. The destination is never removed unless it is still a
 * database this tool created.
 */
function replaceWithRename(sqlite, temporary, output) {
    try {
        renameSync(temporary, output);
        return;
    }
    catch (error) {
        if (!existsSync(output))
            throw error;
        if (!isOwnExportDatabase(sqlite, output)) {
            throw new Error(`refusing to replace ${output}: it is no longer a database created by locator_export`);
        }
        rmSync(output, { force: true });
        renameSync(temporary, output);
    }
}
/** A unique sibling temp path; never a path derived from user input components. */
function temporaryPathFor(target) {
    const random = Math.random().toString(36).slice(2, 10);
    return join(dirname(target), `.${basename(target)}.${String(process.pid)}.${Date.now().toString(36)}.${random}.tmp`);
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function formatSize(bytes) {
    if (bytes < 1024)
        return `${String(bytes)} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(1)} ${units[unit] ?? 'GB'}`;
}
//# sourceMappingURL=export.js.map