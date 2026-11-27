/**
 * Public CLI contract: the frozen 0.22 default surface and the opt-in
 * versioned (agent API 2026-11) output mode.
 *
 * The MCP/CLI parity matrix and the fuller protocol/schema tests live in
 * test/mcp.spec.ts; this file pins the process boundary: argv parsing, exit
 * statuses and the byte-compatible legacy output.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const scriptDir = join(import.meta.dirname, '..', 'scripts')
const cliPath = join(scriptDir, 'locator-cli.mjs')
const packageVersion = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }).version

const cleanups: Array<() => void> = []
afterAll(() => {
  for (const cleanup of cleanups.reverse()) cleanup()
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true, timeout: 60_000 })
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

/** Build a schema-v4 content.db with file documents (no name index needed). */
function makeContentDb(stateDir: string, docs: Array<{ path: string; title: string; body: string }>): void {
  mkdirSync(stateDir, { recursive: true })
  const db = new DatabaseSync(join(stateDir, 'content.db'))
  try {
    db.exec("CREATE VIRTUAL TABLE docs USING fts5(body, kind UNINDEXED, path UNINDEXED, title UNINDEXED, session_id UNINDEXED, message_id UNINDEXED, tokenize = 'trigram')")
    db.exec('CREATE TABLE paths (id INTEGER PRIMARY KEY, path TEXT NOT NULL)')
    db.exec('CREATE UNIQUE INDEX paths_path ON paths(path)')
    db.exec('CREATE TABLE docs_meta (rowid INTEGER PRIMARY KEY, path_id INTEGER NOT NULL, mtime INTEGER, kind_id INTEGER NOT NULL, node_key TEXT, format TEXT, session_key TEXT)')
    db.exec('CREATE TABLE symbols (path_id INTEGER NOT NULL, name TEXT NOT NULL, kind INTEGER NOT NULL, line INTEGER NOT NULL, language INTEGER, scope TEXT)')
    db.exec('CREATE TABLE sources (path TEXT PRIMARY KEY, mtime INTEGER, cwd TEXT, byte_len INTEGER, last_line INTEGER, title TEXT, capped INTEGER)')
    db.exec('CREATE TABLE content_meta (key TEXT PRIMARY KEY, value INTEGER)')
    db.exec('PRAGMA user_version = 4')
    const insertDoc = db.prepare('INSERT INTO docs (rowid, body, kind, path, title, session_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const insertPath = db.prepare('INSERT INTO paths (id, path) VALUES (?, ?)')
    const insertMeta = db.prepare('INSERT INTO docs_meta (rowid, path_id, mtime, kind_id) VALUES (?, ?, ?, ?)')
    for (const [index, doc] of docs.entries()) {
      const rowid = index + 1
      insertDoc.run(rowid, doc.body, 'file', doc.path, doc.title, null, null)
      insertPath.run(rowid, doc.path)
      insertMeta.run(rowid, rowid, index, 0)
    }
  } finally {
    db.close()
  }
}

/** A tiny fake engine: ready + one status answer, no search. */
function writeStatusMock(root: string): string {
  const mock = join(root, 'status-indexd')
  writeFileSync(mock, [
    '#!/usr/bin/env node',
    "const readline = require('node:readline')",
    "process.stdout.write(JSON.stringify({ event: 'ready', params: { scanning: false } }) + String.fromCharCode(10))",
    "const rl = readline.createInterface({ input: process.stdin })",
    "rl.on('line', line => {",
    '  let message',
    '  try { message = JSON.parse(line) } catch { return }',
    "  if (message.method === 'shutdown') process.exit(0)",
    "  if (message.method === 'status') process.stdout.write(JSON.stringify({ id: message.id, result: { scanning: false, entries: 7, files: 6, dirs: 1, version: 'mock' } }) + String.fromCharCode(10))",
    '})',
  ].join('\n'))
  chmodSync(mock, 0o755)
  return mock
}

describe('locator-cli contract', () => {
  it('prints help/version and rejects usage errors with the frozen legacy text', () => {
    const help = runCli(['help'])
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('locator-cli search')
    expect(help.stdout).toContain('Exit codes: 0 ok, 1 runtime error, 2 usage error, 3 index/engine unavailable.')
    expect(help.stdout).toContain('--api=2026-11')
    expect(help.stdout).toContain('locator-cli read')
    expect(help.stdout).toContain('2026-11 exit codes: 0 ok, 1 internal, 2 usage, 3 index unavailable, 4 denied/not found.')
    expect(runCli(['version']).stdout).toBe(packageVersion)
    expect(runCli(['search', '--json']).status).toBe(2)
    expect(runCli(['status', '--api=2099-01-01']).status).toBe(2)
  })

  it('keeps the legacy default outputs free of the 2026-11 envelope', () => {
    const root = tempDir('locator-cli-legacy-')
    const state = join(root, 'state')
    const file = join(root, 'notes.md')
    writeFileSync(file, 'one\ntwo needle here\nthree\n')
    makeContentDb(state, [{ path: file, title: 'notes.md', body: 'one\ntwo needle here\nthree\n' }])
    const find = JSON.parse(runCli(['find', 'needle', '--json', '--state', state, '--root', root]).stdout) as Record<string, unknown>
    expect(find.ok).toBe(true)
    expect(find.command).toBe('find')
    expect(find.mode).toBe('content')
    expect(find.apiVersion).toBeUndefined()
    expect(find.tool).toBeUndefined()
    const status = JSON.parse(runCli(['status', '--json', '--state', state, '--root', root, '--bin', writeStatusMock(root)]).stdout) as Record<string, unknown>
    expect(status.ok).toBe(true)
    expect(status.command).toBe('status')
    expect(status.apiVersion).toBeUndefined()
  })

  it('emits one 2026-11 envelope per command and reads roots from meta.json', () => {
    const root = tempDir('locator-cli-agent-')
    const state = join(root, 'state')
    const file = join(root, 'notes.md')
    writeFileSync(file, 'one\ntwo needle here\nthree\n')
    makeContentDb(state, [{ path: file, title: 'notes.md', body: 'one\ntwo needle here\nthree\n' }])
    writeFileSync(join(state, 'meta.json'), JSON.stringify({ roots: [root] }))
    const find = JSON.parse(runCli(['find', 'needle', '--mode', 'body', '--api=2026-11', '--state', state, '--scope', 'roots']).stdout) as { apiVersion?: string; ok?: boolean; tool?: string; items?: Array<{ ref?: string }> }
    expect(find.apiVersion).toBe('2026-11')
    expect(find.ok).toBe(true)
    expect(find.tool).toBe('locator_find')
    const read = JSON.parse(runCli(['read', String(find.items?.[0]?.ref), '--api=2026-11', '--state', state, '--as', 'excerpt', '--line', '2']).stdout) as { ok?: boolean; items?: Array<{ excerpt?: string }> }
    expect(read.ok).toBe(true)
    expect(String(read.items?.[0]?.excerpt)).toContain('needle')
    const status = JSON.parse(runCli(['status', '--detail', 'full', '--api=2026-11', '--state', state, '--bin', writeStatusMock(root)]).stdout) as { ok?: boolean; status?: { roots?: string[] } }
    expect(status.ok).toBe(true)
    expect(status.status?.roots).toEqual([root])
  })

  it.skipIf(process.platform === 'win32')('maps the 12 closed error codes onto CLI exit statuses', async () => {
    interface CliModule { AGENT_ERROR_EXIT_CODES: Record<string, number>; AGENT_ERROR_CODE_LIST: string[] }
    const cli = await import(new URL('../scripts/locator-cli.mjs', import.meta.url).href) as unknown as CliModule
    expect([...cli.AGENT_ERROR_CODE_LIST].sort()).toEqual([
      'budget-too-small', 'cancelled', 'cursor-invalid', 'index-building', 'index-unavailable', 'internal',
      'invalid-argument', 'not-found', 'query-invalid', 'query-too-short', 'scope-denied', 'scope-empty-workspace',
    ])
    for (const [code, expected] of Object.entries({
      'invalid-argument': 2, 'query-too-short': 2, 'query-invalid': 2, 'budget-too-small': 2, 'cursor-invalid': 2,
      'scope-denied': 4, 'scope-empty-workspace': 4, 'not-found': 4,
      'index-unavailable': 3, 'index-building': 3, cancelled: 1, internal: 1,
    })) {
      expect(cli.AGENT_ERROR_EXIT_CODES[code]).toBe(expected)
    }
    const root = tempDir('locator-cli-exit-')
    const state = join(root, 'state')
    const missingState = join(root, 'never-created')
    const unavailable = runCli(['find', 'needle', '--mode', 'body', '--api=2026-11', '--state', missingState, '--root', root])
    expect(unavailable.status).toBe(3)
    expect((JSON.parse(unavailable.stdout) as { error?: { code?: string } }).error?.code).toBe('index-unavailable')
    expect(existsSync(missingState)).toBe(false)
    const badMode = runCli(['find', 'needle', '--mode', 'bogus', '--api=2026-11', '--state', state, '--root', root])
    expect(badMode.status).toBe(2)
    expect((JSON.parse(badMode.stdout) as { error?: { code?: string } }).error?.code).toBe('invalid-argument')
  })

  it('generates standard JSON Schema and verifies the host contract', () => {
    const check = spawnSync(process.execPath, [join(scriptDir, 'gen-agent-schemas.mjs'), '--check'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    expect(check.status).toBe(0)
    expect(check.stdout).toContain('12 closed codes')
  })
})
