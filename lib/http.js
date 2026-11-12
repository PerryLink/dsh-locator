/**
 * Optional HTTP surface for the Web GUI panel.
 *
 * The panel is a browser overlay (client.js) and cannot call the stdio engine
 * directly, so the host exposes exact routes on the Web server:
 *
 *   POST /dsh-locator/search   { query, limit, offset, sort, desc, ... }
 *   POST /dsh-locator/status   {}
 *
 * Security is fail-closed. The routes only exist when the host's `connection`
 * service — the browser authentication + Host/Origin trust fence — is
 * available, so a profile without it mounts no locator HTTP surface at all.
 * Every request then asks that service for a rejection first; if the service
 * disappeared or its check fails, the route answers 503 instead of allowing
 * the call. On top of that fence each request must be a `POST` with an
 * `application/json` content type (415 otherwise), the body is capped at
 * 64 KiB, and a cross-site `Origin`/`Sec-Fetch-Site` marker is refused locally
 * as defense in depth.
 *
 * Registration is optional: headless and TUI profiles have no `webServer`
 * service, and the plugin still works there through its tools.
 * @module dsh-locator/http
 */
import { readCombinedRequest, runCombinedSearch } from "./combined.js";
import { executableFileRejection, openWithDefaultApp, resolveWithinRoots, revealInFileManager, } from "./reveal.js";
import { statSync } from 'node:fs';
const BODY_LIMIT = 64 * 1024;
/** A wire-format failure that must answer with a real HTTP status. */
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'HttpError';
    }
}
/**
 * Mount the panel's routes when this profile runs a Web server **and** the
 * host connection trust fence. Without `connection` no route is registered:
 * an unauthenticated locator HTTP surface is never exposed.
 * @param ctx - plugin context.
 * @param rt - locator runtime backing the name search.
 * @param content - content index, when enabled.
 * @param ensure - lazy content boot hook.
 */
export function registerHttp(ctx, rt, content, ensure) {
    const inject = ctx.inject;
    if (typeof inject !== 'function')
        return;
    inject.call(ctx, ['webServer', 'connection'], (scoped) => {
        const server = webServerOf(scoped);
        if (server === undefined)
            return;
        // Hard dependency: no trust fence, no routes (fail closed, never "allow").
        if (activeConnection(scoped) === undefined)
            return;
        const route = (path, run) => {
            scoped.effect(() => server.register({ kind: 'exact', path, handler: handler(scoped, run) }));
        };
        route('/dsh-locator/search', async (body) => await search(rt, body));
        route('/dsh-locator/status', async () => await status(rt, content));
        route('/dsh-locator/reveal', async (body) => await reveal(rt, body));
        route('/dsh-locator/combined', async (body) => await combined(rt, content, ensure, body));
        if (content !== undefined) {
            route('/dsh-locator/content/rebuild', async (body) => {
                ensure?.();
                const full = body.full === true;
                const started = full ? content.rebuild() : content.refreshNow();
                return started ? { ok: true, started: true, full } : { ok: false, error: 'a content build is already running' };
            });
            route('/dsh-locator/content', async (body) => {
                ensure?.();
                const query = typeof body.query === 'string' ? body.query : '';
                const limit = typeof body.limit === 'number' ? body.limit : 30;
                return { ok: true, query, hits: await content.search(query, limit), state: content.status() };
            });
        }
        route('/dsh-locator/open', async (body) => await openPath(rt, body));
    });
}
/**
 * Wrap one route body. The order is the security order: trust fence first,
 * then method, then media type, then the bounded JSON body.
 */
function handler(scoped, run) {
    return async (req, res) => {
        const rejection = trustRejection(scoped, req);
        if (rejection !== undefined) {
            res.statusCode = rejection;
            res.end();
            return;
        }
        if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('allow', 'POST');
            res.end();
            return;
        }
        if (!isJsonContentType(req.headers['content-type'])) {
            sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
            return;
        }
        let body;
        try {
            body = await readJson(req, BODY_LIMIT);
        }
        catch (error) {
            const status = error instanceof HttpError ? error.status : 400;
            sendJson(res, status, { ok: false, error: messageOf(error) });
            return;
        }
        try {
            const value = await run(body);
            sendJson(res, 200, { ok: true, ...asRecord(value) });
        }
        catch (error) {
            sendJson(res, 200, { ok: false, error: messageOf(error) });
        }
    };
}
/**
 * The connection trust fence, fail-closed.
 *
 * A missing/inactive `connection` service, a throwing check, or a numeric
 * rejection all refuse the request. When the service accepts the request the
 * local same-origin markers are checked again, so a future trust-policy
 * regression here cannot silently expose a route to another site.
 * @returns an HTTP status to reject with, or undefined to proceed.
 */
function trustRejection(scoped, req) {
    const connection = activeConnection(scoped);
    if (connection === undefined)
        return 503;
    let rejection;
    try {
        rejection = connection.requestRejection(req);
    }
    catch {
        return 503;
    }
    if (typeof rejection === 'number')
        return rejection;
    return originRejection(req.headers);
}
/** Read the active connection implementation; inactive/missing/throwing all mean "unavailable". */
function activeConnection(scoped) {
    let value;
    try {
        const get = scoped.get;
        value = typeof get === 'function'
            ? get.call(scoped, 'connection', true)
            : Reflect.get(scoped, 'connection');
    }
    catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null)
        return undefined;
    const requestRejection = value.requestRejection;
    if (typeof requestRejection !== 'function')
        return undefined;
    return value;
}
function webServerOf(scoped) {
    let value;
    try {
        const get = scoped.get;
        value = typeof get === 'function'
            ? get.call(scoped, 'webServer', true)
            : Reflect.get(scoped, 'webServer');
    }
    catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null)
        return undefined;
    const register = value.register;
    return typeof register === 'function' ? value : undefined;
}
/** First value of a Node header that may arrive repeated. */
function headerValue(headers, name) {
    const raw = headers[name];
    if (typeof raw === 'string')
        return raw;
    if (Array.isArray(raw)) {
        const first = raw[0];
        return typeof first === 'string' ? first : undefined;
    }
    return undefined;
}
/**
 * The exact JSON media type required by every locator route. A charset or any
 * other parameter is tolerated (`application/json; charset=utf-8`), any other
 * essence (including `text/plain` and a missing header) is not.
 * @param value - the raw `content-type` header value.
 */
export function isJsonContentType(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string')
        return false;
    const essence = raw.split(';', 1)[0]?.trim().toLowerCase();
    return essence === 'application/json';
}
/**
 * The local same-origin fence, defense in depth behind the host connection
 * check. A `Sec-Fetch-Site: cross-site` marker is refused; when a browser
 * attaches an `Origin`, it must name this listener's own authority. Requests
 * without browser markers (CLI clients) pass: they are already gated by
 * authentication.
 * @param headers - request headers.
 * @returns 403 when the request is provably cross-site, else undefined.
 */
export function originRejection(headers) {
    const site = headerValue(headers, 'sec-fetch-site');
    if (site !== undefined && site.toLowerCase() === 'cross-site')
        return 403;
    const origin = headerValue(headers, 'origin');
    if (origin === undefined || origin === '')
        return undefined;
    const host = headerValue(headers, 'host');
    // An Origin without a Host cannot be compared; a local request always has one.
    if (host === undefined || host === '')
        return 403;
    try {
        const originUrl = new URL(origin);
        const scheme = originUrl.protocol === 'https:'
            ? 'https:'
            : originUrl.protocol === 'http:'
                ? 'http:'
                : undefined;
        // Opaque origins (`Origin: null`, sandboxed frames, file: pages) and every
        // non-HTTP scheme have no authority this listener can be serving.
        if (scheme === undefined)
            return 403;
        const hostUrl = new URL(`${scheme}//${host}`);
        return originUrl.host === hostUrl.host ? undefined : 403;
    }
    catch {
        return 403;
    }
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
/**
 * One panel search across all enabled scopes. The stores are injected so the
 * orchestration (scope gating, lazy-build guard, de-duplication) stays testable
 * without an HTTP request or an engine process.
 */
async function combined(rt, content, ensure, raw) {
    rt.start();
    const deps = {
        search: async (args) => await rt.search(args),
        maxResults: rt.config.maxResults,
        ...(content === undefined ? {} : {
            contentSearch: async (query, limit, options) => await content.search(query, limit, options),
            contentStatus: () => content.status(),
            ...(ensure === undefined ? {} : { ensure }),
        }),
    };
    const request = readCombinedRequest(raw, rt.config.maxResults);
    const result = await runCombinedSearch(deps, request);
    return {
        query: request.query,
        matchMode: request.matchMode,
        caseSensitive: request.caseSensitive,
        wholeWord: request.wholeWord,
        sessionId: request.sessionId,
        ...result,
    };
}
/**
 * Reveal one path in the platform file manager. The path is authorized and
 * canonicalized first, so the file manager is pointed at the real file inside
 * a root, never at a symlink that leaves it.
 */
async function reveal(rt, raw) {
    const requested = typeof raw.path === 'string' ? raw.path : '';
    const resolved = requested === '' ? undefined : resolveWithinRoots(requested, rt.roots);
    if (resolved === undefined)
        return { ok: false, error: 'path is outside the indexed roots' };
    let info;
    try {
        info = statSync(resolved.path);
    }
    catch {
        return { ok: false, error: 'path does not exist' };
    }
    if (!info.isFile() && !info.isDirectory())
        return { ok: false, error: 'not a file or directory' };
    // TOCTOU best effort: re-canonicalize immediately before handing the path to
    // another process. This closes the window between authorization and spawn,
    // though the platform opener still resolves the path itself.
    const final = resolveWithinRoots(resolved.path, rt.roots);
    if (final === undefined)
        return { ok: false, error: 'path is outside the indexed roots' };
    try {
        await revealInFileManager(final.path);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: messageOf(error) };
    }
}
/**
 * Open one path with the platform's default application: canonicalized inside
 * the roots, still a regular file, and never an executable or script type.
 */
async function openPath(rt, raw) {
    const requested = typeof raw.path === 'string' ? raw.path : '';
    const resolved = requested === '' ? undefined : resolveWithinRoots(requested, rt.roots);
    if (resolved === undefined)
        return { ok: false, error: 'path is outside the indexed roots' };
    let info;
    try {
        info = statSync(resolved.path);
    }
    catch {
        return { ok: false, error: 'path does not exist' };
    }
    if (!info.isFile())
        return { ok: false, error: 'not a file' };
    const refusal = executableFileRejection(resolved.path, info.mode);
    if (refusal !== undefined)
        return { ok: false, error: refusal };
    // TOCTOU best effort: re-canonicalize and re-check the executable guard on
    // the path that is actually handed to the opener.
    const final = resolveWithinRoots(resolved.path, rt.roots);
    if (final === undefined)
        return { ok: false, error: 'path is outside the indexed roots' };
    let finalInfo;
    try {
        finalInfo = statSync(final.path);
    }
    catch {
        return { ok: false, error: 'path does not exist' };
    }
    if (!finalInfo.isFile())
        return { ok: false, error: 'not a file' };
    const finalRefusal = executableFileRejection(final.path, finalInfo.mode);
    if (finalRefusal !== undefined)
        return { ok: false, error: finalRefusal };
    try {
        await openWithDefaultApp(final.path);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: messageOf(error) };
    }
}
async function status(rt, content) {
    rt.start();
    const engine = await rt.engineStatus();
    const contentState = content === undefined ? { enabled: false } : { enabled: true, ...content.status() };
    return {
        running: rt.status.running,
        entries: engine?.entries ?? 0,
        files: engine?.files ?? 0,
        dirs: engine?.dirs ?? 0,
        roots: engine?.roots ?? rt.roots,
        watching: engine?.watching ?? false,
        ...(engine?.watchDegraded === true ? { watchDegraded: true } : {}),
        ...(engine?.watchReason === undefined ? {} : { watchReason: engine.watchReason }),
        ...(engine?.watchRoots === undefined ? {} : { watchRoots: engine.watchRoots }),
        ...(engine?.refreshFallback === true ? { refreshFallback: true } : {}),
        usn: engine?.usn ?? false,
        scanning: engine?.scanning === true || rt.status.scanning !== undefined,
        stateDir: engine?.stateDir ?? rt.stateDir,
        version: engine?.version ?? '',
        content: contentState,
        ...(rt.status.error === undefined ? {} : { error: rt.status.error }),
        ...(rt.status.warning === undefined ? {} : { warning: rt.status.warning }),
    };
}
/**
 * Collect a bounded JSON object body. Oversize bodies answer 413, malformed
 * JSON or a non-object value answers 400.
 */
async function readJson(req, limit) {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > limit) {
            tooLarge = true;
            continue;
        }
        chunks.push(buffer);
    }
    if (tooLarge)
        throw new HttpError(413, `request body exceeds ${String(limit)} bytes`);
    if (size === 0)
        return {};
    let value;
    try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new HttpError(400, 'request body must be valid JSON');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new HttpError(400, 'request body must be an object');
    }
    return value;
}
function sendJson(res, statusCode, body) {
    if (res.writableEnded)
        return;
    const text = JSON.stringify(body);
    res.statusCode = statusCode;
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