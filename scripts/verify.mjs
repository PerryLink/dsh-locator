#!/usr/bin/env node
/**
 * Package sanity check: manifest, bundle patch, compiled entry, engine binary
 * and documentation must all be present before `npm pack`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
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

if (failures.length > 0) {
  console.error('verify: FAILED')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`verify: OK — ${pkg.name}@${pkg.version}, engine ${tag}, ${String(pkg.files.length)} packaged paths`)
