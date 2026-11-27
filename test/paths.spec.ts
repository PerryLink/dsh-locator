import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  LAST_GOOD_PROFILE_RETENTION,
  lastGoodProfilePaths,
  packageVersion,
  readLastGoodProfiles,
  recordLastGoodProfile,
  secureStateDir,
} from '../src/paths.ts'

const cleanups: Array<() => void> = []
function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'locator-paths-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
afterAll(() => {
  for (const cleanup of cleanups.reverse()) cleanup()
})

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

describe.skipIf(process.platform === 'win32')('state directory permissions', () => {
  it('creates a missing state directory 0700', () => {
    const base = tempState()
    const state = join(base, 'new', 'state')
    const result = secureStateDir(state)
    expect(existsSync(state)).toBe(true)
    expect(result.created).toBe(true)
    expect(modeOf(state)).toBe(0o700)
    expect(result.warnings).toEqual([])
  })

  it('tightens files created by older engines and is idempotent', () => {
    const state = tempState()
    chmodSync(state, 0o755)
    const names = ['index.snapshot', 'index.journal', 'meta.json', 'content.db']
    for (const name of names) {
      writeFileSync(join(state, name), 'x')
      chmodSync(join(state, name), 0o644)
    }
    // An unrelated file must be left alone.
    writeFileSync(join(state, 'notes.txt'), 'x')
    chmodSync(join(state, 'notes.txt'), 0o644)

    const first = secureStateDir(state)
    expect(modeOf(state)).toBe(0o700)
    for (const name of names) expect(modeOf(join(state, name))).toBe(0o600)
    expect(modeOf(join(state, 'notes.txt'))).toBe(0o644)
    expect(first.created).toBe(false)
    expect(first.fixed).toEqual(expect.arrayContaining(['.', ...names]))
    expect(first.warnings).toEqual([])

    // A second pass finds nothing to fix.
    const second = secureStateDir(state)
    expect(second.fixed).toEqual([])
  })

  it('skips state files that do not exist yet', () => {
    const state = tempState()
    const result = secureStateDir(state)
    expect(result.fixed).toEqual([])
    expect(readdirSync(state)).toEqual([])
  })
})

describe('last-good profile records', () => {
  it('writes the latest record 0600 with a stable shape', () => {
    const state = tempState()
    if (process.platform !== 'win32') chmodSync(state, 0o755)
    const result = recordLastGoodProfile(state, {
      packageVersion: '0.23.0',
      engineVersion: '0.23.0',
      roots: ['/tmp/root'],
      contentIndex: true,
      warnings: [],
    })
    expect(result.written).toBe(true)
    expect(result.path).toBe(join(state, 'last-good-profile.json'))
    if (process.platform !== 'win32') {
      expect(modeOf(result.path)).toBe(0o600)
      expect(modeOf(state)).toBe(0o700)
    }
    const [latest] = readLastGoodProfiles(state)
    expect(latest?.packageVersion).toBe('0.23.0')
    expect(latest?.engineVersion).toBe('0.23.0')
    expect(latest?.stateDir).toBe(state)
    expect(latest?.nodeVersion).toBe(process.version)
    expect(typeof latest?.recordedAt).toBe('string')
    expect(latest?.roots).toEqual(['/tmp/root'])
  })

  it('rotates at most three records and reads them newest first', () => {
    const state = tempState()
    for (const version of ['0.20.0', '0.21.0', '0.22.0', '0.23.0']) {
      const result = recordLastGoodProfile(state, { packageVersion: version })
      expect(result.written).toBe(true)
    }
    expect(LAST_GOOD_PROFILE_RETENTION).toBe(3)
    expect(existsSync(join(state, 'last-good-profile.json'))).toBe(true)
    expect(existsSync(join(state, 'last-good-profile.1.json'))).toBe(true)
    expect(existsSync(join(state, 'last-good-profile.2.json'))).toBe(true)
    const records = readLastGoodProfiles(state)
    expect(records.map(record => record.packageVersion)).toEqual(['0.23.0', '0.22.0', '0.21.0'])
    expect(lastGoodProfilePaths(state)).toHaveLength(3)
  })

  it('skips a corrupt rotation slot but keeps the other records', () => {
    const state = tempState()
    recordLastGoodProfile(state, { packageVersion: '0.22.0' })
    recordLastGoodProfile(state, { packageVersion: '0.23.0' })
    writeFileSync(join(state, 'last-good-profile.1.json'), '{not json')
    const records = readLastGoodProfiles(state)
    expect(records.map(record => record.packageVersion)).toEqual(['0.23.0'])
  })

  it('reports instead of throwing when the record cannot be written', () => {
    const base = tempState()
    const blocker = join(base, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const result = recordLastGoodProfile(blocker, { packageVersion: '0.23.0' })
    expect(result.written).toBe(false)
    expect(result.warning).toMatch(/cannot record last-good profile/)
  })
})

describe('package version', () => {
  it('reads the package manifest once', () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/)
    expect(packageVersion()).toBe(packageVersion())
  })
})
