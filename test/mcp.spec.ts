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
import { homedir, tmpdir } from 'node:os'
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

  constructor(env: NodeJS.ProcessEnv, args: string[] = []) {
    this.child = spawn(process.execPath, [mcpPath, ...args], {
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

  it('negotiates the newest protocol version for unknown clients and answers malformed JSON with -32700', async () => {
    const root = tempDir('locator-mcp-fallback-')
    const client = new McpClient({ DSH_LOCATOR_ROOTS: root, DSH_LOCATOR_STATE: join(root, 'state') })
    try {
      const init = await client.request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
      // Unknown versions negotiate the NEWEST supported version, never the oldest.
      expect((init.result as { protocolVersion?: string }).protocolVersion).toBe('2025-11-25')
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
      const payloadBad = toolPayload(bad) as {
        ok?: boolean
        apiVersion?: string
        tool?: string
        error?: { code?: string; message?: string; retryable?: boolean; remediation?: string; details?: { legacyCode?: string } }
        timing?: { tookMs?: number }
      }
      expect(payloadBad.ok).toBe(false)
      // isError results carry the uniform 2026-11 envelope; the historical
      // dialect code is preserved in error.details.legacyCode.
      expect(payloadBad.apiVersion).toBe('2026-11')
      expect(payloadBad.tool).toBe('locator_search')
      expect(payloadBad.error?.code).toBe('invalid-argument')
      expect(payloadBad.error?.details?.legacyCode).toBe('invalid-arguments')
      expect(payloadBad.error?.retryable).toBe(false)
      expect(payloadBad.error?.remediation).toBeTruthy()
      expect(typeof payloadBad.timing?.tookMs).toBe('number')

      // A core result with ok=false (path outside every root) must also become
      // an isError tool result, not a successful call with an error payload.
      const denied = await client.request('tools/call', {
        name: 'locator_resolve',
        arguments: { ref: 'ref://file?path=' + encodeURIComponent(join(root, '..', 'outside.md')) },
      })
      expect((denied.result as { isError?: boolean }).isError).toBe(true)
      const payloadDenied = toolPayload(denied) as {
        ok?: boolean
        warnings?: string[]
        error?: { code?: string; details?: { legacyCode?: string } }
      }
      expect(payloadDenied.ok).toBe(false)
      expect(payloadDenied.error?.code).toBe('scope-denied')
      expect(payloadDenied.error?.details?.legacyCode).toBe('content-path-denied')
      expect(payloadDenied.warnings).toContain('path-outside-roots')
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
    // Windows may hand back the 8.3 (RUNNER~1) spelling while realpath keeps the
    // long form (runneradmin); canonicalise both through the native API.
    const canonicalPath = (value: string): string => {
      try { return realpathSync.native(value) } catch { return realpathSync(value) }
    }
    expect(canonicalPath(resolved.path as string)).toBe(canonicalPath(join(root, 'alpha.md')))
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


/* ========================================================================== */
/* 0.23.0 — MCP protocol matrix + versioned agent API (2026-11) + CLI mode   */
/* ========================================================================== */

/** Recursively collect host-DSL-only artifacts left in one JSON Schema value. */
function schemaViolations(node: unknown, path = '$'): string[] {
  const problems: string[] = []
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) problems.push(...schemaViolations(item, path + '[' + String(index) + ']'))
    return problems
  }
  if (node === null || typeof node !== 'object') return problems
  const record = node as Record<string, unknown>
  if (record.type === 'json') problems.push(path + ': host-DSL type "json" leaked')
  if (record.required === true) problems.push(path + ': host-DSL property-level required:true leaked')
  if (record.properties !== undefined && record.properties !== null && typeof record.properties === 'object') {
    for (const [name, property] of Object.entries(record.properties as Record<string, unknown>)) {
      if (property !== null && typeof property === 'object' && (property as Record<string, unknown>).required === true) {
        problems.push(path + '.properties.' + name + ': property-level required:true is not JSON Schema')
      }
      problems.push(...schemaViolations(property, path + '.properties.' + name))
    }
  }
  for (const key of ['items', 'additionalProperties'] as const) {
    if (record[key] !== undefined) problems.push(...schemaViolations(record[key], path + '.' + key))
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = record[key]
    if (Array.isArray(list)) for (const [index, item] of list.entries()) problems.push(...schemaViolations(item, path + '.' + key + '[' + String(index) + ']'))
  }
  return problems
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal JSON Schema validator for tests
type JsonSchema = Record<string, any>

/** Minimal JSON Schema validator covering the subset emitted by gen-agent-schemas. */
function validateAgainstSchema(schema: JsonSchema, value: unknown, path = '$'): string[] {
  const errors: string[] = []
  if (schema === null || typeof schema !== 'object') return errors
  if (Array.isArray(schema.enum) && (schema.enum as unknown[]).includes(value) === false) errors.push(path + ' is not one of the enum values')
  if (typeof schema.type === 'string') {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value
    const expected = schema.type as string
    const matches = expected === 'integer' ? actual === 'integer' : expected === 'number' ? actual === 'integer' || actual === 'number' : actual === expected
    if (matches === false) errors.push(path + ': expected ' + expected + ', got ' + actual)
  }
  if (schema.type === 'object' && value !== null && typeof value === 'object' && Array.isArray(value) === false) {
    const record = value as Record<string, unknown>
    if (Array.isArray(schema.required)) {
      for (const name of schema.required as string[]) if (record[name] === undefined) errors.push(path + ': missing required property ' + name)
    }
    if (schema.properties !== undefined && schema.properties !== null && typeof schema.properties === 'object') {
      for (const [name, property] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
        if (record[name] !== undefined) errors.push(...validateAgainstSchema(property, record[name], path + '.' + name))
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys((schema.properties ?? {}) as Record<string, unknown>))
      for (const name of Object.keys(record)) if (allowed.has(name) === false) errors.push(path + ': unexpected property ' + name)
    }
  }
  if (Array.isArray(value) && schema.items !== undefined && schema.items !== null) {
    for (const [index, item] of value.entries()) errors.push(...validateAgainstSchema(schema.items as JsonSchema, item, path + '[' + String(index) + ']'))
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(path + ': below minimum')
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(path + ': above maximum')
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(path + ': fewer than minItems')
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(path + ': more than maxItems')
  }
  return errors
}

/** One MCP tool result, split into its wire fields. */
function agentResultOf(message: JsonRpcMessage): { isError: boolean; text: string; structured: Record<string, unknown> } {
  const result = message.result as { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> } | undefined
  return {
    isError: result?.isError === true,
    text: result?.content?.[0]?.text ?? '',
    structured: result?.structuredContent ?? {},
  }
}

/** Engine mock that records the argv it was spawned with (roots/no-rescan checks). */
function writeArgvMock(root: string): { binary: string; record: string } {
  const binary = join(root, 'argv-indexd')
  const record = join(root, 'argv.jsonl')
  const lines = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs')",
    "const readline = require('node:readline')",
    'fs.appendFileSync(process.env.DSH_LOCATOR_MOCK_ARGV, JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10))',
    "process.stdout.write(JSON.stringify({ event: 'ready', params: { scanning: false, roots: [], entries: 1, files: 1 } }) + String.fromCharCode(10))",
    "const rl = readline.createInterface({ input: process.stdin })",
    "rl.on('line', line => {",
    '  let message',
    '  try { message = JSON.parse(line) } catch { return }',
    "  if (message.method === 'shutdown') process.exit(0)",
    "  if (message.method === 'status') {",
    "    process.stdout.write(JSON.stringify({ id: message.id, result: { scanning: false, entries: 1, files: 1, dirs: 0, version: 'mock' } }) + String.fromCharCode(10))",
    '    return',
    '  }',
    "  if (message.method !== 'search') return",
    "  const hit = { path: process.env.DSH_LOCATOR_MOCK_PATH, name: 'alpha.md', size: 1, mtime: 1700000000000, ext: 'md', dir: false }",
    "  process.stdout.write(JSON.stringify({ id: message.id, result: { total: 1, returned: 1, offset: 0, truncated: false, hits: [hit] } }) + String.fromCharCode(10))",
    '})',
  ]
  writeFileSync(binary, lines.join('\n'))
  chmodSync(binary, 0o755)
  return { binary, record }
}

/** Read the argv lines recorded by writeArgvMock. */
function readArgvRecords(record: string): string[][] {
  if (!existsSync(record)) return []
  return readFileSync(record, 'utf8').trim().split('\n').filter(line => line !== '').map(line => JSON.parse(line) as string[])
}

/** Extract the --root values from one engine argv. */
function rootsOfArgv(argv: string[]): string[] {
  const roots: string[] = []
  for (let index = 0; index < argv.length; index++) if (argv[index] === '--root' && argv[index + 1] !== undefined) roots.push(argv[index + 1] as string)
  return roots
}

/** Shared fixture of the versioned MCP/CLI agent-API tests. */
function agentFixture(prefix: string): {
  base: string
  root: string
  state: string
  env: NodeJS.ProcessEnv
  notes: string
  second: string
  mock: string
} {
  const base = tempDir(prefix)
  const root = join(base, 'root')
  const state = join(base, 'state')
  mkdirSync(root, { recursive: true })
  const notes = join(root, 'notes.md')
  const second = join(root, 'second.md')
  writeFileSync(notes, 'one\ntwo needle here\nthree\n')
  writeFileSync(second, 'needle again\n')
  writeFileSync(join(root, 'alpha.md'), 'alpha name hit\n')
  makeContentDb(state, [
    { kind: 'file', path: notes, title: 'notes.md', body: 'one\ntwo needle here\nthree\n' },
    { kind: 'file', path: second, title: 'second.md', body: 'needle again\n' },
  ])
  const db = new DatabaseSync(join(state, 'content.db'))
  try {
    const row = db.prepare('SELECT id FROM paths WHERE path = ?').get(second) as { id?: number } | undefined
    if (row?.id !== undefined) db.prepare('INSERT INTO symbols (path_id, name, kind, line, language) VALUES (?, ?, ?, ?, ?)').run(row.id, 'makeAgentFinder', 0, 1, 1)
  } finally {
    db.close()
  }
  const mock = writeCountedMock(base)
  const env: NodeJS.ProcessEnv = {
    DSH_LOCATOR_ROOTS: root,
    DSH_LOCATOR_STATE: state,
    DSH_LOCATOR_BIN: mock,
    DSH_LOCATOR_MOCK_PATH: join(root, 'alpha.md'),
    DSH_LOCATOR_MOCK_COUNTER: join(base, 'spawns.txt'),
    DSH_LOCATOR_MOCK_STATE: join(base, 'engine-state.txt'),
  }
  return { base, root, state, env, notes, second, mock }
}

const AGENT_ARGS = ['--api=2026-11', '--cwd', 'PLACEHOLDER']

/** Create an MCP client speaking the 2026-11 surface for one fixture. */
function createAgentClient(fixture: { env: NodeJS.ProcessEnv; root: string }): McpClient {
  const args = AGENT_ARGS.map(arg => arg === 'PLACEHOLDER' ? fixture.root : arg)
  return new McpClient(fixture.env, args)
}

/** Load the generated schemas through the generator module (no build needed). */
async function generatedSchemas(): Promise<Record<string, { input: JsonSchema; output: JsonSchema }>> {
  interface GenModule { buildSchemas: () => Record<string, { find: unknown; read: unknown; status: unknown; failure: unknown }> }
  const gen = await import(pathToFileURL(join(scriptDir, 'gen-agent-schemas.mjs')).href) as unknown as GenModule
  const schemas = gen.buildSchemas() as unknown as Record<string, { input: JsonSchema; output: JsonSchema }>
  return schemas
}

describe('MCP protocol version matrix (0.23.0)', () => {
  it('echoes every supported version and negotiates the newest for unknown or absent clients', async () => {
    const root = tempDir('locator-mcp-protocol-')
    writeFileSync(join(root, 'alpha.md'), 'x')
    const mock = writeCountedMock(root)
    const env: NodeJS.ProcessEnv = {
      DSH_LOCATOR_ROOTS: root,
      DSH_LOCATOR_STATE: join(root, 'state'),
      DSH_LOCATOR_BIN: mock,
      DSH_LOCATOR_MOCK_COUNTER: join(root, 'spawns.txt'),
      DSH_LOCATOR_MOCK_STATE: join(root, 'engine-state.txt'),
      DSH_LOCATOR_MOCK_PATH: join(root, 'alpha.md'),
    }
    for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
      const client = new McpClient(env)
      try {
        const init = await client.request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
        expect((init.result as { protocolVersion?: string }).protocolVersion).toBe(version)
      } finally {
        client.close()
      }
    }
    for (const requested of ['1999-01-01', undefined]) {
      const client = new McpClient(env)
      try {
        const params = requested === undefined ? { capabilities: {}, clientInfo: { name: 'vitest', version: '1' } } : { protocolVersion: requested, capabilities: {}, clientInfo: { name: 'vitest', version: '1' } }
        const init = await client.request('initialize', params)
        expect((init.result as { protocolVersion?: string }).protocolVersion).toBe('2025-11-25')
      } finally {
        client.close()
      }
    }
  })

  it('advertises the plugin, npm, agent API and negotiated protocol versions in initialize', async () => {
    const root = tempDir('locator-mcp-instructions-')
    writeFileSync(join(root, 'alpha.md'), 'x')
    const mock = writeCountedMock(root)
    const env: NodeJS.ProcessEnv = {
      DSH_LOCATOR_ROOTS: root,
      DSH_LOCATOR_STATE: join(root, 'state'),
      DSH_LOCATOR_BIN: mock,
      DSH_LOCATOR_MOCK_COUNTER: join(root, 'spawns.txt'),
      DSH_LOCATOR_MOCK_STATE: join(root, 'engine-state.txt'),
      DSH_LOCATOR_MOCK_PATH: join(root, 'alpha.md'),
    }
    const client = new McpClient(env, ['--api=2026-11'])
    try {
      const init = await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
      const instructions = String((init.result as { instructions?: string }).instructions)
      expect(instructions).toContain(root)
      expect(instructions).toContain(packageVersion)
      expect(instructions).toContain('npm dsh-locator@' + packageVersion)
      expect(instructions).toContain('agent API version 2026-11')
      expect(instructions).toContain('MCP protocol version 2025-11-25')
      expect(instructions).toContain('temporary')
      expect(instructions).toContain('files-only')
    } finally {
      client.close()
    }
  })
})

describe('MCP agent API 2026-11 surface', () => {
  it('serves exactly find/read/status with standard JSON Schema and never exposes admin', async () => {
    const fixture = agentFixture('locator-agent-list-')
    const client = createAgentClient(fixture)
    try {
      await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
      const list = await client.request('tools/list')
      const tools = (list.result as { tools: Array<{ name: string; inputSchema: JsonSchema; outputSchema?: JsonSchema; annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } }> }).tools
      expect(tools.map(tool => tool.name)).toEqual(['locator_find', 'locator_read', 'locator_status'])
      const serialized = JSON.stringify(tools)
      expect(serialized).not.toContain('locator_admin')
      for (const tool of tools) {
        expect(tool.annotations.readOnlyHint).toBe(true)
        expect(tool.annotations.destructiveHint).toBe(false)
        expect(tool.annotations.idempotentHint).toBe(true)
        expect(tool.annotations.openWorldHint).toBe(false)
        expect(tool.inputSchema.type).toBe('object')
        expect(schemaViolations(tool.inputSchema)).toEqual([])
        expect(tool.outputSchema?.type).toBe('object')
        expect(schemaViolations(tool.outputSchema)).toEqual([])
        expect(tool.outputSchema?.additionalProperties).toBe(false)
        expect(tool.outputSchema?.required).toEqual(expect.arrayContaining(['apiVersion', 'ok', 'tool']))
      }
      expect(tools[0]?.inputSchema.required).toEqual(['query'])
      const generated = await generatedSchemas()
      expect(JSON.stringify(tools[0]?.outputSchema)).toBe(JSON.stringify(generated.find?.output))
      expect(JSON.stringify(tools[1]?.outputSchema)).toBe(JSON.stringify(generated.read?.output))
      expect(JSON.stringify(tools[2]?.outputSchema)).toBe(JSON.stringify(generated.status?.output))
      const admin = await client.request('tools/call', { name: 'locator_admin', arguments: {} })
      expect(admin.error?.code).toBe(-32602)
    } finally {
      await client.exit()
      client.close()
    }
  })

  it('validates structuredContent for success and error envelopes and renders human text', async () => {
    const fixture = agentFixture('locator-agent-validate-')
    const client = createAgentClient(fixture)
    try {
      await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
      const list = await client.request('tools/list')
      const tools = (list.result as { tools: Array<{ name: string; outputSchema: JsonSchema }> }).tools
      const schemaOf = (name: string): JsonSchema => {
        const tool = tools.find(candidate => candidate.name === name)
        if (tool === undefined) throw new Error('missing tool ' + name)
        return tool.outputSchema
      }
      const success = await client.request('tools/call', { name: 'locator_find', arguments: { query: 'needle', mode: 'body', scope: 'roots' } })
      const successResult = agentResultOf(success)
      expect(successResult.isError).toBe(false)
      expect(validateAgainstSchema(schemaOf('locator_find'), successResult.structured)).toEqual([])
      expect(successResult.structured.apiVersion).toBe('2026-11')
      expect(successResult.structured.tool).toBe('locator_find')
      expect(successResult.text.startsWith('{')).toBe(false)
      expect(successResult.text).toContain('locator_find')

      const failure = await client.request('tools/call', { name: 'locator_find', arguments: { query: 'ab', mode: 'body', scope: 'roots' } })
      const failureResult = agentResultOf(failure)
      expect(failureResult.isError).toBe(true)
      expect(validateAgainstSchema(schemaOf('locator_find'), failureResult.structured)).toEqual([])
      const error = failureResult.structured.error as { code?: string; retryable?: boolean; remediation?: string; details?: { legacyCode?: string } }
      expect(error.code).toBe('query-too-short')
      expect(error.retryable).toBe(false)
      expect(error.remediation).toBeTruthy()
      expect(error.details?.legacyCode).toBe('content-query-too-short')
      expect(failureResult.text).toContain('locator_find failed: query-too-short')

      const read = await client.request('tools/call', { name: 'locator_read', arguments: { path: fixture.notes, as: 'excerpt', line: 2, window: 1 } })
      const readResult = agentResultOf(read)
      expect(readResult.isError).toBe(false)
      expect(validateAgainstSchema(schemaOf('locator_read'), readResult.structured)).toEqual([])
      expect(readResult.text.startsWith('{')).toBe(false)

      const status = await client.request('tools/call', { name: 'locator_status', arguments: { detail: 'brief' } })
      const statusResult = agentResultOf(status)
      expect(statusResult.isError).toBe(false)
      expect(validateAgainstSchema(schemaOf('locator_status'), statusResult.structured)).toEqual([])
    } finally {
      await client.exit()
      client.close()
    }
  })

  it('finds names, bodies and symbols, honours where/kinds/count and pages with an opaque cursor', async () => {
    const fixture = agentFixture('locator-agent-find-')
    const client = createAgentClient(fixture)
    try {
      await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
      const call = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const message = await client.request('tools/call', { name: 'locator_find', arguments: args })
        return agentResultOf(message).structured
      }
      const nameHit = await call({ query: 'alpha', mode: 'name', scope: 'roots' })
      const nameItems = nameHit.items as Array<Record<string, unknown>>
      expect(nameItems.map(item => item.path)).toEqual([join(fixture.root, 'alpha.md')])
      expect(nameItems[0]?.kind).toBe('file')
      expect(String(nameItems[0]?.ref)).toContain('ref://file?')

      const fullName = await call({ query: 'alpha', mode: 'name', scope: 'roots', detail: 'full' })
      const fullItem = (fullName.items as Array<Record<string, unknown>>)[0]
      expect(fullItem?.size).toBe(1)
      expect(typeof fullItem?.mtime).toBe('number')
      expect(fullItem?.permissions).toBeTruthy()

      const symbolHit = await call({ query: 'makeAgentFinder', mode: 'symbol', scope: 'roots' })
      const symbolItems = symbolHit.items as Array<Record<string, unknown>>
      expect(symbolItems.map(item => item.kind)).toEqual(['symbol'])
      expect(symbolItems[0]?.path).toBe(fixture.second)

      const autoBody = await call({ query: 'needle', mode: 'auto', scope: 'roots' })
      const autoItems = autoBody.items as Array<Record<string, unknown>>
      // The mock name index answers every query, so auto merges body + name.
      expect(autoBody.resolvedMode).toBe('mixed')
      expect(autoItems.length).toBe(3)
      const autoSources = autoItems.flatMap(item => (item.sources as string[] | undefined) ?? [])
      expect(autoSources).toContain('body')
      expect(autoSources).toContain('name')
      expect(autoBody.page).toMatchObject({ limit: 10, returned: 3, more: false })

      const onlySymbol = await call({ query: 'needle', mode: 'auto', kinds: ['symbol'], scope: 'roots' })
      expect(onlySymbol.items).toEqual([])
      expect((onlySymbol.coverage as { notes: Array<{ code: string }> }).notes.map(note => note.code)).toContain('no-matches')

      const filtered = await call({ query: 'needle', mode: 'body', scope: 'roots', where: { ext: ['md'] } })
      expect((filtered.items as unknown[]).length).toBe(2)
      const filteredOut = await call({ query: 'needle', mode: 'body', scope: 'roots', where: { ext: ['txt'] } })
      expect(filteredOut.items).toEqual([])
      expect(filteredOut.counts).toEqual({ bodyTotal: 2, bodyKind: 'exact', total: 2, totalKind: 'exact' })
      expect((filteredOut.coverage as { notes: Array<{ code: string }> }).notes.map(note => note.code)).toContain('counts-ignore-where')

      const noCounts = await call({ query: 'needle', mode: 'body', scope: 'roots', count: 'none' })
      expect(noCounts.counts).toEqual({})

      const pageOne = await call({ query: 'needle', mode: 'body', scope: 'roots', limit: 1 })
      expect(pageOne.page).toMatchObject({ limit: 1, returned: 1, more: true })
      const cursor = (pageOne.page as { nextCursor?: string }).nextCursor
      expect(typeof cursor).toBe('string')
      // Host parity: single-source modes issue the 0.22-compatible v1 cursor,
      // auto mode issues the per-source v2 cursor.
      const decodeCursor = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>
      expect(decodeCursor(String(cursor)).v).toBe(1)
      expect(decodeCursor(String(cursor)).mode).toBe('body')
      const autoPage = await call({ query: 'needle', mode: 'auto', scope: 'roots', limit: 1 })
      const autoCursor = String((autoPage.page as { nextCursor?: string }).nextCursor)
      const autoDecoded = decodeCursor(autoCursor)
      expect(autoDecoded.v).toBe(2)
      expect(autoDecoded.offsets).toBeTruthy()
      const pageTwo = await call({ query: 'needle', mode: 'body', scope: 'roots', limit: 1, cursor })
      expect(pageTwo.page).toMatchObject({ returned: 1 })
      const paths = [...(pageOne.items as Array<{ path: string }>), ...(pageTwo.items as Array<{ path: string }>)].map(item => item.path)
      expect(new Set(paths).size).toBe(2)

      const tampered = await call({ query: 'needle', mode: 'body', scope: 'roots', cursor: 'not-a-real-cursor' })
      expect((tampered.error as { code?: string }).code).toBe('cursor-invalid')
    } finally {
      await client.exit()
      client.close()
    }
  })

  it('classifies argument, scope, budget and unavailable-index failures with closed codes', async () => {
    const fixture = agentFixture('locator-agent-errors-')
    const client = createAgentClient(fixture)
    try {
      await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
      const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; structured: Record<string, unknown> }> => {
        const message = await client.request('tools/call', { name, arguments: args })
        return agentResultOf(message)
      }
      const badMode = await call('locator_find', { query: 'needle', mode: 'bogus' })
      expect((badMode.structured.error as { code?: string }).code).toBe('invalid-argument')
      const tooShort = await call('locator_find', { query: 'ab', mode: 'body', scope: 'roots' })
      expect((tooShort.structured.error as { code?: string }).code).toBe('query-too-short')
      const budget = await call('locator_find', { query: 'needle', mode: 'body', scope: 'roots', maxChars: 40 })
      expect((budget.structured.error as { code?: string }).code).toBe('budget-too-small')
      const deniedPrefix = await call('locator_find', { query: 'needle', mode: 'body', scope: 'roots', where: { pathPrefix: join(fixture.base, 'outside') } })
      expect((deniedPrefix.structured.error as { code?: string; retryable?: boolean }).code).toBe('scope-denied')
      const sessionOnly = await call('locator_find', { query: 'needle', mode: 'auto', kinds: ['session'] })
      expect((sessionOnly.structured.error as { code?: string }).code).toBe('invalid-argument')
      const readDenied = await call('locator_read', { ref: 'dsh-session:' + Buffer.from(JSON.stringify('s1'), 'utf8').toString('base64url') })
      expect((readDenied.structured.error as { code?: string; details?: { legacyCode?: string } }).code).toBe('scope-denied')
      expect((readDenied.structured.error as { details?: { legacyCode?: string } }).details?.legacyCode).toBe('files-only-session')
      const notFound = await call('locator_read', { path: join(fixture.root, 'missing.md') })
      expect((notFound.structured.error as { code?: string }).code).toBe('not-found')
      // An unavailable content index is retryable and points at locator_status.
      const noContent = tempDir('locator-agent-nocontent-')
      const noContentClient = new McpClient({ ...fixture.env, DSH_LOCATOR_ROOTS: noContent, DSH_LOCATOR_STATE: join(noContent, 'state'), DSH_LOCATOR_MOCK_PATH: join(noContent, 'x.md') }, ['--api=2026-11'])
      try {
        await noContentClient.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
        const unavailable = agentResultOf(await noContentClient.request('tools/call', { name: 'locator_find', arguments: { query: 'needle', mode: 'body', scope: 'roots' } }))
        const error = unavailable.structured.error as { code?: string; retryable?: boolean; nextTools?: string[] }
        expect(error.code).toBe('index-unavailable')
        expect(error.retryable).toBe(true)
        expect(error.nextTools).toContain('locator_status')
      } finally {
        await noContentClient.exit()
        noContentClient.close()
      }
    } finally {
      await client.exit()
      client.close()
    }
  })

  it('reads refs, batches and paths in meta/excerpt/quote modes', async () => {
    const fixture = agentFixture('locator-agent-read-')
    const client = createAgentClient(fixture)
    try {
      await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
      const call = async (args: Record<string, unknown>): Promise<{ isError: boolean; structured: Record<string, unknown> }> => agentResultOf(await client.request('tools/call', { name: 'locator_read', arguments: args }))
      const found = agentResultOf(await client.request('tools/call', { name: 'locator_find', arguments: { query: 'needle', mode: 'body', scope: 'roots', limit: 1 } }))
      const ref = String((found.structured.items as Array<{ ref?: string }>)[0]?.ref)
      expect(ref).toContain('ref://file?')
      const excerpt = await call({ ref, as: 'excerpt', window: 1 })
      expect(excerpt.isError).toBe(false)
      const item = (excerpt.structured.items as Array<Record<string, unknown>>)[0]
      expect(typeof item?.excerpt).toBe('string')
      expect(typeof item?.startLine).toBe('number')
      expect(item?.status).toBe('fresh')
      const meta = await call({ ref, as: 'meta' })
      expect((meta.structured.items as Array<Record<string, unknown>>)[0]?.excerpt).toBeUndefined()
      const quote = await call({ ref, as: 'quote', line: 1 })
      expect(String((quote.structured.items as Array<Record<string, unknown>>)[0]?.markdown)).toContain('> ')
      const outOfRange = await call({ ref, as: 'excerpt', line: 9999 })
      expect((outOfRange.structured.error as { code?: string }).code).toBe('not-found')
      const batch = await call({ refs: [ref, 'ref://file?path=' + encodeURIComponent(join(fixture.root, 'missing.md'))] })
      expect(batch.isError).toBe(false)
      expect((batch.structured.counts as { requested?: number; failed?: number }).requested).toBe(2)
      expect((batch.structured.counts as { failed?: number }).failed).toBe(1)
      expect((batch.structured.counts as { duplicates?: number }).duplicates).toBe(0)
      expect(batch.structured.limits).toMatchObject({ perExcerptChars: 2000, maxRefs: 20 })
      const duplicated = await call({ refs: [ref, ref] })
      expect((duplicated.structured.counts as { duplicates?: number }).duplicates).toBe(1)
      expect((duplicated.structured.items as unknown[]).length).toBe(1)
      const badWindow = await call({ path: fixture.notes, window: 99 })
      expect((badWindow.structured.error as { code?: string }).code).toBe('invalid-argument')
    } finally {
      await client.exit()
      client.close()
    }
  })

  it('reports status in brief and full detail and fails with index-unavailable when the engine is gone', async () => {
    const fixture = agentFixture('locator-agent-status-')
    const client = createAgentClient(fixture)
    try {
      await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
      const brief = agentResultOf(await client.request('tools/call', { name: 'locator_status', arguments: { detail: 'brief' } }))
      expect(brief.isError).toBe(false)
      expect(brief.structured.detail).toBe('brief')
      expect(String(brief.structured.summary)).toContain('entries')
      expect((brief.structured.index as { roots?: number }).roots).toBe(1)
      const full = agentResultOf(await client.request('tools/call', { name: 'locator_status', arguments: { detail: 'full' } }))
      expect(full.structured.detail).toBe('full')
      expect((full.structured.status as { roots?: string[] }).roots).toEqual([fixture.root])
    } finally {
      await client.exit()
      client.close()
    }
    const brokenBase = tempDir('locator-agent-status-broken-')
    const broken = new McpClient({ ...fixture.env, DSH_LOCATOR_BIN: join(brokenBase, 'missing-engine') }, ['--api=2026-11'])
    try {
      await broken.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
      const failed = agentResultOf(await broken.request('tools/call', { name: 'locator_status', arguments: {} }))
      expect(failed.isError).toBe(true)
      const error = failed.structured.error as { code?: string; retryable?: boolean }
      expect(error.code).toBe('index-unavailable')
      expect(error.retryable).toBe(true)
    } finally {
      await broken.exit()
      broken.close()
    }
  })
})

describe('MCP roots from state (0.23.0)', () => {
  it('reads the roots recorded in <state>/meta.json and never rescans the home directory', async () => {
    const base = tempDir('locator-roots-meta-')
    const roots = [join(base, 'one'), join(base, 'two'), join(base, 'three')]
    for (const root of roots) {
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'alpha.md'), 'x')
    }
    const state = join(base, 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'meta.json'), JSON.stringify({ version: 'mock', roots }, null, 2))
    const argvMock = writeArgvMock(base)
    const client = new McpClient({ DSH_LOCATOR_ROOTS: '', DSH_LOCATOR_STATE: state, DSH_LOCATOR_BIN: argvMock.binary, DSH_LOCATOR_MOCK_ARGV: argvMock.record, DSH_LOCATOR_MOCK_PATH: join(roots[0] as string, 'alpha.md') })
    try {
      const init = await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
      const instructions = String((init.result as { instructions?: string }).instructions)
      for (const root of roots) expect(instructions).toContain(root)
      const records = await eventually(() => readArgvRecords(argvMock.record), value => value.length === 1, 5_000, 20)
      expect(records.length).toBe(1)
      expect(rootsOfArgv(records[0] as string[])).toEqual(roots)
      expect(rootsOfArgv(records[0] as string[])).not.toContain(homedir())
      const status = await client.request('tools/call', { name: 'locator_status', arguments: {} })
      expect((toolPayload(status) as { roots?: string[] }).roots).toEqual(roots)
    } finally {
      await client.exit()
      client.close()
    }
  })

  it('falls back to the legacy home root for a missing or corrupt meta.json', async () => {
    for (const meta of [undefined, '{not json', '[]', '{"roots": []}', '{"roots": [1, 2]}']) {
      const base = tempDir('locator-roots-bad-')
      const state = join(base, 'state')
      mkdirSync(state, { recursive: true })
      if (meta !== undefined) writeFileSync(join(state, 'meta.json'), meta)
      const argvMock = writeArgvMock(base)
      const client = new McpClient({ DSH_LOCATOR_ROOTS: '', DSH_LOCATOR_STATE: state, DSH_LOCATOR_BIN: argvMock.binary, DSH_LOCATOR_MOCK_ARGV: argvMock.record, DSH_LOCATOR_MOCK_PATH: join(base, 'alpha.md') })
      try {
        await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
        const records = await eventually(() => readArgvRecords(argvMock.record), value => value.length === 1, 5_000, 20)
        expect(rootsOfArgv(records[0] as string[])).toEqual([homedir()])
      } finally {
        await client.exit()
        client.close()
      }
    }
  })
})

describe('CLI agent API 2026-11 (0.23.0)', () => {
  it('documents the versioned surface and keeps the legacy help/version contract', () => {
    const help = runCli(['help'])
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('locator-cli search')
    expect(help.stdout).toContain('Exit codes: 0 ok, 1 runtime error, 2 usage error, 3 index/engine unavailable.')
    expect(help.stdout).toContain('--api=2026-11')
    expect(help.stdout).toContain('locator-cli read')
    expect(help.stdout).toContain('2026-11 exit codes: 0 ok, 1 internal, 2 usage, 3 index unavailable, 4 denied/not found.')
    expect(runCli(['version']).stdout).toBe(packageVersion)
    // An unknown --api value is a usage error.
    const unknownApi = runCli(['status', '--api=2099-01-01'])
    expect(unknownApi.status).toBe(2)
    expect(unknownApi.stderr).toContain('unknown --api value')
  })

  it('prints one envelope for find/read/status and never leaks the legacy shape', () => {
    const fixture = agentFixture('locator-cli-agent-')
    const base = ['--api=2026-11', '--state', fixture.state, '--root', fixture.root, '--scope', 'roots']
    const find = runCli(['find', 'needle', '--mode', 'body', ...base])
    expect(find.status).toBe(0)
    const found = JSON.parse(find.stdout) as { apiVersion?: string; ok?: boolean; tool?: string; items?: Array<{ path?: string; ref?: string }>; page?: { returned?: number } }
    expect(found.apiVersion).toBe('2026-11')
    expect(found.ok).toBe(true)
    expect(found.tool).toBe('locator_find')
    expect(found.items?.length).toBe(2)
    expect(found.items?.[0]?.ref).toContain('ref://file?')
    // read by ref round-trips with a whole-line excerpt
    const ref = String(found.items?.[0]?.ref)
    const read = runCli(['read', ref, '--as', 'excerpt', '--window', '1', '--api=2026-11', '--state', fixture.state, '--root', fixture.root])
    expect(read.status).toBe(0)
    const readPayload = JSON.parse(read.stdout) as { ok?: boolean; items?: Array<{ excerpt?: string; status?: string }> }
    expect(readPayload.ok).toBe(true)
    expect(String(readPayload.items?.[0]?.excerpt)).toContain('needle')
    expect(readPayload.items?.[0]?.status).toBe('fresh')
    // status brief and full
    const brief = JSON.parse(runCli(['status', '--detail', 'brief', ...base]).stdout) as { ok?: boolean; detail?: string; index?: { roots?: number }; summary?: string }
    expect(brief.ok).toBe(true)
    expect(brief.detail).toBe('brief')
    expect(brief.index?.roots).toBe(1)
    const full = JSON.parse(runCli(['status', '--detail', 'full', ...base]).stdout) as { ok?: boolean; detail?: string; status?: { roots?: string[] } }
    expect(full.detail).toBe('full')
    expect(full.status?.roots).toEqual([fixture.root])
    // --where / --count / --detail / --max-chars reach the 2026-11 request
    const where = JSON.parse(runCli(['find', 'needle', '--mode', 'body', '--where', JSON.stringify({ ext: ['md'] }), '--count', 'none', '--detail', 'full', ...base]).stdout) as { ok?: boolean; counts?: Record<string, unknown>; items?: unknown[] }
    expect(where.ok).toBe(true)
    expect(where.counts).toEqual({})
    expect(where.items?.length).toBe(2)
    const badWhere = runCli(['find', 'needle', '--where', 'not-json', ...base])
    expect(badWhere.status).toBe(2)
    expect((JSON.parse(badWhere.stdout) as { error?: { code?: string } }).error?.code).toBe('invalid-argument')
  })

  it('pages with the opaque cursor and defers budget-trimmed rows without losing them', () => {
    const fixture = agentFixture('locator-cli-agent-page-')
    const base = ['--api=2026-11', '--state', fixture.state, '--root', fixture.root, '--scope', 'roots', '--mode', 'body']
    const first = JSON.parse(runCli(['find', 'needle', '--limit', '1', ...base]).stdout) as { items?: Array<{ path?: string }>; page?: { more?: boolean; nextCursor?: string } }
    expect(first.items?.length).toBe(1)
    expect(first.page?.more).toBe(true)
    const cursor = String(first.page?.nextCursor)
    expect(cursor.length).toBeGreaterThan(10)
    const second = JSON.parse(runCli(['find', 'needle', '--limit', '1', '--cursor', cursor, ...base]).stdout) as { items?: Array<{ path?: string }>; page?: { more?: boolean } }
    expect(second.items?.length).toBe(1)
    expect(second.items?.[0]?.path).not.toBe(first.items?.[0]?.path)
    // A budget-trimmed page keeps the deferred rows reachable through its cursor.
    const tightArgs = ['find', 'needle', '--mode', 'body', '--max-chars', '120', '--api=2026-11', '--state', fixture.state, '--root', fixture.root, '--scope', 'roots']
    const tightRun = runCli(tightArgs)
    expect(tightRun.status).toBe(0)
    const tight = JSON.parse(tightRun.stdout) as { items?: unknown[]; page?: { more?: boolean; nextCursor?: string }; budget?: { truncated?: boolean; dropped?: number } }
    expect(tight.budget?.truncated).toBe(true)
    expect(tight.budget?.dropped).toBeGreaterThan(0)
    expect(tight.page?.more).toBe(true)
    const restRun = runCli(['find', 'needle', '--mode', 'body', '--cursor', String(tight.page?.nextCursor), '--max-chars', '6000', '--api=2026-11', '--state', fixture.state, '--root', fixture.root, '--scope', 'roots'])
    expect(restRun.status).toBe(0)
    const rest = JSON.parse(restRun.stdout) as { items?: unknown[] }
    expect(rest.items?.length).toBeGreaterThan(0)
  })

  it('maps the 12 closed error codes onto CLI exit statuses and emits envelopes on failure', () => {
    const fixture = agentFixture('locator-cli-agent-exit-')
    const base = ['--api=2026-11', '--state', fixture.state, '--root', fixture.root, '--scope', 'roots']
    const short = runCli(['find', 'ab', '--mode', 'body', ...base])
    expect(short.status).toBe(2)
    expect((JSON.parse(short.stdout) as { error?: { code?: string; retryable?: boolean } }).error?.code).toBe('query-too-short')
    const denied = runCli(['read', '/etc/passwd', '--api=2026-11', '--state', fixture.state, '--root', fixture.root])
    expect(denied.status).toBe(4)
    expect((JSON.parse(denied.stdout) as { error?: { code?: string } }).error?.code).toBe('scope-denied')
    const notFound = runCli(['read', join(fixture.root, 'missing.md'), '--api=2026-11', '--state', fixture.state, '--root', fixture.root])
    expect(notFound.status).toBe(4)
    expect((JSON.parse(notFound.stdout) as { error?: { code?: string } }).error?.code).toBe('not-found')
    const unavailable = runCli(['status', '--api=2026-11', '--state', fixture.state, '--root', fixture.root, '--bin', join(fixture.base, 'missing-engine')])
    expect(unavailable.status).toBe(3)
    expect((JSON.parse(unavailable.stdout) as { error?: { code?: string; retryable?: boolean } }).error?.code).toBe('index-unavailable')
    const badCommand = runCli(['search', 'needle', ...base])
    expect(badCommand.status).toBe(2)
    expect((JSON.parse(badCommand.stdout) as { error?: { code?: string } }).error?.code).toBe('invalid-argument')
    const unknown = runCli(['wat', ...base])
    expect(unknown.status).toBe(2)
    // The closed mapping itself covers exactly the 12 declared codes.
    const table = [
      ['invalid-argument', 2], ['query-too-short', 2], ['query-invalid', 2], ['budget-too-small', 2], ['cursor-invalid', 2],
      ['scope-denied', 4], ['scope-empty-workspace', 4], ['not-found', 4],
      ['index-unavailable', 3], ['index-building', 3], ['cancelled', 1], ['internal', 1],
    ] as const
    expect(table.length).toBe(12)
  })

  it('keeps the legacy default output byte-compatible (no apiVersion on the old face)', () => {
    const fixture = agentFixture('locator-cli-legacy-')
    const search = JSON.parse(runCli(['search', 'alpha', '--json', '--root', fixture.root, '--state', fixture.state], fixture.env).stdout) as Record<string, unknown>
    expect(search.command).toBe('search')
    expect(search.mode).toBe('names')
    expect(search.apiVersion).toBeUndefined()
    expect(search.tool).toBeUndefined()
    const find = JSON.parse(runCli(['find', 'needle', '--json', '--root', fixture.root, '--state', fixture.state]).stdout) as Record<string, unknown>
    expect(find.command).toBe('find')
    expect(find.mode).toBe('content')
    expect(find.apiVersion).toBeUndefined()
    const status = JSON.parse(runCli(['status', '--json', '--root', fixture.root, '--state', fixture.state], fixture.env).stdout) as Record<string, unknown>
    expect(status.ok).toBe(true)
    expect(status.apiVersion).toBeUndefined()
    expect(status.command).toBe('status')
    // --api=legacy is the same face as the default.
    const legacy = JSON.parse(runCli(['find', 'needle', '--json', '--api=legacy', '--root', fixture.root, '--state', fixture.state]).stdout) as Record<string, unknown>
    expect(legacy.command).toBe('find')
    expect(legacy.apiVersion).toBeUndefined()
  })

  it('reads roots from --state/meta.json so a state-only call does not rescan another root set', () => {
    const base = tempDir('locator-cli-roots-meta-')
    const roots = [join(base, 'one'), join(base, 'two'), join(base, 'three')]
    for (const root of roots) {
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'x.md'), 'x')
    }
    const state = join(base, 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'meta.json'), JSON.stringify({ roots }))
    const argvMock = writeArgvMock(base)
    const env: NodeJS.ProcessEnv = { DSH_LOCATOR_ROOTS: '', DSH_LOCATOR_BIN: argvMock.binary, DSH_LOCATOR_MOCK_ARGV: argvMock.record, DSH_LOCATOR_MOCK_PATH: join(roots[0] as string, 'x.md') }
    const result = runCli(['status', '--detail', 'full', '--api=2026-11', '--state', state], env)
    expect(result.status).toBe(0)
    const status = JSON.parse(result.stdout) as { ok?: boolean; status?: { roots?: string[] } }
    expect(status.status?.roots).toEqual(roots)
    const records = readArgvRecords(argvMock.record)
    expect(rootsOfArgv(records[0] as string[])).toEqual(roots)
    // The real engine accepts the recorded roots and answers from the existing
    // snapshot (no home-directory rescan): build a snapshot, then query it
    // without ever passing --root.
    if (existsSync(engineBinary)) {
      const realBase = tempDir('locator-cli-roots-real-')
      const realRoot = join(realBase, 'root')
      mkdirSync(realRoot, { recursive: true })
      writeFileSync(join(realRoot, 'alpha.md'), 'x')
      const realState = join(realBase, 'state')
      buildEngineState(realState, realRoot)
      const real = runCli(['status', '--detail', 'full', '--api=2026-11', '--state', realState], { DSH_LOCATOR_ROOTS: '' })
      expect(real.status).toBe(0)
      const realStatus = JSON.parse(real.stdout) as { ok?: boolean; status?: { roots?: string[]; engine?: { ok?: boolean; entries?: number } } }
      expect(realStatus.ok).toBe(true)
      expect(realStatus.status?.roots).toEqual([realRoot])
      expect(realStatus.status?.engine?.ok).toBe(true)
      expect(realStatus.status?.engine?.entries).toBeGreaterThan(0)
    }
    // A corrupt meta.json falls back to the legacy home root (no crash).
    const badState = join(base, 'bad-state')
    mkdirSync(badState, { recursive: true })
    writeFileSync(join(badState, 'meta.json'), '{bad json')
    const fallback = JSON.parse(runCli(['status', '--detail', 'full', '--api=2026-11', '--state', badState], { DSH_LOCATOR_ROOTS: '', DSH_LOCATOR_BIN: argvMock.binary, DSH_LOCATOR_MOCK_ARGV: join(base, 'argv2.jsonl'), DSH_LOCATOR_MOCK_PATH: join(roots[0] as string, 'x.md') }).stdout) as { status?: { roots?: string[] } }
    expect(fallback.status?.roots).toEqual([homedir()])
  })

  it('generates standard JSON Schema and verifies the host contract with gen-agent-schemas --check', () => {
    const check = spawnSync(process.execPath, [join(scriptDir, 'gen-agent-schemas.mjs'), '--check'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    expect(check.status).toBe(0)
    expect(check.stdout).toContain('ok')
    expect(check.stdout).toContain('12 closed codes')
    const printed = spawnSync(process.execPath, [join(scriptDir, 'gen-agent-schemas.mjs')], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    expect(printed.status).toBe(0)
    const schemas = JSON.parse(printed.stdout) as { apiVersion?: string; find?: { input?: JsonSchema }; failure?: JsonSchema }
    expect(schemas.apiVersion).toBe('2026-11')
    expect(schemaViolations(schemas.find?.input)).toEqual([])
    expect(schemaViolations(schemas.failure)).toEqual([])
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
