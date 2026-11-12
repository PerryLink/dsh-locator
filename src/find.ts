/**
 * locator_find — search file bodies and DSH session messages.
 * @module dsh-locator/find
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentIndex, ContentState } from './content.ts'

const HIT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['file', 'session'], required: true },
    path: { type: 'string', required: true },
    title: { type: 'string' },
    snippet: { type: 'string' },
    sessionId: { type: 'string' },
    messageId: { type: 'string' },
    nodeKey: { type: 'string' },
    line: { type: 'integer', description: '1-based line of the first match in the stored body (file hits).' },
    score: { type: 'number' },
  },
} as const

/** Build the locator_find tool. */
export function makeFindTool(content: ContentIndex, ensure?: () => void) {
  return defineTool({
    name: 'locator_find',
    description: [
      'Search the **contents** of text files and DSH session messages (dsh-locator).',
      '',
      'Use it when the user remembers a phrase, a sentence, a decision or a code snippet rather than a file name. `locator_search` searches names and paths; this searches bodies and returns snippets plus `sessionId`/`messageId` for session hits, so the result can be opened at its source.',
      '',
      'Content is built asynchronously after start: results may be partial while `state.building` is true. Text files are capped by `contentMaxFileBytes`; session logs are decompressed from `$DSH_HOME/sessions`.',
    ].join('\n'),
    parameters: {
      query: { type: 'string', required: true, description: 'Words or a phrase to find in file/session content.' },
      limit: { type: 'integer', description: 'Maximum hits (default 30, at most 100).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          query: { type: 'string' },
          hits: { type: 'array', items: HIT },
          state: {
            type: 'object',
            additionalProperties: false,
            properties: {
              building: { type: 'boolean' },
              files: { type: 'integer' },
              sessions: { type: 'integer' },
              messages: { type: 'integer' },
              truncated: { type: 'boolean' },
              updatedAt: { type: 'integer' },
              error: { type: 'string' },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok: boolean; hits?: Array<{ kind: string; title?: string; snippet?: string; path?: string; line?: number }>; error?: string; state?: ContentState }
        if (!v.ok) return [{ type: 'text', text: `locator_find failed: ${v.error ?? 'unknown'}` }]
        const lines = (v.hits ?? []).map((hit, index) => `${String(index + 1)}. [${hit.kind}] ${hit.title ?? ''} — ${hit.snippet ?? ''}\n   ${hit.path ?? ''}${typeof hit.line === 'number' ? ` (line ${String(hit.line)})` : ''}`)
        const notes = [
          v.state?.building ? ' (index still building)' : '',
          v.state?.truncated === true ? ' (content budget reached: raise contentMaxTotalBytes or trim contentExcludes; later files are not searchable)' : '',
        ].join('')
        return [{ type: 'text', text: `${String(v.hits?.length ?? 0)} content hit(s)${notes}\n${lines.join('\n')}` }]
      },
    },
    async execute(args) {
      ensure?.()
      const query = args.query.trim()
      if (query === '') return { ok: false as const, error: 'query is empty' }
      const limit = Math.max(1, Math.min(100, args.limit ?? 30))
      const hits = await content.search(query, limit)
      return { ok: true as const, query, hits, state: content.status() }
    },
  })
}
