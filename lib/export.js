/**
 * `locator_export` — write a read-only SQLite mirror of the index.
 *
 * The engine keeps its compact snapshot; this tool streams the index page by
 * page and writes a normal SQLite database so external tools can query it.
 * `node:sqlite` is loaded lazily: hosts below Node 22.5 get a clear error
 * instead of a plugin that fails to load.
 * @module dsh-locator/export
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
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
/** Build the locator_export tool. */
export function makeExportTool(rt) {
    return defineTool({
        name: 'locator_export',
        description: [
            'Export the local file index as a read-only SQLite database (dsh-locator).',
            '',
            'The database has one table, `entries(path TEXT PRIMARY KEY, name TEXT, dir INTEGER, size INTEGER, mtime_ms INTEGER, ext TEXT)`. It is a snapshot: run the tool again to refresh it. The index itself stays in its compact binary form; this is for external SQL tools, dashboards or scripts.',
            '',
            'Use it when the user asks for a queryable copy of their file index, wants to run SQL against it, or needs the data in another program. It is expensive on a million-entry index (tens of seconds and a large file), so do not call it routinely.',
        ].join('\n'),
        parameters: {
            path: { type: 'string', required: true, description: 'Absolute path of the .sqlite/.db file to create.' },
            overwrite: { type: 'boolean', description: 'Replace an existing file (default false).' },
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
            const target = resolve(args.path);
            if (!isAbsolute(args.path))
                return { ok: false, error: 'path must be absolute' };
            if (existsSync(target) && args.overwrite !== true) {
                return { ok: false, error: `refusing to overwrite ${target}; pass overwrite: true` };
            }
            const pageSize = Math.min(10_000, Math.max(100, args.pageSize ?? 5000));
            mkdirSync(dirname(target), { recursive: true });
            let sqlite;
            try {
                sqlite = await import('node:sqlite');
            }
            catch {
                return { ok: false, error: 'node:sqlite is unavailable; Node 22.5 or newer is required' };
            }
            if (existsSync(target))
                rmSync(target);
            rt.start();
            const db = new sqlite.DatabaseSync(target);
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
            }
            catch (error) {
                try {
                    db.exec('ROLLBACK');
                }
                catch {
                    // The transaction may already be closed; the file is removed below.
                }
                db.close();
                rmSync(target, { force: true });
                return { ok: false, error: messageOf(error) };
            }
            db.close();
            return {
                ok: true,
                path: target,
                rows,
                bytes: statSync(target).size,
                tookMs: Date.now() - started,
            };
        },
    });
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