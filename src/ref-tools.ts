/**
 * `locator_resolve` and `locator_cite`: turn refs into metadata/excerpts and
 * human/agent-readable citations. These tools never return content the caller
 * is not authorized to read (session refs follow the same workspace rule as
 * `locator_find`; file refs must stay inside the configured roots).
 * @module dsh-locator/ref-tools
 */

import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentIndex } from './content.ts'
import { decodeSessionRef, freshnessFor, normalizeUrl, parseRef, sha256File, urlRef, type ParsedRef, type RefFreshness, type RefProvenance } from './refs.ts'
import type { LocatorRuntime } from './runtime.ts'
import { resolveWithinRoots } from './reveal.ts'

/** Read at most `maxBytes` from the head of one file (text excerpt helper). */
function readHead(path: string, maxBytes: number): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(Math.min(maxBytes, 64 * 1024))
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const RESOLVE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    ref: { type: 'string' },
    kind: { type: 'string', enum: ['file', 'session', 'url', 'session-event', 'spill', 'attachment'] },
    hash: { type: 'string' },
    size: { type: 'integer' },
    title: { type: 'string' },
    excerpt: { type: 'string' },
    provenance: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string', enum: ['index', 'tool', 'session', 'web'] },
        path: { type: 'string' },
        sessionId: { type: 'string' },
        messageId: { type: 'string' },
        url: { type: 'string' },
        indexedAt: { type: 'integer' },
      },
    },
    freshness: {
      type: 'object',
      additionalProperties: false,
      properties: {
        state: { type: 'string', enum: ['fresh', 'stale', 'missing', 'unknown'] },
        observedAt: { type: 'integer' },
        mtime: { type: 'integer' },
      },
    },
    permissions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        read: { type: 'string', enum: ['allowed', 'denied'] },
        visibility: { type: 'string', enum: ['workspace', 'roots', 'session', 'external'] },
        reason: { type: 'string' },
      },
    },
    error: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const

const CITE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    format: { type: 'string', enum: ['markdown', 'json', 'mention'] },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'string' },
          kind: { type: 'string', enum: ['file', 'session', 'url', 'session-event', 'spill', 'attachment'] },
          label: { type: 'string' },
          markdown: { type: 'string' },
          mention: { type: 'string' },
        },
      },
    },
    error: { type: 'string' },
  },
} as const

/** Root of the local attachment store (matches @deepseek-ai/attachment-local). */
function attachmentsRoot(): string {
  const home = process.env.DSH_HOME
  return join(home === undefined || home === '' ? join(homedir(), '.dsh') : home, 'attachments', 'v1')
}

/** File-host candidates for one attachment digest (images first, then files). */
function attachmentCandidates(sha256: string): Array<{ path: string; kind: 'image' | 'file' }> {
  const prefix = sha256.slice(0, 2)
  const root = attachmentsRoot()
  return [
    { path: join(root, 'objects', prefix, sha256), kind: 'image' as const },
    { path: join(root, 'file-objects', prefix, sha256), kind: 'file' as const },
  ]
}

/** Authorized occurrences of one ref key shared by the new ref kinds. */
function authorizedOccurrences(content: ContentIndex, refKey: string, callerCwd: string | undefined, callerSessionId: string | undefined): ReturnType<ContentIndex['refsFor']> {
  const allowed = content.authorizedSessionIds(callerCwd, callerSessionId)
  return content.refsFor(refKey).filter(row => allowed.has(row.sessionId))
}

/** One denied resolve result. */
function deniedResult(parsed: ParsedRef, kind: 'session-event' | 'spill' | 'attachment'): {
  ok: false
  ref: string
  kind: 'session-event' | 'spill' | 'attachment'
  error: string
  warnings: string[]
  permissions: { read: 'denied'; visibility: 'session'; reason: string }
} {
  return {
    ok: false,
    ref: parsed.ref,
    kind,
    error: 'content-scope-denied',
    warnings: ['ref-not-authorized'],
    permissions: { read: 'denied', visibility: 'session', reason: 'no authorized session occurrence for this ref (caller cwd differs)' },
  }
}

/** Build the locator_resolve tool. */
export function makeResolveTool(rt: LocatorRuntime, content?: ContentIndex) {
  return defineTool({
    name: 'locator_resolve',
    description: [
      'Resolve one dsh-locator evidence ref into its metadata (provenance, hash, freshness, permissions) and, optionally, a bounded excerpt.',
      '',
      'Refs come from `locator_find`/`locator_search` hits: `dsh-session:` URIs for session messages and `ref://file?...` for files. Session refs are only resolvable for the caller session and sessions whose immutable cwd equals the caller cwd; file refs must stay inside the configured index roots.',
      '',
      'Use it to verify that a citation is still fresh, or to quote a bounded excerpt instead of re-reading a whole file.',
    ].join('\n'),
    parameters: {
      ref: { type: 'string', required: true, description: 'Ref string from a hit (dsh-session: URI or ref://file?...).' },
      mode: { type: 'string', enum: ['meta', 'excerpt'], description: 'meta (default) returns metadata only; excerpt also returns a bounded head of the content.' },
      maxBytes: { type: 'integer', description: 'Excerpt size cap in bytes (default 2048, at most 65536).' },
      messageId: { type: 'string', description: 'For session refs: the message id to excerpt (optional).' },
    },
    output: {
      schema: RESOLVE_OUTPUT,
      render: (_args, value) => {
        const v = value as { ok: boolean; ref?: string; kind?: string; title?: string; hash?: string; size?: number; excerpt?: string; freshness?: { state?: string }; permissions?: { visibility?: string }; error?: string; warnings?: string[] }
        if (!v.ok) return [{ type: 'text', text: `locator_resolve failed: ${v.error ?? 'unknown error'}${v.warnings === undefined || v.warnings.length === 0 ? '' : ` (${v.warnings.join(', ')})`}` }]
        const parts = [`locator_resolve ${v.kind ?? 'ref'} ${v.ref ?? ''}`]
        if (v.title !== undefined) parts.push(`title: ${v.title}`)
        if (v.size !== undefined) parts.push(`size: ${String(v.size)}`)
        if (v.hash !== undefined) parts.push(`sha256: ${v.hash}`)
        if (v.freshness?.state !== undefined) parts.push(`freshness: ${v.freshness.state}`)
        if (v.permissions?.visibility !== undefined) parts.push(`visibility: ${v.permissions.visibility}`)
        const head = parts.join(' · ')
        return [{ type: 'text', text: v.excerpt === undefined ? head : `${head}\n---\n${v.excerpt}` }]
      },
    },
    async execute(args, exec) {
      const observedAt = Date.now()
      const parsed = parseRef(args.ref.trim())
      if (parsed === undefined) return { ok: false as const, error: 'invalid-ref', warnings: ['unsupported-or-malformed-ref'] }
      const mode = args.mode === 'excerpt' ? 'excerpt' : 'meta'
      const maxBytes = Math.max(1, Math.min(65536, Math.trunc(args.maxBytes ?? 2048)))
      const callerSessionId = exec?.agent?.session?.id
      const callerCwd = exec?.agent?.session?.header?.cwd
      if (parsed.kind === 'session') {
        if (content === undefined) return { ok: false as const, ref: parsed.ref, kind: 'session' as const, error: 'content-index-unavailable' }
        const allowed = content.authorizedSessionIds(callerCwd, callerSessionId)
        if (!allowed.has(parsed.sessionId)) {
          return {
            ok: false as const,
            ref: parsed.ref,
            kind: 'session' as const,
            error: 'content-scope-denied',
            warnings: ['session-not-authorized'],
            permissions: { read: 'denied' as const, visibility: 'session' as const, reason: 'target session cwd differs from the caller cwd' },
          }
        }
        const messageId = typeof args.messageId === 'string' && args.messageId !== '' ? args.messageId : undefined
        const indexedAt = messageId === undefined ? content.sessionIndexedMtime(parsed.sessionId) : content.indexedMtime('session', '', messageId)
        const body = messageId === undefined ? undefined : content.sessionBody(parsed.sessionId, messageId)
        const excerpt = mode === 'excerpt' ? body?.slice(0, maxBytes) : undefined
        const provenance: RefProvenance = { origin: 'index', sessionId: parsed.sessionId, ...(messageId === undefined ? {} : { messageId }), ...(indexedAt === undefined ? {} : { indexedAt }) }
        return {
          ok: true as const,
          ref: parsed.ref,
          kind: 'session' as const,
          title: `session ${parsed.sessionId.slice(0, 12)}`,
          ...(body === undefined ? {} : { size: body.length }),
          provenance,
          freshness: freshnessFor(indexedAt, indexedAt, observedAt),
          permissions: { read: 'allowed' as const, visibility: 'session' as const, reason: 'caller workspace authorization' },
          ...(excerpt === undefined ? {} : { excerpt }),
        }
      }
      if (parsed.kind === 'file') {
        const authorized = resolveWithinRoots(parsed.path, rt.roots)
        if (authorized === undefined) {
          return {
            ok: false as const,
            ref: parsed.ref,
            kind: 'file' as const,
            error: 'content-path-denied',
            warnings: ['path-outside-roots'],
            permissions: { read: 'denied' as const, visibility: 'roots' as const, reason: 'path is outside every indexed root' },
          }
        }
        let currentMtime: number | undefined
        let size: number | undefined
        try { const info = statSync(authorized.path); currentMtime = info.mtimeMs; size = info.size } catch { currentMtime = undefined }
        if (currentMtime === undefined) {
          return {
            ok: true as const,
            ref: parsed.ref,
            kind: 'file' as const,
            title: basename(authorized.path),
            provenance: { origin: 'index' as const, path: authorized.path },
            freshness: freshnessFor(undefined, undefined, observedAt),
            permissions: { read: 'allowed' as const, visibility: 'roots' as const, reason: 'path is inside the configured roots' },
            warnings: ['file-missing'],
          }
        }
        const indexedAt = content?.indexedMtime('file', authorized.path)
        const hash = await sha256File(authorized.path)
        const excerpt = mode === 'excerpt' ? readHead(authorized.path, maxBytes) : undefined
        return {
          ok: true as const,
          ref: parsed.ref,
          kind: 'file' as const,
          title: basename(authorized.path),
          ...(size === undefined ? {} : { size }),
          ...(hash === null ? {} : { hash }),
          provenance: { origin: 'index' as const, path: authorized.path, ...(indexedAt === undefined ? {} : { indexedAt }) },
          freshness: freshnessFor(indexedAt, currentMtime, observedAt),
          permissions: { read: 'allowed' as const, visibility: 'roots' as const, reason: 'path is inside the configured roots' },
          ...(excerpt === undefined ? {} : { excerpt }),
        }
      }
      if (parsed.kind === 'session-event') {
        if (content === undefined) return { ok: false as const, ref: parsed.ref, kind: 'session-event' as const, error: 'content-index-unavailable' }
        const allowed = content.authorizedSessionIds(callerCwd, callerSessionId)
        if (!allowed.has(parsed.sessionId)) return deniedResult(parsed, 'session-event')
        const indexedAt = content.sessionIndexedMtime(parsed.sessionId)
        const raw = mode === 'excerpt' ? await content.sessionEventBody(parsed.sessionId, parsed.seq, maxBytes * 2) : undefined
        const excerpt = raw?.slice(0, maxBytes)
        return {
          ok: true as const,
          ref: parsed.ref,
          kind: 'session-event' as const,
          title: `session ${parsed.sessionId.slice(0, 12)} event ${String(parsed.seq)}`,
          ...(raw === undefined ? {} : { size: raw.length }),
          provenance: { origin: 'session' as const, sessionId: parsed.sessionId, ...(indexedAt === undefined ? {} : { indexedAt }) },
          freshness: freshnessFor(indexedAt, indexedAt, observedAt),
          permissions: { read: 'allowed' as const, visibility: 'session' as const, reason: 'caller workspace authorization' },
          ...(excerpt === undefined ? {} : { excerpt }),
          warnings: raw === undefined ? ['event-log-unavailable'] : [],
        }
      }
      if (parsed.kind === 'spill') {
        if (content === undefined) return { ok: false as const, ref: parsed.ref, kind: 'spill' as const, error: 'content-index-unavailable' }
        const occurrences = authorizedOccurrences(content, parsed.ref, callerCwd, callerSessionId)
        if (occurrences.length === 0) return deniedResult(parsed, 'spill')
        let resolvedPath: string | undefined
        let size: number | undefined
        try {
          if (!statSync(parsed.path).isFile()) return { ok: true as const, ref: parsed.ref, kind: 'spill' as const, error: 'spill-not-a-file', freshness: { state: 'missing' as RefFreshness['state'], observedAt }, warnings: ['spill-not-a-file'] }
          resolvedPath = realpathSync(parsed.path)
          size = statSync(resolvedPath).size
        } catch { resolvedPath = undefined }
        const ownerId = occurrences[0]?.sessionId
        const ownerHash = ownerId === undefined ? undefined : createHash('sha256').update(ownerId).digest('hex').slice(0, 12)
        const dirName = resolvedPath === undefined ? '' : basename(dirname(resolvedPath))
        const owned = ownerHash === undefined ? true : dirName === `session-${ownerHash}`
        const excerpt = mode === 'excerpt' && resolvedPath !== undefined ? readHead(resolvedPath, maxBytes) : undefined
        return {
          ok: true as const,
          ref: parsed.ref,
          kind: 'spill' as const,
          title: resolvedPath === undefined ? basename(parsed.path) : basename(resolvedPath),
          ...(size === undefined ? {} : { size }),
          provenance: { origin: 'tool' as const, ...(ownerId === undefined ? {} : { sessionId: ownerId }), ...(occurrences[0]?.messageId === undefined ? {} : { messageId: occurrences[0].messageId }) },
          freshness: resolvedPath === undefined ? { state: 'missing' as const, observedAt } : { state: 'fresh' as const, observedAt, mtime: Math.trunc(statSync(resolvedPath).mtimeMs) },
          permissions: { read: 'allowed' as const, visibility: 'session' as const, reason: 'authorized session occurrence' },
          ...(excerpt === undefined ? {} : { excerpt }),
          warnings: [
            ...(resolvedPath === undefined ? ['spill-file-missing'] : []),
            ...(owned ? [] : ['spill-owner-mismatch']),
          ],
        }
      }
      if (parsed.kind === 'attachment') {
        if (content === undefined) return { ok: false as const, ref: parsed.ref, kind: 'attachment' as const, error: 'content-index-unavailable' }
        const occurrences = authorizedOccurrences(content, parsed.ref, callerCwd, callerSessionId)
        if (occurrences.length === 0) return deniedResult(parsed, 'attachment')
        const found = attachmentCandidates(parsed.sha256).find(candidate => existsSync(candidate.path))
        const excerpt = mode === 'excerpt' && found !== undefined && found.kind === 'file' ? readHead(found.path, maxBytes) : undefined
        return {
          ok: true as const,
          ref: parsed.ref,
          kind: 'attachment' as const,
          title: occurrences[0]?.title ?? `attachment ${parsed.sha256.slice(0, 12)}`,
          ...(found === undefined ? {} : { size: statSync(found.path).size }),
          provenance: { origin: 'session' as const, ...(occurrences[0]?.sessionId === undefined ? {} : { sessionId: occurrences[0].sessionId }), ...(occurrences[0]?.messageId === undefined ? {} : { messageId: occurrences[0].messageId }) },
          freshness: found === undefined ? { state: 'missing' as const, observedAt } : { state: 'fresh' as const, observedAt, mtime: Math.trunc(statSync(found.path).mtimeMs) },
          permissions: { read: 'allowed' as const, visibility: 'session' as const, reason: 'authorized session occurrence' },
          ...(excerpt === undefined ? {} : { excerpt }),
          ...(found === undefined ? { warnings: ['attachment-missing'] } : {}),
        }
      }
      // URL refs are metadata only: resolving them does not fetch the network.
      const normalized = normalizeUrl(parsed.url)
      return {
        ok: true as const,
        ref: parsed.ref,
        kind: 'url' as const,
        title: normalized,
        provenance: { origin: 'web' as const, url: normalized },
        freshness: { state: 'unknown' as const, observedAt },
        permissions: { read: 'allowed' as const, visibility: 'external' as const, reason: 'external URL metadata; no network read' },
        warnings: ['url-not-fetched'],
      }
    },
  })
}

/** Build the locator_cite tool. */
export function makeCiteTool() {
  return defineTool({
    name: 'locator_cite',
    description: [
      'Render citations for dsh-locator evidence refs. Use it when the answer must point at a file or a session message with a stable reference instead of a bare path.',
      '',
      'Formats: `markdown` (default, `[label](ref)`; session refs render as host mention syntax), `mention` (session refs only), `json` (structured entries).',
    ].join('\n'),
    parameters: {
      refs: { type: 'array', items: { type: 'string' }, required: true, description: 'Up to 20 ref strings from locator_find/locator_search/locator_resolve.' },
      format: { type: 'string', enum: ['markdown', 'json', 'mention'], description: 'Citation format (default markdown).' },
    },
    output: {
      schema: CITE_OUTPUT,
      render: (_args, value) => {
        const v = value as { ok: boolean; format?: string; citations?: Array<{ markdown?: string; ref?: string }>; error?: string }
        if (!v.ok) return [{ type: 'text', text: `locator_cite failed: ${v.error ?? 'unknown error'}` }]
        return [{ type: 'text', text: (v.citations ?? []).map(citation => citation.markdown ?? citation.ref ?? '').join('\n') }]
      },
    },
    async execute(args) {
      const format: 'markdown' | 'mention' | 'json' = args.format === 'mention' ? 'mention' : args.format === 'json' ? 'json' : 'markdown'
      const refs = Array.isArray(args.refs) ? args.refs.filter((ref): ref is string => typeof ref === 'string' && ref.trim() !== '').slice(0, 20) : []
      if (refs.length === 0) return { ok: false as const, format, citations: [], error: 'refs is empty' }
      const citations: Array<{ ref: string; kind: 'file' | 'session' | 'url' | 'session-event' | 'spill' | 'attachment'; label: string; markdown: string; mention?: string }> = []
      for (const raw of refs) {
        const parsed = parseRef(raw.trim())
        if (parsed === undefined) return { ok: false as const, format, citations: [], error: `invalid-ref: ${raw.slice(0, 80)}` }
        if (parsed.kind === 'file') {
          const label = basename(parsed.path) || parsed.path
          citations.push({ ref: parsed.ref, kind: 'file', label, markdown: `[${label}](${parsed.ref})` })
          continue
        }
        if (parsed.kind === 'url') {
          const label = parsed.url
          citations.push({ ref: parsed.ref, kind: 'url', label, markdown: `[${label}](${parsed.ref})` })
          continue
        }
        if (parsed.kind === 'session-event') {
          const label = `session ${parsed.sessionId.slice(0, 12)} event ${String(parsed.seq)}`
          citations.push({ ref: parsed.ref, kind: 'session-event', label, markdown: `[${label}](${parsed.ref})` })
          continue
        }
        if (parsed.kind === 'spill') {
          const label = basename(parsed.path)
          citations.push({ ref: parsed.ref, kind: 'spill', label, markdown: `[${label}](${parsed.ref})` })
          continue
        }
        if (parsed.kind === 'attachment') {
          const label = `attachment ${parsed.sha256.slice(0, 12)}`
          citations.push({ ref: parsed.ref, kind: 'attachment', label, markdown: `[${label}](${parsed.ref})` })
          continue
        }
        const label = `session ${parsed.sessionId.slice(0, 12)}`
        const mention = `@[${label}](${parsed.ref})`
        citations.push({ ref: parsed.ref, kind: 'session', label, markdown: mention, mention })
      }
      return { ok: true as const, format, citations }
    },
  })
}

/** Build a URL ref from one raw URL (used by future indexing work and tests). */
export function buildUrlRef(raw: string): string {
  return urlRef(raw)
}

/** Decode a session ref back to its id (exported for tests/other modules). */
export function sessionIdOf(ref: string): string | undefined {
  return decodeSessionRef(ref)
}
