/**
 * Optional HTTP surface for the Web GUI panel.
 *
 * The panel is a browser overlay (client.js) and cannot call the stdio engine
 * directly, so the host exposes two exact routes on the Web server:
 *
 *   POST /dsh-locator/search   { query, limit, offset, sort, desc, ... }
 *   POST /dsh-locator/status   {}
 *
 * Registration is optional: headless and TUI profiles have no `webServer`
 * service, and the plugin still works there through its tools.
 * @module dsh-locator/http
 */
import { openWithDefaultApp, revealInFileManager, withinRoots } from "./reveal.js";
import { statSync } from 'node:fs';
const BODY_LIMIT = 64 * 1024;
/** Mount the panel's routes when this profile runs a Web server. */
export function registerHttp(ctx, rt, content, ensure) {
    const inject = ctx.inject;
    if (typeof inject !== 'function')
        return;
    inject.call(ctx, ['webServer'], (scoped) => {
        const server = scoped.webServer;
        if (server === undefined)
            return;
        scoped.effect(() => server.register({
            kind: 'exact',
            path: '/dsh-locator/search',
            handler: handler(scoped, async (body) => await search(rt, body)),
        }));
        scoped.effect(() => server.register({
            kind: 'exact',
            path: '/dsh-locator/status',
            handler: handler(scoped, async () => await status(rt)),
        }));
        scoped.effect(() => server.register({
            kind: 'exact',
            path: '/dsh-locator/reveal',
            handler: handler(scoped, async (body) => await reveal(rt, body)),
        }));
        if (content !== undefined) {
            scoped.effect(() => server.register({
                kind: 'exact',
                path: '/dsh-locator/content/rebuild',
                handler: handler(scoped, async (body) => {
                    ensure?.();
                    const full = body.full === true;
                    const started = full ? content.rebuild() : content.refreshNow();
                    return started ? { ok: true, started: true, full } : { ok: false, error: 'a content build is already running' };
                }),
            }));
            scoped.effect(() => server.register({
                kind: 'exact',
                path: '/dsh-locator/content',
                handler: handler(scoped, async (body) => {
                    ensure?.();
                    const query = typeof body.query === 'string' ? body.query : '';
                    const limit = typeof body.limit === 'number' ? body.limit : 30;
                    return { ok: true, query, hits: await content.search(query, limit), state: content.status() };
                }),
            }));
        }
        scoped.effect(() => server.register({
            kind: 'exact',
            path: '/dsh-locator/open',
            handler: handler(scoped, async (body) => await openPath(rt, body)),
        }));
    });
}
function handler(scoped, run) {
    return async (req, res) => {
        const rejection = rejectionStatus(scoped, req);
        if (rejection !== undefined) {
            res.statusCode = rejection;
            res.end();
            return;
        }
        if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' });
            return;
        }
        try {
            const body = await readJson(req, BODY_LIMIT);
            const value = await run(body);
            sendJson(res, 200, { ok: true, ...asRecord(value) });
        }
        catch (error) {
            sendJson(res, 200, { ok: false, error: messageOf(error) });
        }
    };
}
async function search(rt, raw) {
    const body = raw;
    const limit = clampNumber(body.limit, 1, rt.config.maxResults, 100);
    const offset = clampNumber(body.offset, 0, 100_000, 0);
    const sort = sortKey(body.sort);
    const args = {
        query: typeof body.query === 'string' ? body.query : '',
        limit,
        offset,
        sort,
        desc: body.desc === true,
        regex: body.regex === true,
        caseSensitive: body.caseSensitive === true,
        wholeWord: body.wholeWord === true,
        filesOnly: body.filesOnly === true,
        dirsOnly: body.dirsOnly === true,
    };
    rt.start();
    const result = await rt.search(args);
    return {
        total: result.total,
        returned: result.returned,
        offset: result.offset,
        truncated: result.truncated,
        tookMs: result.tookNs / 1e6,
        hits: result.hits,
    };
}
async function reveal(rt, raw) {
    const path = typeof raw.path === 'string' ? raw.path : '';
    if (path === '' || !withinRoots(path, rt.roots)) {
        return { ok: false, error: 'path is outside the indexed roots' };
    }
    try {
        const info = statSync(path);
        if (!info.isFile() && !info.isDirectory())
            return { ok: false, error: 'not a file or directory' };
    }
    catch {
        return { ok: false, error: 'path does not exist' };
    }
    try {
        await revealInFileManager(path);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: messageOf(error) };
    }
}
async function openPath(rt, raw) {
    const path = typeof raw.path === 'string' ? raw.path : '';
    if (path === '' || !withinRoots(path, rt.roots)) {
        return { ok: false, error: 'path is outside the indexed roots' };
    }
    try {
        const info = statSync(path);
        if (!info.isFile())
            return { ok: false, error: 'not a file' };
    }
    catch {
        return { ok: false, error: 'path does not exist' };
    }
    try {
        await openWithDefaultApp(path);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: messageOf(error) };
    }
}
async function status(rt) {
    rt.start();
    const engine = await rt.engineStatus();
    return {
        running: rt.status.running,
        entries: engine?.entries ?? 0,
        files: engine?.files ?? 0,
        dirs: engine?.dirs ?? 0,
        roots: engine?.roots ?? rt.roots,
        watching: engine?.watching ?? false,
        usn: engine?.usn ?? false,
        scanning: engine?.scanning === true || rt.status.scanning !== undefined,
        stateDir: engine?.stateDir ?? rt.stateDir,
        version: engine?.version ?? '',
        ...(rt.status.error === undefined ? {} : { error: rt.status.error }),
        ...(rt.status.warning === undefined ? {} : { warning: rt.status.warning }),
    };
}
function rejectionStatus(scoped, req) {
    const connection = scoped.get?.('connection');
    if (connection === undefined || typeof connection.requestRejection !== 'function')
        return undefined;
    const rejection = connection.requestRejection(req);
    return typeof rejection === 'number' ? rejection : undefined;
}
async function readJson(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > limit)
            throw new Error(`request body exceeds ${String(limit)} bytes`);
        chunks.push(buffer);
    }
    if (size === 0)
        return {};
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('request body must be an object');
    return value;
}
function sendJson(res, status, body) {
    if (res.writableEnded)
        return;
    const text = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(text);
}
function sortKey(value) {
    return value === 'name' || value === 'path' || value === 'size' || value === 'mtime' || value === 'ext' ? value : 'mtime';
}
function clampNumber(value, min, max, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
}
function asRecord(value) {
    return typeof value === 'object' && value !== null ? value : {};
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=http.js.map