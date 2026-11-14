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
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
/** Canonical session URI scheme, identical to the host's session-reference. */
export const SESSION_REFERENCE_SCHEME = 'dsh-session:';
/**
 * Encode a session id as the host-compatible canonical `dsh-session:` URI.
 * @param sessionId - opaque session id.
 * @returns canonical session ref.
 */
export function encodeSessionRef(sessionId) {
    return `${SESSION_REFERENCE_SCHEME}${Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')}`;
}
/**
 * Decode a canonical `dsh-session:` URI back to the session id.
 * @param ref - candidate ref.
 * @returns the session id, or undefined when this is not a canonical session ref.
 */
export function decodeSessionRef(ref) {
    if (!ref.startsWith(SESSION_REFERENCE_SCHEME))
        return undefined;
    const payload = ref.slice(SESSION_REFERENCE_SCHEME.length);
    if (!/^[A-Za-z0-9_-]+$/.test(payload))
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return typeof parsed === 'string' && parsed !== '' ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Build a file ref. The path is a locator, not identity: the optional sha256
 * names the bytes; without it the ref identifies the path snapshot.
 * @param input - path plus optional snapshot fields.
 * @returns canonical `ref://file` URI.
 */
export function fileRef(input) {
    const params = new URLSearchParams();
    params.set('path', input.path);
    if (typeof input.mtime === 'number')
        params.set('mtime', String(Math.trunc(input.mtime)));
    if (typeof input.size === 'number')
        params.set('size', String(Math.trunc(input.size)));
    if (typeof input.sha256 === 'string' && input.sha256 !== '')
        params.set('sha256', input.sha256);
    return `ref://file?${params.toString()}`;
}
/**
 * Parse any ref this release understands.
 * @param ref - ref string from a hit, citation or user input.
 * @returns the parsed identity, or undefined for an unsupported/invalid ref.
 */
export function parseRef(ref) {
    const sessionId = decodeSessionRef(ref);
    if (sessionId !== undefined)
        return { kind: 'session', ref, sessionId };
    if (!ref.startsWith('ref://'))
        return undefined;
    let url;
    try {
        url = new URL(ref);
    }
    catch {
        return undefined;
    }
    if (url.host === 'file') {
        const path = url.searchParams.get('path');
        if (path === null || path === '')
            return undefined;
        const sha256 = url.searchParams.get('sha256') ?? undefined;
        return { kind: 'file', ref, path, ...(sha256 === undefined || sha256 === '' ? {} : { sha256 }) };
    }
    if (url.host === 'url') {
        const target = url.searchParams.get('url') ?? url.searchParams.get('u');
        if (target === null || target === '')
            return undefined;
        const sha256 = url.searchParams.get('sha256') ?? undefined;
        return { kind: 'url', ref, url: target, ...(sha256 === undefined || sha256 === '' ? {} : { sha256 }) };
    }
    return undefined;
}
/** Build a URL ref from one URL string (identity = sha256 of the normalized URL). */
export function urlRef(raw) {
    const normalized = normalizeUrl(raw);
    const sha256 = createHash('sha256').update(normalized).digest('hex');
    return `ref://url?url=${encodeURIComponent(normalized)}&sha256=${sha256}`;
}
/** Trim, lowercase the scheme/host and drop the fragment of one URL for identity. */
export function normalizeUrl(raw) {
    try {
        const url = new URL(raw.trim());
        url.hash = '';
        return url.toString();
    }
    catch {
        return raw.trim();
    }
}
/**
 * Hash one file's bytes with a size cap so a huge artifact cannot stall a
 * tool call. The cap is deliberately generous (8 MiB) for source-like files.
 * @param path - absolute file path.
 * @param maxBytes - files larger than this return null instead of being read.
 * @returns lowercase sha256 hex, or null when unreadable/too large.
 */
export async function sha256File(path, maxBytes = 8 * 1024 * 1024) {
    try {
        const info = await stat(path);
        if (!info.isFile() || info.size > maxBytes)
            return null;
        const bytes = await readFile(path);
        return createHash('sha256').update(bytes).digest('hex');
    }
    catch {
        return null;
    }
}
/**
 * Compare an indexed mtime with the current one and label freshness.
 * @param indexedMtime - mtime recorded by the index.
 * @param currentMtime - mtime read now (undefined when the file/session is gone).
 * @param observedAt - epoch ms of this observation.
 * @returns freshness block.
 */
export function freshnessFor(indexedMtime, currentMtime, observedAt = Date.now()) {
    if (currentMtime === undefined)
        return { state: indexedMtime === undefined ? 'unknown' : 'missing', observedAt };
    const mtime = Math.trunc(currentMtime);
    if (indexedMtime === undefined)
        return { state: 'fresh', observedAt, mtime };
    return { state: Math.abs(currentMtime - indexedMtime) < 1 ? 'fresh' : 'stale', observedAt, mtime };
}
/** Human title for a file ref (basename) used by citation rendering. */
export function fileRefTitle(path) {
    const name = basename(path);
    return name === '' ? path : name;
}
//# sourceMappingURL=refs.js.map