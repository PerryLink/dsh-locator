/**
 * Optional HTTP surface for the Web GUI panel.
 *
 * The panel is a browser overlay (client.js) and cannot call the stdio engine
 * directly, so the host exposes exact routes on the Web server:
 *
 *   POST /dsh-locator/search   { query, limit, offset, sort, desc, ... }
 *   GET  /dsh-locator/search?q=...&limit=...&offset=...&mode=names|content|count&json=1
 *   POST /dsh-locator/status   {}
 *   POST /dsh-locator/combined { query, limit, contentLimit, compact, ... }
 *
 * **Method contract, per route.** `/dsh-locator/search` accepts both POST and
 * GET on purpose: the panel keeps the POST JSON-body contract, while scripts and
 * other tools get a plain, citable GET query API (Everything-style HTTP) behind
 * the exact same trust fence, the same auth policy and the same same-origin
 * check. Every other route is POST-only and requires `application/json` (415
 * otherwise); GET carries its parameters in the query string, ignores a request
 * body, and needs no content-type. `json=1` is accepted on GET for historical
 * compatibility with the documented curl examples — every response on every
 * route is already JSON.

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
import { fileRef } from "./refs.js";
import { contentScopeOptionsOf, readContextLines, runContentSearchRequest } from "./find.js";
import { applyOutputBudget, DEFAULT_OUTPUT_BUDGET_CHARS, ERROR_CODES, errorInfoOf, evidenceLimitOf, evidenceVisible, pageAdvance, pageSize, selectPage, } from "./scope.js";
import { isAbortError, readCombinedRequest, runCombinedSearch } from "./combined.js";
import { engineResourceFields } from "./runtime.js";
import { executableFileRejection, openAtLine, openWithDefaultApp, parseLineNumber, resolveWithinRoots, revealInFileManager, } from "./reveal.js";
import { closeSync, constants, fstatSync, openSync, statSync } from 'node:fs';
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
export function registerHttp(ctx, rt, content, ensure, options = {}, capabilities, scope) {
    const inject = ctx.inject;
    if (typeof inject !== 'function')
        return;
    inject.call(ctx, ['webServer', 'connection'], (scoped) => {
        const server = webServerOf(scoped);
        if (server === undefined)
            return;
        // Register even if the connection service is still activating. The service
        // is injected asynchronously during host boot; bailing out here used to
        // leave the panel with permanently missing routes until a restart. Every
        // request re-checks the trust fence and answers 503 when it is unavailable,
        // so this remains fail-closed.
        const route = (path, run) => {
            scoped.effect(() => server.register({ kind: 'exact', path, auth: 'required', handler: handler(scoped, run, options.connectionOptional === true) }));
        };
        // One exact path, two methods: the panel keeps POST + JSON body, the public
        // API uses GET query parameters. Registering the same path twice would throw
        // (the host treats duplicate routes as a composition error), so the handler
        // dispatches on the method itself.
        scoped.effect(() => server.register({
            kind: 'exact',
            path: '/dsh-locator/search',
            auth: 'required',
            handler: searchHandler(scoped, rt, content, ensure, options.connectionOptional === true, scope),
        }));
        route('/dsh-locator/status', async () => await status(rt, content, scope));
        route('/dsh-locator/reveal', async (body) => await reveal(rt, body));
        route('/dsh-locator/combined', async (body, res) => await combined(rt, content, ensure, body, res, options));
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
        if (capabilities !== undefined) {
            // The panel's capability view reads the live tool/skill registries through
            // this route; like every route it sits behind the same trust fence.
            route('/dsh-locator/capabilities', async (body) => {
                if (typeof body.capability === 'string' && body.capability !== '') {
                    const args = typeof body.args === 'object' && body.args !== null && !Array.isArray(body.args)
                        ? body.args
                        : undefined;
                    return await capabilities.preflight(body.capability, args);
                }
                const intent = typeof body.intent === 'string' ? body.intent : '';
                const limit = typeof body.limit === 'number' ? body.limit : undefined;
                return await capabilities.search(intent, limit);
            });
        }
    });
}
/**
 * Wrap one route body. The order is the security order: trust fence first,
 * then method, then media type, then the bounded JSON body.
 */
function handler(scoped, run, connectionOptional = false) {
    return async (req, res, peer) => {
        const rejection = trustRejection(scoped, req, connectionOptional, peer);
        if (rejection !== undefined) {
            res.statusCode = rejection;
            res.end();
            return;
        }
        if (req.method !== 'POST') {
            res.setHeader('allow', 'POST');
            sendFailure(res, 405, 'method-not-allowed', 'method not allowed (use POST)');
            return;
        }
        if (!isJsonContentType(req.headers['content-type'])) {
            sendFailure(res, 415, 'unsupported-media-type', 'content-type must be application/json');
            return;
        }
        let body;
        try {
            body = await readJson(req, BODY_LIMIT);
        }
        catch (error) {
            const status = error instanceof HttpError ? error.status : 400;
            sendFailure(res, status, wireErrorCode(status), messageOf(error));
            return;
        }
        try {
            const value = await run(body, res);
            sendJson(res, 200, withErrorInfo({ ok: true, ...asRecord(value) }));
        }
        catch (error) {
            // A client disconnect cancels the work; there is nobody left to read the
            // error, so report it only if the response is still writable.
            const code = isAbortError(error) ? 'request-aborted' : 'request-failed';
            sendFailure(res, 200, code, isAbortError(error) ? 'request-aborted' : messageOf(error));
        }
    };
}
/** Stable wire error code per HTTP status. */
function wireErrorCode(status) {
    if (status === 413)
        return 'body-too-large';
    if (status === 415)
        return 'unsupported-media-type';
    if (status === 405)
        return 'method-not-allowed';
    if (status === 400)
        return 'invalid-json';
    return 'request-failed';
}
/** Send one JSON failure with both the legacy error string and errorInfo. */
function sendFailure(res, status, code, message) {
    sendJson(res, status, { ok: false, error: message, errorInfo: errorInfoOf(code, message) });
}
/** Content/tool error codes that are already machine-readable message strings. */
const KNOWN_ERROR_CODES = new Set([
    ...Object.values(ERROR_CODES),
    'content-query-too-short',
    'content-query-too-long',
    'content-query-too-many-terms',
    'content-query-invalid',
    'content-regex-not-supported',
    'content-search-cancelled',
    'content-search-worker-failed',
    'content-path-denied',
    'content-scope-denied',
    'session-not-authorized',
    'content-index-unavailable',
    'name-index-unavailable',
    'invalid-escape',
    'invalid-control-char',
]);
/** Best-effort structured error for a legacy error message (routes never throw). */
function errorInfoForMessage(message) {
    const trimmed = message.trim();
    if (KNOWN_ERROR_CODES.has(trimmed))
        return errorInfoOf(trimmed);
    const lower = trimmed.toLowerCase();
    if (lower.includes('already running'))
        return errorInfoOf('content-build-running', message);
    if (lower.includes('outside the indexed roots'))
        return errorInfoOf('content-path-denied', message);
    if (lower.includes('does not exist'))
        return errorInfoOf('invalid-arguments', message, { hint: 'Check the path; locator_status lists the indexed roots.' });
    if (lower.includes('aborted'))
        return errorInfoOf('request-aborted', message);
    return errorInfoOf('request-failed', message);
}
/** Attach errorInfo to any route value that reports ok:false. */
function withErrorInfo(value) {
    if (value.ok === false && typeof value.error === 'string' && value.errorInfo === undefined) {
        return { ...value, errorInfo: errorInfoForMessage(value.error) };
    }
    return value;
}
/**
 * The /dsh-locator/search route: POST keeps the panel's JSON-body contract,
 * GET serves the public query API (?q=&limit=&mode=&json=1). Both run behind
 * the same connection trust fence, the same auth policy and the same local
 * same-origin markers; only the body carrier differs.
 */
function searchHandler(scoped, rt, content, ensure, connectionOptional, scope) {
    return async (req, res, peer) => {
        const rejection = trustRejection(scoped, req, connectionOptional, peer);
        if (rejection !== undefined) {
            res.statusCode = rejection;
            res.end();
            return;
        }
        if (req.method === 'GET') {
            let body;
            try {
                body = searchQueryOf(req);
            }
            catch (error) {
                const status = error instanceof HttpError ? error.status : 400;
                sendFailure(res, status, status === 400 ? 'invalid-arguments' : wireErrorCode(status), messageOf(error));
                return;
            }
            try {
                const value = await search(rt, content, ensure, scope, body, res);
                sendJson(res, 200, withErrorInfo({ ok: true, ...asRecord(value) }));
            }
            catch (error) {
                const code = isAbortError(error) ? 'request-aborted' : 'request-failed';
                sendFailure(res, 200, code, isAbortError(error) ? 'request-aborted' : messageOf(error));
            }
            return;
        }
        if (req.method !== 'POST') {
            res.setHeader('allow', 'GET, POST');
            sendFailure(res, 405, 'method-not-allowed', 'method not allowed (use GET or POST)');
            return;
        }
        if (!isJsonContentType(req.headers['content-type'])) {
            sendFailure(res, 415, 'unsupported-media-type', 'content-type must be application/json');
            return;
        }
        let body;
        try {
            body = await readJson(req, BODY_LIMIT);
        }
        catch (error) {
            const status = error instanceof HttpError ? error.status : 400;
            sendFailure(res, status, wireErrorCode(status), messageOf(error));
            return;
        }
        try {
            const value = await search(rt, content, ensure, scope, body, res);
            sendJson(res, 200, withErrorInfo({ ok: true, ...asRecord(value) }));
        }
        catch (error) {
            const code = isAbortError(error) ? 'request-aborted' : 'request-failed';
            sendFailure(res, 200, code, isAbortError(error) ? 'request-aborted' : messageOf(error));
        }
    };
}
/** Sort keys the search route accepts. */
const SORT_KEYS = new Set(['name', 'path', 'size', 'mtime', 'ext']);
/** Search modes the route accepts. */
const SEARCH_MODES = new Set(['names', 'content', 'count']);
/** Scope values the route accepts. */
const SCOPE_VALUES = new Set(['workspace', 'all']);
/** Count modes the content search accepts. */
const COUNT_MODES = new Set(['exact', 'bounded', 'none']);
/** Match modes the content search accepts. */
const MATCH_MODES = new Set(['normal', 'extended']);
/**
 * Translate a GET query string into the same body shape POST accepts.
 *
 * Public API validation is strict and explicit: a malformed known parameter
 * answers 400 instead of being silently ignored, so a script cannot believe it
 * limited results while nothing was limited.
 * @param req - the incoming GET request.
 * @returns the parsed search body.
 */
function searchQueryOf(req) {
    const raw = typeof req.url === 'string' && req.url !== '' ? req.url : '/';
    let url;
    try {
        url = new URL(raw, 'http://locator.invalid');
    }
    catch {
        throw new HttpError(400, 'invalid request URL');
    }
    const body = {};
    const query = url.searchParams.get('q') ?? url.searchParams.get('query');
    if (query !== null)
        body.query = query;
    const sort = url.searchParams.get('sort');
    if (sort !== null && sort !== '') {
        if (!SORT_KEYS.has(sort))
            throw new HttpError(400, 'invalid sort parameter');
        body.sort = sort;
    }
    const mode = url.searchParams.get('mode');
    if (mode !== null && mode !== '') {
        if (!SEARCH_MODES.has(mode))
            throw new HttpError(400, 'invalid mode parameter');
        body.mode = mode;
    }
    const scopeValue = url.searchParams.get('scope');
    if (scopeValue !== null && scopeValue !== '') {
        if (!SCOPE_VALUES.has(scopeValue))
            throw new HttpError(400, 'invalid scope parameter');
        body.scope = scopeValue;
    }
    const count = url.searchParams.get('count');
    if (count !== null && count !== '') {
        if (!COUNT_MODES.has(count))
            throw new HttpError(400, 'invalid count parameter');
        body.count = count;
    }
    const matchMode = url.searchParams.get('matchMode');
    if (matchMode !== null && matchMode !== '') {
        if (!MATCH_MODES.has(matchMode))
            throw new HttpError(400, 'invalid matchMode parameter');
        body.matchMode = matchMode;
    }
    const detail = url.searchParams.get('detail');
    if (detail !== null && detail !== '') {
        if (detail !== 'full' && detail !== 'compact')
            throw new HttpError(400, 'invalid detail parameter');
        body.detail = detail;
    }
    for (const name of ['sessionId', 'pathPrefix']) {
        const value = url.searchParams.get(name);
        if (value !== null && value !== '')
            body[name] = value;
    }
    for (const name of ['limit', 'headLimit', 'offset', 'contextLines', 'countLimit', 'evidenceLimit']) {
        const value = url.searchParams.get(name);
        if (value === null || value === '')
            continue;
        if (!/^-?\d+$/.test(value))
            throw new HttpError(400, 'invalid ' + name + ' parameter');
        body[name] = Number(value);
    }
    for (const name of ['desc', 'regex', 'caseSensitive', 'wholeWord', 'filesOnly', 'dirsOnly']) {
        const value = url.searchParams.get(name);
        if (value === null || value === '')
            continue;
        if (value === '1' || value === 'true')
            body[name] = true;
        else if (value === '0' || value === 'false')
            body[name] = false;
        else
            throw new HttpError(400, 'invalid ' + name + ' parameter');
    }
    // json=1 is accepted for compatibility with the documented curl examples;
    // every response of this route is already application/json.
    return body;
}
/** The connection trust fence, fail-closed.
 *
 * Host 0.2.x authenticates the route before dispatch and passes the admitted
 * Peer; that admission is trusted directly. On hosts that dispatch without a
 * Peer, a missing/inactive `connection` service, a throwing check, or a numeric
 * rejection all refuse the request, and the local same-origin markers are
 * checked again, so a future trust-policy regression here cannot silently
 * expose a route to another site.
 * @returns an HTTP status to reject with, or undefined to proceed.
 */
function trustRejection(scoped, req, connectionOptional = false, peer) {
    // DSH 0.2.x authenticates the route before dispatch and hands the admitted
    // Peer to the handler. The host already applied its Host/Origin policy and
    // credential verifiers, so trust that admission but keep the local same-origin
    // markers as defense in depth. This path also covers hosts whose `connection`
    // service is not resolvable from a hot-reloaded plugin scope (observed on DSH
    // 0.2.2 builds where the service exists but the scoped get() fails).
    if (peer !== undefined && peer !== null)
        return originRejection(req.headers);
    const connection = activeConnection(scoped);
    if (connection === undefined) {
        // Explicit opt-in for hosts whose connection service is absent/not active.
        // The host has already authenticated the request; still enforce same-origin
        // Fetch metadata so a cross-site page cannot drive the local API.
        return connectionOptional ? originRejection(req.headers) : 503;
    }
    try {
        if (typeof connection.requestRejection === 'function') {
            const rejection = connection.requestRejection({ headers: req.headers });
            if (typeof rejection === 'number')
                return rejection;
            return originRejection(req.headers);
        }
        // Host 0.2.2+ trust fence: admit() applies the Host/Origin policy and the
        // registered credential verifiers. A peer means the request is authenticated;
        // a numeric rejection is passed through; anything else fails closed.
        const admission = connection.admit?.({ headers: req.headers });
        if (admission === undefined)
            return 503;
        if (typeof admission.rejection === 'number')
            return admission.rejection;
        if (admission.peer === undefined || admission.peer === null)
            return 503;
        return originRejection(req.headers);
    }
    catch {
        return 503;
    }
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
    const candidate = value;
    if (typeof candidate.requestRejection !== 'function' && typeof candidate.admit !== 'function')
        return undefined;
    return candidate;
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
/**
 * Abort signal tied to the response lifecycle.
 *
 * Node emits `close` on the response both on a normal finish and on a client
 * disconnect, so only an unfinished response means "the caller went away".
 * `req.on('close')` is deliberately not used: Node also emits it when a normal
 * request has been fully read, which would cancel every POST mid-query.
 * @param res - the response being written.
 * @returns the request-scoped signal and a disposer.
 */
function abortOnDisconnect(res) {
    const controller = new AbortController();
    const target = res;
    const onClose = () => {
        if (target.writableFinished === true)
            return;
        if (!controller.signal.aborted)
            controller.abort();
    };
    if (typeof target.on !== 'function')
        return { signal: controller.signal, dispose: () => { } };
    try {
        target.on.call(res, 'close', onClose);
    }
    catch {
        return { signal: controller.signal, dispose: () => { } };
    }
    return {
        signal: controller.signal,
        dispose: () => {
            const off = typeof target.off === 'function'
                ? target.off
                : typeof target.removeListener === 'function'
                    ? target.removeListener
                    : undefined;
            if (off === undefined)
                return;
            try {
                off.call(res, 'close', onClose);
            }
            catch { /* the response is already gone */ }
        },
    };
}
/**
 * Wrap one content store so every `search` call carries an AbortSignal.
 *
 * The `ContentIndex.search` signature stays positional (find.ts and the tools
 * call it that way); cancellation travels inside the options object, which the
 * content layer reads. Every other method is bound to the real store so a class
 * using private fields keeps working through the proxy.
 * @param content - the real content store.
 * @param signal - request-scoped abort signal.
 * @returns a store view whose searches are cancellable.
 */
function withAbortSignal(content, signal) {
    const store = content;
    return new Proxy(content, {
        get(object, key) {
            if (key === 'search') {
                return (query, limit, options) => 
                // ContentSearchOptions.signal is declared by content-search.ts; the
                // content layer cancels the worker (or checks at entry) and rejects
                // with a DOMException named AbortError.
                store.search.call(content, query, limit, { ...(options ?? {}), signal });
            }
            const value = Reflect.get(object, key);
            return typeof value === 'function' ? value.bind(content) : value;
        },
    });
}
/** Engine status through the runtime's 1 s stats cache when it provides one. */
async function cachedEngineStatus(rt) {
    const candidate = rt.engineStatusCached;
    if (typeof candidate === 'function')
        return await candidate.call(rt, 1_000);
    return await rt.engineStatus();
}
/**
 * One search call for both carriers. The result stays additive: the historical
 * total/returned/offset/truncated/tookMs/hits fields are unchanged, and mode,
 * totalCount, nextOffset and budget are added for paging.
 */
async function search(rt, content, ensure, scopeRules, raw, res) {
    const body = raw;
    const mode = body.mode === 'content' || body.mode === 'count' ? body.mode : 'names';
    const limit = pageSize(typeof body.limit === 'number' ? body.limit : undefined, typeof body.headLimit === 'number' ? body.headLimit : undefined, rt.config.maxResults, 10);
    const offset = clampNumber(body.offset, 0, 100_000, 0);
    const scope = body.scope === 'all' ? 'all' : 'workspace';
    const query = typeof body.query === 'string' ? body.query : '';
    const budgetChars = rt.config.outputBudgetChars ?? DEFAULT_OUTPUT_BUDGET_CHARS;
    const detail = body.detail === 'compact' ? 'compact' : 'full';
    const evidenceLimit = evidenceLimitOf(detail, typeof body.evidenceLimit === 'number' ? body.evidenceLimit : undefined);
    if (mode === 'content' || mode === 'count') {
        if (content === undefined)
            return { ok: false, mode, query, error: 'content-index-unavailable' };
        ensure?.();
        const contextLines = clampNumber(body.contextLines, 0, 10, 0);
        const request = {
            query,
            limit: mode === 'count' ? 1 : limit,
            offset: mode === 'count' ? 0 : offset,
            scope,
            detail,
            evidenceLimit,
            // The HTTP API has no per-session caller identity, so session documents
            // are never exposed here: file bodies only, over every indexed root.
            filesOnly: true,
            ...(body.caseSensitive === true ? { caseSensitive: true } : {}),
            ...(body.wholeWord === true ? { wholeWord: true } : {}),
            ...(mode === 'count' ? { count: 'exact' } : {}),
            ...(typeof body.matchMode === 'string' && MATCH_MODES.has(body.matchMode) ? { matchMode: body.matchMode } : {}),
            ...(typeof body.sessionId === 'string' && body.sessionId !== '' ? { sessionId: body.sessionId } : {}),
            ...(typeof body.pathPrefix === 'string' && body.pathPrefix !== '' ? { pathPrefix: body.pathPrefix } : {}),
        };
        const caller = {};
        // Propagate a client disconnect into the content store: the query runs in a
        // worker, and without a signal a hung-up GET would still burn a full scan.
        const controller = abortOnDisconnect(res);
        const started = Date.now();
        let result;
        try {
            result = await runContentSearchRequest(withAbortSignal(content, controller.signal), request, rt.roots, false, caller, contentScopeOptionsOf(rt));
        }
        finally {
            controller.dispose();
        }
        const tookMs = Date.now() - started;
        if (!result.ok)
            return { ok: false, mode, query, error: result.error, warnings: result.warnings };
        const countKnown = result.count.kind === 'unknown' ? undefined : result.count.value;
        if (mode === 'count') {
            return {
                ok: true,
                mode,
                query,
                ...(countKnown === undefined ? {} : { total: countKnown, totalCount: countKnown }),
                contentCount: result.count,
                count: result.count,
                hits: [],
                truncated: result.count.kind === 'bounded',
                hasMore: false,
                consumed: 0,
                tookMs,
            };
        }
        const keepVisible = (hit) => scopeRules === undefined ? true : scopeRules.contentVisible(hit.path);
        // Select the raw page (scope + limit) first, then add context and trim to the
        // budget once, so nextOffset stays aligned with returned rows.
        const selected = selectPage(result.hits, limit, 0, keepVisible);
        let items = selected.items;
        let keptIndices = [...selected.keptIndices];
        const dropped = [...selected.dropped];
        if (contextLines > 0) {
            items = await Promise.all(items.map(async (hit) => {
                if (hit.kind !== 'file' || hit.line === undefined)
                    return hit;
                const context = await readContextLines(hit.path, hit.line, contextLines);
                return context === undefined ? hit : { ...hit, context: context.lines, contextStart: context.start };
            }));
        }
        const budgeted = applyOutputBudget(items, budgetChars);
        for (let index = budgeted.items.length; index < keptIndices.length; index++) {
            dropped.push({ index: keptIndices[index], reason: 'budget' });
        }
        keptIndices = keptIndices.slice(0, budgeted.items.length);
        // selectPage works on page-relative positions; the cursor math is in
        // absolute store offsets.
        const advance = pageAdvance({
            offset,
            fetchedRows: result.hits.length,
            keptIndices: keptIndices.map(index => offset + index),
            dropped: dropped.map(drop => ({ index: offset + drop.index, reason: drop.reason })),
            more: result.hits.length >= limit || selected.unscanned > 0,
        });
        return {
            ok: true,
            mode,
            query,
            ...(countKnown === undefined ? {} : { total: countKnown, totalCount: countKnown }),
            returned: budgeted.items.length,
            offset,
            truncated: advance.truncated,
            hasMore: advance.hasMore,
            consumed: advance.consumed,
            ...(advance.nextOffset === undefined ? {} : { nextOffset: advance.nextOffset }),
            ...(advance.truncation === undefined ? {} : { truncation: advance.truncation }),
            tookMs,
            hits: budgeted.items,
            budget: budgeted.budget,
            count: result.count,
            contentCount: result.count,
            state: result.state,
            warnings: result.warnings,
            ...(detail === 'compact' ? { detail } : {}),
        };
    }
    const sort = sortKey(body.sort);
    const args = {
        query,
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
    const observedAt = Date.now();
    // Map the whole store page before selecting: the evidence fields are part of
    // the payload the budget measures, and the final slice must happen after them.
    const mapped = result.hits.map((hit, index) => {
        const readable = scopeRules?.readability(hit.path) ?? { read: 'allowed', reason: 'name hits come from the configured index roots' };
        const base = {
            path: hit.path,
            name: hit.name,
            size: hit.size,
            mtime: hit.mtime,
            ext: hit.ext,
            dir: hit.dir,
            ...(hit.dir || readable.read !== 'allowed' ? {} : { ref: fileRefFor(hit.path, hit.mtime, hit.size) }),
        };
        if (!evidenceVisible(index, detail, evidenceLimit))
            return base;
        return {
            ...base,
            modified: new Date(hit.mtime).toISOString(),
            refStatus: 'unknown',
            freshness: { state: 'unknown', observedAt, mtime: hit.mtime },
            permissions: { read: readable.read, visibility: 'roots', reason: readable.reason },
        };
    });
    const selected = selectPage(mapped, limit, budgetChars, hit => scopeRules === undefined ? true : scopeRules.isSearchable(hit.path));
    const advance = pageAdvance({
        offset: result.offset,
        fetchedRows: result.hits.length,
        keptIndices: selected.keptIndices.map(index => result.offset + index),
        dropped: selected.dropped.map(drop => ({ index: result.offset + drop.index, reason: drop.reason })),
        more: result.truncated || selected.unscanned > 0,
    });
    return {
        mode: 'names',
        query,
        total: result.total,
        totalCount: result.total,
        returned: selected.items.length,
        offset: result.offset,
        truncated: advance.truncated,
        hasMore: advance.hasMore,
        consumed: advance.consumed,
        ...(advance.nextOffset === undefined ? {} : { nextOffset: advance.nextOffset }),
        ...(advance.truncation === undefined ? {} : { truncation: advance.truncation }),
        indexing: result.indexing === true,
        tookMs: result.tookNs / 1e6,
        hits: selected.items,
        budget: selected.budget,
        ...(detail === 'compact' ? { detail } : {}),
    };
}
/** Path/mtime/size identity ref used by the HTTP name-hit rows. */
function fileRefFor(path, mtime, size) {
    return fileRef({ path, mtime, size });
}
/**
 * One panel search across all enabled scopes. The stores are injected so the
 * orchestration (scope gating, lazy-build guard, de-duplication) stays testable
 * without an HTTP request or an engine process.
 */
async function combined(rt, content, ensure, raw, res, options = {}) {
    rt.start();
    const controller = abortOnDisconnect(res);
    try {
        // 0.20.2: one chunked mtime query covers every file hit of a page; a content
        // store without the batch method keeps the per-hit SQL (older embedders and
        // hand-built test stores).
        const batchMtimes = content !== undefined && typeof content.mtimesForPaths === 'function'
            ? content.mtimesForPaths.bind(content)
            : undefined;
        const deps = {
            search: async (args) => await rt.search(args),
            maxResults: rt.config.maxResults,
            roots: rt.roots,
            ...(content === undefined ? {} : {
                contentSearch: async (query, limit, searchOptions) => await content.search(query, limit, searchOptions),
                contentStatus: () => content.status(),
                contentIndexedMtime: (hit) => content.indexedMtime(hit.kind, hit.path, hit.messageId),
                ...(batchMtimes === undefined
                    ? {}
                    : { contentIndexedMtimes: (paths) => batchMtimes(paths) }),
                ...(ensure === undefined ? {} : { ensure }),
            }),
        };
        const request = readCombinedRequest(raw, rt.config.maxResults);
        if (request.rootPrefix !== null) {
            const resolved = resolveWithinRoots(request.rootPrefix, rt.roots);
            request.rootPrefix = resolved === undefined ? null : resolved.path;
        }
        const result = await runCombinedSearch(deps, request, {
            ...(options.combinedBudgetChars === undefined ? {} : { budgetChars: options.combinedBudgetChars }),
            ...(options.combinedEnrichConcurrency === undefined ? {} : { enrichConcurrency: options.combinedEnrichConcurrency }),
            ...(options.combinedHashMaxHits === undefined ? {} : { hashMaxHits: options.combinedHashMaxHits }),
            ...(options.combinedCacheTtlMs === undefined ? {} : { cacheTtlMs: options.combinedCacheTtlMs }),
            // The plugin turns the bounded 2-character fallback on from config; the
            // panel's short-query phase then gets real hits instead of a guard error.
            shortQueryFallback: rt.config.contentShortQueryFallback !== false,
            signal: controller.signal,
        });
        return {
            query: request.query,
            rootPrefix: request.rootPrefix,
            matchMode: request.matchMode,
            caseSensitive: request.caseSensitive,
            wholeWord: request.wholeWord,
            sessionId: request.sessionId,
            ...result,
        };
    }
    finally {
        controller.dispose();
    }
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
    // Last TOCTOU window: open the final component without following a symlink and
    // compare the inode with the stat we just authorized. Keep the fd open until
    // the opener has spawned; the path is still resolved by the platform opener,
    // but a symlink swapped in after this point can no longer be authorized here.
    let fd;
    try {
        const noFollow = constants.O_NOFOLLOW ?? 0;
        fd = openSync(final.path, constants.O_RDONLY | noFollow);
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.ino !== finalInfo.ino || opened.dev !== finalInfo.dev) {
            return { ok: false, error: 'path changed while opening' };
        }
        const openedRefusal = executableFileRejection(final.path, opened.mode);
        if (openedRefusal !== undefined)
            return { ok: false, error: openedRefusal };
        const line = parseLineNumber(raw.line);
        if (line === null) {
            await openWithDefaultApp(final.path);
            return { ok: true, line: false };
        }
        const mode = await openAtLine(final.path, line);
        return { ok: true, line: mode === 'line' };
    }
    catch (error) {
        return { ok: false, error: messageOf(error) };
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
/**
 * Read-only 0.20.0 content diagnostics (coverage/db bytes/refresh mode) as an
 * optional nested block. The call is O(1) and must never fail the status route.
 * @param content - the content store.
 * @returns `{ diagnostics }` or an empty object.
 */
export function contentDiagnostics(content) {
    const candidate = content.diagnostics;
    if (typeof candidate !== 'function')
        return {};
    try {
        const value = candidate.call(content);
        return typeof value === 'object' && value !== null && !Array.isArray(value) ? { diagnostics: value } : {};
    }
    catch {
        return {};
    }
}
async function status(rt, content, scope) {
    rt.start();
    // Served from the pushed stats cache for up to 1 s (0.20.0 P0-12).
    const engine = await cachedEngineStatus(rt);
    const contentState = content === undefined ? { enabled: false } : { enabled: true, ...content.status(), ...contentDiagnostics(content) };
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
        ...(engine?.incrementalRefresh === undefined ? {} : { incrementalRefresh: engine.incrementalRefresh }),
        ...(engine?.watchUnwatchedRoots === undefined ? {} : { watchUnwatchedRoots: engine.watchUnwatchedRoots }),
        ...(engine?.refreshMode === undefined ? {} : { refreshMode: engine.refreshMode }),
        ...(engine?.refreshReason === undefined ? {} : { refreshReason: engine.refreshReason }),
        ...(engine?.refreshScannedRoots === undefined ? {} : { refreshScannedRoots: engine.refreshScannedRoots }),
        ...(engine?.refreshSkippedRoots === undefined ? {} : { refreshSkippedRoots: engine.refreshSkippedRoots }),
        ...(engine?.refreshEntries === undefined ? {} : { refreshEntries: engine.refreshEntries }),
        ...(engine?.refreshTookMs === undefined ? {} : { refreshTookMs: engine.refreshTookMs }),
        ...(engine?.refreshAt === undefined ? {} : { refreshAt: engine.refreshAt }),
        usn: engine?.usn ?? false,
        scanning: engine?.scanning === true || rt.status.scanning !== undefined,
        stateDir: engine?.stateDir ?? rt.stateDir,
        version: engine?.version ?? '',
        ...engineResourceFields(engine),
        content: contentState,
        scope: {
            ...(scope?.describe() ?? { notSearchable: [], notReadable: [], notIndexed: [], activeRules: 0 }),
            outputBudgetChars: rt.config.outputBudgetChars ?? DEFAULT_OUTPUT_BUDGET_CHARS,
        },
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