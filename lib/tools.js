/**
 * Agent-facing tools: locator_search, locator_status and locator_rebuild.
 * @module dsh-locator/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { CONTENT_STATE_SCHEMA } from "./find.js";
import { fileRef } from "./refs.js";
import { resolveWithinRoots, withinRoots } from "./reveal.js";
const HIT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        path: { type: 'string', required: true },
        name: { type: 'string', required: true },
        size: { type: 'integer' },
        mtime: { type: 'integer', description: 'Modification time in Unix milliseconds.' },
        modified: { type: 'string', description: 'ISO-8601 modification time.' },
        ext: { type: 'string' },
        dir: { type: 'boolean' },
        ref: { type: 'string', description: 'Citable ref://file reference (files only).' },
        freshness: {
            type: 'object',
            additionalProperties: false,
            properties: {
                state: { type: 'string', enum: ['fresh', 'stale', 'missing', 'unknown'] },
                observedAt: { type: 'integer' },
                mtime: { type: 'integer' },
            },
        },
        permissions: {
            type: 'object',
            additionalProperties: false,
            properties: {
                read: { type: 'string', enum: ['allowed', 'denied'] },
                visibility: { type: 'string', enum: ['workspace', 'roots', 'session', 'external'] },
                reason: { type: 'string' },
            },
        },
    },
};
const SEARCH_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true },
        query: { type: 'string' },
        total: { type: 'integer' },
        returned: { type: 'integer' },
        offset: { type: 'integer' },
        truncated: { type: 'boolean' },
        indexing: { type: 'boolean' },
        tookMs: { type: 'number' },
        hits: { type: 'array', items: HIT_SCHEMA },
        scope: { type: 'string', enum: ['workspace', 'all'] },
        scopeFallback: { type: 'string' },
        error: { type: 'string' },
    },
};
const STATUS_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true },
        running: { type: 'boolean' },
        version: { type: 'string' },
        platform: { type: 'string' },
        roots: { type: 'array', items: { type: 'string' } },
        entries: { type: 'integer' },
        files: { type: 'integer' },
        dirs: { type: 'integer' },
        watching: { type: 'boolean' },
        watchDegraded: { type: 'boolean' },
        watchReason: { type: 'string' },
        watchRoots: { type: 'integer' },
        refreshFallback: { type: 'boolean' },
        content: {
            type: 'object',
            additionalProperties: false,
            properties: {
                enabled: { type: 'boolean' },
                ...CONTENT_STATE_SCHEMA.properties,
            },
        },
        usn: { type: 'boolean' },
        scanning: { type: 'boolean' },
        stateDir: { type: 'string' },
        binary: { type: 'string' },
        warning: { type: 'string' },
        error: { type: 'string' },
    },
};
const REBUILD_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true },
        started: { type: 'boolean' },
        error: { type: 'string' },
    },
};
/**
 * Restrict a `locator_rebuild` request to the configured scope.
 *
 * Root replacement is the dangerous knob: letting the model pick an arbitrary
 * absolute path would turn a search tool into a disk-indexer for directories
 * the operator never configured. A requested root must therefore canonicalize
 * (symlinks resolved) to a configured root or a directory below one; requested
 * excludes must be draw from the configured exclude list. Everything is passed
 * through the same canonicalization as `/reveal`/`/open`.
 * @param roots - requested replacement roots, if any.
 * @param excludes - requested replacement excludes, if any.
 * @param configuredRoots - the plugin's configured (resolved) roots.
 * @param configuredExcludes - the plugin's configured excludes.
 * @returns the canonical narrowed scope, or the first refusal.
 */
export function validateRebuildArguments(roots, excludes, configuredRoots, configuredExcludes) {
    let narrowedRoots;
    if (roots !== undefined) {
        if (!Array.isArray(roots) || roots.length === 0) {
            return { ok: false, error: 'roots must be a non-empty array of directory paths' };
        }
        narrowedRoots = [];
        for (const root of roots) {
            if (typeof root !== 'string' || root.trim() === '') {
                return { ok: false, error: 'roots must contain non-empty directory paths' };
            }
            const resolved = resolveWithinRoots(root.trim(), configuredRoots);
            if (resolved === undefined) {
                return { ok: false, error: `root is outside the configured roots: ${root}` };
            }
            if (!narrowedRoots.includes(resolved.path))
                narrowedRoots.push(resolved.path);
        }
    }
    let narrowedExcludes;
    if (excludes !== undefined) {
        if (!Array.isArray(excludes))
            return { ok: false, error: 'excludes must be an array of configured globs' };
        const allowed = new Set(configuredExcludes);
        narrowedExcludes = [];
        for (const exclude of excludes) {
            if (typeof exclude !== 'string' || exclude.trim() === '') {
                return { ok: false, error: 'excludes must contain non-empty globs' };
            }
            if (!allowed.has(exclude)) {
                return { ok: false, error: `exclude is not one of the configured excludes: ${exclude}` };
            }
            if (!narrowedExcludes.includes(exclude))
                narrowedExcludes.push(exclude);
        }
    }
    return {
        ok: true,
        ...(narrowedRoots === undefined ? {} : { roots: narrowedRoots }),
        ...(narrowedExcludes === undefined ? {} : { excludes: narrowedExcludes }),
    };
}
const SEARCH_DESCRIPTION = [
    'Search a persistent local file-name index in milliseconds (dsh-locator).',
    '',
    'This is not a workspace walk: a background scanner keeps an index of the configured roots in a snapshot, so a query over hundreds of thousands of files returns in a few milliseconds even after a restart.',
    '',
    'Query language (Everything-flavored): bare words are ANDed substrings of the file name; `!word` negates; `"two words"` keeps a phrase; `*.go` and `?` are wildcards; `ext:ts,js` / `ext:!tmp`; `path:src` matches the full path; `size:>10mb`, `size:1kb..2mb`; `dm:today`, `dm:yesterday`, `dm:thisweek`, `dm:2026-01-01`, `dm:>=2026-01-01`; `folder:` or `file:` restrict the kind; `case:1` and `wholeword:1` tune matching.',
    '',
    'Use it when the user remembers part of a name or path but not where it lives (whole disk / home directory), or for filters like "the PDFs over 50 MB from this week". Use `grep` for file contents and `glob` for a known workspace path — this index stores names, sizes and modification times, not contents. Results are limited to the roots the plugin was configured with; `locator_status` reports them.',
].join('\n');
/** Build the locator_search tool. */
export function makeSearchTool(rt) {
    return defineTool({
        name: 'locator_search',
        description: SEARCH_DESCRIPTION,
        parameters: {
            query: { type: 'string', required: true, description: 'Search expression, Everything-style. Empty text matches everything.' },
            limit: { type: 'integer', description: `Maximum hits to return (default 50, at most ${String(rt.config.maxResults)}).` },
            offset: { type: 'integer', description: 'Skip this many sorted matches (pagination).' },
            sort: { type: 'string', enum: ['name', 'path', 'size', 'mtime', 'ext'], description: 'Sort key (default name).' },
            desc: { type: 'boolean', description: 'Sort descending.' },
            regex: { type: 'boolean', description: 'Treat the whole query as a regular expression over the file name.' },
            caseSensitive: { type: 'boolean', description: 'Match letter case.' },
            wholeWord: { type: 'boolean', description: 'Require word boundaries around each bare term.' },
            filesOnly: { type: 'boolean', description: 'Return files only.' },
            dirsOnly: { type: 'boolean', description: 'Return directories only.' },
            scope: {
                type: 'string',
                enum: ['workspace', 'all'],
                description: 'workspace (default) restricts hits to the caller cwd when that cwd is inside an indexed root; all searches every configured root.',
            },
        },
        output: {
            schema: SEARCH_OUTPUT,
            render: (_args, value) => {
                const v = value;
                if (!v.ok)
                    return [{ type: 'text', text: `locator_search failed: ${v.error ?? 'unknown error'}` }];
                const hits = v.hits ?? [];
                const lines = [
                    `locator_search ${JSON.stringify(v.query ?? '')}: ${String(v.total ?? 0)} match(es)` +
                        `${v.truncated === true ? `, showing ${String(v.returned ?? 0)}` : ''}` +
                        ` in ${(v.tookMs ?? 0).toFixed(1)} ms` +
                        (v.indexing === true ? ' (initial scan still running; results are partial)' : '') +
                        (v.scope === undefined ? '' : ` (scope: ${v.scope}${v.scopeFallback === undefined ? '' : `; ${v.scopeFallback}`})`),
                ];
                for (const hit of hits) {
                    const suffix = hit.dir ? '/' : '';
                    const size = hit.dir ? '' : `  ${formatSize(hit.size)}`;
                    lines.push(`${hit.path}${suffix}${size}`);
                    if (hit.ref !== undefined)
                        lines.push(`   ref ${hit.ref}`);
                }
                if (v.truncated === true && (v.total ?? 0) > (v.returned ?? 0)) {
                    lines.push(`(${String((v.total ?? 0) - (v.returned ?? 0))} more not shown; raise limit/offset or narrow the query)`);
                }
                return [{ type: 'text', text: lines.join('\n') }];
            },
            presentationMeta: (_args, value) => {
                const v = value;
                if (!v.ok)
                    return { shape: 'paths', paths: [], truncated: false, total: 0 };
                return {
                    shape: 'paths',
                    paths: (v.hits ?? []).map(hit => `${hit.path}${hit.dir ? '/' : ''}`),
                    truncated: v.truncated === true,
                    total: v.total ?? 0,
                };
            },
        },
        presentResult: (_args, result) => {
            const meta = result.meta;
            if (!isPathsMeta(meta))
                return undefined;
            return {
                card: 'search',
                shape: 'paths',
                paths: meta.paths,
                truncated: meta.truncated,
                total: meta.total,
            };
        },
        async execute(args, exec) {
            const limit = clamp(args.limit ?? 50, 1, rt.config.maxResults);
            const scope = args.scope === 'all' ? 'all' : 'workspace';
            const callerCwd = exec?.agent?.session?.header?.cwd;
            const cwdIsIndexed = callerCwd !== undefined && rt.roots.some(root => withinRoots(callerCwd, [root]));
            const narrowToCwd = scope === 'workspace' && cwdIsIndexed;
            // Ask for a wider page when the cwd filter will drop rows so the returned
            // page stays full for the workspace scope.
            const fetchLimit = narrowToCwd ? Math.min(rt.config.maxResults, limit * 5) : limit;
            try {
                rt.start();
                const result = await rt.search({
                    query: args.query,
                    limit: fetchLimit,
                    offset: Math.max(0, args.offset ?? 0),
                    sort: args.sort ?? 'name',
                    desc: args.desc ?? false,
                    regex: args.regex ?? false,
                    caseSensitive: args.caseSensitive ?? false,
                    wholeWord: args.wholeWord ?? false,
                    filesOnly: args.filesOnly ?? false,
                    dirsOnly: args.dirsOnly ?? false,
                });
                const observedAt = Date.now();
                const visibility = cwdIsIndexed ? 'workspace' : 'roots';
                const mapped = result.hits.map(hit => ({
                    path: hit.path,
                    name: hit.name,
                    size: hit.size,
                    mtime: hit.mtime,
                    modified: new Date(hit.mtime).toISOString(),
                    ext: hit.ext,
                    dir: hit.dir,
                    ...(hit.dir ? {} : { ref: fileRef({ path: hit.path, mtime: hit.mtime, size: hit.size }) }),
                    freshness: { state: 'unknown', observedAt, mtime: hit.mtime },
                    permissions: { read: 'allowed', visibility: visibility, reason: 'name hits come from the configured index roots' },
                }));
                const kept = narrowToCwd
                    ? mapped.filter(hit => withinRoots(hit.path, [callerCwd])).slice(0, limit)
                    : mapped;
                return {
                    ok: true,
                    query: args.query,
                    total: result.total,
                    returned: kept.length,
                    offset: result.offset,
                    truncated: result.truncated || kept.length < mapped.length,
                    indexing: result.indexing === true,
                    tookMs: result.tookNs / 1e6,
                    hits: kept,
                    scope: scope,
                    ...(scope === 'workspace' && !cwdIsIndexed ? { scopeFallback: 'cwd-not-indexed; searched every configured root' } : {}),
                };
            }
            catch (error) {
                return { ok: false, query: args.query, error: messageOf(error) };
            }
        },
    });
}
/** Build the locator_status tool. */
export function makeStatusTool(rt, content) {
    return defineTool({
        name: 'locator_status',
        description: [
            'Report the local file index behind locator_search (dsh-locator): roots, entry counts, whether the filesystem watcher is active, the state directory and the engine binary.',
            'Call it when a locator_search result looks stale, when the user asks whether their disk is indexed, or to explain which directories are covered.',
        ].join('\n'),
        parameters: {},
        output: {
            schema: STATUS_OUTPUT,
            render: (_args, value) => {
                const v = value;
                if (!v.ok)
                    return [{ type: 'text', text: `locator_status: engine unavailable — ${v.error ?? 'unknown error'}` }];
                const lines = [
                    `locator_status: ${String(v.entries ?? 0)} entries (${String(v.files ?? 0)} files, ${String(v.dirs ?? 0)} dirs)`,
                    `  roots: ${(v.roots ?? []).join(', ') || '(none)'}`,
                    `  watcher: ${v.watching === true ? 'active' : 'inactive'}${v.watchDegraded === true ? ` (degraded: ${v.watchReason ?? 'partial coverage'}; roots ${String(v.watchRoots ?? 0)})` : ''}${v.usn === true ? '; USN-built index (size/date fill in on display)' : ''}${v.scanning === true ? '; initial scan running' : ''}`,
                    `  state: ${v.stateDir ?? ''}`,
                    `  engine: ${v.binary ?? ''}${v.version === undefined ? '' : ` (${v.version}, ${v.platform ?? ''})`}`,
                ];
                if (v.refreshFallback === true)
                    lines.push('  fallback: periodic rebuild is active (native watcher incomplete)');
                if (v.content?.enabled === true) {
                    lines.push(`  content: ${String(v.content.files ?? 0)} files / ${String(v.content.messages ?? 0)} messages${v.content.fullIndex === true ? ' · full-index' : ''}${v.content.reasoningIndex === true ? ' · reasoning-indexed' : ''}${v.content.toolResultsIndex === true ? ' · tool-results-indexed' : ''}${v.content.truncated === true ? ' · truncated' : ''}`);
                    const progress = v.content.progress;
                    if (progress !== undefined) {
                        const total = typeof progress.total === 'number' ? ` / ${String(progress.total)}` : '';
                        lines.push(`  building: ${progress.phase === 'sessions' ? 'sessions' : 'files'} ${String(progress.scanned ?? 0)}${total} scanned, ${String(progress.indexed ?? 0)} indexed${typeof progress.path === 'string' && progress.path !== '' ? ` · ${progress.path}` : ''}`);
                    }
                }
                if (v.warning !== undefined)
                    lines.push(`  warning: ${v.warning}`);
                if (v.error !== undefined)
                    lines.push(`  error: ${v.error}`);
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        async execute() {
            rt.start();
            const status = rt.status;
            const engine = await rt.engineStatus();
            return {
                ok: status.error === undefined,
                running: status.running,
                ...(engine === undefined ? {} : { version: engine.version, platform: engine.platform }),
                roots: engine?.roots ?? rt.roots,
                entries: engine?.entries ?? 0,
                files: engine?.files ?? 0,
                dirs: engine?.dirs ?? 0,
                watching: engine?.watching ?? false,
                usn: engine?.usn ?? false,
                scanning: status.scanning !== undefined,
                stateDir: engine?.stateDir ?? rt.stateDir,
                binary: rt.binary,
                ...(content === undefined ? {} : { content: { enabled: true, ...content.status() } }),
                ...(status.warning === undefined ? {} : { warning: status.warning }),
                ...(status.error === undefined ? {} : { error: status.error }),
            };
        },
    });
}
/** Build the locator_rebuild tool. */
export function makeRebuildTool(rt) {
    return defineTool({
        name: 'locator_rebuild',
        description: [
            'Rebuild the local file index from scratch (dsh-locator). Runs in the background; locator_search keeps answering from the old index until the new one is ready.',
            'The rebuild is always confined to the configured scope: replacement `roots` must resolve inside the roots the plugin was configured with, and replacement `excludes` must come from the configured exclude list. To index a different directory, change the plugin configuration instead.',
            'Use it after changing indexed roots, after the index looks stale and the watcher is inactive, or when the user explicitly asks to rescan. It can take minutes for a large home directory and costs disk I/O, so do not call it routinely.',
        ].join('\n'),
        parameters: {
            roots: { type: 'array', items: { type: 'string' }, description: 'Replacement root directories (defaults to the current roots). Each must be a configured root or inside one.' },
            excludes: { type: 'array', items: { type: 'string' }, description: 'Replacement exclusion globs (defaults to the current excludes). Each must already be configured.' },
        },
        output: {
            schema: REBUILD_OUTPUT,
            render: (_args, value) => {
                const v = value;
                if (!v.ok)
                    return [{ type: 'text', text: `locator_rebuild failed: ${v.error ?? 'unknown error'}` }];
                return [{ type: 'text', text: 'locator_rebuild: started in the background; searches keep using the old index until it finishes' }];
            },
        },
        async execute(args) {
            const scope = validateRebuildArguments(args.roots, args.excludes, rt.roots, rt.config.excludes);
            if (!scope.ok)
                return { ok: false, error: scope.error };
            try {
                rt.start();
                const result = await rt.rebuild(scope.roots, scope.excludes);
                return { ok: true, started: result.started };
            }
            catch (error) {
                return { ok: false, error: messageOf(error) };
            }
        },
    });
}
function isPathsMeta(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const record = value;
    return (record.shape === 'paths' &&
        Array.isArray(record.paths) &&
        record.paths.every(path => typeof path === 'string') &&
        typeof record.truncated === 'boolean' &&
        typeof record.total === 'number');
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Math.trunc(value)));
}
function formatSize(bytes) {
    if (bytes < 1024)
        return `${String(bytes)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit] ?? 'TB'}`;
}
//# sourceMappingURL=tools.js.map