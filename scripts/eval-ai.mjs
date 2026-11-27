#!/usr/bin/env node
/**
 * Offline AI contract eval: build a tiny name index under /tmp, then exercise
 * the 2026-11 CLI face (find/read/status/cursor/errors) and record latency.
 * No live state and no content DB are needed; this is a release smoke for the
 * agent envelope, paging and error recovery.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const host = process.platform + '-' + (process.arch === 'x64' ? 'x64' : process.arch)
const bin = join(root, 'bin', host, process.platform === 'win32' ? 'indexd.exe' : 'indexd')
const cli = join(root, 'scripts', 'locator-cli.mjs')
const work = mkdtempSync(join(tmpdir(), 'locator-eval-'))
const fixture = join(work, 'fixture')
const state = join(work, 'state')
mkdirSync(join(fixture, 'docs'), { recursive: true })
writeFileSync(join(fixture, 'docs', 'alpha.md'), '# Alpha\n\nretry policy for the alpha service\n')
writeFileSync(join(fixture, 'docs', 'beta.ts'), 'export const retryPolicy = 1\n')
writeFileSync(join(fixture, 'config.json'), '{"retry":true}\n')
execFileSync(bin, ['scan', '--state', state, '--root', fixture], { stdio: 'ignore' })

function run(args) {
  const started = Date.now()
  let stdout = ''
  let status = 0
  try {
    stdout = execFileSync(process.execPath, [cli, ...args, '--state', state], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    stdout = String(error.stdout ?? '')
    status = typeof error.status === 'number' ? error.status : 1
  }
  let value = null
  try { value = JSON.parse(stdout) } catch { value = null }
  return { value, status, ms: Date.now() - started }
}

const results = []
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }) } catch (error) { results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) }) }
}
function expect(condition, message) { if (!condition) throw new Error(message) }

const find = run(['find', 'alpha', '--api=2026-11', '--limit', '2'])
check('find returns the 2026-11 envelope', () => {
  expect(find.value?.apiVersion === '2026-11' && find.value?.ok === true, 'bad envelope: ' + JSON.stringify(find.value))
  expect(find.value?.tool === 'locator_find', 'wrong tool')
  expect(Array.isArray(find.value?.items), 'items must be an array')
  expect(find.value.items.length > 0, 'expected a hit')
  expect(find.value?.page?.limit === 2, 'page limit echo')
})
const firstRef = find.value?.items?.find(item => typeof item.ref === 'string')?.ref
check('find page has a ref', () => expect(typeof firstRef === 'string', 'no ref in items'))

const read = run(['read', firstRef, '--api=2026-11', '--as', 'excerpt', '--max-bytes', '400'])
check('read opens a find ref', () => {
  expect(read.value?.ok === true, 'read failed: ' + JSON.stringify(read.value))
  expect(Array.isArray(read.value?.items) && read.value.items.length === 1, 'read items')
})

const brief = run(['status', '--api=2026-11', '--detail', 'brief'])
check('status brief envelope', () => {
  expect(brief.value?.apiVersion === '2026-11' && brief.value?.ok === true, 'bad status')
  expect(typeof brief.value?.summary === 'string', 'no summary')
})
const full = run(['status', '--api=2026-11', '--detail', 'full'])
check('status full envelope', () => expect(full.value?.ok === true, 'full status failed'))

const page1 = run(['find', 'a', '--api=2026-11', '--limit', '1', '--mode', 'name'])
const cursor = page1.value?.page?.nextCursor
check('paging emits a cursor', () => expect(page1.value?.ok === true && typeof cursor === 'string', 'no nextCursor'))
if (cursor !== undefined) {
  const page2 = run(['find', 'a', '--api=2026-11', '--limit', '1', '--mode', 'name', '--cursor', cursor])
  check('cursor page is accepted', () => expect(page2.value?.ok === true, 'cursor failed: ' + JSON.stringify(page2.value?.error)))
  check('paging union has no duplicate path', () => {
    const paths = [...(page1.value?.items ?? []), ...(page2.value?.items ?? [])].map(item => item.path).filter(Boolean)
    expect(new Set(paths).size === paths.length, 'duplicate path across pages')
  })
}
check('bad cursor is cursor-invalid', () => {
  const bad = run(['find', 'alpha', '--api=2026-11', '--cursor', 'not-a-cursor'])
  expect(bad.value?.ok === false && bad.value?.error?.code === 'cursor-invalid', JSON.stringify(bad.value?.error))
})
check('unknown argument exits 2', () => {
  const bad = run(['find', 'alpha', '--api=2026-11', '--bogus', 'x'])
  expect(bad.status === 2, 'exit ' + bad.status)
})
check('scope roots is accepted', () => {
  const scoped = run(['find', 'alpha', '--api=2026-11', '--scope', 'roots'])
  expect(scoped.value?.ok === true, 'scope roots failed')
})
check('where ext filters markdown', () => {
  const filtered = run(['find', 'alpha', '--api=2026-11', '--where', '{"ext":["md"]}'])
  expect(filtered.value?.ok === true, 'where failed')
})

const times = [find.ms, read.ms, brief.ms, full.ms].sort((a, b) => a - b)
const p50 = times[Math.floor(times.length / 2)]
const failed = results.filter(result => !result.ok)
for (const result of results) console.log((result.ok ? 'PASS' : 'FAIL'), result.name, result.ok ? '' : '— ' + result.error)
console.log('eval:', results.length - failed.length + '/' + results.length, 'passed; p50', p50, 'ms')
rmSync(work, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)