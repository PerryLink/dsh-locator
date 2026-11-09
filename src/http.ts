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

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LocatorRuntime, SearchArgs } from './runtime.ts'
import { revealInFileManager, withinRoots } from './reveal.ts'
import { statSync } from 'node:fs'

interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

interface ConnectionLike {
  requestRejection(req: IncomingMessage): number | undefined
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

/** Mount the panel's routes when this profile runs a Web server. */
export function registerHttp(ctx: Context, rt: LocatorRuntime): void {
  const inject = (ctx as unknown as {
    inject?: (deps: string[], callback: (scoped: Context) => void) => void
  }).inject
  if (typeof inject !== 'function') return
  inject.call(ctx, ['webServer'], (scoped: Context) => {
    const server = (scoped as unknown as { webServer?: WebServerLike }).webServer
    if (server === undefined) return
    scoped.effect(() => server.register({
      kind: 'exact',
      path: '/dsh-locator/search',
      handler: handler(scoped, async body => await search(rt, body)),
    }))
    scoped.effect(() => server.register({
      kind: 'exact',
      path: '/dsh-locator/status',
      handler: handler(scoped, async () => await status(rt)),
    }))
    scoped.effect(() => server.register({
      kind: 'exact',
      path: '/dsh-locator/reveal',
      handler: handler(scoped, async body => await reveal(rt, body)),
    }))
  })
}

function handler(
  scoped: Context,
  run: (body: Record<string, unknown>) => Promise<unknown>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const rejection = rejectionStatus(scoped, req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'POST only' })
      return
    }
    try {
      const body = await readJson(req, BODY_LIMIT)
      const value = await run(body)
      sendJson(res, 200, { ok: true, ...asRecord(value) })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: messageOf(error) })
    }
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

async function reveal(rt: LocatorRuntime, raw: Record<string, unknown>): Promise<unknown> {
  const path = typeof raw.path === 'string' ? raw.path : ''
  if (path === '' || !withinRoots(path, rt.roots)) {
    return { ok: false, error: 'path is outside the indexed roots' }
  }
  try {
    const info = statSync(path)
    if (!info.isFile() && !info.isDirectory()) return { ok: false, error: 'not a file or directory' }
  } catch {
    return { ok: false, error: 'path does not exist' }
  }
  try {
    await revealInFileManager(path)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

async function status(rt: LocatorRuntime): Promise<unknown> {
  rt.start()
  const engine = await rt.engineStatus()
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
  }
}

function rejectionStatus(scoped: Context, req: IncomingMessage): number | undefined {
  const connection = (scoped as unknown as { get?: (name: string) => unknown }).get?.('connection') as ConnectionLike | undefined
  if (connection === undefined || typeof connection.requestRejection !== 'function') return undefined
  const rejection = connection.requestRejection(req)
  return typeof rejection === 'number' ? rejection : undefined
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > limit) throw new Error(`request body exceeds ${String(limit)} bytes`)
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('request body must be an object')
  return value as Record<string, unknown>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  const text = JSON.stringify(body)
  res.statusCode = status
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
