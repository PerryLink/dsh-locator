/**
 * MCP stdio server and public CLI contract.
 *
 * Both deliverables are scripts (not compiled modules), so the tests exercise
 * their real process boundary: spawn the script, speak the protocol, assert the
 * wire format. No live DSH host is involved; the name path uses the bundled Go
 * engine on a temporary root and the content path a hand-built content.db.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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

  /**
   * End stdin and wait for the server to exit on its own.
   *
   * This is the graceful lifecycle path (EOF), so it also proves that the
   * server stops its long-lived engine and deletes the temporary state copy.
   */
  async exit(timeoutMs = 15_000): Promise<number | null> {
    const child = this.child
    const exited = new Promise<number | null>(resolve => {
      if (child.exitCode !== null) { resolve(child.exitCode); return }
      child.once('exit', code => resolve(code))
    })
    try { child.stdin.end() } catch { /* already ended */ }
    return await Promise.race([
      exited,
      new Promise<number | null>((_, reject) => {
        setTimeout(() => reject(new Error('MCP server did not exit after EOF')), timeoutMs)
      }),
    ])
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

/**
 * Build a content.db with the schema v4 shape the plugin writes since 0.21.0:
 * normalized paths dictionary, integer document kinds (0 = file, 1 = session)
 * and the same derived indexes. docs_meta.rowid mirrors docs.rowid, which is
 * what every content query joins on.
 */
function makeContentDb(
  stateDir: string,
  docs: Array<{ kind: 'file' | 'session'; path: string; title: string; body: string; sessionId?: string; messageId?: string }>,
  sources: Array<{ path: string; cwd: string; mtime?: number }> = [],
): string {
  mkdirSync(stateDir, { recursive: true })
  const dbPath = join(stateDir, 'content.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec("CREATE VIRTUAL TABLE docs USING fts5(body, kind UNINDEXED, path UNINDEXED, title UNINDEXED, session_id UNINDEXED, message_id UNINDEXED, tokenize = 'trigram')")
    db.exec('CREATE TABLE paths (id INTEGER PRIMARY KEY, path TEXT NOT NULL)')
    db.exec('CREATE UNIQUE INDEX paths_path ON paths(path)')
    db.exec('CREATE TABLE docs_meta (rowid INTEGER PRIMARY KEY, path_id INTEGER NOT NULL, mtime INTEGER, kind_id INTEGER NOT NULL, node_key TEXT, format TEXT, session_key TEXT)')
    db.exec('CREATE INDEX docs_meta_path_id ON docs_meta(path_id)')
    db.exec('CREATE INDEX docs_meta_mtime ON docs_meta(mtime, rowid)')
    db.exec('CREATE UNIQUE INDEX docs_meta_file_path ON docs_meta(path_id) WHERE kind_id = 0')
    db.exec('CREATE UNIQUE INDEX docs_meta_session_key ON docs_meta(session_key) WHERE kind_id = 1')
    db.exec('CREATE TABLE symbols (path_id INTEGER NOT NULL, name TEXT NOT NULL, kind INTEGER NOT NULL, line INTEGER NOT NULL, language INTEGER, scope TEXT)')
    // Schema v4 sources shape: one row per indexed session log, including the
    // workspace cwd the CLI cross-checks when allowSessions is requested.
    db.exec('CREATE TABLE sources (path TEXT PRIMARY KEY, mtime INTEGER, cwd TEXT, byte_len INTEGER, last_line INTEGER, title TEXT, capped INTEGER)')
    db.exec('CREATE TABLE content_meta (key TEXT PRIMARY KEY, value INTEGER)')
    db.exec('PRAGMA user_version = 4')
    const insertDoc = db.prepare('INSERT INTO docs (rowid, body, kind, path, title, session_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const insertPath = db.prepare('INSERT INTO paths (path) VALUES (?) ON CONFLICT(path) DO UPDATE SET path = excluded.path RETURNING id')
    const insertMeta = db.prepare('INSERT INTO docs_meta (rowid, path_id, mtime, kind_id, node_key, format, session_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const [index, doc] of docs.entries()) {
      const rowid = index + 1
      insertDoc.run(rowid, doc.body, doc.kind, doc.path, doc.title, doc.sessionId ?? null, doc.messageId ?? null)
      const pathId = Number((insertPath.get(doc.path) as { id?: number } | undefined)?.id ?? 0)
      const kindId = doc.kind === 'session' ? 1 : 0
      const sessionKey = kindId === 1
        ? 'session:' + (doc.sessionId ?? 'none') + ':' + (doc.messageId ?? 'row-' + String(index))
        : null
      insertMeta.run(rowid, pathId, index, kindId, null, null, sessionKey)
    }
    const insertSource = db.prepare('INSERT INTO sources (path, mtime, cwd) VALUES (?, ?, ?)')
    for (const [index, source] of sources.entries()) insertSource.run(source.path, source.mtime ?? index, source.cwd)
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

/**
 * Poll a value-producing call until the predicate holds.
 *
 * The engine now waits for its first scan, but a CI filesystem can still be
 * slower than one attempt (cold snapshot, antivirus on Windows); the tests
 * assert the converged state instead of the timing of the first attempt.
 */
async function eventually<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, timeoutMs = 20_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (predicate(value) || Date.now() >= deadline) return value
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

/**
 * Write a fake engine whose first scan finishes after `scanMs`: it announces
 * `scanning: true`, answers status/search accordingly, and only returns the
 * hit once the scan is done. Used to pin the CLI's wait-for-scan contract
 * without depending on real filesystem timing.
 */
function writeScanMock(root: string): string {
  const mock = join(root, 'mock-indexd')
  const lines = [
    '#!/usr/bin/env node',
    "const readline = require('node:readline')",
    "const scanMs = Number(process.env.DSH_LOCATOR_MOCK_SCAN_MS ?? '0')",
    'const started = Date.now()',
    "process.stdout.write(JSON.stringify({ event: 'ready', params: { scanning: true, roots: [], entries: 0 } }) + String.fromCharCode(10))",
    "const rl = readline.createInterface({ input: process.stdin })",
    "rl.on('line', line => {",
    '  let message',
    '  try { message = JSON.parse(line) } catch { return }',
    "  if (message.method === 'shutdown') process.exit(0)",
    '  const scanning = Date.now() - started < scanMs',
    "  if (message.method === 'status') {",
    '    process.stdout.write(JSON.stringify({ id: message.id, result: { scanning, entries: scanning ? 0 : 1 } }) + String.fromCharCode(10))',
    '    return',
    '  }',
    "  if (message.method !== 'search') return",
    "  const hit = { path: process.env.DSH_LOCATOR_MOCK_PATH, name: 'mock.md', size: 1, mtime: 1700000000000, ext: 'md', dir: false }",
    '  const hits = scanning ? [] : [hit]',
    '  process.stdout.write(JSON.stringify({ id: message.id, result: { total: hits.length, returned: hits.length, offset: 0, truncated: false, tookNs: 1000, indexing: scanning, hits } }) + String.fromCharCode(10))',
    '})',
  ]
  writeFileSync(mock, lines.join('\n'))
  chmodSync(mock, 0o755)
  return mock
}


/** Content hash, size and mtime of every regular file in one directory. */
function dirSnapshot(dir: string): Array<{ name: string; sha256: string; size: number; mtime: number }> {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const path = join(dir, entry.name)
      const info = statSync(path)
      return { name: entry.name, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), size: info.size, mtime: info.mtimeMs }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Build a real engine state directory (index.snapshot + meta.json) for one root. */
function buildEngineState(stateDir: string, root: string): void {
  mkdirSync(stateDir, { recursive: true })
  const result = spawnSync(engineBinary, ['scan', '--state', stateDir, '--root', root], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  if (result.status !== 0 || !existsSync(join(stateDir, 'index.snapshot'))) {
    throw new Error('engine scan failed (status ' + String(result.status) + '): ' + String(result.stderr ?? '').slice(0, 400))
  }
}

/**
 * A fake engine that records each spawn (counter file) and the --state it
 * received. Used to prove the MCP server spawns one engine for many calls and
 * points it at a temporary copy instead of the caller state directory.
 */
function writeCountedMock(root: string): string {
  const mock = join(root, 'counted-indexd')
  const lines = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs')",
    "const readline = require('node:readline')",
    'fs.appendFileSync(process.env.DSH_LOCATOR_MOCK_COUNTER, \'spawn\' + String.fromCharCode(10))',
    'fs.writeFileSync(process.env.DSH_LOCATOR_MOCK_STATE, process.argv[process.argv.indexOf(\'--state\') + 1] || \'\')',
    "process.stdout.write(JSON.stringify({ event: 'ready', params: { scanning: false, roots: [], entries: 1, files: 1 } }) + String.fromCharCode(10))",
    "const rl = readline.createInterface({ input: process.stdin })",
    "rl.on('line', line => {",
    "  let message",
    "  try { message = JSON.parse(line) } catch { return }",
    "  if (message.method === 'shutdown') process.exit(0)",
    "  if (message.method === 'status') {",
    "    process.stdout.write(JSON.stringify({ id: message.id, result: { scanning: false, entries: 1, files: 1, dirs: 0, version: 'mock' } }) + String.fromCharCode(10))",
    "    return",
    "  }",
    "  if (message.method !== 'search') return",
    "  const hit = { path: process.env.DSH_LOCATOR_MOCK_PATH, name: 'alpha.md', size: 1, mtime: 1700000000000, ext: 'md', dir: false }",
    "  process.stdout.write(JSON.stringify({ id: message.id, result: { total: 1, returned: 1, offset: 0, truncated: false, hits: [hit] } }) + String.fromCharCode(10))",
    "})",
  ]
  writeFileSync(mock, lines.join('\n'))
  chmodSync(mock, 0o755)
  return mock
}

/** A dedicated temp directory exposed as TMPDIR/TEMP/TMP to a child process. */
function sandboxTmp(base: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = join(base, 'tmp')
  mkdirSync(dir, { recursive: true })
  return { dir, env: { TMPDIR: dir, TEMP: dir, TMP: dir } }
}

/** Read the spawn counter written by writeCountedMock. */
function spawnCount(counterPath: string): number {
  if (!existsSync(counterPath)) return 0
  return readFileSync(counterPath, 'utf8').trim().split('\n').filter(line => line !== '').length
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
      const tools = (list.result as { tools: Array<{ name: string; title?: string; description: string; inputSchema: { type: string }; outputSchema?: { type?: string; required?: string[] }; annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } }> }).tools
      expect(tools.map(tool => tool.name)).toEqual(['locator_search', 'locator_find', 'locator_status', 'locator_resolve', 'locator_cite'])
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe('object')
        expect(tool.title).toBeTruthy()
        // AI contract: every tool publishes a machine-readable output schema.
        expect(tool.outputSchema?.type).toBe('object')
        expect(tool.outputSchema?.required).toContain('ok')
        expect(tool.annotations.readOnlyHint).toBe(true)
        expect(tool.annotations.destructiveHint).toBe(false)
        expect(tool.annotations.idempotentHint).toBe(true)
        expect(tool.annotations.openWorldHint).toBe(false)
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

      // A core result with ok=false (path outside every root) must also become
      // an isError tool result, not a successful call with an error payload.
      const denied = await client.request('tools/call', {
        name: 'locator_resolve',
        arguments: { ref: 'ref://file?path=' + encodeURIComponent(join(root, '..', 'outside.md')) },
      })
      expect((denied.result as { isError?: boolean }).isError).toBe(true)
      const payloadDenied = toolPayload(denied) as { ok?: boolean; error?: string }
      expect(payloadDenied.ok).toBe(false)
      expect(payloadDenied.error).toBe('content-path-denied')
    } finally {
      client.close()
    }
  })

  it.skipIf(!existsSync(engineBinary))('searches the local name index through the MCP tool', async () => {
    const root = tempDir('locator-mcp-search-')
    writeFileSync(join(root, 'alpha.md'), 'x')
    const client = new McpClient({ DSH_LOCATOR_ROOTS: root, DSH_LOCATOR_STATE: join(root, 'state') })
    try {
      // One-shot name searches start a fresh engine session, so a cold scan may
      // still be running when the first call lands; assert the converged state.
      const payload = await eventually(async () => {
        const search = await client.request('tools/call', { name: 'locator_search', arguments: { query: 'alpha', limit: 5 } })
        expect((search.result as { isError?: boolean }).isError).toBe(false)
        return toolPayload(search) as { ok?: boolean; total?: number; hits?: Array<{ path: string }> }
      }, value => value.total === 1)
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

  it.skipIf(!existsSync(engineBinary))('runs a real name search through the bundled engine', async () => {
    const root = tempDir('locator-cli-search-')
    writeFileSync(join(root, 'alpha.md'), 'x')
    const state = join(root, 'state')
    // The CLI waits for the engine's first scan itself; the poll keeps the
    // assertion independent of a cold filesystem on Windows/macOS CI.
    const payload = await eventually(() => {
      const result = runCli(['search', 'alpha', '--root', root, '--state', state, '--json', '--limit', '5'])
      expect(result.status).toBe(0)
      return JSON.parse(result.stdout) as { ok: boolean; mode: string; total: number; hits: Array<{ path: string }> }
    }, value => value.total === 1)
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

  it.skipIf(process.platform === 'win32')('waits for the engine initial scan before a one-shot search', () => {
    const root = tempDir('locator-cli-scan-')
    const mock = writeScanMock(root)
    const file = join(root, 'mock.md')
    const result = runCli(['search', 'mock', '--root', root, '--state', join(root, 'state'), '--json'], {
      DSH_LOCATOR_BIN: mock,
      DSH_LOCATOR_MOCK_PATH: file,
      DSH_LOCATOR_MOCK_SCAN_MS: '120',
    })
    expect(result.status).toBe(0)
    const payload = JSON.parse(result.stdout) as { ok: boolean; total: number; indexing?: boolean; warnings?: string[]; hits: Array<{ path: string }> }
    expect(payload.ok).toBe(true)
    expect(payload.total).toBe(1)
    expect(payload.indexing).toBe(false)
    expect(payload.warnings).toBeUndefined()
    expect(payload.hits[0]?.path).toBe(file)
  })

  it.skipIf(process.platform === 'win32')('returns a partial result plus a warning when the scan outlasts the wait', () => {
    const root = tempDir('locator-cli-scan-timeout-')
    const mock = writeScanMock(root)
    const result = runCli(['search', 'mock', '--root', root, '--state', join(root, 'state'), '--json'], {
      DSH_LOCATOR_BIN: mock,
      DSH_LOCATOR_MOCK_PATH: join(root, 'mock.md'),
      DSH_LOCATOR_MOCK_SCAN_MS: '60000',
      DSH_LOCATOR_SCAN_TIMEOUT: '150',
    })
    expect(result.status).toBe(0)
    const payload = JSON.parse(result.stdout) as { ok: boolean; total: number; indexing?: boolean; warnings?: string[] }
    expect(payload.ok).toBe(true)
    expect(payload.total).toBe(0)
    expect(payload.indexing).toBe(true)
    expect(payload.warnings).toContain('initial-scan-incomplete')
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
describe('read-only state helper', () => {
  // Windows Node 22/24 throws a SyntaxError when dynamically importing this ESM
  // script (the real CLI integration test below still proves read-only state).
  it.skipIf(process.platform === 'win32')('copies the state files into a private temp directory and never touches the source', async () => {
    interface PreparedState {
      engineStateDir: string
      copied: string[]
      readOnly: boolean
      cleanup: () => void
    }
    interface CliModule { prepareReadOnlyState: (stateDir: string) => PreparedState }
    const cli = await import(pathToFileURL(cliPath).href) as CliModule
    const base = tempDir('locator-ro-helper-')
    const state = join(base, 'state')
    mkdirSync(state, { recursive: true })
    const names = ['index.snapshot', 'index.journal', 'meta.json']
    for (const name of names) writeFileSync(join(state, name), 'content-of-' + name)
    const before = dirSnapshot(state)
    const prepared = cli.prepareReadOnlyState(state)
    try {
      expect(prepared.readOnly).toBe(true)
      expect([...prepared.copied].sort()).toEqual([...names].sort())
      for (const name of names) {
        expect(readFileSync(join(prepared.engineStateDir, name), 'utf8')).toBe('content-of-' + name)
      }
      expect(prepared.engineStateDir).not.toBe(state)
      expect(existsSync(prepared.engineStateDir)).toBe(true)
      expect(dirSnapshot(state)).toEqual(before)
    } finally {
      prepared.cleanup()
    }
    expect(existsSync(prepared.engineStateDir)).toBe(false)
    expect(dirSnapshot(state)).toEqual(before)
    // A missing source directory is never created as a side effect.
    const missing = join(base, 'never-created')
    const empty = cli.prepareReadOnlyState(missing)
    try {
      expect(empty.copied).toEqual([])
      expect(existsSync(missing)).toBe(false)
    } finally {
      empty.cleanup()
    }
    expect(existsSync(empty.engineStateDir)).toBe(false)
  })
})
describe('read-only state (P0)', () => {
  it.skipIf(!existsSync(engineBinary))('CLI status/search never mutate the caller state directory', () => {
    const base = tempDir('locator-ro-state-')
    const root = join(base, 'root')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'alpha.md'), 'x')
    const state = join(base, 'state')
    buildEngineState(state, root)
    const sandbox = sandboxTmp(base)
    const before = dirSnapshot(state)
    const stateDirMtime = statSync(state).mtimeMs
    expect(before.map(file => file.name)).toContain('index.snapshot')
    for (const command of [
      ['status'],
      ['status'],
      ['search', 'alpha'],
    ]) {
      const result = runCli([...command, '--state', state, '--root', root, '--json'], sandbox.env)
      expect(result.status).toBe(0)
      // The temporary engine state copy is deleted when the process exits.
      expect(readdirSync(sandbox.dir)).toEqual([])
      // Both sha256 and mtime of every source file, and the directory mtime,
      // stay unchanged.
      expect(dirSnapshot(state)).toEqual(before)
      expect(statSync(state).mtimeMs).toBe(stateDirMtime)
    }
    const status = JSON.parse(runCli(['status', '--state', state, '--root', root, '--json'], sandbox.env).stdout) as {
      ok: boolean
      readOnly?: boolean
      copiedStateFiles?: string[]
      engine: { ok: boolean; entries: number }
    }
    expect(status.ok).toBe(true)
    expect(status.readOnly).toBe(true)
    expect(status.copiedStateFiles).toEqual(expect.arrayContaining(['index.snapshot', 'meta.json']))
    expect(status.engine.ok).toBe(true)
    expect(status.engine.entries).toBeGreaterThan(0)
    // A hit ref is directly citable: locator_resolve accepts it unchanged.
    const search = JSON.parse(runCli(['search', 'alpha', '--state', state, '--root', root, '--json'], sandbox.env).stdout) as {
      hits: Array<{ ref?: string; path?: string }>
    }
    const ref = search.hits[0]?.ref as string
    expect(ref).toContain('ref://file?')
    const resolved = JSON.parse(runCli(['resolve', ref, '--state', state, '--root', root, '--json'], sandbox.env).stdout) as { ok: boolean; path?: string }
    expect(resolved.ok).toBe(true)
    expect(realpathSync(resolved.path as string)).toBe(realpathSync(join(root, 'alpha.md')))
    const cited = JSON.parse(runCli(['cite', ref, '--json'], sandbox.env).stdout) as { ok: boolean; citations: Array<{ ref?: string; markdown?: string }> }
    expect(cited.ok).toBe(true)
    expect(cited.citations[0]?.ref).toBe(ref)
    expect(cited.citations[0]?.markdown).toContain('ref://file')
    // A missing state directory is never created as a side effect of a read.
    const missingState = join(base, 'never-created-state')
    const missing = runCli(['status', '--state', missingState, '--root', root, '--json'], sandbox.env)
    expect(missing.status).toBe(0)
    expect(existsSync(missingState)).toBe(false)
    const missingSearch = runCli(['search', 'alpha', '--state', missingState, '--root', root, '--json'], sandbox.env)
    expect(missingSearch.status).toBe(0)
    expect(existsSync(missingState)).toBe(false)
    expect(readdirSync(sandbox.dir)).toEqual([])
  })

  it.skipIf(!existsSync(engineBinary))('CLI search returns refs/budget/nextOffset and clamps the page size to 100', () => {
    const base = tempDir('locator-ro-search-')
    const root = join(base, 'root')
    mkdirSync(root, { recursive: true })
    for (const index of [1, 2, 3]) writeFileSync(join(root, 'file-' + String(index) + '.md'), 'x')
    const state = join(base, 'state')
    buildEngineState(state, root)
    const sandbox = sandboxTmp(base)
    const first = JSON.parse(runCli(['search', 'file', '--state', state, '--root', root, '--json', '--limit', '1000'], sandbox.env).stdout) as {
      ok: boolean
      limit: number
      total: number
      returned: number
      truncated: boolean
      nextOffset?: number
      budget?: { limitChars?: number; dropped?: number }
      hits: Array<{ ref?: string; freshness?: { state?: string }; permissions?: { read?: string } }>
    }
    expect(first.ok).toBe(true)
    expect(first.limit).toBe(100)
    expect(first.total).toBe(3)
    expect(first.returned).toBe(3)
    expect(first.truncated).toBe(false)
    expect(first.nextOffset).toBeUndefined()
    expect(first.budget?.limitChars).toBe(8000)
    expect(first.hits[0]?.ref).toContain('ref://file?')
    expect(first.hits[0]?.permissions?.read).toBe('allowed')
    const page = JSON.parse(runCli(['search', 'file', '--state', state, '--root', root, '--json', '--limit', '1'], sandbox.env).stdout) as {
      returned: number
      truncated: boolean
      nextOffset?: number
    }
    expect(page.returned).toBe(1)
    expect(page.truncated).toBe(true)
    expect(page.nextOffset).toBe(1)
    expect(readdirSync(sandbox.dir)).toEqual([])
  })
})

/** Shared fixture: two roots, two in-root files, an out-of-root file and two session logs. */
function contentTrustFixture(prefix: string): {
  base: string; root: string; outside: string; state: string
  insideFiles: string[]; outsideFile: string; sessionInside: string; sessionOutside: string
} {
  const base = tempDir(prefix)
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  const state = join(base, 'state')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const insideFiles = [join(root, 'inside-1.md'), join(root, 'inside-2.md')]
  writeFileSync(insideFiles[0] as string, 'one\ntwo needle inside\nthree\n')
  writeFileSync(insideFiles[1] as string, 'needle again\n')
  const outsideFile = join(outside, 'outside.md')
  writeFileSync(outsideFile, 'needle outside\n')
  const sessionInside = join(root, 'sessions', 's1', 'log.jsonl')
  const sessionOutside = join(root, 'sessions', 's2', 'log.jsonl')
  makeContentDb(state, [
    { kind: 'file', path: insideFiles[0] as string, title: 'inside-1.md', body: 'one\ntwo needle inside\nthree\n' },
    { kind: 'file', path: insideFiles[1] as string, title: 'inside-2.md', body: 'needle again\n' },
    { kind: 'file', path: outsideFile, title: 'outside.md', body: 'needle outside\n' },
    { kind: 'session', path: sessionInside, title: 's1', body: 'needle from session one', sessionId: 's1', messageId: 'm1' },
    { kind: 'session', path: sessionOutside, title: 's2', body: 'needle from session two', sessionId: 's2', messageId: 'm2' },
  ], [
    { path: sessionInside, cwd: root },
    { path: sessionOutside, cwd: outside },
  ])
  return { base, root, outside, state, insideFiles, outsideFile, sessionInside, sessionOutside }
}

describe('content trust boundary', () => {
  it('CLI find restricts file hits to the configured roots and hides session logs by default', () => {
    const fixture = contentTrustFixture('locator-ro-content-')
    const sandbox = sandboxTmp(fixture.base)
    const before = dirSnapshot(fixture.state)
    const find = (roots: string[], extra: string[] = []) => JSON.parse(runCli([
      'find', 'needle', '--state', fixture.state, ...roots.flatMap(root => ['--root', root]), '--json', ...extra,
    ], sandbox.env).stdout) as {
      ok: boolean
      returned: number
      truncated: boolean
      nextOffset?: number
      budget?: { limitChars?: number }
      warnings?: string[]
      hits: Array<{ kind: string; path: string; ref?: string; line?: number; permissions?: { read?: string } }>
    }
    const plain = find([fixture.root])
    expect(plain.ok).toBe(true)
    expect(plain.returned).toBe(2)
    expect(plain.hits.map(hit => hit.path).sort()).toEqual([...fixture.insideFiles].sort())
    expect(plain.hits.every(hit => hit.kind === 'file' && hit.path !== fixture.outsideFile)).toBe(true)
    const firstInside = plain.hits.find(hit => hit.path === fixture.insideFiles[0])
    expect(firstInside?.ref).toContain('ref://file?')
    expect(firstInside?.line).toBe(2)
    expect(plain.budget?.limitChars).toBe(8000)
    expect(plain.hits[0]?.permissions?.read).toBe('allowed')
    // A page of one reports where the next page starts.
    const page = find([fixture.root], ['--limit', '1'])
    expect(page.returned).toBe(1)
    expect(page.truncated).toBe(true)
    expect(page.nextOffset).toBe(1)
    // Session logs stay hidden unless explicitly requested; the session whose
    // log is inside the root but whose recorded workspace is outside is denied.
    const withSessions = find([fixture.root], ['--allow-sessions'])
    expect(withSessions.hits.map(hit => hit.kind + ':' + hit.path).sort()).toEqual([
      'file:' + String(fixture.insideFiles[0]),
      'file:' + String(fixture.insideFiles[1]),
      'session:' + fixture.sessionInside,
    ].sort())
    const allowedPaths = new Set(withSessions.hits.map(hit => hit.path))
    expect(allowedPaths.has(fixture.sessionOutside)).toBe(false)
    expect(allowedPaths.has(fixture.outsideFile)).toBe(false)
    // search --mode content honors the same trust boundary and budget.
    const contentSearch = JSON.parse(runCli([
      'search', 'needle', '--mode', 'content', '--state', fixture.state, '--root', fixture.root, '--json',
    ], sandbox.env).stdout) as { ok: boolean; returned: number; budget?: { limitChars?: number }; hits: Array<{ kind: string; path: string }> }
    expect(contentSearch.ok).toBe(true)
    expect(contentSearch.returned).toBe(2)
    expect(contentSearch.budget?.limitChars).toBe(8000)
    expect(contentSearch.hits.every(hit => hit.kind === 'file' && hit.path !== fixture.outsideFile)).toBe(true)
    // Roots are the boundary: the same database read from the outside root
    // only exposes the outside file.
    const outsideOnly = find([fixture.outside])
    expect(outsideOnly.hits.map(hit => hit.path)).toEqual([fixture.outsideFile])
    // No SQLite -wal/-shm side files were created next to the caller DB.
    expect(dirSnapshot(fixture.state)).toEqual(before)
    expect(readdirSync(sandbox.dir)).toEqual([])
  })

  it('CLI status reports schema-v4 files/sessions/messages/refs counts', () => {
    const fixture = contentTrustFixture('locator-ro-counts-')
    const db = new DatabaseSync(join(fixture.state, 'content.db'))
    try {
      db.exec('CREATE TABLE refs (ref TEXT PRIMARY KEY)')
      db.prepare('INSERT INTO refs (ref) VALUES (?)').run('ref://file?path=x')
    } finally {
      db.close()
    }
    const payload = JSON.parse(runCli(['status', '--state', fixture.state, '--root', fixture.root, '--json']).stdout) as {
      content: { available: boolean; files?: number; sessions?: number; messages?: number; refs?: number; readOnly?: string }
    }
    expect(payload.content.available).toBe(true)
    expect(payload.content.files).toBe(3)
    expect(payload.content.sessions).toBe(2)
    expect(payload.content.messages).toBe(2)
    expect(payload.content.refs).toBe(1)
    expect(payload.content.readOnly).toBe('immutable')
  })

  it('opens a WAL content database without creating -wal/-shm side files', () => {
    const fixture = contentTrustFixture('locator-ro-wal-')
    const db = new DatabaseSync(join(fixture.state, 'content.db'))
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = OFF')
    } finally {
      db.close()
    }
    const before = dirSnapshot(fixture.state)
    expect(before.map(file => file.name)).toEqual(['content.db'])
    const payload = JSON.parse(runCli([
      'find', 'needle', '--state', fixture.state, '--root', fixture.root, '--json', '--limit', '1',
    ]).stdout) as { ok: boolean; returned: number }
    expect(payload.ok).toBe(true)
    expect(payload.returned).toBe(1)
    expect(dirSnapshot(fixture.state)).toEqual(before)
  })
})

describe('MCP lifecycle (0.21.1)', () => {
  it.skipIf(process.platform === 'win32')('starts one engine during initialize, reuses it and stops it on shutdown', async () => {
    const base = tempDir('locator-mcp-lifecycle-')
    const root = join(base, 'root')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'alpha.md'), 'x')
    const state = join(base, 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'index.snapshot'), 'fake-snapshot')
    writeFileSync(join(state, 'index.journal'), 'fake-journal')
    writeFileSync(join(state, 'meta.json'), '{"fake":true}')
    const mock = writeCountedMock(base)
    const sandbox = sandboxTmp(base)
    const counter = join(base, 'spawns.txt')
    const engineStateFile = join(base, 'engine-state.txt')
    const before = dirSnapshot(state)
    const client = new McpClient({
      DSH_LOCATOR_ROOTS: root,
      DSH_LOCATOR_STATE: state,
      DSH_LOCATOR_BIN: mock,
      DSH_LOCATOR_MOCK_COUNTER: counter,
      DSH_LOCATOR_MOCK_STATE: engineStateFile,
      DSH_LOCATOR_MOCK_PATH: join(root, 'alpha.md'),
      ...sandbox.env,
    })
    try {
      const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
      expect(String((init.result as { instructions?: string }).instructions)).toContain('temporary')
      const first = await client.request('tools/call', { name: 'locator_search', arguments: { query: 'alpha' } })
      const second = await client.request('tools/call', { name: 'locator_search', arguments: { query: 'alpha' } })
      expect((first.result as { isError?: boolean }).isError).toBe(false)
      expect((second.result as { isError?: boolean }).isError).toBe(false)
      const payload = toolPayload(first) as {
        ok?: boolean
        hits?: Array<{ ref?: string }>
        budget?: { limitChars?: number }
      }
      expect(payload.ok).toBe(true)
      expect(payload.hits?.[0]?.ref).toContain('ref://file?')
      expect(payload.budget?.limitChars).toBe(8000)
      // initialize + two tools/call round-trips = exactly one engine process.
      expect(spawnCount(counter)).toBe(1)
      // The engine received a temporary state directory, never the caller one.
      const engineState = readFileSync(engineStateFile, 'utf8')
      expect(engineState).not.toBe(state)
      expect(engineState.startsWith(sandbox.dir)).toBe(true)
      // snapshot + journal + meta are all copied into the temporary state.
      expect(readdirSync(engineState).sort()).toEqual(['index.journal', 'index.snapshot', 'meta.json'])
      const status = await client.request('tools/call', { name: 'locator_status', arguments: {} })
      const statusPayload = toolPayload(status) as { readOnly?: boolean; engine?: { ok?: boolean } }
      expect(statusPayload.readOnly).toBe(true)
      expect(statusPayload.engine?.ok).toBe(true)
      expect(spawnCount(counter)).toBe(1)
      expect(dirSnapshot(state)).toEqual(before)
      const shutdown = await client.request('shutdown')
      expect(shutdown.result).toEqual({ ok: true })
      const exitCode = await client.exit()
      expect(exitCode).toBe(0)
      // The temporary engine state copy and the source state are both clean.
      expect(readdirSync(sandbox.dir)).toEqual([])
      expect(dirSnapshot(state)).toEqual(before)
    } finally {
      client.close()
    }
  })

  it.skipIf(process.platform === 'win32')('locator_find hides sessions unless allowSessions and enforces roots', async () => {
    const fixture = contentTrustFixture('locator-mcp-content-')
    const mock = writeCountedMock(fixture.base)
    const sandbox = sandboxTmp(fixture.base)
    const client = new McpClient({
      DSH_LOCATOR_ROOTS: fixture.root,
      DSH_LOCATOR_STATE: fixture.state,
      DSH_LOCATOR_BIN: mock,
      DSH_LOCATOR_MOCK_COUNTER: join(fixture.base, 'spawns.txt'),
      DSH_LOCATOR_MOCK_STATE: join(fixture.base, 'engine-state.txt'),
      DSH_LOCATOR_MOCK_PATH: fixture.insideFiles[0] as string,
      ...sandbox.env,
    })
    try {
      await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
      const plain = await client.request('tools/call', { name: 'locator_find', arguments: { query: 'needle' } })
      expect((plain.result as { isError?: boolean }).isError).toBe(false)
      const plainPayload = toolPayload(plain) as {
        ok?: boolean
        hits?: Array<{ kind?: string; path?: string; ref?: string }>
      }
      expect(plainPayload.ok).toBe(true)
      expect(plainPayload.hits?.every(hit => hit.kind === 'file')).toBe(true)
      expect(plainPayload.hits?.map(hit => hit.path).sort()).toEqual([...fixture.insideFiles].sort())
      expect(plainPayload.hits?.[0]?.ref).toBeTruthy()
      const sessions = await client.request('tools/call', {
        name: 'locator_find',
        arguments: { query: 'needle', allowSessions: true },
      })
      expect((sessions.result as { isError?: boolean }).isError).toBe(false)
      const sessionPayload = toolPayload(sessions) as { hits?: Array<{ kind?: string; path?: string }> }
      expect(sessionPayload.hits?.map(hit => String(hit.kind) + ':' + String(hit.path)).sort()).toEqual([
        'file:' + String(fixture.insideFiles[0]),
        'file:' + String(fixture.insideFiles[1]),
        'session:' + fixture.sessionInside,
      ].sort())
      expect(sessionPayload.hits?.some(hit => hit.path === fixture.outsideFile || hit.path === fixture.sessionOutside)).toBe(false)
    } finally {
      await client.exit()
      client.close()
    }
  })
})
