/**
 * Read-only contract of the versioned CLI (--api=2026-11).
 *
 * The 2026-11 commands must behave like the 0.21.1 read-only promise: the
 * caller state directory is never created, rewritten or appended to; the
 * engine runs against a temporary copy of the snapshot that is deleted on
 * exit; and the files-only identity hides session documents.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const scriptDir = join(import.meta.dirname, '..', 'scripts')
const cliPath = join(scriptDir, 'locator-cli.mjs')
const engineName = process.platform === 'win32' ? 'indexd.exe' : 'indexd'
const engineBinary = join(import.meta.dirname, '..', 'bin', process.platform + '-' + process.arch, engineName)

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

/** Build a schema-v4 content.db with file and session documents. */
function makeContentDb(stateDir: string, docs: Array<{ kind: 'file' | 'session'; path: string; title: string; body: string; sessionId?: string }>): void {
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
    const insertMeta = db.prepare('INSERT INTO docs_meta (rowid, path_id, mtime, kind_id, session_key) VALUES (?, ?, ?, ?, ?)')
    for (const [index, doc] of docs.entries()) {
      const rowid = index + 1
      insertDoc.run(rowid, doc.body, doc.kind, doc.path, doc.title, doc.sessionId ?? null, null)
      insertPath.run(rowid, doc.path)
      insertMeta.run(rowid, rowid, index, doc.kind === 'session' ? 1 : 0, doc.kind === 'session' ? 'session:' + String(index) : null)
    }
  } finally {
    db.close()
  }
}

/** Build a real engine state directory (index.snapshot + meta.json) for one root. */
function buildEngineState(stateDir: string, root: string): void {
  mkdirSync(stateDir, { recursive: true })
  const result = spawnSync(engineBinary, ['scan', '--state', stateDir, '--root', root], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  if (result.status !== 0 || !existsSync(join(stateDir, 'index.snapshot'))) throw new Error('engine scan failed (status ' + String(result.status) + ')')
}

/** A dedicated temp directory exposed as TMPDIR/TEMP/TMP to a child process. */
function sandboxTmp(base: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = join(base, 'tmp')
  mkdirSync(dir, { recursive: true })
  return { dir, env: { TMPDIR: dir, TEMP: dir, TMP: dir } }
}

describe('CLI 2026-11 read-only contract', () => {
  it.skipIf(!existsSync(engineBinary))('never mutates the caller state directory and cleans up its temporary copy', () => {
    const base = tempDir('locator-cli-ro-agent-')
    const root = join(base, 'root')
    mkdirSync(root, { recursive: true })
    const file = join(root, 'notes.md')
    writeFileSync(file, 'one\ntwo needle here\nthree\n')
    const sessionLog = join(root, 'sessions', 's1', 'log.jsonl')
    const state = join(base, 'state')
    buildEngineState(state, root)
    makeContentDb(state, [
      { kind: 'file', path: file, title: 'notes.md', body: 'one\ntwo needle here\nthree\n' },
      { kind: 'session', path: sessionLog, title: 's1', body: 'needle from session one', sessionId: 's1' },
    ])
    const sandbox = sandboxTmp(base)
    const before = dirSnapshot(state)
    const stateDirMtime = statSync(state).mtimeMs
    const commands: string[][] = [
      ['status', '--api=2026-11', '--detail', 'brief', '--state', state, '--root', root],
      ['find', 'needle', '--mode', 'body', '--api=2026-11', '--state', state, '--root', root, '--scope', 'roots'],
      ['find', 'needle', '--mode', 'name', '--api=2026-11', '--state', state, '--root', root, '--scope', 'roots'],
      ['find', 'notes', '--mode', 'name', '--api=2026-11', '--state', state, '--root', root, '--scope', 'roots'],
      ['read', file, '--as', 'excerpt', '--line', '2', '--api=2026-11', '--state', state, '--root', root],
      ['status', '--api=2026-11', '--detail', 'full', '--state', state, '--root', root],
    ]
    for (const command of commands) {
      const result = runCli(command, sandbox.env)
      expect(result.status).toBe(0)
      // The temporary engine state copy is deleted when the process exits.
      expect(readdirSync(sandbox.dir)).toEqual([])
      expect(dirSnapshot(state)).toEqual(before)
      expect(statSync(state).mtimeMs).toBe(stateDirMtime)
    }
    // Session documents are hidden by the files-only agent identity.
    const find = JSON.parse(runCli(['find', 'needle', '--mode', 'body', '--api=2026-11', '--state', state, '--root', root, '--scope', 'roots'], sandbox.env).stdout) as { items?: Array<{ kind?: string; path?: string }> }
    expect(find.items?.every(item => item.kind === 'file')).toBe(true)
    expect(find.items?.some(item => item.path === sessionLog)).toBe(false)
    // Session refs are denied without reading any bytes.
    const sessionRef = 'dsh-session:' + Buffer.from(JSON.stringify('s1'), 'utf8').toString('base64url')
    const denied = runCli(['read', sessionRef, '--api=2026-11', '--state', state, '--root', root], sandbox.env)
    expect(denied.status).toBe(4)
    expect((JSON.parse(denied.stdout) as { error?: { code?: string; details?: { legacyCode?: string } } }).error?.code).toBe('scope-denied')
    expect((JSON.parse(denied.stdout) as { error?: { details?: { legacyCode?: string } } }).error?.details?.legacyCode).toBe('files-only-session')
  })

  it('never creates a missing state directory as a side effect of a 2026-11 read', () => {
    const base = tempDir('locator-cli-ro-missing-')
    const root = join(base, 'root')
    mkdirSync(root, { recursive: true })
    const file = join(root, 'notes.md')
    writeFileSync(file, 'needle here\n')
    const missingState = join(base, 'never-created')
    const sandbox = sandboxTmp(base)
    const body = runCli(['find', 'needle', '--mode', 'body', '--api=2026-11', '--state', missingState, '--root', root], sandbox.env)
    expect(body.status).toBe(3)
    expect((JSON.parse(body.stdout) as { error?: { code?: string } }).error?.code).toBe('index-unavailable')
    expect(existsSync(missingState)).toBe(false)
    const read = runCli(['read', file, '--api=2026-11', '--state', missingState, '--root', root], sandbox.env)
    expect(read.status).toBe(0)
    expect((JSON.parse(read.stdout) as { ok?: boolean }).ok).toBe(true)
    expect(existsSync(missingState)).toBe(false)
    expect(readdirSync(sandbox.dir)).toEqual([])
    // --api=2026-11 exposes no maintenance/admin command at all.
    const maintenance = runCli(['rebuild', '--api=2026-11', '--state', missingState, '--root', root], sandbox.env)
    expect(maintenance.status).toBe(2)
    expect((JSON.parse(maintenance.stdout) as { error?: { code?: string } }).error?.code).toBe('invalid-argument')
    expect(existsSync(missingState)).toBe(false)
  })
})
