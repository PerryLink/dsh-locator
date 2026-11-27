/**
 * HTTP surface security: fail-closed registration, the connection trust fence,
 * wire-format validation (POST + application/json), and the local same-origin
 * checks. The handlers are exercised through a fake WebServer and fake
 * IncomingMessage/ServerResponse objects, so no listener is opened and no
 * platform opener is spawned.
 */

import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isJsonContentType, originRejection, registerHttp } from '../src/http.ts'
import type { LocatorRuntime } from '../src/runtime.ts'
import type { ContentIndex } from '../src/content.ts'
import { Scope } from '../src/scope.ts'

interface RegisteredRoute {
  kind: string
  path: string
  auth?: string
  handler: (req: IncomingMessage, res: ServerResponse, peer?: unknown) => void | Promise<void>
}

/** A minimal connection service: rejection is configurable and can be swapped mid-test. */
class FakeConnection {
  rejection: number | undefined = undefined
  calls = 0
  throws = false

  requestRejection(): number | undefined {
    this.calls++
    if (this.throws) throw new Error('connection exploded')
    return this.rejection
  }
}

/**
 * Host 0.2.2+ connection shape: `admit()` returns the admitted peer or a
 * rejection status. Exercised separately from the legacy `requestRejection` API.
 */
class FakeAdmitConnection {
  rejection: 401 | 403 | 503 | undefined = undefined
  omitOutcome = false
  calls = 0
  throws = false

  admit(): { peer?: unknown; rejection?: number } | undefined {
    this.calls++
    if (this.throws) throw new Error('admit exploded')
    if (this.rejection !== undefined) return { rejection: this.rejection }
    if (this.omitOutcome) return {}
    return { peer: { principal: { kind: 'owner' } } }
  }
}

type FakeConnectionService = FakeConnection | FakeAdmitConnection

interface FakeHarness {
  ctx: Context
  routes: RegisteredRoute[]
  connection: FakeConnectionService | undefined
  setConnection(connection: FakeConnectionService | undefined): void
}

function fakeHarness(options: { connection?: FakeConnectionService; missingDeps?: readonly string[] } = {}): FakeHarness {
  const routes: RegisteredRoute[] = []
  let connection = options.connection
  const services = new Map<string, unknown>()
  services.set('webServer', {
    register: (route: RegisteredRoute) => {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index !== -1) routes.splice(index, 1)
      }
    },
  })
  if (connection !== undefined) services.set('connection', connection)
  const scoped = {
    effect: (factory: () => () => void) => {
      factory()
    },
    get: (name: string, strict?: boolean) => {
      if (strict === true && name === 'connection' && connection === undefined) return undefined
      if (strict === true && name === 'connection') return connection
      return services.get(name)
    },
  }
  const harness: FakeHarness = {
    routes,
    connection,
    get ctx() {
      return {
        inject: (deps: readonly string[], callback: (scoped: Context) => void) => {
          for (const dep of deps) {
            if (options.missingDeps?.includes(dep) === true) return
          }
          callback(scoped as unknown as Context)
        },
      } as unknown as Context
    },
    setConnection: next => {
      connection = next
      harness.connection = next
      if (next === undefined) services.delete('connection')
      else services.set('connection', next)
    },
  }
  return harness
}

class FakeResponse {
  statusCode = 200
  readonly headers = new Map<string, unknown>()
  body = ''
  writableEnded = false
  /** Node's "response finished" flag; false while a client can still disconnect. */
  writableFinished = false
  private readonly listeners = new Map<string, Array<() => void>>()

  setHeader(name: string, value: unknown): void {
    this.headers.set(name.toLowerCase(), value)
  }

  on(event: string, listener: () => void): this {
    const list = this.listeners.get(event)
    if (list === undefined) this.listeners.set(event, [listener])
    else list.push(listener)
    return this
  }

  off(event: string, listener: () => void): this {
    const list = this.listeners.get(event)
    if (list !== undefined) {
      const index = list.indexOf(listener)
      if (index !== -1) list.splice(index, 1)
    }
    return this
  }

  removeListener(event: string, listener: () => void): this {
    return this.off(event, listener)
  }

  /** Simulate the socket closing; the handler must see close while unfinished. */
  emitClose(finished = false): void {
    this.writableFinished = finished
    for (const listener of [...(this.listeners.get('close') ?? [])]) listener()
  }

  end(chunk?: unknown): void {
    this.writableEnded = true
    this.writableFinished = true
    if (typeof chunk === 'string') this.body = chunk
    else if (Buffer.isBuffer(chunk)) this.body = chunk.toString('utf8')
  }

  json(): Record<string, unknown> {
    return this.body === '' ? {} : JSON.parse(this.body) as Record<string, unknown>
  }
}

interface FakeRuntimeOptions {
  config?: Record<string, unknown>
  /** Engine status used by routes that do not go through the cache. */
  engineStatus?: () => Promise<unknown>
  /** 0.20.0 pushed-stats cache used by /status. */
  engineStatusCached?: (ttlMs?: number) => Promise<unknown>
}

function fakeRuntime(
  roots: readonly string[] = [],
  hits: Array<Record<string, unknown>> = [],
  options: FakeRuntimeOptions = {},
): LocatorRuntime {
  return {
    roots: [...roots],
    stateDir: join(tmpdir(), 'locator-http-state'),
    status: { running: false },
    config: { maxResults: 100, outputBudgetChars: 8000, ...options.config },
    start: () => {},
    engineStatus: options.engineStatus ?? (async () => undefined),
    ...(options.engineStatusCached === undefined ? {} : { engineStatusCached: options.engineStatusCached }),
    search: async (args: { offset: number; limit: number }) => ({
      total: hits.length,
      returned: hits.slice(args.offset, args.offset + args.limit).length,
      offset: args.offset,
      truncated: hits.length > args.offset + args.limit,
      tookNs: 2_000_000,
      hits: hits.slice(args.offset, args.offset + args.limit),
    }),
  } as unknown as LocatorRuntime
}

/** One name hit for the HTTP route tests. */
function httpHit(path: string): Record<string, unknown> {
  return { path, name: path.split('/').pop() ?? path, size: 10, mtime: 1_700_000_000_000, ext: 'md', dir: false }
}

function fakeRequest(body: unknown, headers: Record<string, string> = {}, method = 'POST', url?: string): IncomingMessage {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const request = Readable.from(text === '' ? [] : [Buffer.from(text)]) as unknown as IncomingMessage
  Reflect.set(request, 'method', method)
  if (url !== undefined) Reflect.set(request, 'url', url)
  Reflect.set(request, 'headers', {
    host: '127.0.0.1:3081',
    'content-type': 'application/json',
    ...headers,
  })
  return request
}

async function callRoute(
  harness: FakeHarness,
  path: string,
  request: IncomingMessage,
  peer?: unknown,
  response: FakeResponse = new FakeResponse(),
): Promise<FakeResponse> {
  const route = harness.routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  await route.handler(request, response as unknown as ServerResponse, peer)
  return response
}

const cleanups: Array<() => void> = []
afterAll(() => {
  for (const cleanup of cleanups.reverse()) cleanup()
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('HTTPS fail-closed registration', () => {
  it('registers routes but answers 503 when the connection service is not active yet', async () => {
    const harness = fakeHarness()
    registerHttp(harness.ctx, fakeRuntime())
    expect(harness.routes.length).toBeGreaterThan(0)
    const response = await callRoute(harness, '/dsh-locator/status', fakeRequest({}))
    expect(response.statusCode).toBe(503)
  })

  it('registers no routes when the connection dependency never resolves', () => {
    const connection = new FakeConnection()
    const harness = fakeHarness({ connection, missingDeps: ['connection'] })
    registerHttp(harness.ctx, fakeRuntime())
    expect(harness.routes).toEqual([])
  })

  it('can explicitly fall back to host auth + same-origin checks when connection is absent', async () => {
    const harness = fakeHarness()
    registerHttp(harness.ctx, fakeRuntime(), undefined, undefined, { connectionOptional: true })
    const response = await callRoute(harness, '/dsh-locator/status', fakeRequest({}))
    expect(response.statusCode).toBe(200)
  })

  it('registers the panel routes when webserver and connection are present', () => {
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime())
    expect(harness.routes.map(route => route.path).sort()).toEqual([
      '/dsh-locator/combined',
      '/dsh-locator/open',
      '/dsh-locator/reveal',
      '/dsh-locator/search',
      '/dsh-locator/status',
      '/dsh-locator/v1/find',
      '/dsh-locator/v1/read',
      '/dsh-locator/v1/status',
    ])
  })
})

describe('HTTP trust fence', () => {
  it('asks the connection service first and honours its rejection', async () => {
    const connection = new FakeConnection()
    connection.rejection = 401
    const harness = fakeHarness({ connection })
    registerHttp(harness.ctx, fakeRuntime())
    const response = await callRoute(harness, '/dsh-locator/status', fakeRequest({}))
    expect(response.statusCode).toBe(401)
    expect(connection.calls).toBe(1)
  })

  it('answers 503 instead of allowing the request when connection becomes unavailable', async () => {
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime())
    harness.setConnection(undefined)
    const response = await callRoute(harness, '/dsh-locator/status', fakeRequest({}))
    expect(response.statusCode).toBe(503)
  })

  it('answers 503 when the connection check itself throws', async () => {
    const connection = new FakeConnection()
    connection.throws = true
    const harness = fakeHarness({ connection })
    registerHttp(harness.ctx, fakeRuntime())
    const response = await callRoute(harness, '/dsh-locator/status', fakeRequest({}))
    expect(response.statusCode).toBe(503)
  })

  it('refuses cross-site browser markers even when connection allows', async () => {
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime())
    const crossSite = await callRoute(harness, '/dsh-locator/status', fakeRequest({}, { 'sec-fetch-site': 'cross-site' }))
    expect(crossSite.statusCode).toBe(403)
    const foreignOrigin = await callRoute(harness, '/dsh-locator/status', fakeRequest({}, { origin: 'http://evil.example' }))
    expect(foreignOrigin.statusCode).toBe(403)
  })

  it('accepts a same-origin panel request', async () => {
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime())
    const response = await callRoute(
      harness,
      '/dsh-locator/status',
      fakeRequest({}, { origin: 'http://127.0.0.1:3081', 'sec-fetch-site': 'same-origin' }),
    )
    expect(response.statusCode).toBe(200)
    expect(response.json().ok).toBe(true)
  })
})

describe('HTTP trust fence (host 0.2.2 admit API)', () => {
  it('accepts a request the host admits as a peer', async () => {
    const connection = new FakeAdmitConnection()
    const harness = fakeHarness({ connection })
    registerHttp(harness.ctx, fakeRuntime())
    const response = await callRoute(harness, '/dsh-locator/status', fakeRequest({}))
    expect(response.statusCode).toBe(200)
    expect(response.json().ok).toBe(true)
    expect(connection.calls).toBe(1)
  })

  it('passes an admit rejection through unchanged', async () => {
    const connection = new FakeAdmitConnection()
    connection.rejection = 401
    const harness = fakeHarness({ connection })
    registerHttp(harness.ctx, fakeRuntime())
    const response = await callRoute(harness, '/dsh-locator/status', fakeRequest({}))
    expect(response.statusCode).toBe(401)
    expect(connection.calls).toBe(1)
  })

  it('answers 503 when admit throws', async () => {
    const connection = new FakeAdmitConnection()
    connection.throws = true
    const harness = fakeHarness({ connection })
    registerHttp(harness.ctx, fakeRuntime())
    const response = await callRoute(harness, '/dsh-locator/status', fakeRequest({}))
    expect(response.statusCode).toBe(503)
  })

  it('answers 503 when admit returns neither a peer nor a rejection', async () => {
    const connection = new FakeAdmitConnection()
    connection.omitOutcome = true
    const harness = fakeHarness({ connection })
    registerHttp(harness.ctx, fakeRuntime())
    const response = await callRoute(harness, '/dsh-locator/status', fakeRequest({}))
    expect(response.statusCode).toBe(503)
  })

  it('treats a connection service with neither trust API as unavailable', async () => {
    const harness = fakeHarness({ connection: {} as unknown as FakeConnectionService })
    registerHttp(harness.ctx, fakeRuntime())
    const response = await callRoute(harness, '/dsh-locator/status', fakeRequest({}))
    expect(response.statusCode).toBe(503)
  })

  it('still enforces the local same-origin markers behind admit', async () => {
    const connection = new FakeAdmitConnection()
    const harness = fakeHarness({ connection })
    registerHttp(harness.ctx, fakeRuntime())
    const crossSite = await callRoute(harness, '/dsh-locator/status', fakeRequest({}, { 'sec-fetch-site': 'cross-site' }))
    expect(crossSite.statusCode).toBe(403)
  })
})

describe('HTTP host-authenticated Peer (DSH 0.2.x)', () => {
  const peer = { principal: { kind: 'owner' } }

  it('accepts the host-admitted Peer even when the connection service is not visible', async () => {
    const harness = fakeHarness()
    registerHttp(harness.ctx, fakeRuntime())
    const response = await callRoute(harness, '/dsh-locator/status', fakeRequest({}), peer)
    expect(response.statusCode).toBe(200)
    expect(response.json().ok).toBe(true)
  })

  it('registers every panel route with the host auth policy required', () => {
    const harness = fakeHarness()
    registerHttp(harness.ctx, fakeRuntime())
    expect(harness.routes.length).toBeGreaterThan(0)
    for (const route of harness.routes) expect(route.auth).toBe('required')
  })

  it('trusts the Peer over the legacy connection rejection', async () => {
    const connection = new FakeConnection()
    connection.rejection = 401
    const harness = fakeHarness({ connection })
    registerHttp(harness.ctx, fakeRuntime())
    const response = await callRoute(harness, '/dsh-locator/status', fakeRequest({}), peer)
    expect(response.statusCode).toBe(200)
    expect(connection.calls).toBe(0)
  })

  it('still refuses cross-site browser markers behind an admitted Peer', async () => {
    const harness = fakeHarness()
    registerHttp(harness.ctx, fakeRuntime())
    const crossSite = await callRoute(harness, '/dsh-locator/status', fakeRequest({}, { 'sec-fetch-site': 'cross-site' }), peer)
    expect(crossSite.statusCode).toBe(403)
    const foreignOrigin = await callRoute(harness, '/dsh-locator/status', fakeRequest({}, { origin: 'http://evil.example' }), peer)
    expect(foreignOrigin.statusCode).toBe(403)
  })
})

describe('HTTP wire format', () => {
  function harnessWithStatus(): FakeHarness {
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime())
    return harness
  }

  it('rejects every method but POST', async () => {
    const response = await callRoute(harnessWithStatus(), '/dsh-locator/status', fakeRequest({}, {}, 'GET'))
    expect(response.statusCode).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('requires an application/json content type before reading the body', async () => {
    const textPlain = await callRoute(
      harnessWithStatus(),
      '/dsh-locator/status',
      fakeRequest({}, { 'content-type': 'text/plain' }),
    )
    expect(textPlain.statusCode).toBe(415)
    const missing = await callRoute(
      harnessWithStatus(),
      '/dsh-locator/status',
      fakeRequest({}, { 'content-type': '' }),
    )
    expect(missing.statusCode).toBe(415)
  })

  it('answers 400 for malformed or non-object JSON', async () => {
    const malformed = await callRoute(harnessWithStatus(), '/dsh-locator/status', fakeRequest('{not json'))
    expect(malformed.statusCode).toBe(400)
    const array = await callRoute(harnessWithStatus(), '/dsh-locator/status', fakeRequest('[1,2]'))
    expect(array.statusCode).toBe(400)
  })

  it('answers 413 for a body over the 64 KiB cap', async () => {
    const oversized = JSON.stringify({ padding: 'x'.repeat(70 * 1024) })
    const response = await callRoute(harnessWithStatus(), '/dsh-locator/status', fakeRequest(oversized))
    expect(response.statusCode).toBe(413)
  })
})

describe('JSON media type helper', () => {
  it('accepts the exact JSON essence with parameters', () => {
    expect(isJsonContentType('application/json')).toBe(true)
    expect(isJsonContentType('Application/JSON; charset=utf-8')).toBe(true)
    expect(isJsonContentType(['application/json; charset=utf-8'])).toBe(true)
  })

  it('rejects other types and a missing header', () => {
    expect(isJsonContentType(undefined)).toBe(false)
    expect(isJsonContentType('')).toBe(false)
    expect(isJsonContentType('text/json')).toBe(false)
    expect(isJsonContentType('application/json5')).toBe(false)
    expect(isJsonContentType('application/x-www-form-urlencoded')).toBe(false)
  })
})

describe('same-origin helper', () => {
  const headers = { host: '127.0.0.1:3081' }

  it('allows requests without browser markers and exact same-origin requests', () => {
    expect(originRejection({ ...headers })).toBeUndefined()
    expect(originRejection({ ...headers, origin: 'http://127.0.0.1:3081' })).toBeUndefined()
    expect(originRejection({ ...headers, 'sec-fetch-site': 'same-origin' })).toBeUndefined()
  })

  it('refuses cross-site, foreign, opaque and unverifiable origins', () => {
    expect(originRejection({ ...headers, 'sec-fetch-site': 'cross-site' })).toBe(403)
    expect(originRejection({ ...headers, origin: 'http://evil.example' })).toBe(403)
    expect(originRejection({ ...headers, origin: 'null' })).toBe(403)
    expect(originRejection({ ...headers, origin: 'file:///etc/passwd' })).toBe(403)
    expect(originRejection({ origin: 'http://127.0.0.1:3081' })).toBe(403)
  })
})

describe('HTTP path routes stay inside the real roots', () => {
  it('refuses a symlink that resolves outside the indexed root', async () => {
    const root = tempDir('locator-http-root-')
    const outside = tempDir('locator-http-outside-')
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'nope')
    const link = join(root, 'innocent.txt')
    try {
      symlinkSync(secret, link, 'file')
    } catch {
      return // Symbolic links need privileges on some Windows runners.
    }
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([root]))
    const response = await callRoute(harness, '/dsh-locator/reveal', fakeRequest({ path: link }))
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ ok: false })
    expect(String(response.json().error)).toContain('outside the indexed roots')
  })

  it('refuses to open executables and scripts even inside a root', async () => {
    const root = tempDir('locator-http-exec-')
    mkdirSync(join(root, 'scripts'))
    const script = join(root, 'scripts', 'deploy.sh')
    writeFileSync(script, '#!/bin/sh\necho hi\n')
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([root]))
    const response = await callRoute(harness, '/dsh-locator/open', fakeRequest({ path: script }))
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ ok: false })
    expect(String(response.json().error)).toContain('refusing to open an executable or script')
  })

  it('keeps the legacy /content route off when the content index is disabled', () => {
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime())
    expect(harness.routes.some(route => route.path === '/dsh-locator/content')).toBe(false)
    expect(harness.routes.some(route => route.path === '/dsh-locator/content/rebuild')).toBe(false)
  })
})

describe('capability adapter route', () => {
  it('serves panel capability search and preflight behind the same fence', async () => {
    const harness = fakeHarness({ connection: new FakeConnection() })
    const searches: Array<{ intent: string; limit?: number }> = []
    const preflights: Array<{ capability: string; args?: Record<string, unknown> }> = []
    registerHttp(harness.ctx, fakeRuntime(), undefined, undefined, {}, {
      search: async (intent, limit) => {
        searches.push({ intent, ...(limit === undefined ? {} : { limit }) })
        return { ok: true, intent, total: 0, returned: 0, hits: [] }
      },
      preflight: async (capability, args) => {
        preflights.push({ capability, ...(args === undefined ? {} : { args }) })
        return { ok: true, next: { callable: true } }
      },
    })
    const search = await callRoute(harness, '/dsh-locator/capabilities', fakeRequest({ intent: 'find files', limit: 3 }))
    expect(search.json()).toMatchObject({ ok: true, intent: 'find files', hits: [] })
    expect(searches).toEqual([{ intent: 'find files', limit: 3 }])
    const preflight = await callRoute(harness, '/dsh-locator/capabilities', fakeRequest({ capability: 'tool:bash', args: { command: 'echo hi' } }))
    expect(preflight.json()).toMatchObject({ ok: true, next: { callable: true } })
    expect(preflights).toEqual([{ capability: 'tool:bash', args: { command: 'echo hi' } }])
    // Without the adapter the route does not exist at all.
    const bare = fakeHarness({ connection: new FakeConnection() })
    registerHttp(bare.ctx, fakeRuntime())
    expect(bare.routes.some(route => route.path === '/dsh-locator/capabilities')).toBe(false)
  })
})

describe('incremental refresh status pass-through', () => {
  it('exposes the engine fallback-refresh fields on the status route', async () => {
    const harness = fakeHarness({ connection: new FakeConnection() })
    const runtime = {
      ...fakeRuntime(),
      engineStatus: async () => ({
        version: '0.19.0', platform: 'linux/amd64', roots: ['/tmp'], entries: 2, files: 2, dirs: 0,
        nameBytes: 1, deleted: 0, watching: true, refreshFallback: true, incrementalRefresh: true,
        watchUnwatchedRoots: ['/tmp'], refreshMode: 'incremental', refreshReason: 'watch-incomplete',
        refreshScannedRoots: ['/tmp'], refreshSkippedRoots: ['/home'], refreshEntries: 5,
        refreshTookMs: 9, refreshAt: 1_700_000_000_000, scanning: false, usn: false, uptimeSec: 1, stateDir: '/state',
      }),
    } as unknown as LocatorRuntime
    registerHttp(harness.ctx, runtime)
    const response = await callRoute(harness, '/dsh-locator/status', fakeRequest({}))
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      incrementalRefresh: true,
      refreshMode: 'incremental',
      refreshSkippedRoots: ['/home'],
      refreshTookMs: 9,
    })
  })
})

describe('public GET search API', () => {
  function harnessWithHits(): FakeHarness {
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], [httpHit('/root/a.md'), httpHit('/root/b.md')]))
    return harness
  }

  it('serves the same results over GET query parameters', async () => {
    const response = await callRoute(harnessWithHits(), '/dsh-locator/search', fakeRequest('', {}, 'GET', '/dsh-locator/search?q=a&limit=1&json=1'))
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.mode).toBe('names')
    expect(body.totalCount).toBe(2)
    expect(body.nextOffset).toBe(1)
    expect((body.hits as unknown[]).length).toBe(1)
    expect(String(response.headers.get('content-type'))).toContain('application/json')
  })

  it('accepts the query alias and boolean parameters', async () => {
    const response = await callRoute(harnessWithHits(), '/dsh-locator/search', fakeRequest('', {}, 'GET', '/dsh-locator/search?query=.md&desc=1&filesOnly=true&json=1'))
    expect(response.statusCode).toBe(200)
    expect(response.json().ok).toBe(true)
  })

  it('rejects malformed query parameters with 400', async () => {
    for (const query of ['?limit=abc', '?offset=-1x', '?mode=weird', '?sort=bad', '?desc=maybe', '?count=many']) {
      const response = await callRoute(harnessWithHits(), '/dsh-locator/search', fakeRequest('', {}, 'GET', '/dsh-locator/search' + query))
      expect(response.statusCode, query).toBe(400)
      expect(response.json().ok).toBe(false)
    }
  })

  it('answers content mode with a clear error when the content index is disabled', async () => {
    const response = await callRoute(harnessWithHits(), '/dsh-locator/search', fakeRequest('', {}, 'GET', '/dsh-locator/search?q=needle&mode=content'))
    expect(response.statusCode).toBe(200)
    expect(response.json().ok).toBe(false)
    expect(String(response.json().error)).toContain('content-index-unavailable')
  })

  it('keeps the POST body contract on the same path', async () => {
    const response = await callRoute(harnessWithHits(), '/dsh-locator/search', fakeRequest({ query: 'a', limit: 1 }))
    expect(response.statusCode).toBe(200)
    expect(response.json().mode).toBe('names')
    expect((response.json().hits as unknown[]).length).toBe(1)
  })

  it('applies the same trust fence and same-origin markers to GET', async () => {
    const noConnection = fakeHarness()
    registerHttp(noConnection.ctx, fakeRuntime())
    const refused = await callRoute(noConnection, '/dsh-locator/search', fakeRequest('', {}, 'GET', '/dsh-locator/search?q=a'))
    expect(refused.statusCode).toBe(503)
    const crossSite = await callRoute(harnessWithHits(), '/dsh-locator/search', fakeRequest('', { 'sec-fetch-site': 'cross-site' }, 'GET', '/dsh-locator/search?q=a'))
    expect(crossSite.statusCode).toBe(403)
    const foreign = await callRoute(harnessWithHits(), '/dsh-locator/search', fakeRequest('', { origin: 'http://evil.example' }, 'GET', '/dsh-locator/search?q=a'))
    expect(foreign.statusCode).toBe(403)
    const sameOrigin = await callRoute(harnessWithHits(), '/dsh-locator/search', fakeRequest('', { origin: 'http://127.0.0.1:3081', 'sec-fetch-site': 'same-origin' }, 'GET', '/dsh-locator/search?q=a'))
    expect(sameOrigin.statusCode).toBe(200)
  })

  it('rejects other methods with a GET/POST Allow header', async () => {
    const response = await callRoute(harnessWithHits(), '/dsh-locator/search', fakeRequest('', {}, 'DELETE', '/dsh-locator/search'))
    expect(response.statusCode).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, POST')
  })
})


/** Minimal content store for the content-mode and status route tests. */
function fakeContent(options: {
  file?: string
  hits?: Array<Record<string, unknown>>
  search?: (query: string, limit: number, searchOptions: Record<string, unknown>) => Promise<unknown>
  diagnostics?: Record<string, unknown>
  mtimesForPaths?: (paths: readonly string[]) => Map<string, number>
} = {}): ContentIndex {
  const state = { building: false, files: 1, sessions: 0, messages: 0, truncated: false, error: '', warnings: [], updatedAt: 1 }
  return {
    status: () => state,
    authorizedSessionIds: () => new Set<string>(),
    indexedMtime: () => options.file === undefined ? undefined : statSync(options.file).mtimeMs,
    sessionEventRefs: () => new Map(),
    async search(query: string, limit: number, searchOptions: Record<string, unknown>) {
      if (options.search !== undefined) return await options.search(query, limit, searchOptions)
      const hits = options.hits ?? []
      return { hits: hits.slice(0, limit), count: { value: hits.length, kind: 'exact' as const }, warnings: [] }
    },
    ...(options.diagnostics === undefined ? {} : { diagnostics: () => options.diagnostics }),
    ...(options.mtimesForPaths === undefined ? {} : { mtimesForPaths: options.mtimesForPaths }),
  } as unknown as ContentIndex
}

/** One content hit for the HTTP tests. */
function contentHttpHit(path: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'file', path, title: path.split('/').pop() ?? path, snippet: 'needle body', line: 1, score: 1, ...overrides }
}

describe('search paging and real tookMs (0.20.0 P0-15)', () => {
  it('keeps budget-deferred rows reachable instead of skipping the page', async () => {
    const hits = [httpHit('/root/a.md'), httpHit('/root/b.md'), httpHit('/root/c.md')]
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], hits, { config: { outputBudgetChars: 120 } }))
    const body = (await callRoute(harness, '/dsh-locator/search', fakeRequest({ query: 'a', limit: 3 }))).json()
    const returned = (body.hits as unknown[]).length
    expect(body.ok).toBe(true)
    expect(returned).toBeLessThan(3)
    expect(body.budget).toMatchObject({ truncated: true })
    // 0.21.1: the cursor lands after the last returned row, so the deferred rows
    // are delivered on the next page instead of being skipped.
    expect(body.nextOffset).toBe(1)
    expect(body.hasMore).toBe(true)
    expect(body.truncation).toMatchObject({ reason: 'budget' })
    const next = (await callRoute(harness, '/dsh-locator/search', fakeRequest({ query: 'a', limit: 3, offset: 1 }))).json()
    expect((next.hits as Array<{ path: string }>)[0]?.path).toBe('/root/b.md')
  })

  it('does not invent a next page when scope-filtered rows are already consumed', async () => {
    const hits = [httpHit('/root/a.md'), httpHit('/root/b.md'), httpHit('/root/c.md')]
    const scope = new Scope({ notSearchable: ['b.md'], notReadable: [], notIndexed: [] }, false)
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], hits), undefined, undefined, {}, undefined, scope)
    const body = (await callRoute(harness, '/dsh-locator/search', fakeRequest({ query: 'a', limit: 3 }))).json()
    expect(body.ok).toBe(true)
    expect((body.hits as Array<{ path: string }>).map(hit => hit.path)).toEqual(['/root/a.md', '/root/c.md'])
    expect(body.truncated).toBe(false)
    expect(body.nextOffset).toBeUndefined()
  })

  it('reports the real content tookMs and page-advancing nextOffset', async () => {
    const dir = tempDir('locator-http-content-')
    const file = join(dir, 'notes.md')
    writeFileSync(file, 'needle line\nmore\n')
    const hits = [
      contentHttpHit(file),
      contentHttpHit(file, { snippet: 'x'.repeat(600) }),
      contentHttpHit(file, { snippet: 'y'.repeat(600) }),
    ]
    const content = fakeContent({
      file,
      search: async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
        return { hits, count: { value: 3, kind: 'exact' }, warnings: [] }
      },
    })
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], [], { config: { outputBudgetChars: 250 } }), content)
    const body = (await callRoute(harness, '/dsh-locator/search', fakeRequest({ query: 'needle', mode: 'content', limit: 3 }))).json()
    expect(body.ok).toBe(true)
    expect(body.tookMs).toBeGreaterThanOrEqual(20)
    expect((body.hits as unknown[]).length).toBeLessThan(3)
    expect(body.budget).toMatchObject({ truncated: true })
    // The budget deferred the other rows; the cursor points at the first one.
    expect(body.nextOffset).toBe(1)
    expect(body.hasMore).toBe(true)
    expect(body.truncation).toMatchObject({ reason: 'budget' })
  })

  it('cancels the content query when the client disconnects', async () => {
    const signals: AbortSignal[] = []
    const content = fakeContent({
      search: async (_query, _limit, searchOptions) => {
        const signal = searchOptions.signal
        expect(signal).toBeInstanceOf(AbortSignal)
        signals.push(signal as AbortSignal)
        return await new Promise((_resolve, reject) => {
          (signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')))
        })
      },
    })
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([]), content)
    const response = new FakeResponse()
    const pending = callRoute(harness, '/dsh-locator/search', fakeRequest({ query: 'needle', mode: 'content' }), undefined, response)
    // Let the handler reach the store, then drop the connection.
    await new Promise(resolve => setTimeout(resolve, 25))
    response.emitClose(false)
    await pending
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(response.json()).toMatchObject({ ok: false, error: 'request-aborted' })
  })
})

describe('combined route 0.20.0 options', () => {
  it('serves compact responses without evidence fields', async () => {
    const dir = tempDir('locator-http-compact-')
    const file = join(dir, 'notes.md')
    writeFileSync(file, 'body')
    const content = fakeContent({ hits: [contentHttpHit('/tmp/body-only.md')] })
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([dir], [httpHit('/tmp/name-only.md')]), content)
    const body = (await callRoute(harness, '/dsh-locator/combined', fakeRequest({ query: 'note', compact: true }))).json()
    expect(body.compact).toBe(true)
    const fileHits = (body.files as { hits: Array<Record<string, unknown>> }).hits
    expect(fileHits).toHaveLength(1)
    expect(fileHits[0]).toMatchObject({ path: '/tmp/name-only.md' })
    expect(fileHits[0]?.freshness).toBeUndefined()
    expect(fileHits[0]?.permissions).toBeUndefined()
    expect(fileHits[0]?.ref).toBeUndefined()
    expect(fileHits[0]?.hash).toBeUndefined()
    const contentHits = (body.content as { hits: Array<Record<string, unknown>> }).hits
    expect(contentHits[0]?.freshness).toBeUndefined()
    expect(contentHits[0]?.permissions).toBeUndefined()
  })

  it('applies the configured combined character budget', async () => {
    const hits = Array.from({ length: 12 }, (_, index) => httpHit('/tmp/name-' + String(index) + '.md'))
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], hits), undefined, undefined, { combinedBudgetChars: 700 })
    const body = (await callRoute(harness, '/dsh-locator/combined', fakeRequest({ query: 'name', compact: true }))).json()
    expect(body.budget).toBeDefined()
    expect(body.budget).toMatchObject({ limitChars: 700, truncated: true })
    expect((body.budget as { dropped: number }).dropped).toBeGreaterThan(0)
    // Structural counts stay intact even when hits are trimmed.
    expect((body.files as { count: { value: number } }).count.value).toBe(12)
  })

  it('keeps the response unbudgeted by default', async () => {
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], [httpHit('/tmp/a.md')]))
    const body = (await callRoute(harness, '/dsh-locator/combined', fakeRequest({ query: 'a' }))).json()
    expect(body.budget).toBeUndefined()
    expect(body.compact).toBeUndefined()
  })
})

describe('combined route 0.20.2 evidence and short-query limits', () => {
  it('keeps evidence on the first evidenceLimit rows and strips the rest', async () => {
    const hits = Array.from({ length: 12 }, (_, index) => httpHit('/tmp/limit-' + String(index) + '.md'))
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], hits))
    const body = (await callRoute(harness, '/dsh-locator/combined', fakeRequest({ query: 'limit' }))).json()
    const fileHits = (body.files as { hits: Array<Record<string, unknown>>; count: { value: number }; truncated: boolean }).hits
    expect(fileHits).toHaveLength(12)
    // The documented default keeps exactly 10 evidence rows.
    expect(fileHits.slice(0, 10).every(hit => hit.freshness !== undefined && hit.permissions !== undefined)).toBe(true)
    expect(fileHits.slice(10).every(hit => hit.freshness === undefined && hit.ref === undefined)).toBe(true)
    expect((body.files as { count: { value: number } }).count.value).toBe(12)
    expect((body.files as { truncated: boolean }).truncated).toBe(false)
    // A body limit narrows the evidence rows further, never the counts.
    const two = (await callRoute(harness, '/dsh-locator/combined', fakeRequest({ query: 'limit', evidenceLimit: 2 }))).json()
    const twoHits = (two.files as { hits: Array<Record<string, unknown>> }).hits
    expect(twoHits.slice(0, 2).every(hit => hit.freshness !== undefined)).toBe(true)
    expect(twoHits.slice(2).every(hit => hit.freshness === undefined)).toBe(true)
    expect((two.files as { count: { value: number } }).count.value).toBe(12)
  })

  it('admits a 2-code-point query when the short-query fallback is enabled', async () => {
    const calls: Array<Record<string, unknown>> = []
    const content = fakeContent({
      search: async (_query, _limit, searchOptions) => {
        calls.push(searchOptions)
        return {
          hits: [contentHttpHit('/tmp/ai.md')],
          count: { value: 1, kind: 'exact' as const },
          warnings: ['content-query-short-fallback'],
          shortQueryFallback: true,
        }
      },
    })
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], [], { config: { contentShortQueryFallback: true } }), content)
    const body = (await callRoute(harness, '/dsh-locator/combined', fakeRequest({ query: 'ai' }))).json()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.shortQueryFallback).toBe(true)
    expect((body.content as { shortQueryFallback?: boolean }).shortQueryFallback).toBe(true)
    expect((body.content as { warnings?: string[] }).warnings).toContain('content-query-short-fallback')
  })

  it('still rejects a 2-code-point query when the fallback is disabled', async () => {
    const calls: Array<Record<string, unknown>> = []
    const content = fakeContent({
      search: async (_query, _limit, searchOptions) => {
        calls.push(searchOptions)
        return { hits: [], count: { value: 0, kind: 'exact' as const }, warnings: [] }
      },
    })
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], [], { config: { contentShortQueryFallback: false } }), content)
    const body = (await callRoute(harness, '/dsh-locator/combined', fakeRequest({ query: 'ai' }))).json()
    expect(calls).toHaveLength(0)
    expect((body.content as { error?: string }).error).toBe('content-query-too-short')
  })

  it('batches content freshness mtimes through one store call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-http-batch-'))
    const file = join(dir, 'body.md')
    writeFileSync(file, 'batch body')
    try {
      const batchCalls: Array<readonly string[]> = []
      const content = fakeContent({
        hits: [contentHttpHit(file)],
        mtimesForPaths: paths => {
          batchCalls.push(paths)
          return new Map([[file, statSync(file).mtimeMs]])
        },
      })
      const harness = fakeHarness({ connection: new FakeConnection() })
      registerHttp(harness.ctx, fakeRuntime([], []), content)
      const body = (await callRoute(harness, '/dsh-locator/combined', fakeRequest({ query: 'body' }))).json()
      expect(batchCalls).toHaveLength(1)
      expect(batchCalls[0]).toEqual([file])
      const contentHits = (body.content as { hits: Array<Record<string, unknown>> }).hits
      expect(contentHits[0]?.freshness).toMatchObject({ state: 'fresh' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('status route 0.20.0 observability', () => {
  const payload = {
    version: '0.20.0', platform: 'linux/amd64', roots: ['/tmp'], entries: 3, files: 3, dirs: 0,
    nameBytes: 10, deleted: 0, watching: true, scanning: false, usn: false, uptimeSec: 1, stateDir: '/state',
    rssBytes: 111, hwmBytes: 222, watchDirs: 10, watchLimit: 120_000, watchLimited: true,
    watchInitializing: true, snapshotBytes: 1_000, saveBytes: 900, saveMs: 12, saveCount: 2,
    queueDepth: 3, generation: 5, builtAt: 1_700_000_000_000, queryCount: 4, lastQueryMs: 1.5,
    recentQueryMs: [1, 2], heapBytes: 1234, numGC: 2, refreshBackoffMs: 0,
    unwatchedRefreshMs: 300_000, nextRefreshAt: 1_700_000_600_000, refreshRounds: 4, refreshSkippedByPressure: 2,
  }

  it('answers from the pushed 1 s status cache and forwards engine gauges', async () => {
    let cachedCalls = 0
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], [], {
      engineStatus: async () => {
        throw new Error('the status route must use the cached copy')
      },
      engineStatusCached: async () => {
        cachedCalls += 1
        return payload
      },
    }))
    const body = (await callRoute(harness, '/dsh-locator/status', fakeRequest({}))).json()
    expect(body.ok).toBe(true)
    expect(cachedCalls).toBe(1)
    expect(body).toMatchObject({
      rssBytes: 111,
      hwmBytes: 222,
      watchDirs: 10,
      watchLimit: 120_000,
      watchLimited: true,
      watchInitializing: true,
      snapshotBytes: 1_000,
      saveBytes: 900,
      saveMs: 12,
      saveCount: 2,
      queueDepth: 3,
      generation: 5,
      queryCount: 4,
      recentQueryMs: [1, 2],
      unwatchedRefreshMs: 300_000,
      nextRefreshAt: 1_700_000_600_000,
      refreshRounds: 4,
      refreshSkippedByPressure: 2,
    })
  })

  it('forwards the content diagnostics block read-only', async () => {
    const diagnostics = {
      coverage: { indexedFiles: 10, candidateFiles: 12, ratio: 0.833, bodyBytes: 100, budgetBytes: 200, fileBudget: 0, truncated: false, evictedDocs: 1, sessions: 1, messages: 2 },
      dbBytes: 300, walBytes: 4, dbBudgetBytes: 400, dbOverBudget: false, ftsOptimizedAt: 1_700_000_000_000,
      dbLiveBytes: 280, freelistBytes: 20, ftsSegments: 1, optimizeWarnings: 0, liveRefreshMsLast: 42,
      lastRefreshMs: 5, lastRefreshMode: 'fast', engineGeneration: 1, symbolsPerFile: 500, extractWorker: true,
    }
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime(), fakeContent({ diagnostics }))
    const body = (await callRoute(harness, '/dsh-locator/status', fakeRequest({}))).json()
    expect((body.content as { diagnostics?: unknown }).diagnostics).toEqual(diagnostics)
  })

  it('omits diagnostics when the store does not provide them', async () => {
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime(), fakeContent())
    const body = (await callRoute(harness, '/dsh-locator/status', fakeRequest({}))).json()
    expect((body.content as { diagnostics?: unknown }).diagnostics).toBeUndefined()
  })
})


describe('search 0.21.1 contract', () => {
  it('returns structured errorInfo on failures', async () => {
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], [httpHit('/root/a.md')]))
    const body = (await callRoute(harness, '/dsh-locator/search', fakeRequest({ query: 'x', mode: 'content' }))).json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('content-index-unavailable')
    expect(body.errorInfo).toMatchObject({ code: 'content-index-unavailable', retryable: false })
    const bad = await callRoute(harness, '/dsh-locator/search', fakeRequest('', {}, 'GET', '/dsh-locator/search?limit=abc'))
    expect(bad.statusCode).toBe(400)
    expect((bad.json().errorInfo as { code?: string }).code).toBe('invalid-arguments')
  })

  it('defaults the name page size to 10 and reports page truncation', async () => {
    const hits = Array.from({ length: 15 }, (_, index) => httpHit('/root/file-' + String(index) + '.md'))
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], hits))
    const body = (await callRoute(harness, '/dsh-locator/search', fakeRequest({ query: 'file' }))).json()
    expect(body.ok).toBe(true)
    expect((body.hits as unknown[]).length).toBe(10)
    expect(body.truncated).toBe(true)
    expect(body.hasMore).toBe(true)
    expect(body.nextOffset).toBe(10)
    expect(body.truncation).toMatchObject({ reason: 'page' })
    expect(body.total).toBe(15)
  })

  it('supports compact detail over POST and GET', async () => {
    const hits = [httpHit('/root/a.md'), httpHit('/root/b.md')]
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], hits))
    const post = (await callRoute(harness, '/dsh-locator/search', fakeRequest({ query: 'a', detail: 'compact', limit: 2 }))).json()
    expect(post.detail).toBe('compact')
    const compactHits = post.hits as Array<Record<string, unknown>>
    expect(compactHits[0]?.ref).toBeDefined()
    expect(compactHits[0]?.freshness).toBeUndefined()
    expect(compactHits[0]?.permissions).toBeUndefined()
    expect(compactHits[0]?.refStatus).toBeUndefined()
    const get = await callRoute(harness, '/dsh-locator/search', fakeRequest('', {}, 'GET', '/dsh-locator/search?q=a&detail=compact&limit=1'))
    expect(get.statusCode).toBe(200)
    expect(get.json().detail).toBe('compact')
    const invalid = await callRoute(harness, '/dsh-locator/search', fakeRequest('', {}, 'GET', '/dsh-locator/search?q=a&detail=weird'))
    expect(invalid.statusCode).toBe(400)
    expect((invalid.json().errorInfo as { code?: string }).code).toBe('invalid-arguments')
  })

  it('reports live content counters on a building index', async () => {
    const building = {
      status: () => ({
        building: true,
        files: 5,
        sessions: 0,
        messages: 2,
        truncated: false,
        updatedAt: 1,
        error: '',
        warnings: [],
        progress: { phase: 'files', scanned: 9, indexed: 12, total: 20, startedAt: 1 },
      }),
      authorizedSessionIds: () => new Set<string>(),
      indexedMtime: () => undefined,
      sessionEventRefs: () => new Map(),
      async search() {
        return { hits: [], count: { value: 0, kind: 'unknown' as const }, warnings: [] }
      },
    } as unknown as ContentIndex
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime(), building)
    const body = (await callRoute(harness, '/dsh-locator/status', fakeRequest({}))).json()
    expect(body.content).toMatchObject({ enabled: true, building: true, files: 5, messages: 2 })
    expect((body.content as { progress?: { indexed?: number } }).progress?.indexed).toBe(12)
  })
})


/* ------------------------------------------------------------------------- */
/* 0.23.0 versioned /v1 AI-first API                                         */
/* ------------------------------------------------------------------------- */

/**
 * Fake content store for the /v1 body-mode tests: it records the search
 * options and only hides its session row when the store is asked to.
 */
function v1Content(options: { file: string; calls?: Array<Record<string, unknown>> }): ContentIndex {
  const state = { building: false, files: 1, sessions: 1, messages: 1, truncated: false, error: '', warnings: [], updatedAt: 1 }
  const fileHit = { kind: 'file', path: options.file, title: 'notes.md', snippet: 'needle body', line: 1, score: 1 }
  const sessionHit = {
    kind: 'session',
    path: '/sessions/s1/events.jsonl',
    title: 's1',
    snippet: 'needle session',
    line: 1,
    score: 2,
    sessionId: 's1',
    messageId: 'm1',
  }
  return {
    status: () => state,
    authorizedSessionIds: () => new Set(['s1']),
    indexedMtime: () => 1_000,
    sessionEventRefs: () => new Map(),
    findSymbols: () => [],
    async search(_query: string, limit: number, searchOptions: Record<string, unknown> = {}) {
      options.calls?.push(searchOptions)
      const hits = searchOptions.excludeSessions === true ? [fileHit] : [sessionHit, fileHit]
      return { hits: hits.slice(0, limit), count: { value: hits.length, kind: 'exact' as const }, warnings: [] }
    },
  } as unknown as ContentIndex
}

/** Register the plugin with the panel connection present. */
function registerV1(rt: LocatorRuntime, content?: ContentIndex): FakeHarness {
  const harness = fakeHarness({ connection: new FakeConnection() })
  registerHttp(harness.ctx, rt, content)
  return harness
}

function errorOf(body: Record<string, unknown>): { code?: string; message?: string; retryable?: boolean } {
  const error = body.error
  return typeof error === 'object' && error !== null ? error as { code?: string; message?: string; retryable?: boolean } : {}
}

describe('/v1 find', () => {
  it('answers the agent-core envelope for a name search', async () => {
    const root = tempDir('locator-http-v1-find-')
    const file = join(root, 'alpha.ts')
    writeFileSync(file, 'export const alpha = 1\n')
    const harness = registerV1(fakeRuntime([root], [httpHit(file)]))
    const response = await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({ query: 'alpha', mode: 'name' }))
    expect(response.statusCode).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = response.json()
    expect(body).toMatchObject({ apiVersion: '2026-11', ok: true, tool: 'locator_find', mode: 'name', resolvedMode: 'name' })
    expect(body.detail).toBe('compact')
    expect(body.scope).toMatchObject({ requested: 'roots', effective: 'roots' })
    const items = body.items as Array<Record<string, unknown>>
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'file', path: file })
    expect(body.page).toMatchObject({ limit: 10, returned: 1, more: false })
  })

  it('is files-only: session documents are never searched or returned', async () => {
    const root = tempDir('locator-http-v1-session-')
    const file = join(root, 'notes.md')
    writeFileSync(file, 'needle body\n')
    const calls: Array<Record<string, unknown>> = []
    const harness = registerV1(fakeRuntime([root], [], { config: { outputBudgetChars: 8000 } }), v1Content({ file, calls }))
    const body = (await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({ query: 'needle', mode: 'body' }))).json()
    expect(body.ok).toBe(true)
    expect(body.resolvedMode).toBe('body')
    const items = body.items as Array<Record<string, unknown>>
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(item => item.kind !== 'session')).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(call => call.excludeSessions === true)).toBe(true)
  })

  it('keeps the default auto mode files-only', async () => {
    const root = tempDir('locator-http-v1-auto-')
    const file = join(root, 'notes.md')
    writeFileSync(file, 'needle body\n')
    const calls: Array<Record<string, unknown>> = []
    const harness = registerV1(fakeRuntime([root], [httpHit(file)], { config: { outputBudgetChars: 8000 } }), v1Content({ file, calls }))
    const body = (await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({ query: 'needle' }))).json()
    expect(body.ok).toBe(true)
    const items = body.items as Array<Record<string, unknown>>
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(item => item.kind !== 'session')).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(call => call.excludeSessions === true)).toBe(true)
  })

  it('rejects session kinds, workspace scope, bad pathPrefix and unknown arguments', async () => {
    const root = tempDir('locator-http-v1-deny-')
    const harness = registerV1(fakeRuntime([root], [httpHit(join(root, 'a.md'))]))
    const session = (await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({ query: 'x', kinds: ['file', 'session'] }))).json()
    expect(session).toMatchObject({ apiVersion: '2026-11', ok: false, tool: 'locator_http' })
    expect(errorOf(session).code).toBe('invalid-argument')
    expect(String(errorOf(session).message)).toContain('session')

    const workspace = (await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({ query: 'x', scope: 'workspace' }))).json()
    expect(errorOf(workspace).code).toBe('invalid-argument')
    expect(String(errorOf(workspace).message)).toContain('roots')

    const combinedPrefix = (await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({ query: 'x', pathPrefix: root, where: { pathPrefix: root } }))).json()
    expect(errorOf(combinedPrefix).code).toBe('invalid-argument')

    const unknown = (await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({ query: 'x', sessionId: 's1' }))).json()
    expect(unknown).toMatchObject({ ok: false, tool: 'locator_http' })
    expect(errorOf(unknown).code).toBe('invalid-argument')
    expect(String(errorOf(unknown).message)).toContain('sessionId')
  })

  it('honours an explicit pathPrefix inside the roots in both spellings', async () => {
    const root = tempDir('locator-http-v1-prefix-')
    const sub = join(root, 'sub')
    mkdirSync(sub)
    const harness = registerV1(fakeRuntime([root], [httpHit(join(root, 'a.md')), httpHit(join(sub, 'b.md'))]))
    const topLevel = (await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({ query: 'b', mode: 'name', pathPrefix: sub }))).json()
    expect(topLevel.ok).toBe(true)
    expect((topLevel.items as Array<{ path: string }>).map(item => item.path)).toEqual([join(sub, 'b.md')])
    const viaWhere = (await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({ query: 'b', mode: 'name', where: { pathPrefix: sub } }))).json()
    expect(viaWhere.ok).toBe(true)
    expect((viaWhere.items as Array<{ path: string }>).map(item => item.path)).toEqual([join(sub, 'b.md')])
  })

  it('reports a missing content index inside the envelope', async () => {
    const root = tempDir('locator-http-v1-nocontent-')
    const harness = registerV1(fakeRuntime([root], []))
    const body = (await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({ query: 'needle', mode: 'body' }))).json()
    expect(body).toMatchObject({ apiVersion: '2026-11', ok: false, tool: 'locator_find' })
    expect(errorOf(body).code).toBe('index-unavailable')
    expect(errorOf(body).retryable).toBe(true)
  })

  it('answers scope-denied for a pathPrefix outside every root', async () => {
    const root = tempDir('locator-http-v1-root-')
    const outside = tempDir('locator-http-v1-outside-')
    const harness = registerV1(fakeRuntime([root], [httpHit(join(root, 'a.md'))]))
    const response = await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({ query: 'a', pathPrefix: outside }))
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(false)
    expect(errorOf(body).code).toBe('scope-denied')
  })

  it('keeps tool-level failures as invalid-argument envelopes', async () => {
    const harness = registerV1(fakeRuntime())
    const empty = (await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({}))).json()
    expect(empty).toMatchObject({ apiVersion: '2026-11', ok: false, tool: 'locator_find' })
    expect(errorOf(empty).code).toBe('invalid-argument')
    const wrongType = (await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({ query: 42 }))).json()
    expect(wrongType).toMatchObject({ ok: false, tool: 'locator_find' })
    expect(errorOf(wrongType).code).toBe('invalid-argument')
    expect((wrongType.error as { details?: { violations?: string[] } }).details?.violations?.length).toBeGreaterThan(0)
  })

  it('answers wire-format failures with the same envelope shape', async () => {
    const harness = registerV1(fakeRuntime())
    const method = await callRoute(harness, '/dsh-locator/v1/find', fakeRequest('', {}, 'GET'))
    expect(method.statusCode).toBe(405)
    expect(method.headers.get('allow')).toBe('POST')
    expect(method.json()).toMatchObject({ apiVersion: '2026-11', ok: false, tool: 'locator_http', error: { code: 'invalid-argument' } })

    const media = await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({}, { 'content-type': 'text/plain' }))
    expect(media.statusCode).toBe(415)
    expect(media.json()).toMatchObject({ ok: false, tool: 'locator_http' })

    const malformed = await callRoute(harness, '/dsh-locator/v1/find', fakeRequest('{not json'))
    expect(malformed.statusCode).toBe(400)
    expect(errorOf(malformed.json()).code).toBe('invalid-argument')
  })

  it('pages through the opaque envelope cursor', async () => {
    const root = tempDir('locator-http-v1-page-')
    const hits = ['alpha.ts', 'beta.ts', 'gamma.ts'].map(name => httpHit(join(root, name)))
    const harness = registerV1(fakeRuntime([root], hits))
    const first = (await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({ query: 'a', mode: 'name', limit: 1 }))).json()
    expect(first.ok).toBe(true)
    expect((first.items as unknown[]).length).toBe(1)
    expect(first.page).toMatchObject({ limit: 1, returned: 1, more: true })
    const cursor = (first.page as { nextCursor?: string }).nextCursor
    expect(typeof cursor).toBe('string')
    const second = (await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({ query: 'a', mode: 'name', limit: 1, cursor }))).json()
    expect(second.ok).toBe(true)
    const firstPath = (first.items as Array<{ path: string }>)[0]?.path
    const secondPath = (second.items as Array<{ path: string }>)[0]?.path
    expect(secondPath).toBeDefined()
    expect(secondPath).not.toBe(firstPath)
    const bad = (await callRoute(harness, '/dsh-locator/v1/find', fakeRequest({ query: 'a', mode: 'name', cursor: 'not-a-cursor' }))).json()
    expect(bad.ok).toBe(false)
    expect(errorOf(bad).code).toBe('cursor-invalid')
  })

  it('sits behind the same connection trust fence', async () => {
    const harness = fakeHarness()
    registerHttp(harness.ctx, fakeRuntime())
    const response = await callRoute(harness, '/dsh-locator/v1/status', fakeRequest({}))
    expect(response.statusCode).toBe(503)
  })

  it('never exposes an admin route and requires host auth', () => {
    const harness = registerV1(fakeRuntime())
    const paths = harness.routes.map(route => route.path)
    expect(paths.some(path => path.toLowerCase().includes('admin'))).toBe(false)
    expect(paths).toEqual(expect.arrayContaining(['/dsh-locator/v1/find', '/dsh-locator/v1/read', '/dsh-locator/v1/status']))
    for (const route of harness.routes.filter(candidate => candidate.path.startsWith('/dsh-locator/v1/'))) {
      expect(route.auth).toBe('required')
    }
  })
})

describe('/v1 read', () => {
  it('reads an absolute file path inside the roots', async () => {
    const root = tempDir('locator-http-v1-read-')
    const file = join(root, 'hello.md')
    writeFileSync(file, 'hello line\nworld line\n')
    const harness = registerV1(fakeRuntime([root]))
    const body = (await callRoute(harness, '/dsh-locator/v1/read', fakeRequest({ path: file }))).json()
    expect(body).toMatchObject({ apiVersion: '2026-11', ok: true, tool: 'locator_read' })
    const items = body.items as Array<{ path?: string; excerpt?: string; kind?: string }>
    const canonical = (value: string): string => {
      try { return realpathSync.native(value) } catch { return realpathSync(value) }
    }
    expect(items[0]?.path).toBe(canonical(file))
    expect(items[0]?.excerpt).toContain('hello line')
  })

  it('rejects relative paths and every non-file ref', async () => {
    const root = tempDir('locator-http-v1-read-deny-')
    const harness = registerV1(fakeRuntime([root]))
    const relative = (await callRoute(harness, '/dsh-locator/v1/read', fakeRequest({ path: 'notes.md' }))).json()
    expect(relative).toMatchObject({ ok: false, tool: 'locator_read' })
    expect(errorOf(relative).code).toBe('invalid-argument')

    const empty = (await callRoute(harness, '/dsh-locator/v1/read', fakeRequest({ ref: '' }))).json()
    expect(empty).toMatchObject({ ok: false, tool: 'locator_read' })
    expect(errorOf(empty).code).toBe('invalid-argument')

    for (const body of [
      { ref: 'dsh-session:abc' },
      { ref: 'ref://spill?path=' + encodeURIComponent(join(root, 'spill.txt')) },
      { refs: ['ref://attachment?sha256=abc'] },
      { ref: 'ref://url?url=' + encodeURIComponent('http://example.test/') + '&sha256=abc' },
    ]) {
      const response = await callRoute(harness, '/dsh-locator/v1/read', fakeRequest(body))
      expect(response.statusCode).toBe(200)
      const value = response.json()
      expect(value).toMatchObject({ ok: false, tool: 'locator_read' })
      expect(errorOf(value).code).toBe('scope-denied')
    }
  })

  it('refuses a path outside every configured root', async () => {
    const root = tempDir('locator-http-v1-read-root-')
    const outside = tempDir('locator-http-v1-read-outside-')
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'nope\n')
    const harness = registerV1(fakeRuntime([root]))
    const body = (await callRoute(harness, '/dsh-locator/v1/read', fakeRequest({ path: secret }))).json()
    expect(body.ok).toBe(false)
    expect(errorOf(body).code).toBe('scope-denied')
  })

  it('applies the layered notReadable fence and never returns its bytes', async () => {
    const root = tempDir('locator-http-v1-read-scope-')
    const file = join(root, 'secret.md')
    writeFileSync(file, 'secret body line\n')
    const scope = new Scope({ notSearchable: [], notReadable: ['secret.md'], notIndexed: [] }, false)
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([root]), undefined, undefined, {}, undefined, scope)
    const body = (await callRoute(harness, '/dsh-locator/v1/read', fakeRequest({ path: file }))).json()
    expect(body.ok).toBe(false)
    expect(errorOf(body).code).toBe('scope-denied')
    expect(JSON.stringify(body)).not.toContain('secret body line')
  })

  it('refuses file refs and symlinks that resolve outside the roots', async () => {
    const root = tempDir('locator-http-v1-read-outside-ref-')
    const outside = tempDir('locator-http-v1-read-outside-target-')
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'outside secret body\n')
    const harness = registerV1(fakeRuntime([root]))
    const ref = 'ref://file?path=' + encodeURIComponent(secret)
    const refBody = (await callRoute(harness, '/dsh-locator/v1/read', fakeRequest({ ref }))).json()
    expect(refBody.ok).toBe(false)
    expect(errorOf(refBody).code).toBe('scope-denied')
    expect(JSON.stringify(refBody)).not.toContain('outside secret body')
    const link = join(root, 'innocent.txt')
    try {
      symlinkSync(secret, link, 'file')
    } catch {
      return // Symbolic links need privileges on some Windows runners.
    }
    const linkBody = (await callRoute(harness, '/dsh-locator/v1/read', fakeRequest({ path: link }))).json()
    expect(linkBody.ok).toBe(false)
    expect(errorOf(linkBody).code).toBe('scope-denied')
    expect(JSON.stringify(linkBody)).not.toContain('outside secret body')
  })

  it('rejects unknown read arguments', async () => {
    const root = tempDir('locator-http-v1-read-extra-')
    const harness = registerV1(fakeRuntime([root]))
    const body = (await callRoute(harness, '/dsh-locator/v1/read', fakeRequest({ path: join(root, 'a.md'), filesOnly: true }))).json()
    expect(body).toMatchObject({ ok: false, tool: 'locator_http' })
    expect(errorOf(body).code).toBe('invalid-argument')
    expect(String(errorOf(body).message)).toContain('filesOnly')
  })
})

describe('/v1 status', () => {
  const engineStatus = async () => ({
    version: '0.23.0-test',
    platform: 'test',
    roots: ['/v1-root'],
    entries: 12,
    files: 10,
    dirs: 2,
    watching: true,
  })

  it('answers the brief envelope by default', async () => {
    const harness = registerV1(fakeRuntime([], [], { engineStatus }))
    const response = await callRoute(harness, '/dsh-locator/v1/status', fakeRequest({}))
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({ apiVersion: '2026-11', ok: true, tool: 'locator_status', detail: 'brief' })
    expect(typeof body.summary).toBe('string')
    expect(body.index).toMatchObject({ running: false, entries: 12, files: 10, dirs: 2, watching: true, roots: 1 })
    expect(body.content).toMatchObject({ enabled: false })
  })

  it('serves the full legacy status on request', async () => {
    const harness = registerV1(fakeRuntime([], [], { engineStatus }))
    const body = (await callRoute(harness, '/dsh-locator/v1/status', fakeRequest({ detail: 'full' }))).json()
    expect(body).toMatchObject({ ok: true, tool: 'locator_status', detail: 'full' })
    const status = body.status as Record<string, unknown>
    expect(status.ok).toBe(true)
    expect(status.roots).toEqual(['/v1-root'])
    expect(status.entries).toBe(12)
  })

  it('rejects unknown fields and invalid detail', async () => {
    const harness = registerV1(fakeRuntime())
    const unknown = (await callRoute(harness, '/dsh-locator/v1/status', fakeRequest({ admin: true }))).json()
    expect(unknown).toMatchObject({ ok: false, tool: 'locator_http' })
    expect(errorOf(unknown).code).toBe('invalid-argument')
    const badDetail = (await callRoute(harness, '/dsh-locator/v1/status', fakeRequest({ detail: 'everything' }))).json()
    expect(badDetail).toMatchObject({ ok: false, tool: 'locator_status' })
    expect(errorOf(badDetail).code).toBe('invalid-argument')
  })
})

describe('legacy route deprecation (0.23.0)', () => {
  it('marks /content deprecated in both response header and body', async () => {
    const content = fakeContent({ hits: [contentHttpHit('/tmp/deprecated.md')] })
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime(), content)
    const response = await callRoute(harness, '/dsh-locator/content', fakeRequest({ query: 'needle' }))
    expect(response.statusCode).toBe(200)
    expect(response.headers.get('deprecation')).toBe('true')
    expect(String(response.headers.get('warning'))).toContain('/dsh-locator/content')
    expect(response.json()).toMatchObject({ ok: true, deprecated: true, replacement: '/dsh-locator/v1/find' })
  })

  it('marks /content/rebuild deprecated in both response header and body', async () => {
    const base = fakeContent() as unknown as Record<string, unknown>
    const content = { ...base, refreshNow: () => true, rebuild: () => true } as unknown as ContentIndex
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime(), content)
    const response = await callRoute(harness, '/dsh-locator/content/rebuild', fakeRequest({ full: false }))
    expect(response.statusCode).toBe(200)
    expect(response.headers.get('deprecation')).toBe('true')
    expect(String(response.headers.get('warning'))).toContain('locator_admin')
    expect(response.json()).toMatchObject({ ok: true, deprecated: true, replacement: 'locator_admin' })
  })

  it('keeps /search and the panel routes undeprecated', async () => {
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], [httpHit('/root/a.md')]))
    const response = await callRoute(harness, '/dsh-locator/search', fakeRequest({ query: 'a' }))
    expect(response.statusCode).toBe(200)
    expect(response.headers.get('deprecation')).toBeUndefined()
    expect(response.json()).toMatchObject({ ok: true, mode: 'names' })
    for (const path of ['/dsh-locator/status', '/dsh-locator/combined', '/dsh-locator/open', '/dsh-locator/reveal']) {
      expect(harness.routes.some(route => route.path === path)).toBe(true)
    }
  })
})
