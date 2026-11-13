/**
 * HTTP surface security: fail-closed registration, the connection trust fence,
 * wire-format validation (POST + application/json), and the local same-origin
 * checks. The handlers are exercised through a fake WebServer and fake
 * IncomingMessage/ServerResponse objects, so no listener is opened and no
 * platform opener is spawned.
 */

import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isJsonContentType, originRejection, registerHttp } from '../src/http.ts'
import type { LocatorRuntime } from '../src/runtime.ts'

interface RegisteredRoute {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
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

interface FakeHarness {
  ctx: Context
  routes: RegisteredRoute[]
  connection: FakeConnection | undefined
  setConnection(connection: FakeConnection | undefined): void
}

function fakeHarness(options: { connection?: FakeConnection; missingDeps?: readonly string[] } = {}): FakeHarness {
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

  setHeader(name: string, value: unknown): void {
    this.headers.set(name.toLowerCase(), value)
  }

  end(chunk?: unknown): void {
    this.writableEnded = true
    if (typeof chunk === 'string') this.body = chunk
    else if (Buffer.isBuffer(chunk)) this.body = chunk.toString('utf8')
  }

  json(): Record<string, unknown> {
    return this.body === '' ? {} : JSON.parse(this.body) as Record<string, unknown>
  }
}

function fakeRuntime(roots: readonly string[] = []): LocatorRuntime {
  return {
    roots: [...roots],
    stateDir: join(tmpdir(), 'locator-http-state'),
    status: { running: false },
    config: { maxResults: 100 },
    start: () => {},
    engineStatus: async () => undefined,
    search: async () => ({ total: 0, returned: 0, offset: 0, truncated: false, tookNs: 0, hits: [] }),
  } as unknown as LocatorRuntime
}

function fakeRequest(body: unknown, headers: Record<string, string> = {}, method = 'POST'): IncomingMessage {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const request = Readable.from(text === '' ? [] : [Buffer.from(text)]) as unknown as IncomingMessage
  Reflect.set(request, 'method', method)
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
): Promise<FakeResponse> {
  const route = harness.routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  const response = new FakeResponse()
  await route.handler(request, response as unknown as ServerResponse)
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
