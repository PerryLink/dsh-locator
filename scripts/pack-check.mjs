#!/usr/bin/env node
/** Pack-check: assert the npm tarball contains every runtime asset users need. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Let the OS shell resolve npm: on Windows the executable is npm.cmd, and
// spawning a .cmd directly from Node is EINVAL without a shell.
const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root,
  encoding: 'utf8',
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
const parsed = JSON.parse(raw)
const entry = Array.isArray(parsed) ? parsed[0] : parsed
const files = new Set((entry.files ?? []).map(file => String(file.path)))
const required = [
  'package.json', 'lib/index.js', 'lib/agent-core.js', 'lib/agent-find.js', 'lib/agent-read.js', 'lib/agent-status.js', 'lib/agent-admin.js',
  'client.js', 'cordis.patch.yml', 'icon.svg',
  'bin/linux-x64/indexd', 'bin/linux-arm64/indexd', 'bin/win32-x64/indexd.exe', 'bin/win32-arm64/indexd.exe', 'bin/darwin-x64/indexd', 'bin/darwin-arm64/indexd',
  'scripts/locator-cli.mjs', 'scripts/locator-mcp.mjs', 'scripts/doctor.mjs', 'scripts/gen-agent-schemas.mjs',
  'docs/install.md', 'docs/agent.md', 'docs/cli-mcp.md', 'examples/mcp/claude.json', 'llms.txt',
]
const missing = required.filter(path => !files.has(path))
const forbidden = ['lib/agent-find.ts']
const leaked = forbidden.filter(path => files.has(path))
const locale = [...files].filter(path => path.startsWith('locale/') && path.endsWith('.json'))
if (missing.length > 0 || leaked.length > 0 || locale.length === 0) {
  console.error('pack-check: missing:', missing)
  console.error('pack-check: leaked:', leaked)
  console.error('pack-check: locale files:', locale.length)
  process.exit(1)
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
console.log('pack-check: ok —', pkg.version, files.size, 'files,', locale.length, 'locales, 6 engines')