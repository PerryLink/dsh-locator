#!/usr/bin/env node
/**
 * Cross-build the Go engine into bin/<platform>-<arch>/.
 *
 *   node scripts/build-engine.mjs                 # host platform only
 *   node scripts/build-engine.mjs --all           # all six targets
 *   node scripts/build-engine.mjs --all --preserve-darwin-cgo
 *                                                 # keep committed FSEvents
 *                                                 # binaries on non-macOS hosts
 *
 * The engine is pure Go for Linux and Windows. The macOS FSEvents backend needs
 * cgo, so a real release build must run on macOS with CGO_ENABLED=1 (that is
 * what .github/workflows/ci.yml does and publishes as an artifact). On any
 * other host the darwin targets fall back to the kqueue implementation built
 * with CGO_ENABLED=0. Those fallback binaries are functional for tests but are
 * NOT release-grade: they ship without the recursive FSEvents backend. The
 * script prints that explicitly and the final summary marks them.
 *
 * Every binary's embedded version (`indexd version`) is checked against
 * package.json. Host-runnable binaries are executed; cross-built binaries are
 * checked by reading their build info and the injected version string.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const engineDir = join(root, 'engine')
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
if (typeof packageVersion !== 'string' || packageVersion === '') {
  console.error('package.json has no version')
  process.exit(1)
}

const TARGETS = [
  { goos: 'linux', goarch: 'amd64', tag: 'linux-x64', ext: '' },
  { goos: 'linux', goarch: 'arm64', tag: 'linux-arm64', ext: '' },
  { goos: 'windows', goarch: 'amd64', tag: 'win32-x64', ext: '.exe' },
  { goos: 'windows', goarch: 'arm64', tag: 'win32-arm64', ext: '.exe' },
  { goos: 'darwin', goarch: 'amd64', tag: 'darwin-x64', ext: '', crossCC: 'clang -arch x86_64' },
  { goos: 'darwin', goarch: 'arm64', tag: 'darwin-arm64', ext: '' },
]

const hostGOOS = process.platform === 'win32' ? 'windows' : process.platform
const hostGOARCH = process.arch === 'x64' ? 'amd64' : process.arch === 'ia32' ? '386' : process.arch
const hostTag = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`
const args = new Set(process.argv.slice(2))
const all = args.has('--all')
const preserveDarwinCgo = args.has('--preserve-darwin-cgo')
const onDarwin = process.platform === 'darwin'

const targets = (all ? TARGETS : TARGETS.filter(target => target.tag === hostTag))
  .filter(target => target !== undefined)
if (targets.length === 0) {
  console.error(`no engine target for ${hostTag}; pass --all`)
  process.exit(1)
}

const go = findGo()
if (go === null) {
  console.error('Go toolchain not found. Set GO=/path/to/go or put go on PATH.')
  process.exit(1)
}

const results = []
for (const target of targets) {
  const outDir = join(root, 'bin', target.tag)
  const out = join(outDir, `indexd${target.ext}`)

  // FSEvents needs cgo, which only exists on a macOS host with Xcode CLT.
  const cgo = onDarwin && target.goos === 'darwin' ? '1' : '0'
  const fallbackDarwin = target.goos === 'darwin' && cgo === '0'
  if (fallbackDarwin) {
    const existing = readBuildInfo(go, out)
    const existingCgo = existing?.settings?.CGO_ENABLED === '1'
    if (preserveDarwinCgo && existingCgo) {
      const keptVersion = embeddedVersion(out, packageVersion)
      if (keptVersion === null) {
        console.error(`${out}: committed FSEvents build does not contain version ${packageVersion}; rebuild on macOS or drop --preserve-darwin-cgo`)
        process.exit(1)
      }
      console.log(`kept ${out} (committed FSEvents build, CGO_ENABLED=1, version ${keptVersion}); macOS CI owns this artifact`)
      results.push({ target, out, cgo: '1', version: keptVersion, kept: true, releaseGrade: true })
      continue
    }
    if (existingCgo) {
      console.warn(`warning: replacing ${target.tag} FSEvents (CGO_ENABLED=1) binary with a kqueue fallback;`)
      console.warn('         run macOS CI/release to produce the real darwin artifacts, or pass --preserve-darwin-cgo.')
    }
  }

  mkdirSync(outDir, { recursive: true })
  const env = {
    ...process.env,
    GOOS: target.goos,
    GOARCH: target.goarch,
    CGO_ENABLED: cgo,
  }
  if (cgo === '1' && target.crossCC !== undefined) env.CC = target.crossCC
  const result = spawnSync(go, ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${packageVersion}`, '-o', out, './cmd/indexd'], {
    cwd: engineDir,
    stdio: 'inherit',
    env,
  })
  if (result.status !== 0) {
    if (cgo === '1') {
      console.error(`building ${target.tag} needs cgo/FSEvents; install Xcode Command Line Tools or run with CGO_ENABLED=0 (kqueue fallback).`)
    }
    process.exit(result.status ?? 1)
  }
  if (target.ext === '') {
    try {
      chmodSync(out, 0o755)
    } catch {
      // A non-POSIX file system may refuse the mode change; npm keeps the bit
      // from the package tarball instead.
    }
  }
  const info = readBuildInfo(go, out)
  if (info !== null) {
    if (info.settings.GOOS !== target.goos || info.settings.GOARCH !== target.goarch) {
      console.error(`${out}: build info says ${info.settings.GOOS}/${info.settings.GOARCH}, expected ${target.goos}/${target.goarch}`)
      process.exit(1)
    }
    if (info.settings.CGO_ENABLED !== cgo) {
      console.error(`${out}: CGO_ENABLED=${info.settings.CGO_ENABLED ?? '?'}, expected ${cgo}`)
      process.exit(1)
    }
  }
  const reported = verifyVersion(target, out, packageVersion)
  if (reported === null) {
    process.exit(1)
  }
  results.push({ target, out, cgo, version: reported, kept: false, releaseGrade: !fallbackDarwin })
  console.log(`built ${out} (CGO_ENABLED=${cgo})`)
  if (fallbackDarwin) {
    console.log(`  note: ${target.tag} is a kqueue fallback build — NOT release-ready; macOS CI builds the FSEvents version`)
  }
}

console.log('\nengine binaries:')
for (const row of results) {
  const kind = row.kept
    ? 'kept'
    : row.target.goos === 'darwin'
      ? row.cgo === '1'
        ? 'cgo/FSEvents'
        : 'kqueue fallback (not release-ready)'
      : 'pure Go'
  console.log(`  ${row.target.tag.padEnd(13)} ${String(row.version).padEnd(8)} ${kind}`)
}
if (!onDarwin && all && !preserveDarwinCgo && results.some(row => row.target.goos === 'darwin' && !row.releaseGrade)) {
  console.log('\nrelease note: the darwin binaries above were built with CGO_ENABLED=0 and are not release-grade.')
  console.log('release note: rebuild them on macOS with CGO_ENABLED=1 (see .github/workflows/ci.yml).')
}

/**
 * Runs `indexd version` when this host can execute the binary and checks the
 * reported version; for cross builds, checks the version string embedded by
 * -ldflags. Returns the version on success, null on mismatch.
 */
function verifyVersion(target, out, want) {
  const runnable = target.goos === hostGOOS && target.goarch === hostGOARCH
  if (runnable) {
    const run = spawnSync(out, ['version'], { encoding: 'utf8' })
    if (run.status !== 0) {
      console.error(`${out}: version failed: ${run.stderr || run.error || 'unknown error'}`)
      return null
    }
    const match = /indexd\s+(\S+)\s+(\S+)/.exec(run.stdout)
    if (match === null) {
      console.error(`${out}: unexpected version output: ${run.stdout.trim()}`)
      return null
    }
    if (match[1] !== want) {
      console.error(`${out}: reports version ${match[1]}, package.json says ${want}`)
      return null
    }
    return match[1]
  }
  return embeddedVersion(out, want)
}

/** Returns want when the injected version string is present in a cross binary. */
function embeddedVersion(out, want) {
  if (!readFileSync(out).includes(Buffer.from(want, 'utf8'))) {
    console.error(`${out}: embedded version string ${want} not found`)
    return null
  }
  return want
}

function readBuildInfo(goTool, path) {
  if (!existsSync(path)) return null
  const run = spawnSync(goTool, ['version', '-m', path], { encoding: 'utf8' })
  if (run.status !== 0) return null
  const settings = {}
  for (const line of run.stdout.split('\n')) {
    const match = /^\s+build\s+(\S+)=(.*)$/.exec(line)
    if (match !== null) settings[match[1]] = match[2].trim()
  }
  return { settings, raw: run.stdout }
}

function findGo() {
  const explicit = process.env.GO
  if (explicit !== undefined && explicit !== '') {
    return explicit
  }
  const probe = spawnSync('go', ['version'], { stdio: 'ignore' })
  if (probe.status === 0) return 'go'
  const candidates = [
    'D:/Projects/dsh/toolchain/go/bin/go.exe',
    'C:/Program Files/Go/bin/go.exe',
    '/usr/local/go/bin/go',
    '/usr/lib/go/bin/go',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}
