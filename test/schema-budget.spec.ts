import { describe, expect, it } from 'vitest'
import type { LocatorRuntime } from '../src/runtime.ts'
import { makeAgentAdminTool } from '../src/agent-admin.ts'
import { makeAgentFindTool } from '../src/agent-find.ts'
import { makeAgentReadTool } from '../src/agent-read.ts'
import { makeAgentStatusTool } from '../src/agent-status.ts'
import { Config as ConfigSchema } from '../src/config.ts'

function fakeRuntime(): LocatorRuntime {
  return { roots: ['/tmp/locator-budget'], config: { maxResults: 100 }, start() {}, search: async () => ({ hits: [], total: 0 }) } as unknown as LocatorRuntime
}

function bytes(tool: { name: string; description: string; parameters: unknown }): number {
  return JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length
}

describe('agent declaration budget (0.23)', () => {
  it('keeps the three resident locator tools within 4,500 bytes', () => {
    const rt = fakeRuntime()
    const tools = [
      makeAgentFindTool(rt, undefined, () => {}, {}),
      makeAgentReadTool(rt, undefined),
      makeAgentStatusTool(rt, undefined),
    ]
    const total = tools.reduce((sum, tool) => sum + bytes(tool), 0)
    // A regression here means every native session pays for it. If a feature
    // genuinely needs more bytes, trim an old description instead of raising
    // this limit; the 0.23 measured baseline is 4,408 B.
    expect(total).toBeLessThanOrEqual(4_500)
    expect(tools.every(tool => tool.deferLoading !== true)).toBe(true)
  })

  it('defers locator_admin and the legacy tools', () => {
    const rt = fakeRuntime()
    const admin = makeAgentAdminTool({ rt, ensure: () => {} })
    expect(admin.deferLoading).toBe(true)
  })

  it('defaults legacyTools to false', () => {
    const parsed = ConfigSchema({} as Parameters<typeof ConfigSchema>[0]) as { legacyTools?: boolean }
    expect(parsed.legacyTools).toBe(false)
  })
})