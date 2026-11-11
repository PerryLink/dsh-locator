/** locator_reindex — full or incremental content-index maintenance. */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentIndex } from './content.ts'

export function makeReindexTool(content: ContentIndex, ensure?: () => void) {
  return defineTool({
    name: 'locator_reindex',
    description: [
      'Rebuild or refresh the dsh-locator content index (file bodies + DSH session messages).',
      '',
      '`full: true` drops the content database and re-reads everything; `full: false` (default) only re-reads files/sessions whose mtime changed. Name/path search keeps working during either mode. Use `locator_status` or the content state in `locator_find` to watch progress.',
    ].join('\n'),
    parameters: {
      full: { type: 'boolean', description: 'Drop and rebuild the content database (default false = incremental).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          started: { type: 'boolean' },
          full: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok: boolean; started?: boolean; full?: boolean; error?: string }
        return [{ type: 'text', text: v.ok ? `${v.full ? 'Full' : 'Incremental'} content rebuild started.` : `locator_reindex failed: ${v.error ?? 'unknown'}` }]
      },
    },
    async execute(args) {
      ensure?.()
      const full = args.full === true
      const started = full ? content.rebuild() : content.refreshNow()
      if (!started) return { ok: false as const, error: 'a content build is already running' }
      return { ok: true as const, started: true, full }
    },
  })
}
