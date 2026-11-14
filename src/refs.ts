/**
 * Evidence references (`ref`) for file and session objects.
 *
 * A ref is a stable, opaque-ish identity for one object the locator indexed.
 * Session refs reuse the host's canonical `dsh-session:` URI so mentions and
 * citations stay compatible with DeepSeek Harness; file refs carry the path as
 * a locator plus an optional sha256 of the bytes. Permissions are never part of
 * a ref: callers resolve them against their own identity at query time.
 * @module dsh-locator/refs
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'

/** Kinds of addressable objects this release understands. */
export type RefKind = 'file' | 'session' | 'url'

/** Where a hit/ref came from. */
export interface RefProvenance {
  origin: 'index' | 'tool' | 'session' | 'web'
  path?: string
  sessionId?: string
  messageId?: string
  callId?: string
  url?: string
  /** Epoch ms when the index last stored this object. */
  indexedAt?: number
}

/** Whether the referenced bytes still match what was observed. */
export interface RefFreshness {
  state: 'fresh' | 'stale' | 'missing' | 'unknown'
  observedAt: number
  mtime?: number
}

/** The caller's read permission as computed at resolve time (never persisted). */
export interface RefPermissions {
  read: 'allowed' | 'denied'
  visibility: 'workspace' | 'roots' | 'session' | 'external'
  reason: string
}

/** Metadata returned with a hit or a resolve call. */
export interface RefMeta {
  ref: string
  kind: RefKind
  hash?: { algo: 'sha256'; value: string } | null
  size?: number
  title?: string
  provenance: RefProvenance
  freshness: RefFreshness
  permissions: RefPermissions
}

/** Canonical session URI scheme, identical to the host's session-reference. */
export const SESSION_REFERENCE_SCHEME = 'dsh-session:'

/**
 * Encode a session id as the host-compatible canonical `dsh-session:` URI.
 * @param sessionId - opaque session id.
 * @returns canonical session ref.
 */
export function encodeSessionRef(sessionId: string): string {
  return `${SESSION_REFERENCE_SCHEME}${Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')}`
}

/**
 * Decode a canonical `dsh-session:` URI back to the session id.
 * @param ref - candidate ref.
 * @returns the session id, or undefined when this is not a canonical session ref.
 */
export function decodeSessionRef(ref: string): string | undefined {
  if (!ref.startsWith(SESSION_REFERENCE_SCHEME)) return undefined
  const payload = ref.slice(SESSION_REFERENCE_SCHEME.length)
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof parsed === 'string' && parsed !== '' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Inputs for one file ref. */
export interface FileRefInput {
  path: string
  mtime?: number
  size?: number
  sha256?: string | null
}

/**
 * Build a file ref. The path is a locator, not identity: the optional sha256
 * names the bytes; without it the ref identifies the path snapshot.
 * @param input - path plus optional snapshot fields.
 * @returns canonical `ref://file` URI.
 */
export function fileRef(input: FileRefInput): string {
  const params = new URLSearchParams()
  params.set('path', input.path)
  if (typeof input.mtime === 'number') params.set('mtime', String(Math.trunc(input.mtime)))
  if (typeof input.size === 'number') params.set('size', String(Math.trunc(input.size)))
  if (typeof input.sha256 === 'string' && input.sha256 !== '') params.set('sha256', input.sha256)
  return `ref://file?${params.toString()}`
}

/** One parsed ref. */
export type ParsedRef =
  | { kind: 'session'; ref: string; sessionId: string }
  | { kind: 'file'; ref: string; path: string; sha256?: string }
  | { kind: 'url'; ref: string; url: string; sha256?: string }

/**
 * Parse any ref this release understands.
 * @param ref - ref string from a hit, citation or user input.
 * @returns the parsed identity, or undefined for an unsupported/invalid ref.
 */
export function parseRef(ref: string): ParsedRef | undefined {
  const sessionId = decodeSessionRef(ref)
  if (sessionId !== undefined) return { kind: 'session', ref, sessionId }
  if (!ref.startsWith('ref://')) return undefined
  let url: URL
  try {
    url = new URL(ref)
  } catch {
    return undefined
  }
  if (url.host === 'file') {
    const path = url.searchParams.get('path')
    if (path === null || path === '') return undefined
    const sha256 = url.searchParams.get('sha256') ?? undefined
    return { kind: 'file', ref, path, ...(sha256 === undefined || sha256 === '' ? {} : { sha256 }) }
  }
  if (url.host === 'url') {
    const target = url.searchParams.get('url') ?? url.searchParams.get('u')
    if (target === null || target === '') return undefined
    const sha256 = url.searchParams.get('sha256') ?? undefined
    return { kind: 'url', ref, url: target, ...(sha256 === undefined || sha256 === '' ? {} : { sha256 }) }
  }
  return undefined
}

/** Build a URL ref from one URL string (identity = sha256 of the normalized URL). */
export function urlRef(raw: string): string {
  const normalized = normalizeUrl(raw)
  const sha256 = createHash('sha256').update(normalized).digest('hex')
  return `ref://url?url=${encodeURIComponent(normalized)}&sha256=${sha256}`
}

/** Trim, lowercase the scheme/host and drop the fragment of one URL for identity. */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim())
    url.hash = ''
    return url.toString()
  } catch {
    return raw.trim()
  }
}

/**
 * Hash one file's bytes with a size cap so a huge artifact cannot stall a
 * tool call. The cap is deliberately generous (8 MiB) for source-like files.
 * @param path - absolute file path.
 * @param maxBytes - files larger than this return null instead of being read.
 * @returns lowercase sha256 hex, or null when unreadable/too large.
 */
export async function sha256File(path: string, maxBytes = 8 * 1024 * 1024): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > maxBytes) return null
    const bytes = await readFile(path)
    return createHash('sha256').update(bytes).digest('hex')
  } catch {
    return null
  }
}

/**
 * Compare an indexed mtime with the current one and label freshness.
 * @param indexedMtime - mtime recorded by the index.
 * @param currentMtime - mtime read now (undefined when the file/session is gone).
 * @param observedAt - epoch ms of this observation.
 * @returns freshness block.
 */
export function freshnessFor(indexedMtime: number | undefined, currentMtime: number | undefined, observedAt = Date.now()): RefFreshness {
  if (currentMtime === undefined) return { state: indexedMtime === undefined ? 'unknown' : 'missing', observedAt }
  const mtime = Math.trunc(currentMtime)
  if (indexedMtime === undefined) return { state: 'fresh', observedAt, mtime }
  return { state: Math.abs(currentMtime - indexedMtime) < 1 ? 'fresh' : 'stale', observedAt, mtime }
}

/** Human title for a file ref (basename) used by citation rendering. */
export function fileRefTitle(path: string): string {
  const name = basename(path)
  return name === '' ? path : name
}
