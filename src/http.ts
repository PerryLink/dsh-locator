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

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { LocatorRuntime, SearchArgs } from './runtime.ts'
import type { ContentIndex } from './content.ts'
import type { ContentSearchOptions } from './content-search.ts'
import { readCombinedRequest, runCombinedSearch, type CombinedDeps } from './combined.ts'
import {
  executableFileRejection,
  openWithDefaultApp,
  resolveWithinRoots,
  revealInFileManager,
} from './reveal.ts'
import { statSync } from 'node:fs'

interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The host `connection` service slice consumed here (typed locally: the package is browser-side). */
interface ConnectionLike {
  requestRejection(req: { readonly headers: IncomingMessage['headers'] }): number | undefined
}

interface SearchBody {
  query?: unknown
  limit?: unknown
  offset?: unknown
  sort?: unknown
  desc?: unknown
  regex?: unknown
  caseSensitive?: unknown
  wholeWord?: unknown
  filesOnly?: unknown
  dirsOnly?: unknown
}

const BODY_LIMIT = 64 * 1024

/** A wire-format failure that must answer with a real HTTP status. */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'HttpError'
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
export function registerHttp(ctx: Context, rt: LocatorRuntime, content?: ContentIndex, ensure?: () => void): void {
  const inject = (ctx as unknown as {
    inject?: (deps: string[], callback: (scoped: Context) => void) => unknown
  }).inject
  if (typeof inject !== 'function') return
  inject.call(ctx, ['webServer', 'connection'], (scoped: Context) => {
    const server = webServerOf(scoped)
    if (server === undefined) return
    // Hard dependency: no trust fence, no routes (fail closed, never "allow").
    if (activeConnection(scoped) === undefined) return
    const route = (
      path: string,
      run: (body: Record<string, unknown>) => Promise<unknown>,
    ): void => {
      scoped.effect(() => server.register({ kind: 'exact', path, handler: handler(scoped, run) }))
    }
    route('/dsh-locator/search', async body => await search(rt, body))
    route('/dsh-locator/status', async () => await status(rt, content))
    route('/dsh-locator/reveal', async body => await reveal(rt, body))
    route('/dsh-locator/combined', async body => await combined(rt, content, ensure, body))
    if (content !== undefined) {
      route('/dsh-locator/content/rebuild', async body => {
        ensure?.()
        const full = body.full === true
        const started = full ? content.rebuild() : content.refreshNow()
        return started ? { ok: true, started: true, full } : { ok: false, error: 'a content build is already running' }
      })
      route('/dsh-locator/content', async body => {
        ensure?.()
        const query = typeof body.query === 'string' ? body.query : ''
        const limit = typeof body.limit === 'number' ? body.limit : 30
        return { ok: true, query, hits: await content.search(query, limit), state: content.status() }
      })
    }
    route('/dsh-locator/open', async body => await openPath(rt, body))
  })
}

/**
 * Wrap one route body. The order is the security order: trust fence first,
 * then method, then media type, then the bounded JSON body.
 */
function handler(
  scoped: Context,
  run: (body: Record<string, unknown>) => Promise<unknown>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const rejection = trustRejection(scoped, req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }
    if (!isJsonContentType(req.headers['content-type'])) {
      sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJson(req, BODY_LIMIT)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400
      sendJson(res, status, { ok: false, error: messageOf(error) })
      return
    }
    try {
      const value = await run(body)
      sendJson(res, 200, { ok: true, ...asRecord(value) })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: messageOf(error) })
    }
  }
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
function trustRejection(scoped: Context, req: IncomingMessage): number | undefined {
  const connection = activeConnection(scoped)
  if (connection === undefined) return 503
  let rejection: number | undefined
  try {
    rejection = connection.requestRejection(req)
  } catch {
    return 503
  }
  if (typeof rejection === 'number') return rejection
  return originRejection(req.headers)
}

/** Read the active connection implementation; inactive/missing/throwing all mean "unavailable". */
function activeConnection(scoped: Context): ConnectionLike | undefined {
  let value: unknown
  try {
    const get = (scoped as unknown as { get?: (name: string, strict?: boolean) => unknown }).get
    value = typeof get === 'function'
      ? get.call(scoped, 'connection', true)
      : Reflect.get(scoped as object, 'connection')
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const requestRejection = (value as { requestRejection?: unknown }).requestRejection
  if (typeof requestRejection !== 'function') return undefined
  return value as ConnectionLike
}

function webServerOf(scoped: Context): WebServerLike | undefined {
  let value: unknown
  try {
    const get = (scoped as unknown as { get?: (name: string, strict?: boolean) => unknown }).get
    value = typeof get === 'function'
      ? get.call(scoped, 'webServer', true)
      : Reflect.get(scoped as object, 'webServer')
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const register = (value as { register?: unknown }).register
  return typeof register === 'function' ? value as WebServerLike : undefined
}

/** First value of a Node header that may arrive repeated. */
function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name]
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    const first = raw[0]
    return typeof first === 'string' ? first : undefined
  }
  return undefined
}

/**
 * The exact JSON media type required by every locator route. A charset or any
 * other parameter is tolerated (`application/json; charset=utf-8`), any other
 * essence (including `text/plain` and a missing header) is not.
 * @param value - the raw `content-type` header value.
 */
export function isJsonContentType(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return false
  const essence = raw.split(';', 1)[0]?.trim().toLowerCase()
  return essence === 'application/json'
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
export function originRejection(headers: IncomingHttpHeaders): 403 | undefined {
  const site = headerValue(headers, 'sec-fetch-site')
  if (site !== undefined && site.toLowerCase() === 'cross-site') return 403
  const origin = headerValue(headers, 'origin')
  if (origin === undefined || origin === '') return undefined
  const host = headerValue(headers, 'host')
  // An Origin without a Host cannot be compared; a local request always has one.
  if (host === undefined || host === '') return 403
  try {
    const originUrl = new URL(origin)
    const scheme = originUrl.protocol === 'https:'
      ? 'https:'
      : originUrl.protocol === 'http:'
        ? 'http:'
        : undefined
    // Opaque origins (`Origin: null`, sandboxed frames, file: pages) and every
    // non-HTTP scheme have no authority this listener can be serving.
    if (scheme === undefined) return 403
    const hostUrl = new URL(`${scheme}//${host}`)
    return originUrl.host === hostUrl.host ? undefined : 403
  } catch {
    return 403
  }
}

async function search(rt: LocatorRuntime, raw: Record<string, unknown>): Promise<unknown> {
  const body = raw as SearchBody
  const limit = clampNumber(body.limit, 1, rt.config.maxResults, 100)
  const offset = clampNumber(body.offset, 0, 100_000, 0)
  const sort = sortKey(body.sort)
  const args: SearchArgs = {
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
  }
  rt.start()
  const result = await rt.search(args)
  return {
    total: result.total,
    returned: result.returned,
    offset: result.offset,
    truncated: result.truncated,
    tookMs: result.tookNs / 1e6,
    hits: result.hits,
  }
}

/**
 * One panel search across all enabled scopes. The stores are injected so the
 * orchestration (scope gating, lazy-build guard, de-duplication) stays testable
 * without an HTTP request or an engine process.
 */
async function combined(
  rt: LocatorRuntime,
  content: ContentIndex | undefined,
  ensure: (() => void) | undefined,
  raw: Record<string, unknown>,
): Promise<unknown> {
  rt.start()
  const deps: CombinedDeps = {
    search: async args => await rt.search(args),
    maxResults: rt.config.maxResults,
    ...(content === undefined ? {} : {
      contentSearch: async (query: string, limit: number, options: ContentSearchOptions) =>
        await content.search(query, limit, options),
      contentStatus: () => content.status(),
      ...(ensure === undefined ? {} : { ensure }),
    }),
  }
  const request = readCombinedRequest(raw, rt.config.maxResults)
  const result = await runCombinedSearch(deps, request)
  return {
    query: request.query,
    matchMode: request.matchMode,
    caseSensitive: request.caseSensitive,
    wholeWord: request.wholeWord,
    sessionId: request.sessionId,
    ...result,
  }
}

/**
 * Reveal one path in the platform file manager. The path is authorized and
 * canonicalized first, so the file manager is pointed at the real file inside
 * a root, never at a symlink that leaves it.
 */
async function reveal(rt: LocatorRuntime, raw: Record<string, unknown>): Promise<unknown> {
  const requested = typeof raw.path === 'string' ? raw.path : ''
  const resolved = requested === '' ? undefined : resolveWithinRoots(requested, rt.roots)
  if (resolved === undefined) return { ok: false, error: 'path is outside the indexed roots' }
  let info
  try {
    info = statSync(resolved.path)
  } catch {
    return { ok: false, error: 'path does not exist' }
  }
  if (!info.isFile() && !info.isDirectory()) return { ok: false, error: 'not a file or directory' }
  // TOCTOU best effort: re-canonicalize immediately before handing the path to
  // another process. This closes the window between authorization and spawn,
  // though the platform opener still resolves the path itself.
  const final = resolveWithinRoots(resolved.path, rt.roots)
  if (final === undefined) return { ok: false, error: 'path is outside the indexed roots' }
  try {
    await revealInFileManager(final.path)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * Open one path with the platform's default application: canonicalized inside
 * the roots, still a regular file, and never an executable or script type.
 */
async function openPath(rt: LocatorRuntime, raw: Record<string, unknown>): Promise<unknown> {
  const requested = typeof raw.path === 'string' ? raw.path : ''
  const resolved = requested === '' ? undefined : resolveWithinRoots(requested, rt.roots)
  if (resolved === undefined) return { ok: false, error: 'path is outside the indexed roots' }
  let info
  try {
    info = statSync(resolved.path)
  } catch {
    return { ok: false, error: 'path does not exist' }
  }
  if (!info.isFile()) return { ok: false, error: 'not a file' }
  const refusal = executableFileRejection(resolved.path, info.mode)
  if (refusal !== undefined) return { ok: false, error: refusal }
  // TOCTOU best effort: re-canonicalize and re-check the executable guard on
  // the path that is actually handed to the opener.
  const final = resolveWithinRoots(resolved.path, rt.roots)
  if (final === undefined) return { ok: false, error: 'path is outside the indexed roots' }
  let finalInfo
  try {
    finalInfo = statSync(final.path)
  } catch {
    return { ok: false, error: 'path does not exist' }
  }
  if (!finalInfo.isFile()) return { ok: false, error: 'not a file' }
  const finalRefusal = executableFileRejection(final.path, finalInfo.mode)
  if (finalRefusal !== undefined) return { ok: false, error: finalRefusal }
  try {
    await openWithDefaultApp(final.path)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

async function status(rt: LocatorRuntime, content?: ContentIndex): Promise<unknown> {
  rt.start()
  const engine = await rt.engineStatus()
  const contentState = content === undefined ? { enabled: false } : { enabled: true, ...content.status() }
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
  }
}

/**
 * Collect a bounded JSON object body. Oversize bodies answer 413, malformed
 * JSON or a non-object value answers 400.
 */
async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > limit) {
      tooLarge = true
      continue
    }
    chunks.push(buffer)
  }
  if (tooLarge) throw new HttpError(413, `request body exceeds ${String(limit)} bytes`)
  if (size === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'request body must be valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'request body must be an object')
  }
  return value as Record<string, unknown>
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.writableEnded) return
  const text = JSON.stringify(body)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function sortKey(value: unknown): string {
  return value === 'name' || value === 'path' || value === 'size' || value === 'mtime' || value === 'ext' ? value : 'mtime'
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
