#!/usr/bin/env node
/**
 * Cross-build the Go engine into bin/<platform>-<arch>/.
 *
 *   node scripts/build-engine.mjs            # host platform only
 *   node scripts/build-engine.mjs --all      # linux-x64, linux-arm64, win32-x64, darwin-x64, darwin-arm64
 *
 * The engine is pure Go (no cgo), so one host toolchain cross-compiles every
 * target. Set GO=/path/to/go when the toolchain is not on PATH.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const engineDir = join(root, 'engine')

const TARGETS = [
  { goos: 'linux', goarch: 'amd64', tag: 'linux-x64', ext: '' },
  { goos: 'linux', goarch: 'arm64', tag: 'linux-arm64', ext: '' },
  { goos: 'windows', goarch: 'amd64', tag: 'win32-x64', ext: '.exe' },
  { goos: 'windows', goarch: 'arm64', tag: 'win32-arm64', ext: '.exe' },
  { goos: 'darwin', goarch: 'amd64', tag: 'darwin-x64', ext: '' },
  { goos: 'darwin', goarch: 'arm64', tag: 'darwin-arm64', ext: '' },
]

const hostTag = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`
const all = process.argv.includes('--all')
const targets = all ? TARGETS : TARGETS.filter(target => target.tag === hostTag)
if (targets.length === 0) {
  console.error(`no engine target for ${hostTag}; pass --all`)
  process.exit(1)
}

const go = findGo()
if (go === null) {
  console.error('Go toolchain not found. Set GO=/path/to/go or put go on PATH.')
  process.exit(1)
}

for (const target of targets) {
  const outDir = join(root, 'bin', target.tag)
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, `indexd${target.ext}`)
  const result = spawnSync(go, ['build', '-trimpath', '-ldflags', '-s -w', '-o', out, './cmd/indexd'], {
    cwd: engineDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      GOOS: target.goos,
      GOARCH: target.goarch,
      CGO_ENABLED: '0',
    },
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
  if (target.ext === '') {
    try {
      chmodSync(out, 0o755)
    } catch {
      // A non-POSIX file system may refuse the mode change; npm keeps the bit
      // from the package tarball instead.
    }
  }
  console.log(`built ${out}`)
}

function findGo() {
  const explicit = process.env.GO
  if (explicit !== undefined && explicit !== '') {
    return existsSync(explicit) ? explicit : explicit
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
