#!/usr/bin/env node
/**
 * Package sanity check: manifest, bundle patch, compiled entry, engine binary
 * and documentation must all be present before `npm pack`.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tag = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`
const engineName = process.platform === 'win32' ? 'indexd.exe' : 'indexd'
const failures = []

function requireFile(path, label, minBytes = 1) {
  if (!existsSync(path)) {
    failures.push(`${label} is missing: ${path}`)
    return
  }
  const size = statSync(path).size
  if (size < minBytes) failures.push(`${label} is too small (${String(size)} bytes): ${path}`)
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
for (const target of [
  ['linux-x64', 'indexd'],
  ['linux-arm64', 'indexd'],
  ['win32-x64', 'indexd.exe'],
  ['win32-arm64', 'indexd.exe'],
  ['darwin-x64', 'indexd'],
  ['darwin-arm64', 'indexd'],
]) {
  requireFile(join(root, 'bin', target[0], target[1]), `engine binary for ${target[0]}`, 1_000_000)
}
if (!existsSync(join(root, 'bin', tag, engineName))) failures.push(`host engine ${tag}/${engineName} is missing`)
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

if (failures.length > 0) {
  console.error('verify: FAILED')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`verify: OK — ${pkg.name}@${pkg.version}, engine ${tag}, ${String(pkg.files.length)} packaged paths`)
