import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const doctorPath = join(import.meta.dirname, '..', 'scripts', 'doctor.mjs')
const packageVersion = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }).version
const cleanups: Array<() => void> = []
afterAll(() => {
  for (const cleanup of cleanups.reverse()) cleanup()
})

interface DoctorCheck {
  id: string
  status: 'ok' | 'info' | 'warning' | 'error' | 'skipped'
  summary: string
  details?: Record<string, unknown>
}
interface DoctorReport {
  generatedAt: string
  doctorVersion: string
  root: string
  stateDir: string
  ok: boolean
  summary: { ok: number; info: number; warning: number; error: number; skipped: number }
  checks: DoctorCheck[]
  restoreCommands: Array<{ label: string; command: string }>
}

interface Fixture {
  root: string
  state: string
  files: string[]
}

function tempBase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'locator-doctor-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const ENGINE_TARGETS = ['linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64']

/** A package+state fixture the doctor can inspect without touching real installs. */
function makeFixture(options: {
  withState?: boolean
  wrongPermissions?: boolean
  corruptMeta?: boolean
  missingLib?: boolean
  contentDb?: boolean
  lastGoodVersion?: string
} = {}): Fixture {
  const base = tempBase()
  const root = join(base, 'package')
  const state = join(base, 'state')
  mkdirSync(root, { recursive: true })
  const manifest = {
    name: 'dsh-locator',
    version: '0.23.0',
    type: 'module',
    engines: { node: '^22.19.0 || >=24.9.0', dsh: '>=0.2.1-rc.2 <0.3.0' },
    dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    exports: { '.': { default: './lib/index.js' }, './client': { default: './client.js' } },
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(join(root, 'cordis.patch.yml'), 'name: dsh-locator\n---\nplugin: dsh-locator\n')
  writeFileSync(join(root, 'client.js'), '/* client bundle */\n'.repeat(500))
  if (options.missingLib !== true) {
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'lib', 'index.js'), 'export {}\n'.repeat(120))
    writeFileSync(join(root, 'lib', 'index.d.ts'), 'export {}\n')
  }
  const payload = Buffer.alloc(1_100_000)
  for (const target of ENGINE_TARGETS) {
    const dir = join(root, 'bin', target)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, target.startsWith('win32') ? 'indexd.exe' : 'indexd'), payload)
  }
  const files: string[] = []
  if (options.withState !== false) {
    mkdirSync(state, { recursive: true })
    // A v2 snapshot header (the doctor parses the header, not the payload).
    const snapshot = Buffer.alloc(96)
    snapshot.write('DSHLOC01', 0, 'latin1')
    snapshot.writeUInt32LE(2, 8)
    snapshot.writeUInt32LE(0, 12)
    snapshot.writeBigUInt64LE(42n, 16)
    snapshot.writeBigUInt64LE(32n, 24)
    snapshot.writeBigInt64LE(BigInt(Date.now()) * 1_000_000n, 32)
    snapshot.writeUInt32LE(3, 40)
    snapshot.writeUInt32LE(9, 44)
    snapshot.writeUInt32LE(0, 48)
    snapshot.writeUInt32LE(1, 52)
    snapshot.writeUInt32LE(16, 56)
    snapshot.writeUInt32LE(0, 60)
    writeFileSync(join(state, 'index.snapshot'), snapshot)
    writeFileSync(join(state, 'meta.json'), options.corruptMeta === true
      ? '{not json'
      : JSON.stringify({
          version: '0.23.0',
          roots: ['/tmp/fixture-root'],
          excludes: [],
          builtAt: new Date().toISOString(),
          platform: 'linux/amd64',
          stats: { roots: 1, entries: 3, dirs: 1, files: 2, skipped: 0, errors: 0, workers: 1, usn: false, tookNs: 1_000_000 },
          indexStats: { entries: 3, files: 2, dirs: 1, roots: 1 },
          lastRefresh: { at: new Date().toISOString(), mode: 'initial', stats: { roots: 1, entries: 3, dirs: 1, files: 2, skipped: 0, errors: 0, workers: 1, usn: false, tookNs: 1_000_000 } },
        }))
    if (options.contentDb === true) {
      const db = new DatabaseSync(join(state, 'content.db'))
      db.exec('PRAGMA user_version = 4')
      db.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT)')
      db.exec('CREATE TABLE docs_meta (path TEXT PRIMARY KEY)')
      db.exec('CREATE TABLE sources (id INTEGER PRIMARY KEY)')
      db.exec('CREATE TABLE content_meta (key TEXT PRIMARY KEY, value INTEGER)')
      db.exec("INSERT INTO content_meta (key, value) VALUES ('warn:content-fts-optimize-failed', 2)")
      db.close()
    }
    // A stale engine lock from a process that already exited.
    const dead = spawnSync(process.execPath, ['-e', '0'])
    writeFileSync(join(state, 'engine.lock'), JSON.stringify({ pid: dead.pid, procStart: 1, startedAt: Date.now() - 60_000, heartbeatAt: Date.now() - 60_000, version: '0.23.0' }))
    writeFileSync(join(state, 'last-good-profile.json'), JSON.stringify({
      recordedAt: new Date().toISOString(),
      packageVersion: options.lastGoodVersion ?? packageVersion,
      stateDir: state,
      platform: 'linux-x64',
      nodeVersion: process.version,
      warnings: ['filesystem watching degraded: inotify quota'],
    }))
    if (options.wrongPermissions === true && process.platform !== 'win32') {
      chmodSync(state, 0o755)
      chmodSync(join(state, 'meta.json'), 0o644)
    }
    for (const name of readdirSync(state)) files.push(name)
  }
  return { root, state, files }
}

/** Run the doctor and return the raw process result. */
function runDoctor(args: string[]) {
  const result = spawnSync(process.execPath, [doctorPath, ...args], { encoding: 'utf8', timeout: 90_000 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** A deterministic digest of a directory tree (paths, sizes, modes, contents). */
function treeHash(dir: string): string {
  const hash = createHash('sha256')
  const walk = (current: string) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        hash.update('d:' + full + '\n')
        walk(full)
      } else if (entry.isFile()) {
        const info = statSync(full)
        hash.update('f:' + full + ':' + String(info.size) + ':' + String(info.mode & 0o777) + '\n')
        hash.update(readFileSync(full))
      }
    }
  }
  walk(dir)
  return hash.digest('hex')
}
describe('doctor (read-only)', () => {
  it('reports a healthy fixture as JSON without error-level findings', () => {
    const fixture = makeFixture({ contentDb: true })
    const { status, stdout, stderr } = runDoctor(['--root', fixture.root, '--state', fixture.state, '--json'])
    expect(stderr).toBe('')
    const report = JSON.parse(stdout) as DoctorReport
    expect(report.doctorVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(report.stateDir).toBe(fixture.state)
    expect(report.summary.error).toBe(0)
    expect(report.ok).toBe(true)
    const byId = new Map(report.checks.map(check => [check.id, check]))
    expect(byId.get('package.name')?.status).toBe('ok')
    expect(byId.get('package.node')?.status).toBe('ok')
    expect(byId.get('bundle.patch')?.status).toBe('ok')
    expect(byId.get('lib.entry')?.status).toBe('ok')
    expect(byId.get('bin.payload')?.status).toBe('ok')
    expect(byId.get('stateDir.snapshot')?.status).toBe('ok')
    expect(byId.get('stateDir.meta')?.status).toBe('ok')
    expect(byId.get('stateDir.meta-indexStats')?.status).toBe('ok')
    expect(byId.get('stateDir.meta-lastRefresh')?.status).toBe('ok')
    expect(byId.get('stateDir.meta-consistency')?.status).toBe('ok')
    expect(byId.get('stateDir.contentDb-schema')?.status).toBe('ok')
    expect(byId.get('stateDir.engineLock')?.status).toBe('warning')
    expect(byId.get('warnings.latest')?.status).toBe('warning')
    expect(byId.get('profile.untouched')?.status).toBe('ok')
    expect(status).toBe(0)
  })

  it('detects missing engines and exits 1 on error-level findings', () => {
    const fixture = makeFixture({ missingLib: true })
    rmSync(join(fixture.root, 'bin'), { recursive: true, force: true })
    const { status, stdout } = runDoctor(['--root', fixture.root, '--state', fixture.state, '--json'])
    const report = JSON.parse(stdout) as DoctorReport
    expect(report.summary.error).toBeGreaterThan(0)
    expect(report.ok).toBe(false)
    const ids = report.checks.filter(check => check.status === 'error').map(check => check.id)
    expect(ids).toContain('lib.entry')
    expect(ids.some(id => id.startsWith('bin.'))).toBe(true)
    expect(status).toBe(1)
  })

  it('warns about a corrupt meta.json and suggests a copy', () => {
    const fixture = makeFixture({ corruptMeta: true })
    const { stdout } = runDoctor(['--root', fixture.root, '--state', fixture.state, '--json'])
    const report = JSON.parse(stdout) as DoctorReport
    const meta = report.checks.find(check => check.id === 'stateDir.meta')
    expect(meta?.status).toBe('warning')
    expect(meta?.summary).toMatch(/corrupt/i)
    expect(report.restoreCommands.some(item => /meta\.json\.bak/.test(item.command))).toBe(true)
  })

  it('suggests permission fixes only on POSIX platforms', () => {
    if (process.platform === 'win32') return
    const fixture = makeFixture({ wrongPermissions: true })
    const { stdout } = runDoctor(['--root', fixture.root, '--state', fixture.state, '--json'])
    const report = JSON.parse(stdout) as DoctorReport
    const permissions = report.checks.find(check => check.id === 'stateDir.permissions')
    expect(permissions?.status).toBe('warning')
    const commands = report.restoreCommands.map(item => item.command)
    expect(commands).toContain('chmod 700 ' + fixture.state)
    expect(commands.some(command => command.startsWith('chmod 600 ') && command.endsWith('meta.json'))).toBe(true)
  })

  it('reports the last known-good version and how to pin it', () => {
    const fixture = makeFixture({ lastGoodVersion: '0.22.3' })
    const { stdout } = runDoctor(['--root', fixture.root, '--state', fixture.state, '--json'])
    const report = JSON.parse(stdout) as DoctorReport
    const lastGood = report.checks.find(check => check.id === 'stateDir.lastGood-version')
    expect(lastGood?.status).toBe('warning')
    expect(report.restoreCommands.map(item => item.command)).toContain('dsh plugin add dsh-locator@0.22.3')
  })

  it('prints only restore commands with --print-restore', () => {
    const fixture = makeFixture({ wrongPermissions: true })
    const { status, stdout } = runDoctor(['--root', fixture.root, '--state', fixture.state, '--print-restore'])
    expect(stdout).toContain('# dsh-locator doctor restore steps')
    expect(stdout).toContain('Printed only')
    expect(stdout).not.toContain('[ok]')
    expect(stdout).not.toContain('summary:')
    expect(stdout).toMatch(/chmod |rm |del /)
    expect(status).toBe(0)
  })

  it('never modifies the package or state directory', () => {
    const fixture = makeFixture({ contentDb: true })
    const rootBefore = treeHash(fixture.root)
    const stateBefore = treeHash(fixture.state)
    runDoctor(['--root', fixture.root, '--state', fixture.state, '--json'])
    expect(treeHash(fixture.root)).toBe(rootBefore)
    expect(treeHash(fixture.state)).toBe(stateBefore)
  })

  it('tolerates a missing state directory (first run)', () => {
    const fixture = makeFixture({ withState: false })
    const missingState = join(fixture.root, 'nope', 'state')
    const { status, stdout } = runDoctor(['--root', fixture.root, '--state', missingState, '--json'])
    const report = JSON.parse(stdout) as DoctorReport
    expect(report.ok).toBe(true)
    expect(report.checks.find(check => check.id === 'stateDir.exists')?.status).toBe('info')
    expect(status).toBe(0)
  })

  it('warns instead of crashing on an engine payload that cannot run', () => {
    const fixture = makeFixture()
    const { stdout } = runDoctor(['--root', fixture.root, '--state', fixture.state, '--json'])
    const report = JSON.parse(stdout) as DoctorReport
    const host = report.checks.find(check => check.id === 'bin.host')
    expect(host?.status).toBe('warning')
  })

  it('prints usage and validates arguments', () => {
    const help = runDoctor(['--help'])
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('usage: node scripts/doctor.mjs')
    const bad = runDoctor(['--bogus'])
    expect(bad.status).toBe(2)
    expect(bad.stderr).toContain('unknown argument')
  })
})
