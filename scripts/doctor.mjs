#!/usr/bin/env node
/**
 * Read-only dsh-locator doctor.
 *
 * Diagnoses an installed (or development) dsh-locator package and its state
 * directory: package manifest, bundle patch, peer dependencies, compiled lib,
 * the six engine binaries, state-dir permissions, snapshot/journal/meta schema,
 * content.db schema and warning counters, quarantine archives, stale temporary
 * files, the engine write lock, the last-good-profile records and free disk
 * space.
 *
 * This script NEVER writes anything: it only reads files and prints a report.
 * The DSH profile (cordis.yml, config, state directory contents) is never
 * modified and no command is ever executed on the user's behalf --
 * `--print-restore` prints the recovery commands for a human to run.
 *
 * Usage:
 *   node scripts/doctor.mjs [--json] [--print-restore] [--state DIR] [--root DIR]
 *
 * Exit code: 0 when no error-level finding exists, 1 when one does, 2 on a
 * usage error.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, statfsSync } from 'node:fs'
import { openSync, readSync, closeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOC_VERSION = '0.23.0'
const IS_WINDOWS = process.platform === 'win32'

/** All six engine payloads every published package must ship. */
const ENGINE_TARGETS = [
  { tag: 'linux-x64', goos: 'linux', goarch: 'amd64', binary: 'indexd' },
  { tag: 'linux-arm64', goos: 'linux', goarch: 'arm64', binary: 'indexd' },
  { tag: 'win32-x64', goos: 'windows', goarch: 'amd64', binary: 'indexd.exe' },
  { tag: 'win32-arm64', goos: 'windows', goarch: 'arm64', binary: 'indexd.exe' },
  { tag: 'darwin-x64', goos: 'darwin', goarch: 'amd64', binary: 'indexd' },
  { tag: 'darwin-arm64', goos: 'darwin', goarch: 'arm64', binary: 'indexd' },
]
/** A binary smaller than this cannot be a real engine payload. */
const MIN_ENGINE_BYTES = 1_000_000
/** Files inside the state directory that must be owner-only (0600). */
const PRIVATE_STATE_FILES = ['index.snapshot', 'index.journal', 'meta.json', 'content.db', 'content.db-wal', 'content.db-shm', 'engine.lock']
/** Content schema this plugin version writes (src/content.ts SCHEMA_VERSION). */
const CONTENT_SCHEMA_VERSION = 4
/** content.ts quarantine retention: 2 archives, 7 days. */
const CORRUPT_MAX_ARCHIVES = 2
const CORRUPT_RETENTION_MS = 7 * 24 * 60 * 60_000
/** Engine lock staleness window (engine/internal/store/lock.go). */
const ENGINE_LOCK_STALE_MS = 5 * 60_000
/** Temporary state files older than this are leftovers from a crashed save. */
const STALE_TMP_MS = 60 * 60_000

/** Resolve the per-user default state directory (mirrors src/paths.ts). */
function defaultStateDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return join(base, 'dsh-locator')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'dsh-locator')
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dsh-locator')
}

/** Human-readable byte size. */
function formatBytes(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n < 1024) return String(Math.round(n)) + ' B'
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let size = n / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
  return size.toFixed(size >= 10 ? 0 : 1) + ' ' + units[unit]
}

/** Message of an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Stat a path, or null when it does not exist. */
function statOrNull(path) {
  try { return statSync(path) } catch { return null }
}

/** POSIX permission bits of a path, or null. */
function modeOrNull(path) {
  const info = statOrNull(path)
  return info === null ? null : info.mode & 0o777
}

/** Parse 'v24.1.0' / '0.2.2-rc.4+build' into comparable parts. */
function parseSemver(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text).trim())
  if (match === null) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? '' }
}

/** Compare two parsed versions (a prerelease sorts before its release). */
function compareSemver(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return a.pre < b.pre ? -1 : 1
}

/**
 * Does version satisfy a simple semver range (the subset package.json uses)?
 * Supports ^, ~, >=, <=, >, <, =, exact, whitespace conjunction and ||.
 */
function satisfiesRange(version, range) {
  const parsed = parseSemver(version)
  if (parsed === null) return false
  return String(range).split('||').some(part => {
    const tokens = part.trim().split(/\s+/).filter(token => token !== '')
    if (tokens.length === 0) return false
    return tokens.every(token => {
      const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token)
      if (match === null) return false
      const op = match[1] ?? '='
      const target = parseSemver(match[2])
      if (target === null) return false
      const cmp = compareSemver(parsed, target)
      switch (op) {
        case '^':
          if (cmp < 0) return false
          if (target.major > 0) return parsed.major === target.major
          if (target.minor > 0) return parsed.major === 0 && parsed.minor === target.minor
          return parsed.major === 0 && parsed.minor === 0 && parsed.patch === target.patch
        case '~':
          return cmp >= 0 && parsed.major === target.major && parsed.minor === target.minor
        case '>=':
          return cmp >= 0
        case '<=':
          return cmp <= 0
        case '>':
          return cmp > 0
        case '<':
          return cmp < 0
        default:
          return cmp === 0
      }
    })
  })
}

/** Read engine.lock-liveness helpers: a PID that exists (EPERM still exists). */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error !== null && typeof error === 'object' && error.code === 'EPERM'
  }
}

/** One diagnostic report collector. */
function createReport() {
  const checks = []
  const restore = []
  const add = (id, status, summary, details) => {
    const check = { id, status, summary }
    if (details !== undefined) check.details = details
    checks.push(check)
    return check
  }
  const suggest = (label, command) => { restore.push({ label, command }) }
  return { checks, restore, add, suggest }
}
/** Check package.json, the bundle patch and the client bundle. */
function checkPackage(report, root) {
  const manifestPath = join(root, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    report.add('package.manifest', 'error', 'cannot read ' + manifestPath + ': ' + messageOf(error))
    return null
  }
  if (pkg !== null && typeof pkg === 'object' && pkg.name === 'dsh-locator') {
    report.add('package.name', 'ok', 'dsh-locator ' + String(pkg.version))
  } else {
    report.add('package.name', 'error', 'unexpected package name ' + JSON.stringify(pkg?.name))
  }
  const version = typeof pkg.version === 'string' ? pkg.version : ''
  if (parseSemver(version) === null) {
    report.add('package.version', 'error', 'package.json has no semver version: ' + JSON.stringify(pkg.version))
  } else {
    report.add('package.version', 'ok', 'version ' + version)
  }

  const nodeRange = pkg.engines?.node
  if (typeof nodeRange === 'string' && nodeRange !== '') {
    if (satisfiesRange(process.version, nodeRange)) {
      report.add('package.node', 'ok', 'Node ' + process.version + ' satisfies engines.node ' + nodeRange)
    } else {
      report.add('package.node', 'error', 'Node ' + process.version + ' does not satisfy engines.node ' + nodeRange + '; the plugin cannot load')
      report.suggest('Install a supported Node.js release for this profile', '# required: ' + nodeRange + ' (current ' + process.version + ')')
    }
  } else {
    report.add('package.node', 'warning', 'package.json has no engines.node range')
  }
  const dshRange = pkg.engines?.dsh
  if (typeof dshRange === 'string' && dshRange !== '') {
    report.add('package.dsh', 'ok', 'declares engines.dsh ' + dshRange + ' (the installed host version is only visible to DSH itself)')
  } else {
    report.add('package.dsh', 'warning', 'package.json has no engines.dsh range')
  }

  const patch = pkg.dsh?.bundle?.patch
  if (patch === './cordis.patch.yml') {
    report.add('bundle.manifest', 'ok', 'package.json declares dsh.bundle.patch')
  } else {
    report.add('bundle.manifest', 'error', 'package.json dsh.bundle.patch is ' + JSON.stringify(patch) + ', expected \'./cordis.patch.yml\'')
  }
  if (pkg.dsh?.client?.platform === 'web') {
    report.add('bundle.client', 'ok', 'package.json declares dsh.client.platform = web')
  } else {
    report.add('bundle.client', 'warning', 'package.json does not declare dsh.client.platform = web (the search panel will not mount)')
  }
  const patchPath = join(root, 'cordis.patch.yml')
  if (!existsSync(patchPath)) {
    report.add('bundle.patch', 'error', 'bundle patch is missing: ' + patchPath)
    report.suggest('Reinstall the package (the bundle patch ships with it)', IS_WINDOWS
      ? '# reinstall dsh-locator through the DSH profile manager; the npm tarball contains cordis.patch.yml'
      : '# reinstall dsh-locator: npm pack / dsh plugin update; cordis.patch.yml must exist at the package root')
  } else {
    let patchText = ''
    try { patchText = readFileSync(patchPath, 'utf8') } catch (error) {
      report.add('bundle.patch', 'error', 'cannot read ' + patchPath + ': ' + messageOf(error))
    }
    if (patchText !== '') {
      if (patchText.includes('dsh-locator')) {
        report.add('bundle.patch', 'ok', 'cordis.patch.yml references dsh-locator')
      } else {
        report.add('bundle.patch', 'warning', 'cordis.patch.yml does not mention dsh-locator; the bundle may not mount the plugin')
      }
    }
  }
  const clientPath = join(root, 'client.js')
  const clientInfo = statOrNull(clientPath)
  if (clientInfo === null || clientInfo.size < 5_000) {
    report.add('bundle.client-asset', 'warning', 'client.js is missing or truncated; the Web search panel will not load')
  } else {
    report.add('bundle.client-asset', 'ok', 'client.js ' + formatBytes(clientInfo.size))
  }
  return pkg
}

/** Check that the declared peer dependencies are resolvable from the package. */
function checkDependencies(report, root) {
  let pkg
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) } catch { return }
  const peers = Object.keys(pkg.peerDependencies ?? {})
  if (peers.length === 0) {
    report.add('deps.peers', 'info', 'package.json declares no peer dependencies')
    return
  }
  const require = createRequire(join(root, 'package.json'))
  const missing = []
  const resolved = []
  for (const name of peers) {
    let path = null
    try { path = require.resolve(name) } catch { path = null }
    if (path === null) {
      missing.push(name)
      continue
    }
    let version = 'unknown'
    try {
      let dir = path
      for (let depth = 0; depth < 6; depth++) {
        const candidate = join(dir, 'package.json')
        const info = statOrNull(candidate)
        if (info !== null) {
          try { version = String(JSON.parse(readFileSync(candidate, 'utf8')).version ?? 'unknown') } catch { version = 'unknown' }
          break
        }
        dir = dirname(dir)
      }
    } catch { version = 'unknown' }
    resolved.push(name + '@' + version)
  }
  if (missing.length > 0) {
    report.add('deps.peers', 'warning', 'peer dependencies not resolvable from the package: ' + missing.join(', '), { resolved })
  } else {
    report.add('deps.peers', 'ok', 'resolved ' + resolved.join(', '))
  }
}

/** Newest modification time under a directory tree (bounded), 0 when empty. */
function newestMtime(dir, filter, limit = 4000) {
  let newest = 0
  let seen = 0
  const walk = current => {
    if (seen > limit) return
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (seen++ > limit) return
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && filter(entry.name)) {
        const info = statOrNull(full)
        if (info !== null && info.mtimeMs > newest) newest = info.mtimeMs
      }
    }
  }
  walk(dir)
  return newest
}

/** Compiled lib presence, plus freshness in a git development checkout. */
function checkLib(report, root) {
  const entry = join(root, 'lib', 'index.js')
  const types = join(root, 'lib', 'index.d.ts')
  const entryInfo = statOrNull(entry)
  if (entryInfo === null || entryInfo.size < 500) {
    report.add('lib.entry', 'error', 'compiled entry is missing or too small: ' + entry)
    report.suggest('Build the plugin', '. ' + buildHint(root))
    return
  }
  report.add('lib.entry', 'ok', 'lib/index.js ' + formatBytes(entryInfo.size))
  const typesInfo = statOrNull(types)
  if (typesInfo === null) {
    report.add('lib.types', 'warning', 'lib/index.d.ts is missing; TypeScript hosts lose the public types')
  } else {
    report.add('lib.types', 'ok', 'lib/index.d.ts present')
  }
  const isCheckout = existsSync(join(root, '.git'))
  if (!isCheckout) {
    report.add('lib.freshness', 'info', 'installed package: lib is built at publish time, freshness skipped')
    return
  }
  const sourceNewest = newestMtime(join(root, 'src'), name => name.endsWith('.ts'))
  const packageNewest = Math.max(
    statOrNull(join(root, 'package.json'))?.mtimeMs ?? 0,
    statOrNull(join(root, 'tsconfig.json'))?.mtimeMs ?? 0,
  )
  const newestSource = Math.max(sourceNewest, packageNewest)
  if (newestSource > entryInfo.mtimeMs + 5) {
    report.add('lib.freshness', 'warning', 'lib/ is older than src/ (stale build); run the build before using the plugin', {
      libMtime: new Date(entryInfo.mtimeMs).toISOString(),
      srcMtime: new Date(newestSource).toISOString(),
    })
    report.suggest('Rebuild the plugin', 'cd ' + quotePath(root) + ' && pnpm build')
  } else {
    report.add('lib.freshness', 'ok', 'lib/ is at least as new as src/')
  }
}

/** The command shape a developer checkout uses to rebuild. */
function buildHint(root) {
  return existsSync(join(root, '.git'))
    ? 'cd ' + quotePath(root) + ' && pnpm build'
    : '# reinstall the package: its lib/ was compiled at publish time'
}

/** Quote a path for a shell snippet. */
function quotePath(path) {
  if (!/[\s'"$`!*?&|<>()\[\]{};\\]/.test(path)) return path
  if (IS_WINDOWS) return '"' + path.replace(/"/g, '`"') + '"'
  return "'" + path.replace(/'/g, "'\\''") + "'"
}

/** Engine payloads and the host engine's self-reported version. */
function checkEngines(report, root, pkgVersion) {
  const hostTag = process.platform + '-' + (process.arch === 'x64' ? 'x64' : process.arch)
  const missing = []
  for (const target of ENGINE_TARGETS) {
    const path = join(root, 'bin', target.tag, target.binary)
    const info = statOrNull(path)
    if (info === null || info.size < MIN_ENGINE_BYTES) missing.push(target.tag)
  }
  if (missing.length > 0) {
    report.add('bin.payload', 'warning', 'engine binaries missing or too small: ' + missing.join(', '), { missing })
    report.suggest('Repair the engine payload', existsSync(join(root, '.git'))
      ? 'cd ' + quotePath(root) + ' && pnpm build:engine:all'
      : '# reinstall dsh-locator; the npm tarball ships all six engines')
  } else {
    report.add('bin.payload', 'ok', 'all six engine binaries present (' + formatBytes(MIN_ENGINE_BYTES) + '+ each)')
  }
  const target = ENGINE_TARGETS.find(entry => entry.tag === hostTag)
  if (target === undefined) {
    report.add('bin.host', 'error', 'no bundled engine for this platform: ' + hostTag)
    return
  }
  const hostPath = join(root, 'bin', target.tag, target.binary)
  const info = statOrNull(hostPath)
  if (info === null) {
    report.add('bin.host', 'error', 'the engine for this platform is missing: ' + hostPath)
    report.suggest('Repair the host engine', buildHint(root))
    return
  }
  let versionOutput = ''
  let spawnError = null
  try {
    const result = spawnSync(hostPath, ['version'], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
    if (result.error !== undefined && result.error !== null) spawnError = messageOf(result.error)
    else {
      versionOutput = String(result.stdout ?? '').trim()
      if (result.status !== 0) spawnError = 'exit code ' + String(result.status) + (result.stderr === undefined || result.stderr === null ? '' : ': ' + String(result.stderr).trim())
    }
  } catch (error) {
    spawnError = messageOf(error)
  }
  if (spawnError !== null) {
    report.add('bin.host', 'warning', 'cannot execute the host engine (' + hostPath + '): ' + spawnError)
    return
  }
  const parsed = /^indexd (\S+) (\S+)\/(\S+)$/.exec(versionOutput)
  if (parsed === null) {
    report.add('bin.host', 'warning', 'unexpected engine version output: ' + JSON.stringify(versionOutput))
    return
  }
  const engineVersion = parsed[1]
  const goos = parsed[2]
  const goarch = parsed[3]
  const details = { engineVersion, goos, goarch, path: hostPath }
  if (goos !== target.goos || goarch !== target.goarch) {
    report.add('bin.host', 'error', 'host engine is built for ' + goos + '/' + goarch + ', expected ' + target.goos + '/' + target.goarch, details)
  } else if (pkgVersion !== '' && engineVersion !== pkgVersion) {
    report.add('bin.host', 'warning', 'engine version ' + engineVersion + ' does not match package version ' + pkgVersion + '; rebuild or reinstall', details)
    report.suggest('Align the engine and package versions', buildHint(root))
  } else {
    report.add('bin.host', 'ok', 'indexd ' + engineVersion + ' ' + goos + '/' + goarch, details)
  }
}
/** Resolve the state directory from the flag, the environment or the default. */
function resolveStateDirOption(stateOption) {
  if (typeof stateOption === 'string' && stateOption.trim() !== '') return { path: resolve(stateOption), source: '--state' }
  const env = process.env.DSH_LOCATOR_STATE
  if (typeof env === 'string' && env.trim() !== '') return { path: resolve(env), source: 'DSH_LOCATOR_STATE' }
  return { path: defaultStateDir(), source: 'default' }
}

/** Read the Go snapshot header (v1 = 48 bytes, v2 = 64 bytes, little endian). */
function readSnapshotHeader(path) {
  let fd = null
  try {
    fd = openSync(path, 'r')
    const header = Buffer.alloc(64)
    const read = readSync(fd, header, 0, 64, 0)
    if (read < 48) return { error: 'truncated snapshot header (' + String(read) + ' bytes)' }
    if (header.subarray(0, 8).toString('latin1') !== 'DSHLOC01') return { error: 'not a dsh-locator snapshot (bad magic)' }
    const version = header.readUInt32LE(8)
    if (version === 1) {
      return {
        version,
        builtNs: Number(header.readBigInt64LE(16)),
        records: header.readUInt32LE(24),
        nameBytes: header.readUInt32LE(28),
        roots: header.readUInt32LE(36),
        deleted: header.readUInt32LE(44),
        compressed: false,
      }
    }
    if (version === 2) {
      if (read < 64) return { error: 'truncated v2 snapshot header' }
      const flags = header.readUInt32LE(12)
      return {
        version,
        flags,
        baseId: header.readBigUInt64LE(16).toString(),
        payloadBytes: Number(header.readBigUInt64LE(24)),
        builtNs: Number(header.readBigInt64LE(32)),
        records: header.readUInt32LE(40),
        nameBytes: header.readUInt32LE(44),
        roots: header.readUInt32LE(52),
        deleted: header.readUInt32LE(60),
        compressed: (flags & 1) === 1,
      }
    }
    return { error: 'unsupported snapshot format version ' + String(version) }
  } catch (error) {
    return { error: messageOf(error) }
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/** Read the incremental journal header (magic + base id + entry count). */
function readJournalHeader(path) {
  let fd = null
  try {
    fd = openSync(path, 'r')
    const header = Buffer.alloc(24)
    const read = readSync(fd, header, 0, 24, 0)
    if (read < 24) return { error: 'truncated journal header (' + String(read) + ' bytes)' }
    if (header.subarray(0, 8).toString('latin1') !== 'DSHLJRN1') return { error: 'not a dsh-locator journal (bad magic)' }
    return {
      baseId: header.readBigUInt64LE(8).toString(),
      entries: header.readUInt32LE(16),
    }
  } catch (error) {
    return { error: messageOf(error) }
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/** Read a JSON file, returning { value } or { error }. */
function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

/** Timestamp (ms) of an ISO string; 0 when unparseable. */
function isoMs(value) {
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

/** Inspect the state directory (permissions, index files, content db, lock). */
async function checkStateDir(report, stateInfo, pkgVersion) {
  const stateDir = stateInfo.path
  report.add('stateDir.path', 'info', stateDir + ' (from ' + stateInfo.source + ')')
  const dirInfo = statOrNull(stateDir)
  if (dirInfo === null) {
    report.add('stateDir.exists', 'info', 'no state directory yet; the engine creates it (0700) on first run')
    return
  }
  if (!dirInfo.isDirectory()) {
    report.add('stateDir.exists', 'error', stateDir + ' exists but is not a directory')
    return
  }
  report.add('stateDir.exists', 'ok', 'state directory exists')
  let entries = []
  try { entries = readdirSync(stateDir) } catch (error) { report.add('stateDir.readable', 'error', 'cannot list ' + stateDir + ': ' + messageOf(error)); return }
  const empty = entries.length === 0
  checkStatePermissions(report, stateDir)
  const snapshot = checkSnapshot(report, stateDir, empty)
  checkJournal(report, stateDir)
  const meta = checkMeta(report, stateDir, snapshot, empty)
  await checkContentDatabase(report, stateDir, meta)
  checkEngineLock(report, stateDir)
  checkQuarantine(report, stateDir)
  checkTemporaryFiles(report, stateDir)
  checkLastGoodProfile(report, stateDir, pkgVersion)
  checkDiskSpace(report, stateDir, snapshot)
  // A state directory with no files at all is indistinguishable from an engine
  // that never started; say so instead of reporting everything missing.
  if (empty) report.add('stateDir.empty', 'info', 'state directory is empty (the engine has not run here yet)')
  report.add('profile.untouched', 'ok', 'the DSH profile and the state directory were only read; nothing was modified')
}

/** Directory/file mode checks (a no-op on Windows). */
function checkStatePermissions(report, stateDir) {
  if (IS_WINDOWS) {
    report.add('stateDir.permissions', 'info', 'Windows: POSIX modes do not apply; the directory inherits the user ACL of %LOCALAPPDATA%')
    return
  }
  const dirMode = modeOrNull(stateDir)
  if (dirMode === null) return
  const problems = []
  if (dirMode !== 0o700) {
    problems.push('directory is ' + dirMode.toString(8).padStart(4, '0') + ', expected 0700')
    report.suggest('Tighten the state directory mode', 'chmod 700 ' + quotePath(stateDir))
  }
  const files = []
  for (const name of PRIVATE_STATE_FILES) {
    const path = join(stateDir, name)
    const mode = modeOrNull(path)
    if (mode === null) continue
    if (mode !== 0o600) {
      files.push(name + ' (' + mode.toString(8).padStart(4, '0') + ')')
      report.suggest('Tighten ' + name, 'chmod 600 ' + quotePath(path))
    }
  }
  if (problems.length === 0 && files.length === 0) {
    report.add('stateDir.permissions', 'ok', 'directory 0700 and state files 0600')
  } else if (files.length > 0 && problems.length === 0) {
    report.add('stateDir.permissions', 'warning', 'state files are readable by other users: ' + files.join(', '))
  } else {
    report.add('stateDir.permissions', 'warning', 'state directory mode is too open: ' + problems.concat(files).join('; '))
  }
}

/** Snapshot presence, header schema and size. */
function checkSnapshot(report, stateDir, empty) {
  const path = join(stateDir, 'index.snapshot')
  const info = statOrNull(path)
  if (info === null) {
    if (empty) {
      report.add('stateDir.snapshot', 'info', 'empty state directory: no index.snapshot yet')
    } else {
      report.add('stateDir.snapshot', 'warning', 'no index.snapshot: the next engine start scans the roots from scratch')
    }
    return null
  }
  const header = readSnapshotHeader(path)
  if (header.error !== undefined) {
    report.add('stateDir.snapshot', 'warning', 'index.snapshot is unreadable (' + header.error + '); the engine rescans and rewrites it on the next start', {
      path, bytes: info.size,
    })
    report.suggest('Inspect the broken snapshot (the engine overwrites it automatically)', '# ls -l ' + quotePath(path))
    return null
  }
  const builtAt = header.builtNs > 0 ? new Date(header.builtNs / 1e6).toISOString() : ''
  report.add('stateDir.snapshot', 'ok', 'format v' + String(header.version) + ', ' + String(header.records) + ' records, ' + formatBytes(info.size) + (header.compressed ? ', zstd' : '') + (builtAt === '' ? '' : ', built ' + builtAt), {
    path, bytes: info.size, format: header.version, records: header.records, roots: header.roots, deleted: header.deleted, builtAt,
  })
  return { path, info, header }
}

/** Incremental journal header (a bad journal is tolerated by the engine). */
function checkJournal(report, stateDir) {
  const path = join(stateDir, 'index.journal')
  const info = statOrNull(path)
  if (info === null) return
  const header = readJournalHeader(path)
  if (header.error !== undefined) {
    report.add('stateDir.journal', 'warning', 'index.journal is unreadable (' + header.error + '); the engine ignores it and keeps the base snapshot', { path, bytes: info.size })
    report.suggest('Remove the unusable journal (safe: the base snapshot stays)', IS_WINDOWS ? 'del ' + quotePath(path) : 'rm ' + quotePath(path))
    return
  }
  report.add('stateDir.journal', 'ok', String(header.entries) + ' incremental entries, ' + formatBytes(info.size), { path, bytes: info.size, entries: header.entries })
}

/** meta.json schema, including the 0.23 indexStats/lastRefresh fields. */
function checkMeta(report, stateDir, snapshot, empty) {
  const path = join(stateDir, 'meta.json')
  const info = statOrNull(path)
  if (info === null) {
    if (empty) {
      report.add('stateDir.meta', 'info', 'empty state directory: no meta.json yet')
    } else {
      report.add('stateDir.meta', 'warning', 'meta.json is missing; the engine rebuilds it from the snapshot without rescanning')
    }
    return null
  }
  const parsed = readJson(path)
  if (parsed.error !== undefined) {
    report.add('stateDir.meta', 'warning', 'meta.json is corrupt (' + parsed.error + '); the engine rebuilds it from the snapshot without rescanning')
    report.suggest('Keep a copy of the damaged meta.json before the engine rewrites it', IS_WINDOWS ? 'copy ' + quotePath(path) + ' ' + quotePath(path + '.bak') : 'cp ' + quotePath(path) + ' ' + quotePath(path + '.bak'))
    return null
  }
  const meta = parsed.value
  if (meta === null || typeof meta !== 'object') {
    report.add('stateDir.meta', 'warning', 'meta.json is not a JSON object; the engine rebuilds it from the snapshot')
    return null
  }
  const problems = []
  if (typeof meta.version !== 'string' || meta.version === '') problems.push('no engine version')
  if (!Array.isArray(meta.roots) || meta.roots.length === 0) problems.push('no roots')
  if (isoMs(meta.builtAt) === 0) problems.push('no builtAt timestamp')
  if (typeof meta.platform !== 'string' || meta.platform === '') problems.push('no platform')
  if (problems.length > 0) {
    report.add('stateDir.meta', 'warning', 'meta.json is incomplete (' + problems.join(', ') + '); old engine or interrupted write')
  } else {
    report.add('stateDir.meta', 'ok', 'meta.json: engine ' + meta.version + ', ' + String(meta.roots.length) + ' root(s), built ' + new Date(isoMs(meta.builtAt)).toISOString())
  }
  if (meta.indexStats === undefined || meta.indexStats === null) {
    report.add('stateDir.meta-indexStats', 'info', 'legacy meta without indexStats; a 0.23+ engine fills it on the next save')
  } else if (typeof meta.indexStats !== 'object'
    || typeof meta.indexStats.entries !== 'number'
    || typeof meta.indexStats.files !== 'number'
    || typeof meta.indexStats.dirs !== 'number'
    || typeof meta.indexStats.roots !== 'number') {
    report.add('stateDir.meta-indexStats', 'warning', 'meta.indexStats is malformed; it should hold entries/files/dirs/roots numbers')
  } else {
    report.add('stateDir.meta-indexStats', 'ok', 'index totals: ' + String(meta.indexStats.entries) + ' entries, ' + String(meta.indexStats.files) + ' files, ' + String(meta.indexStats.dirs) + ' dirs across ' + String(meta.indexStats.roots) + ' root(s)')
  }
  if (meta.lastRefresh !== undefined && meta.lastRefresh !== null) {
    const refresh = meta.lastRefresh
    const ok = typeof refresh === 'object' && isoMs(refresh.at) > 0 && typeof refresh.mode === 'string' && typeof refresh.stats === 'object' && refresh.stats !== null
    if (ok) {
      report.add('stateDir.meta-lastRefresh', 'ok', 'last refresh: ' + String(refresh.mode) + ' at ' + new Date(isoMs(refresh.at)).toISOString() + ', ' + String(refresh.stats.entries ?? 0) + ' entries')
    } else {
      report.add('stateDir.meta-lastRefresh', 'warning', 'meta.lastRefresh is malformed; it should hold at/mode/stats')
    }
  }
  if (snapshot !== null && Array.isArray(meta.roots) && meta.roots.length !== snapshot.header.roots) {
    report.add('stateDir.meta-consistency', 'warning', 'meta.json lists ' + String(meta.roots.length) + ' root(s) but the snapshot records ' + String(snapshot.header.roots) + '; the next start may rescan')
  } else if (snapshot !== null) {
    report.add('stateDir.meta-consistency', 'ok', 'meta.json and the snapshot agree on the root count')
  }
  return meta
}
/** content.db schema and persisted warning counters (read-only sqlite probe). */
async function checkContentDatabase(report, stateDir) {
  const path = join(stateDir, 'content.db')
  const info = statOrNull(path)
  if (info === null) {
    report.add('stateDir.contentDb', 'info', 'no content.db yet (content index disabled, or not built on this machine)')
    return
  }
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch (error) {
    report.add('stateDir.contentDb', 'skipped', 'content.db exists but node:sqlite is unavailable: ' + messageOf(error))
    return
  }
  let db
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true })
  } catch (error) {
    report.add('stateDir.contentDb', 'skipped', 'cannot open content.db read-only (the engine may hold it): ' + messageOf(error))
    return
  }
  try {
    const versionRow = db.prepare('PRAGMA user_version').get()
    const schemaVersion = Number(versionRow === undefined || versionRow === null ? 0 : versionRow.user_version ?? 0)
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map(row => row.name)
      .filter(name => typeof name === 'string'))
    const owned = ['docs', 'docs_meta', 'sources', 'content_meta']
    const missingTables = owned.filter(name => !tables.has(name))
    const warningCounts = {}
    if (tables.has('content_meta')) {
      for (const row of db.prepare("SELECT key, value FROM content_meta WHERE key LIKE 'warn:%'").all()) {
        if (typeof row.key === 'string') warningCounts[row.key.slice(5)] = Number(row.value ?? 0)
      }
    }
    const details = { path, bytes: info.size, schemaVersion, warnings: warningCounts }
    report.add('stateDir.contentDb', 'ok', 'content.db ' + formatBytes(info.size) + ', ' + (missingTables.length === 0 ? 'dsh-locator schema' : 'foreign schema'), details)
    if (missingTables.length > 0) {
      report.add('stateDir.contentDb-schema', 'warning', 'content.db has a foreign schema (missing ' + missingTables.join(', ') + '); the content plugin refuses to modify it')
      report.suggest('Inspect the foreign content.db before removing it', '# ls -l ' + quotePath(path))
    } else if (schemaVersion !== CONTENT_SCHEMA_VERSION) {
      report.add('stateDir.contentDb-schema', 'warning', 'content schema v' + String(schemaVersion) + ' differs from the current v' + String(CONTENT_SCHEMA_VERSION) + '; the next content start quarantines and rebuilds the database (a large rebuild)')
    } else {
      report.add('stateDir.contentDb-schema', 'ok', 'content schema v' + String(schemaVersion) + ' is current')
    }
    const warningNames = Object.keys(warningCounts)
    if (warningNames.length > 0) {
      report.add('content.warnings', 'info', warningNames.length + ' persisted content warning counter(s): ' + warningNames.map(name => name + ' x' + String(warningCounts[name])).join(', '), { counts: warningCounts })
    } else {
      report.add('content.warnings', 'ok', 'no persisted content warnings')
    }
  } catch (error) {
    report.add('stateDir.contentDb', 'skipped', 'content.db probe failed: ' + messageOf(error))
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}
/** Engine write-lock holder and staleness. */
function checkEngineLock(report, stateDir) {
  const path = join(stateDir, 'engine.lock')
  const info = statOrNull(path)
  if (info === null) {
    report.add('stateDir.engineLock', 'info', 'no engine.lock: no engine is running against this state directory')
    return
  }
  const parsed = readJson(path)
  if (parsed.error !== undefined || parsed.value === null || typeof parsed.value !== 'object') {
    report.add('stateDir.engineLock', 'warning', 'engine.lock is not a valid JSON record; the next engine start clears it')
    report.suggest('Remove the unusable write lock', (IS_WINDOWS ? 'del ' : 'rm ') + quotePath(path))
    return
  }
  const holder = parsed.value
  const pid = Number(holder.pid)
  const heartbeat = Number(holder.heartbeatAt ?? holder.startedAt)
  const ageMs = Number.isFinite(heartbeat) && heartbeat > 0 ? Math.max(0, Date.now() - heartbeat) : null
  const alive = processAlive(pid)
  const details = { path, pid, alive, heartbeatAgeMs: ageMs, procStart: holder.procStart, version: holder.version }
  if (alive && (ageMs === null || ageMs <= ENGINE_LOCK_STALE_MS)) {
    report.add('stateDir.engineLock', 'ok', 'engine is running (pid ' + String(pid) + (ageMs === null ? '' : ', heartbeat ' + String(Math.round(ageMs / 1000)) + 's ago') + '); read-only clients can still query it', details)
  } else if (alive) {
    report.add('stateDir.engineLock', 'warning', 'engine.lock heartbeat is ' + String(Math.round((ageMs ?? 0) / 1000)) + 's old while pid ' + String(pid) + ' is alive; the owning engine may be hung (the next start takes the lock over)', details)
  } else {
    report.add('stateDir.engineLock', 'warning', 'stale engine.lock from pid ' + String(pid) + ', which is not running; the next engine start clears it', details)
    report.suggest('Remove the stale write lock', (IS_WINDOWS ? 'del ' : 'rm ') + quotePath(path))
  }
}

/** Quarantined content databases (content.db.corrupt-<timestamp>). */
function checkQuarantine(report, stateDir) {
  let entries = []
  try { entries = readdirSync(stateDir) } catch { return }
  const archives = entries.filter(name => /^content\.db\.corrupt-\d+$/.test(name))
  if (archives.length === 0) return
  let bytes = 0
  let oldest = 0
  const items = []
  for (const name of archives) {
    const info = statOrNull(join(stateDir, name))
    if (info === null) continue
    bytes += info.size
    if (oldest === 0 || info.mtimeMs < oldest) oldest = info.mtimeMs
    items.push({ name, bytes: info.size, ageMs: Date.now() - info.mtimeMs })
  }
  const details = { count: archives.length, bytes, oldest: oldest === 0 ? null : new Date(oldest).toISOString(), items }
  const tooMany = archives.length > CORRUPT_MAX_ARCHIVES
  const tooOld = oldest !== 0 && Date.now() - oldest > CORRUPT_RETENTION_MS
  if (tooMany || tooOld || bytes > 1024 * 1024 * 1024) {
    report.add('stateDir.quarantine', 'warning', 'quarantined content databases use ' + formatBytes(bytes) + ' (' + String(archives.length) + ' archive(s)); retention is ' + String(CORRUPT_MAX_ARCHIVES) + ' recent archives / 7 days and the next content open trims them', details)
    report.suggest('Review the quarantined content databases', '# ls -lh ' + quotePath(stateDir) + '/content.db.corrupt-*')
  } else {
    report.add('stateDir.quarantine', 'info', String(archives.length) + ' quarantined content database(s), ' + formatBytes(bytes) + ' (within the 2-archive/7-day retention)', details)
  }
}

/** Leftover temporary files from an interrupted save/copy. */
function checkTemporaryFiles(report, stateDir) {
  let entries = []
  try { entries = readdirSync(stateDir) } catch { return }
  const stale = []
  for (const name of entries) {
    if (!name.endsWith('.tmp') && !name.includes('.tmp-')) continue
    const info = statOrNull(join(stateDir, name))
    if (info === null || !info.isFile()) continue
    const ageMs = Date.now() - info.mtimeMs
    if (ageMs <= STALE_TMP_MS) continue
    stale.push({ name, bytes: info.size, ageMs })
  }
  if (stale.length === 0) return
  report.add('stateDir.tmp', 'warning', String(stale.length) + ' stale temporary file(s) older than 1h: ' + stale.map(item => item.name).join(', '), { files: stale })
  for (const item of stale) {
    report.suggest('Remove the stale temporary file ' + item.name, (IS_WINDOWS ? 'del ' : 'rm ') + quotePath(join(stateDir, item.name)))
  }
}
/** last-good-profile records written by 0.23+ plugin boots. */
function checkLastGoodProfile(report, stateDir, pkgVersion) {
  const names = ['last-good-profile.json', 'last-good-profile.1.json', 'last-good-profile.2.json']
  const records = []
  for (const name of names) {
    const info = statOrNull(join(stateDir, name))
    if (info === null) continue
    const parsed = readJson(join(stateDir, name))
    if (parsed.error !== undefined || parsed.value === null || typeof parsed.value !== 'object') continue
    records.push({ name, record: parsed.value, mtimeMs: info.mtimeMs })
  }
  if (records.length === 0) {
    report.add('stateDir.lastGood', 'info', 'no last-good-profile record yet; 0.23+ writes one into the state directory at every successful boot')
    report.add('warnings.latest', 'info', 'no boot record exists, so the latest warning cannot be recovered (engine warnings are not persisted)')
    return
  }
  const latest = records[0]
  const latestVersion = String(latest.record.packageVersion ?? '')
  const recordedAt = isoMs(latest.record.recordedAt)
  const recordedText = recordedAt === 0 ? '' : ', recorded ' + new Date(recordedAt).toISOString()
  const engineText = typeof latest.record.engineVersion === 'string' ? ' engine ' + latest.record.engineVersion : ''
  report.add('stateDir.lastGood', 'ok', 'latest known-good: dsh-locator@' + latestVersion + engineText + recordedText + ' (' + String(records.length) + ' record(s) kept)', {
    records: records.map(entry => ({ name: entry.name, packageVersion: entry.record.packageVersion, recordedAt: entry.record.recordedAt })),
  })
  const latestWarnings = Array.isArray(latest.record.warnings) ? latest.record.warnings.filter(item => typeof item === 'string') : []
  if (latestWarnings.length > 0) {
    report.add('warnings.latest', 'warning', 'the last recorded boot reported ' + String(latestWarnings.length) + ' warning(s): ' + latestWarnings.slice(0, 3).join(', ') + (latestWarnings.length > 3 ? ' ...' : ''), { warnings: latestWarnings })
  } else {
    report.add('warnings.latest', 'ok', 'the last recorded boot had no warnings')
  }
  if (pkgVersion !== '' && latestVersion !== '' && latestVersion !== pkgVersion) {
    report.add('stateDir.lastGood-version', 'warning', 'last known-good is dsh-locator@' + latestVersion + ' but the installed package is ' + pkgVersion + '; if the upgrade misbehaves you can pin the previous version')
    report.suggest('Restore the last known-good dsh-locator version (printed only; run manually)', 'dsh plugin add dsh-locator@' + latestVersion)
  }
}

/** Free/total space of the state-directory filesystem. */
function checkDiskSpace(report, stateDir, snapshot) {
  let stats
  try {
    stats = statfsSync(stateDir)
  } catch (error) {
    report.add('disk.space', 'skipped', 'cannot read filesystem statistics: ' + messageOf(error))
    return
  }
  const blockSize = Number(stats.bsize)
  const availableBlocks = Number(stats.bavail ?? stats.bfree)
  const totalBlocks = Number(stats.blocks)
  if (!Number.isFinite(blockSize) || blockSize <= 0 || !Number.isFinite(availableBlocks)) {
    report.add('disk.space', 'skipped', 'filesystem statistics are not numeric on this platform')
    return
  }
  const freeBytes = blockSize * availableBlocks
  const totalBytes = Number.isFinite(totalBlocks) ? blockSize * totalBlocks : 0
  const snapshotBytes = snapshot === null ? 0 : snapshot.info.size
  const contentInfo = statOrNull(join(stateDir, 'content.db'))
  const contentBytes = contentInfo === null ? 0 : contentInfo.size
  // A rebuild writes the replacement next to the old files (snapshot plus a new
  // content database), so both sizes are the meaningful headroom.
  const neededBytes = snapshotBytes + contentBytes + 256 * 1024 * 1024
  const details = { path: stateDir, freeBytes, totalBytes, snapshotBytes, contentBytes, neededBytes }
  if (freeBytes < neededBytes) {
    report.add('disk.space', 'warning', 'only ' + formatBytes(freeBytes) + ' free on the state filesystem; a snapshot/content rebuild may need about ' + formatBytes(neededBytes), details)
    report.suggest('Free disk space (a rebuild writes a replacement next to the old state)', '# free at least ' + formatBytes(neededBytes) + ' on the filesystem holding ' + quotePath(stateDir))
  } else {
    report.add('disk.space', 'ok', formatBytes(freeBytes) + ' free of ' + formatBytes(totalBytes) + ' (rebuild headroom ~' + formatBytes(neededBytes) + ')', details)
  }
}
/** Run every read-only check and return the report object. */
async function runDoctor(options) {
  const report = createReport()
  const root = resolve(options.root)
  report.add('doctor.version', 'info', 'dsh-locator doctor ' + DOC_VERSION + ' (read-only: nothing is written or executed)')
  report.add('doctor.root', 'info', root)
  const pkg = checkPackage(report, root)
  const pkgVersion = pkg !== null && typeof pkg.version === 'string' ? pkg.version : ''
  if (pkg !== null) {
    checkDependencies(report, root)
    checkLib(report, root)
  }
  checkEngines(report, root, pkgVersion)
  const stateInfo = resolveStateDirOption(options.state)
  await checkStateDir(report, stateInfo, pkgVersion)
  const summary = { ok: 0, info: 0, warning: 0, error: 0, skipped: 0 }
  for (const check of report.checks) {
    if (summary[check.status] !== undefined) summary[check.status]++
  }
  const seen = new Set()
  const restoreCommands = []
  for (const item of report.restore) {
    if (seen.has(item.command)) continue
    seen.add(item.command)
    restoreCommands.push(item)
  }
  return {
    generatedAt: new Date().toISOString(),
    doctorVersion: DOC_VERSION,
    root,
    stateDir: stateInfo.path,
    ok: summary.error === 0,
    summary,
    checks: report.checks,
    restoreCommands,
  }
}

/** Status tag for the human report. */
function statusTag(status) {
  switch (status) {
    case 'ok': return '[ok]  '
    case 'info': return '[info]'
    case 'warning': return '[warn]'
    case 'error': return '[fail]'
    case 'skipped': return '[skip]'
    default: return '[?]   '
  }
}

/** Human-readable report. */
function formatHuman(report) {
  const lines = []
  lines.push('dsh-locator doctor ' + DOC_VERSION + ' (read-only; the DSH profile and the state directory are never modified)')
  lines.push('')
  for (const check of report.checks) {
    lines.push(statusTag(check.status) + ' ' + check.id + (typeof check.summary === 'string' && check.summary !== '' ? ' - ' + check.summary : ''))
  }
  const summary = report.summary
  lines.push('')
  lines.push('summary: ' + String(summary.error) + ' error(s), ' + String(summary.warning) + ' warning(s), ' + String(summary.ok) + ' ok, ' + String(summary.info) + ' info, ' + String(summary.skipped) + ' skipped')
  if (report.restoreCommands.length > 0) {
    lines.push('run with --print-restore to print the ' + String(report.restoreCommands.length) + ' suggested recovery command(s) (never executed automatically)')
  }
  return lines.join('\n')
}

/** Recovery commands, plainly labeled (printed only, never executed). */
function formatRestore(restoreCommands) {
  const lines = []
  lines.push('# dsh-locator doctor restore steps')
  lines.push('# Printed only: nothing was executed and no file was modified.')
  if (restoreCommands.length === 0) {
    lines.push('# nothing to restore: no actionable findings.')
    return lines.join('\n')
  }
  for (const item of restoreCommands) {
    lines.push('')
    lines.push('# ' + item.label)
    lines.push(item.command)
  }
  return lines.join('\n')
}
/** Usage text. */
function usage() {
  return [
    'usage: node scripts/doctor.mjs [options]',
    '',
    'Read-only diagnostics for an installed or development dsh-locator.',
    '',
    'options:',
    '  --json             print the full report as JSON',
    '  --print-restore    print only the suggested recovery commands (never executed)',
    '  --state DIR        state directory to inspect (default: the platform state dir)',
    '  --root DIR         package root to inspect (default: this script\'s package)',
    '  -h, --help         show this help',
    '',
    'exit code: 0 = no error-level finding, 1 = an error-level finding exists, 2 = usage error',
  ].join('\n')
}

/** Parse the command line. Unknown arguments are collected, never ignored. */
function parseArgs(argv) {
  const options = { json: false, printRestore: false, help: false, root: SCRIPT_ROOT, state: undefined }
  const errors = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--print-restore') { options.printRestore = true; continue }
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg === '--root' || arg === '--state') {
      const value = argv[++index]
      if (value === undefined || value === '') { errors.push(arg + ' needs a directory'); continue }
      if (arg === '--root') options.root = value
      else options.state = value
      continue
    }
    errors.push('unknown argument: ' + arg)
  }
  return { options, errors }
}

/** Entry point. */
async function main() {
  const { options, errors } = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage() + '\n')
    return 0
  }
  if (errors.length > 0) {
    process.stderr.write('dsh-locator doctor: ' + errors.join('; ') + '\n\n' + usage() + '\n')
    return 2
  }
  let report
  try {
    report = await runDoctor(options)
  } catch (error) {
    process.stderr.write('dsh-locator doctor failed: ' + messageOf(error) + '\n')
    return 1
  }
  if (options.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else if (options.printRestore) process.stdout.write(formatRestore(report.restoreCommands) + '\n')
  else process.stdout.write(formatHuman(report) + '\n')
  return report.ok ? 0 : 1
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  main().then(code => { process.exitCode = code }).catch(error => {
    process.stderr.write('dsh-locator doctor failed: ' + messageOf(error) + '\n')
    process.exitCode = 1
  })
}

export { runDoctor, readSnapshotHeader, readJournalHeader, satisfiesRange, formatHuman, formatRestore, defaultStateDir }
