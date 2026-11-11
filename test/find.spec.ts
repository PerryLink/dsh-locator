import { describe, expect, it } from 'vitest'
import { makeFindTool } from '../src/find.ts'
import type { ContentIndex } from '../src/content.ts'

const tool = makeFindTool({} as unknown as ContentIndex)

function render(value: unknown): string {
  const blocks = tool.output.render({ query: 'x' }, value as never)
  return blocks.map(block => (block as { text?: string }).text ?? '').join('\n')
}

describe('locator_find render', () => {
  it('lists hits with kind, title, snippet and path', () => {
    const text = render({
      ok: true,
      query: 'x',
      hits: [{ kind: 'session', path: '/tmp/s/session.v4.jsonl.zstd', title: 'plan', snippet: 'ship friday', sessionId: 's', messageId: 'm', score: 0 }],
      state: { building: false, files: 1, sessions: 1, messages: 1, truncated: false, updatedAt: 1, error: '' },
    })
    expect(text).toContain('[session] plan — ship friday')
    expect(text).toContain('/tmp/s/session.v4.jsonl.zstd')
    expect(text).not.toContain('budget reached')
    expect(text).not.toContain('still building')
  })

  it('warns while the index is building and when the body budget truncated the build', () => {
    const building = render({ ok: true, hits: [], state: { building: true, files: 0, sessions: 0, messages: 0, truncated: false, updatedAt: 0, error: '' } })
    expect(building).toContain('index still building')
    const truncated = render({ ok: true, hits: [], state: { building: false, files: 1, sessions: 1, messages: 1, truncated: true, updatedAt: 1, error: '' } })
    expect(truncated).toContain('content budget reached')
    expect(truncated).toContain('contentMaxTotalBytes')
  })

  it('renders tool errors', () => {
    expect(render({ ok: false, error: 'query is empty' })).toContain('locator_find failed: query is empty')
  })
})
