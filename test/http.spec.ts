/**
 * HTTP surface security: fail-closed registration, the connection trust fence,
 * wire-format validation (POST + application/json), and the local same-origin
 * checks. The handlers are exercised through a fake WebServer and fake
 * IncomingMessage/ServerResponse objects, so no listener is opened and no
 * platform opener is spawned.
 */

import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
  it('advances nextOffset past the whole name page when the output budget trims it', async () => {
    const hits = [httpHit('/root/a.md'), httpHit('/root/b.md'), httpHit('/root/c.md')]
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], hits, { config: { outputBudgetChars: 120 } }))
    const body = (await callRoute(harness, '/dsh-locator/search', fakeRequest({ query: 'a', limit: 3 }))).json()
    const returned = (body.hits as unknown[]).length
    expect(body.ok).toBe(true)
    expect(returned).toBeLessThan(3)
    expect(body.budget).toMatchObject({ truncated: true })
    // One page, not one request per dropped row: advance by the fetched page.
    expect(body.nextOffset).toBe(3)
  })

  it('advances nextOffset past rows dropped by the scope filter', async () => {
    const hits = [httpHit('/root/a.md'), httpHit('/root/b.md'), httpHit('/root/c.md')]
    const scope = new Scope({ notSearchable: ['b.md'], notReadable: [], notIndexed: [] }, false)
    const harness = fakeHarness({ connection: new FakeConnection() })
    registerHttp(harness.ctx, fakeRuntime([], hits), undefined, undefined, {}, undefined, scope)
    const body = (await callRoute(harness, '/dsh-locator/search', fakeRequest({ query: 'a', limit: 3 }))).json()
    expect(body.ok).toBe(true)
    expect((body.hits as Array<{ path: string }>).map(hit => hit.path)).toEqual(['/root/a.md', '/root/c.md'])
    expect(body.truncated).toBe(true)
    expect(body.nextOffset).toBe(3)
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
    expect(body.nextOffset).toBe(3)
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
