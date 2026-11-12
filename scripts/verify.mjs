#!/usr/bin/env node
/**
 * Package sanity check: manifest, bundle patch, compiled entry, the six engine
 * binaries (version, GOOS/GOARCH and cgo flavour) and the documentation must
 * all be present and consistent before `npm pack` / `npm publish`.
 *
 * The engine checks intentionally fail instead of skipping:
 *  - a missing host binary is a release blocker, not "no engine tests today";
 *  - every shipped binary must embed package.json's version (built with
 *    `-X main.version=...`); a stale bin/ from an older version fails here;
 *  - every binary's Go build settings must match the directory it lives in,
 *    and darwin binaries should be the cgo/FSEvents build. Running
 *    `pnpm build:engine:all` on Linux/Windows produces CGO_ENABLED=0 darwin
 *    binaries (kqueue fallback) and silently replaces the real macOS build, so
 *    a plain local run warns loudly about that fallback while CI/release run
 *    this script with DSH_LOCATOR_REQUIRE_DARWIN_CGO=1 and hard-fail on it.
 *
 * This script needs no Go toolchain: it reads the build settings embedded in
 * each Go binary. The host binary is additionally executed and must print the
 * expected version/platform.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostTag = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`
const hostGoos = process.platform === 'win32' ? 'windows' : process.platform
const hostGoarch = process.arch === 'x64' ? 'amd64' : process.arch
const hostEngineName = process.platform === 'win32' ? 'indexd.exe' : 'indexd'
const requireDarwinCgo = process.env.DSH_LOCATOR_REQUIRE_DARWIN_CGO === '1'
const failures = []
const warnings = []

function requireFile(path, label, minBytes = 1) {
  if (!existsSync(path)) {
    failures.push(`${label} is missing: ${path}`)
    return false
  }
  const size = statSync(path).size
  if (size < minBytes) failures.push(`${label} is too small (${String(size)} bytes): ${path}`)
  return true
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (pkg.name !== 'dsh-locator') failures.push(`unexpected package name ${String(pkg.name)}`)
if (typeof pkg.version !== 'string' || pkg.version === '') failures.push('missing version')
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') failures.push('package.json must declare dsh.bundle.patch')
if (pkg.dsh?.client?.platform !== 'web') failures.push('package.json must declare dsh.client.platform = web')
if (pkg.exports?.['./client'] === undefined) failures.push("package.json must export './client'")
if (!String(pkg.engines?.dsh ?? '').includes('0.2.')) failures.push('engines.dsh must accept the 0.2 line')
for (const file of ['lib', 'bin', 'cordis.patch.yml']) {
  if (!(pkg.files ?? []).includes(file)) failures.push(`files[] must include ${file}`)
}

requireFile(join(root, 'cordis.patch.yml'), 'bundle patch')
requireFile(join(root, 'lib', 'index.js'), 'compiled plugin entry', 500)
requireFile(join(root, 'lib', 'tools.js'), 'compiled tools', 500)
requireFile(join(root, 'client.js'), 'client bundle', 5_000)
try {
  execFileSync(process.execPath, ['--check', join(root, 'client.js')], { stdio: 'pipe' })
} catch (error) {
  const detail = error instanceof Error && 'stderr' in error ? String(error.stderr).trim().split('\n').slice(0, 3).join(' ') : String(error)
  failures.push(`client.js does not parse: ${detail}`)
}
const clientSource = existsSync(join(root, 'client.js')) ? readFileSync(join(root, 'client.js'), 'utf8') : ''
for (const marker of ['/dsh-locator/combined', '::highlight(dsh-locator-find)', 'Alt+1–3', 'dsh-locator-find-active', 'dsh-locator-findbar', 'dsh-locator-find-scope', 'contentEnabled']) {
  if (!clientSource.includes(marker)) failures.push(`client.js is missing ${marker}`)
}
for (const marker of ['/dsh-locator/combined', 'runCombinedSearch']) {
  const source = existsSync(join(root, 'src', 'http.ts')) ? readFileSync(join(root, 'src', 'http.ts'), 'utf8') : ''
  if (!source.includes(marker)) failures.push(`src/http.ts is missing ${marker}`)
}

// The six shipped engine binaries. cgo is 1 only for darwin: those must be
// built on macOS so the FSEvents watcher is compiled in; the kqueue fallback
// (CGO_ENABLED=0) is a local development substitute, never the shipped build.
const ENGINE_TARGETS = [
  { tag: 'linux-x64', goos: 'linux', goarch: 'amd64', binary: 'indexd', cgo: '0' },
  { tag: 'linux-arm64', goos: 'linux', goarch: 'arm64', binary: 'indexd', cgo: '0' },
  { tag: 'win32-x64', goos: 'windows', goarch: 'amd64', binary: 'indexd.exe', cgo: '0' },
  { tag: 'win32-arm64', goos: 'windows', goarch: 'arm64', binary: 'indexd.exe', cgo: '0' },
  { tag: 'darwin-x64', goos: 'darwin', goarch: 'amd64', binary: 'indexd', cgo: '1' },
  { tag: 'darwin-arm64', goos: 'darwin', goarch: 'arm64', binary: 'indexd', cgo: '1' },
]
const ENGINE_MODULE = 'github.com/PerryLink/dsh-locator/engine'

function readBuildSettings(source, key) {
  // Go embeds its build settings as `build\tKEY=value` lines in every binary
  // (Go 1.18+). Reading the bytes avoids needing the Go toolchain and also
  // works for binaries this platform cannot execute.
  const values = new Set()
  const pattern = new RegExp(`build\\t${key}=([^\\s]+)`, 'g')
  let match
  while ((match = pattern.exec(source)) !== null) values.add(match[1])
  return values
}

const verifiedEngines = []
for (const target of ENGINE_TARGETS) {
  const relative = `bin/${target.tag}/${target.binary}`
  const path = join(root, 'bin', target.tag, target.binary)
  if (!requireFile(path, `engine binary for ${target.tag}`, 1_000_000)) continue

  let source
  try {
    source = readFileSync(path).toString('latin1')
  } catch (error) {
    failures.push(`cannot read ${relative}: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }

  if (!source.includes(ENGINE_MODULE)) {
    failures.push(`${relative} is not a dsh-locator engine (embedded module path ${ENGINE_MODULE} is missing); rebuild it from engine/`)
  }
  const goos = readBuildSettings(source, 'GOOS')
  const goarch = readBuildSettings(source, 'GOARCH')
  const cgo = readBuildSettings(source, 'CGO_ENABLED')
  if (goos.size === 0 || goarch.size === 0) {
    failures.push(`${relative} has no Go build settings; not a Go binary (or built before Go 1.18)`)
  } else {
    if (goos.size !== 1 || !goos.has(target.goos)) {
      failures.push(`${relative} is built for GOOS ${[...goos].join('|')} but must hold ${target.goos}`)
    }
    if (goarch.size !== 1 || !goarch.has(target.goarch)) {
      failures.push(`${relative} is built for GOARCH ${[...goarch].join('|')} but must hold ${target.goarch}`)
    }
  }
  if (cgo.size === 0) {
    failures.push(`${relative} has no CGO_ENABLED build setting`)
  } else if (cgo.size !== 1 || !cgo.has(target.cgo)) {
    const actual = [...cgo].join('|')
    if (target.cgo === '1') {
      // A kqueue darwin binary (CGO_ENABLED=0) can be produced on Linux/Windows
      // but never ships: release.yml rebuilds darwin on macOS with cgo and runs
      // this script with DSH_LOCATOR_REQUIRE_DARWIN_CGO=1. Keep local runs
      // green for the committed fallback but warn loudly so nobody mistakes it
      // for the releasable payload.
      const detail = 'darwin must be built on macOS with CGO_ENABLED=1 so the FSEvents watcher is compiled in; the kqueue fallback is only a development substitute'
      if (requireDarwinCgo) failures.push(`${relative} is built with CGO_ENABLED ${actual} but must be 1: ${detail}`)
      else warnings.push(`${relative} is built with CGO_ENABLED ${actual} (kqueue fallback, not releasable): ${detail}. Release/CI run verify with DSH_LOCATOR_REQUIRE_DARWIN_CGO=1 and rebuild bin/ from the macOS artifact.`)
    } else {
      failures.push(`${relative} is built with CGO_ENABLED ${actual} but must be 0: cross-built linux/windows engines must be static`)
    }
  }
  if (typeof pkg.version === 'string' && !source.includes(pkg.version)) {
    failures.push(`${relative} does not embed package version ${pkg.version}; rebuild it (CI artifact or scripts/build-engine.mjs) so the engine and the npm package cannot drift apart`)
  } else if (typeof pkg.version === 'string') {
    verifiedEngines.push(`${target.tag}=${pkg.version}`)
  }
}

// The host binary is the one the plugin actually spawns in this CI job or dev
// machine: execute it and parse `indexd <version> <goos>/<goarch>`.
const hostTarget = ENGINE_TARGETS.find(target => target.tag === hostTag)
if (hostTarget === undefined) {
  failures.push(`unsupported host ${hostTag}: no engine target has that tag; verify cannot test the host engine`)
} else if (existsSync(join(root, 'bin', hostTag, hostEngineName))) {
  try {
    const output = execFileSync(join(root, 'bin', hostTag, hostEngineName), ['version'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    const match = /^indexd\s+(\S+)\s+(\S+?)\/(\S+)\s*$/.exec(output)
    if (match === null) {
      failures.push(`host engine bin/${hostTag}/${hostEngineName} printed an unexpected version line: ${JSON.stringify(output.slice(0, 160))}`)
    } else {
      const [, version, goos, goarch] = match
      if (version !== pkg.version) {
        failures.push(`host engine reports version ${version} but package.json is ${pkg.version}; rebuild the host engine (${hostTag})`)
      }
      if (goos !== hostGoos || goarch !== hostGoarch) {
        failures.push(`host engine reports ${goos}/${goarch} but this host is ${hostGoos}/${hostGoarch}`)
      }
    }
  } catch (error) {
    const stderr = error !== null && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : ''
    const detail = `${error instanceof Error ? error.message : String(error)}${stderr === '' ? '' : ` (${stderr.split('\n').slice(0, 2).join(' ')})`}`
    failures.push(`host engine bin/${hostTag}/${hostEngineName} failed to run: ${detail}`)
  }
}

requireFile(join(root, 'README.md'), 'README')
requireFile(join(root, 'README.en.md'), 'English README')
requireFile(join(root, 'docs', 'assets', 'panel-zh.png'), 'panel screenshot')
requireFile(join(root, 'docs', 'assets', 'architecture.svg'), 'architecture diagram')
requireFile(join(root, 'LICENSE'), 'LICENSE')

const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
for (const key of ['id: dsh-locator', 'name: dsh-locator', 'roots:', 'stateDir:', 'refreshIntervalMs:']) {
  if (!patch.includes(key)) failures.push(`cordis.patch.yml is missing ${key}`)
}

// Privacy guard, learned from 0.5.1: that release shipped a screenshot with a
// real home directory and a README path example. npm unpublish only lasts 72
// hours and mirrors keep serving the tarball, so the check runs before pack.
const LEAKED_SCREENSHOTS = new Map([
  ['3653c25817cd601202215dc79083f62b', 'panel-en.png from 0.5.1'],
  ['dbb1e592ebff225662d5515e9efabd77', 'panel-zh.png from 0.5.1'],
])
for (const name of readdirSync(join(root, 'docs', 'assets'))) {
  if (!name.endsWith('.png')) continue
  const digest = createHash('md5').update(readFileSync(join(root, 'docs', 'assets', name))).digest('hex')
  const leaked = LEAKED_SCREENSHOTS.get(digest)
  if (leaked !== undefined) failures.push(`docs/assets/${name} is the leaked screenshot (${leaked}); regenerate it from /tmp/demo fake data`)
}
const TEXT_FILES = ['README.md', 'README.en.md', 'README-es.md', 'README-pt.md', 'README-hi.md', 'CHANGELOG.md', 'SECURITY.md', 'cordis.patch.yml', 'client.js', 'package.json']
for (const name of readdirSync(join(root, 'src'))) {
  if (name.endsWith('.ts')) TEXT_FILES.push(`src/${name}`)
}
const HOME_PATH = /\/home\/(?!user\b|username\b|you\b|me\b|example\b|<)[a-z0-9_.-]+\//i
const WINDOWS_HOME_PATH = /[A-Za-z]:\\Users\\(?!<|Public\b)[A-Za-z0-9_.-]+\\/
for (const name of TEXT_FILES) {
  const path = join(root, name)
  if (!existsSync(path)) continue
  const text = readFileSync(path, 'utf8')
  const match = text.match(HOME_PATH) ?? text.match(WINDOWS_HOME_PATH)
  if (match !== null) failures.push(`${name} contains an absolute home path (${match[0]}); use $HOME or a placeholder`)
}

for (const warning of warnings) console.warn(`verify: warning: ${warning}`)

if (failures.length > 0) {
  console.error('verify: FAILED')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
const gate = requireDarwinCgo ? ', shippable-engine gate on' : ''
console.log(`verify: OK — ${pkg.name}@${pkg.version}, host ${hostTag}, engines [${verifiedEngines.join(', ')}], ${String(pkg.files.length)} packaged paths${gate}`)
