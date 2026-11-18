/**
 * MCP stdio server and public CLI contract.
 *
 * Both deliverables are scripts (not compiled modules), so the tests exercise
 * their real process boundary: spawn the script, speak the protocol, assert the
 * wire format. No live DSH host is involved; the name path uses the bundled Go
 * engine on a temporary root and the content path a hand-built content.db.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const scriptDir = join(import.meta.dirname, '..', 'scripts')
const cliPath = join(scriptDir, 'locator-cli.mjs')
const mcpPath = join(scriptDir, 'locator-mcp.mjs')
const packageVersion = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }).version
const engineName = process.platform === 'win32' ? 'indexd.exe' : 'indexd'
const engineBinary = join(import.meta.dirname, '..', 'bin', process.platform + '-' + process.arch, engineName)

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

/** A minimal MCP client over the real child process stdio. */
class McpClient {
  private readonly child: ChildProcessWithoutNullStreams
  private nextId = 1
  private readonly pending = new Map<number, (message: JsonRpcMessage) => void>()
  /** Responses with an id the client never sent (parse errors, batch replies). */
  readonly stray: JsonRpcMessage[] = []

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [mcpPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...env },
    })
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      const text = line.trim()
      if (text === '') return
      let parsed: JsonRpcMessage | JsonRpcMessage[]
      try { parsed = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[] } catch { return }
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        const waiter = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
        if (waiter !== undefined) {
          this.pending.delete(message.id as number)
          waiter(message)
        } else {
          this.stray.push(message)
        }
      }
    })
  }

  request(method: string, params?: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('MCP response timeout for ' + method))
      }, 20_000)
      this.pending.set(id, message => {
        clearTimeout(timer)
        resolve(message)
      })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n')
    })
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n')
  }

  writeRaw(line: string): void {
    this.child.stdin.write(line + '\n')
  }

  async waitForStray(predicate: (message: JsonRpcMessage) => boolean, timeoutMs = 5_000): Promise<JsonRpcMessage> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.stray.find(predicate)
      if (found !== undefined) return found
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('no matching stray MCP message')
  }

  close(): void {
    try { this.child.stdin.end() } catch { /* ignore */ }
    try { this.child.kill() } catch { /* ignore */ }
  }
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

/** Build a content.db with the same schema the plugin uses. */
function makeContentDb(stateDir: string, docs: Array<{ kind: 'file' | 'session'; path: string; title: string; body: string; sessionId?: string; messageId?: string }>): string {
  mkdirSync(stateDir, { recursive: true })
  const dbPath = join(stateDir, 'content.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec("CREATE VIRTUAL TABLE docs USING fts5(body, kind UNINDEXED, path UNINDEXED, title UNINDEXED, session_id UNINDEXED, message_id UNINDEXED, tokenize = 'trigram')")
    db.exec('CREATE TABLE docs_meta (rowid INTEGER PRIMARY KEY, doc_key TEXT UNIQUE, path TEXT, mtime INTEGER, kind TEXT, node_key TEXT)')
    db.exec('CREATE TABLE sources (path TEXT PRIMARY KEY, mtime INTEGER)')
    db.exec('CREATE TABLE content_meta (key TEXT PRIMARY KEY, value INTEGER)')
    const insert = db.prepare('INSERT INTO docs (body, kind, path, title, session_id, message_id) VALUES (?, ?, ?, ?, ?, ?)')
    for (const doc of docs) {
      insert.run(doc.body, doc.kind, doc.path, doc.title, doc.sessionId ?? null, doc.messageId ?? null)
    }
  } finally {
    db.close()
  }
  return dbPath
}

function toolPayload(message: JsonRpcMessage): Record<string, unknown> {
  const result = message.result as { content?: Array<{ text?: string }> } | undefined
  return JSON.parse(result?.content?.[0]?.text ?? '{}') as Record<string, unknown>
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true, timeout: 60_000 })
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

describe('MCP protocol model', () => {
  it('initializes with read-only capabilities, serves tools/list and rejects unknown methods', async () => {
    const root = tempDir('locator-mcp-root-')
    const client = new McpClient({ DSH_LOCATOR_ROOTS: root, DSH_LOCATOR_STATE: join(root, 'state') })
    try {
      const init = await client.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '1' },
      })
      const initResult = init.result as { protocolVersion?: string; capabilities?: { tools?: { listChanged?: boolean } }; serverInfo?: { name?: string; version?: string }; instructions?: string }
      expect(initResult.protocolVersion).toBe('2025-06-18')
      expect(initResult.serverInfo?.name).toBe('dsh-locator')
      expect(initResult.serverInfo?.version).toBe(packageVersion)
      expect(initResult.capabilities?.tools?.listChanged).toBe(false)
      expect(initResult.instructions).toContain(root)
      client.notify('notifications/initialized')
      const ping = await client.request('ping')
      expect(ping.result).toEqual({})

      const list = await client.request('tools/list')
      const tools = (list.result as { tools: Array<{ name: string; description: string; inputSchema: { type: string }; annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } }> }).tools
      expect(tools.map(tool => tool.name)).toEqual(['locator_search', 'locator_find', 'locator_status', 'locator_resolve', 'locator_cite'])
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe('object')
        expect(tool.annotations.readOnlyHint).toBe(true)
        expect(tool.annotations.destructiveHint).toBe(false)
      }

      const unknown = await client.request('tools/nonexistent')
      expect(unknown.error?.code).toBe(-32601)

      // An unknown tool is a protocol-level invalid-params failure, not a tool result.
      const call = await client.request('tools/call', { name: 'locator_nope', arguments: {} })
      expect(call.error?.code).toBe(-32602)

      const resources = await client.request('resources/list')
      expect(resources.result).toEqual({ resources: [] })
    } finally {
      client.close()
    }
  })

  it('negotiates the fallback protocol version and answers malformed JSON with -32700', async () => {
    const root = tempDir('locator-mcp-fallback-')
    const client = new McpClient({ DSH_LOCATOR_ROOTS: root, DSH_LOCATOR_STATE: join(root, 'state') })
    try {
      const init = await client.request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
      expect((init.result as { protocolVersion?: string }).protocolVersion).toBe('2024-11-05')
      client.writeRaw('{not json')
      const parseError = await client.waitForStray(message => message.error?.code === -32700)
      expect(parseError.id).toBeNull()
    } finally {
      client.close()
    }
  })

  it('serves locator_cite without the index and keeps tool errors as isError results', async () => {
    const root = tempDir('locator-mcp-cite-')
    const client = new McpClient({ DSH_LOCATOR_ROOTS: root, DSH_LOCATOR_STATE: join(root, 'state') })
    try {
      const cite = await client.request('tools/call', {
        name: 'locator_cite',
        arguments: { refs: ['ref://file?path=' + encodeURIComponent(join(root, 'notes.md'))], format: 'markdown' },
      })
      expect((cite.result as { isError?: boolean }).isError).toBe(false)
      const payload = toolPayload(cite) as { ok?: boolean; citations?: Array<{ markdown?: string }> }
      expect(payload.ok).toBe(true)
      expect(payload.citations?.[0]?.markdown).toContain('ref://file')
      const bad = await client.request('tools/call', { name: 'locator_search', arguments: {} })
      expect((bad.result as { isError?: boolean }).isError).toBe(true)
      const payloadBad = toolPayload(bad) as { ok?: boolean; error?: { code?: string } }
      expect(payloadBad.ok).toBe(false)
      expect(payloadBad.error?.code).toBe('invalid-arguments')
    } finally {
      client.close()
    }
  })

  it.skipIf(!existsSync(engineBinary))('searches the local name index through the MCP tool', async () => {
    const root = tempDir('locator-mcp-search-')
    writeFileSync(join(root, 'alpha.md'), 'x')
    const client = new McpClient({ DSH_LOCATOR_ROOTS: root, DSH_LOCATOR_STATE: join(root, 'state') })
    try {
      const search = await client.request('tools/call', { name: 'locator_search', arguments: { query: 'alpha', limit: 5 } })
      expect((search.result as { isError?: boolean }).isError).toBe(false)
      const payload = toolPayload(search) as { ok?: boolean; total?: number; hits?: Array<{ path: string }> }
      expect(payload.ok).toBe(true)
      expect(payload.total).toBe(1)
      expect(payload.hits?.[0]?.path).toBe(join(root, 'alpha.md'))
    } finally {
      client.close()
    }
  })
})

describe('locator-cli', () => {
  it('prints help and version, and rejects usage errors with exit code 2', () => {
    const help = runCli(['help'])
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('locator-cli search')
    expect(help.stdout).toContain('Exit codes: 0 ok, 1 runtime error, 2 usage error, 3 index/engine unavailable')
    const version = runCli(['version'])
    expect(version.status).toBe(0)
    expect(version.stdout).toBe(packageVersion)
    const missingQuery = runCli(['search', '--json'])
    expect(missingQuery.status).toBe(2)
    expect(missingQuery.stdout).toContain('"code": "usage"')
    const unknownOption = runCli(['search', 'x', '--nope'])
    expect(unknownOption.status).toBe(2)
    const badNumber = runCli(['find', 'x', '--limit', 'abc'])
    expect(badNumber.status).toBe(2)
    const unknownCommand = runCli(['wat'])
    expect(unknownCommand.status).toBe(2)
    expect(unknownCommand.stderr).toContain('unknown command: wat')
  })

  it('searches content.db directly (find mode) with snippets and line numbers', () => {
    const root = tempDir('locator-cli-content-')
    const state = join(root, 'state')
    const file = join(root, 'notes.md')
    writeFileSync(file, 'one\ntwo needle here\nthree\n')
    makeContentDb(state, [{ kind: 'file', path: file, title: 'notes.md', body: 'one\ntwo needle here\nthree\n' }])
    const result = runCli(['find', 'needle', '--state', state, '--root', root, '--json'])
    expect(result.status).toBe(0)
    const payload = JSON.parse(result.stdout) as { ok: boolean; command: string; hits: Array<{ path: string; snippet: string; line?: number }>; returned: number }
    expect(payload.ok).toBe(true)
    expect(payload.command).toBe('find')
    expect(payload.returned).toBe(1)
    expect(payload.hits[0]?.path).toBe(file)
    expect(payload.hits[0]?.snippet).toContain('needle')
    expect(payload.hits[0]?.line).toBe(2)
  })

  it('rejects content queries shorter than a trigram with a clear code', () => {
    const root = tempDir('locator-cli-short-')
    const state = join(root, 'state')
    makeContentDb(state, [{ kind: 'file', path: join(root, 'a.md'), title: 'a.md', body: 'tiny body' }])
    const result = runCli(['find', 'ab', '--state', state, '--root', root, '--json'])
    expect(result.status).toBe(2)
    const payload = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } }
    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe('content-query-too-short')
    const missing = runCli(['find', 'needle', '--state', join(root, 'missing-state'), '--root', root, '--json'])
    expect(missing.status).toBe(3)
    expect((JSON.parse(missing.stdout) as { error: { code: string } }).error.code).toBe('content-index-missing')
  })

  it.skipIf(!existsSync(engineBinary))('runs a real name search through the bundled engine', () => {
    const root = tempDir('locator-cli-search-')
    writeFileSync(join(root, 'alpha.md'), 'x')
    const state = join(root, 'state')
    const result = runCli(['search', 'alpha', '--root', root, '--state', state, '--json', '--limit', '5'])
    expect(result.status).toBe(0)
    const payload = JSON.parse(result.stdout) as { ok: boolean; mode: string; total: number; hits: Array<{ path: string }> }
    expect(payload.ok).toBe(true)
    expect(payload.mode).toBe('names')
    expect(payload.total).toBe(1)
    expect(payload.hits[0]?.path).toBe(join(root, 'alpha.md'))
  })

  it.skipIf(!existsSync(engineBinary))('reports status with engine and content counts', () => {
    const root = tempDir('locator-cli-status-')
    const state = join(root, 'state')
    makeContentDb(state, [{ kind: 'file', path: join(root, 'doc.md'), title: 'doc.md', body: 'body' }])
    const result = runCli(['status', '--state', state, '--root', root, '--json'])
    expect(result.status).toBe(0)
    const payload = JSON.parse(result.stdout) as { ok: boolean; engine: { ok: boolean }; content: { available: boolean; files?: number } }
    expect(payload.ok).toBe(true)
    expect(payload.engine.ok).toBe(true)
    expect(payload.content.available).toBe(true)
    expect(payload.content.files).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('honours DSH_LOCATOR_BIN for a custom engine build', () => {
    const root = tempDir('locator-cli-bin-')
    const mock = join(root, 'mock-indexd')
    const mockLines = [
      '#!/usr/bin/env node',
      "const readline = require('node:readline')",
      'process.stdout.write(JSON.stringify({ event: "ready" }) + String.fromCharCode(10))',
      "const rl = readline.createInterface({ input: process.stdin })",
      "rl.on('line', line => {",
      '  let message',
      '  try { message = JSON.parse(line) } catch { return }',
      "  if (message.method === 'shutdown') process.exit(0)",
      "  if (message.method !== 'search') return",
      "  const hit = { path: process.env.DSH_LOCATOR_MOCK_PATH, name: 'mock.md', size: 1, mtime: 1700000000000, ext: 'md', dir: false }",
      '  process.stdout.write(JSON.stringify({ id: message.id, result: { total: 1, returned: 1, offset: 0, truncated: false, tookNs: 1000, hits: [hit] } }) + String.fromCharCode(10))',
      '})',
    ]
    writeFileSync(mock, mockLines.join('\n'))
    chmodSync(mock, 0o755)
    const state = join(root, 'state')
    const result = runCli(['search', 'mock', '--root', root, '--state', state, '--json'], { DSH_LOCATOR_BIN: mock, DSH_LOCATOR_MOCK_PATH: join(root, 'mock.md') })
    expect(result.status).toBe(0)
    const payload = JSON.parse(result.stdout) as { ok: boolean; total: number; hits: Array<{ path: string }> }
    expect(payload.total).toBe(1)
    expect(payload.hits[0]?.path).toBe(join(root, 'mock.md'))
  })
})
