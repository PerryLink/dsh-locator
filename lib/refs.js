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
/** Map a freshness state onto the lifecycle status (missing markers are caller-owned). */
export function refStatusForFreshness(state) {
    return state === 'fresh' ? 'fresh' : state === 'stale' ? 'stale' : state === 'missing' ? 'missing' : 'unknown';
}
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
/** One optional non-negative integer ref parameter (`line`, `cs`, `ce`). */
function refNumberParam(params, key) {
    const raw = params.get(key);
    if (raw === null || raw === '')
        return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
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
    if (typeof input.line === 'number' && Number.isInteger(input.line) && input.line > 0)
        params.set('line', String(input.line));
    if (typeof input.charStart === 'number' && Number.isInteger(input.charStart) && input.charStart >= 0)
        params.set('cs', String(input.charStart));
    if (typeof input.charEnd === 'number' && Number.isInteger(input.charEnd) && input.charEnd >= 0)
        params.set('ce', String(input.charEnd));
    return `ref://file?${params.toString()}`;
}
/**
 * Build a ref for one session event. The canonical `dsh-session:` URI cannot
 * carry a sequence, so event refs use the locator's own scheme.
 * @param input - session id and event sequence.
 * @returns canonical `ref://session-event` URI.
 */
export function sessionEventRef(input) {
    const params = new URLSearchParams();
    params.set('sid', Buffer.from(JSON.stringify(input.sessionId), 'utf8').toString('base64url'));
    params.set('seq', String(Math.trunc(input.seq)));
    return `ref://session-event?${params.toString()}`;
}
/** Build a ref for one spill file (locator plus optional session ownership). */
export function spillRef(input) {
    const params = new URLSearchParams();
    params.set('path', input.path);
    if (typeof input.sessionId === 'string' && input.sessionId !== '')
        params.set('sid', Buffer.from(JSON.stringify(input.sessionId), 'utf8').toString('base64url'));
    if (typeof input.seq === 'number')
        params.set('seq', String(Math.trunc(input.seq)));
    return `ref://spill?${params.toString()}`;
}
/** Build a ref for one attachment (identity is the attachment digest). */
export function attachmentRef(input) {
    return `ref://attachment?sha256=${encodeURIComponent(input.sha256.toLowerCase())}`;
}
/** Decode a base64url JSON string id (session-event/spill `sid` parameter). */
export function decodeSessionIdParam(value) {
    if (value === null || value === '')
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        return typeof parsed === 'string' && parsed !== '' ? parsed : undefined;
    }
    catch {
        return undefined;
    }
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
        const mtime = refNumberParam(url.searchParams, 'mtime');
        const size = refNumberParam(url.searchParams, 'size');
        const line = refNumberParam(url.searchParams, 'line');
        const charStart = refNumberParam(url.searchParams, 'cs');
        const charEnd = refNumberParam(url.searchParams, 'ce');
        return {
            kind: 'file',
            ref,
            path,
            ...(sha256 === undefined || sha256 === '' ? {} : { sha256 }),
            ...(mtime === undefined ? {} : { mtime: Math.trunc(mtime) }),
            ...(size === undefined ? {} : { size: Math.trunc(size) }),
            ...(line === undefined || !Number.isInteger(line) || line <= 0 ? {} : { line: Math.trunc(line) }),
            ...(charStart === undefined || !Number.isInteger(charStart) || charStart < 0 ? {} : { charStart: Math.trunc(charStart) }),
            ...(charEnd === undefined || !Number.isInteger(charEnd) || charEnd < 0 ? {} : { charEnd: Math.trunc(charEnd) }),
        };
    }
    if (url.host === 'url') {
        const target = url.searchParams.get('url') ?? url.searchParams.get('u');
        if (target === null || target === '')
            return undefined;
        const sha256 = url.searchParams.get('sha256') ?? undefined;
        return { kind: 'url', ref, url: target, ...(sha256 === undefined || sha256 === '' ? {} : { sha256 }) };
    }
    if (url.host === 'session-event') {
        const sessionId = decodeSessionIdParam(url.searchParams.get('sid'));
        const seq = Number(url.searchParams.get('seq') ?? '');
        if (sessionId === undefined || !Number.isInteger(seq) || seq < 0)
            return undefined;
        return { kind: 'session-event', ref, sessionId, seq };
    }
    if (url.host === 'spill') {
        const path = url.searchParams.get('path');
        if (path === null || path === '')
            return undefined;
        const sessionId = decodeSessionIdParam(url.searchParams.get('sid'));
        const seqRaw = url.searchParams.get('seq');
        const seq = seqRaw === null ? undefined : Number(seqRaw);
        return {
            kind: 'spill', ref, path,
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(seq === undefined || !Number.isInteger(seq) ? {} : { seq }),
        };
    }
    if (url.host === 'attachment') {
        const sha256 = (url.searchParams.get('sha256') ?? '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(sha256))
            return undefined;
        return { kind: 'attachment', ref, sha256 };
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
/** Meta key used inside the additive `refs.meta` JSON column for URL freshness. */
export const URL_FRESHNESS_META_KEY = 'urlFreshness';
/** Default per-request deadline for a URL freshness check. */
export const URL_FRESHNESS_TIMEOUT_MS = 5000;
/** Default cap on the body prefix hashed for a URL freshness check. */
export const URL_FRESHNESS_MAX_BYTES = 64 * 1024;
/** In-process fallback cache used when no content index writer is available. */
const URL_FRESHNESS_CACHE_LIMIT = 200;
const urlFreshnessCache = new Map();
/**
 * Remember one URL observation for the rest of this process. Bounded LRU-ish:
 * the oldest inserted entry is evicted once the cache is full.
 * @param refKey - complete `ref://url` key.
 * @param record - latest observation.
 */
export function rememberUrlFreshness(refKey, record) {
    if (refKey === '')
        return;
    urlFreshnessCache.delete(refKey);
    urlFreshnessCache.set(refKey, record);
    while (urlFreshnessCache.size > URL_FRESHNESS_CACHE_LIMIT) {
        const oldest = urlFreshnessCache.keys().next().value;
        if (oldest === undefined)
            break;
        urlFreshnessCache.delete(oldest);
    }
}
/**
 * Recall the last in-process URL observation.
 * @param refKey - complete `ref://url` key.
 * @returns the cached observation, or undefined.
 */
export function recallUrlFreshness(refKey) {
    return urlFreshnessCache.get(refKey);
}
/**
 * Drop one or all cached URL observations (tests and `locator_rebuild` reuse).
 * @param refKey - omit to clear the whole cache.
 */
export function forgetUrlFreshness(refKey) {
    if (refKey === undefined)
        urlFreshnessCache.clear();
    else
        urlFreshnessCache.delete(refKey);
}
/**
 * Read the additive URL freshness block out of one `refs.meta` JSON string.
 * Unparseable/legacy metadata yields undefined; the block is optional.
 * @param meta - raw `refs.meta` column value.
 * @returns the stored observation, or undefined.
 */
export function parseUrlFreshnessMeta(meta) {
    if (meta === null || meta === undefined || meta === '')
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(meta);
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return undefined;
    const block = parsed[URL_FRESHNESS_META_KEY];
    if (typeof block !== 'object' || block === null || Array.isArray(block))
        return undefined;
    const value = block;
    const status = value.status;
    const checkedAt = typeof value.checkedAt === 'number' && Number.isFinite(value.checkedAt) ? Math.trunc(value.checkedAt) : undefined;
    if (checkedAt === undefined)
        return undefined;
    if (status !== 'fresh' && status !== 'stale' && status !== 'missing' && status !== 'unknown')
        return undefined;
    const text = (key) => typeof value[key] === 'string' && value[key] !== '' ? value[key] : undefined;
    const sha256 = typeof value.contentSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.contentSha256) ? value.contentSha256 : undefined;
    return {
        url: typeof value.url === 'string' ? value.url : '',
        status,
        checkedAt,
        ...(text('etag') === undefined ? {} : { etag: text('etag') }),
        ...(text('lastModified') === undefined ? {} : { lastModified: text('lastModified') }),
        ...(sha256 === undefined ? {} : { contentSha256: sha256 }),
        ...(typeof value.contentLength === 'number' && Number.isFinite(value.contentLength) && value.contentLength >= 0 ? { contentLength: Math.trunc(value.contentLength) } : {}),
        ...(typeof value.statusCode === 'number' && Number.isInteger(value.statusCode) ? { statusCode: value.statusCode } : {}),
    };
}
/**
 * Build the `refs.meta` patch for one URL observation. The URL itself is left
 * out because the ref key already encodes it and `refs.meta` is capped at 400
 * characters by the content index.
 * @param record - observation to persist.
 * @returns a JSON patch object ready for a `setRefMeta`-style writer.
 */
export function urlFreshnessMetaPatch(record) {
    return {
        [URL_FRESHNESS_META_KEY]: {
            status: record.status,
            checkedAt: Math.trunc(record.checkedAt),
            ...(record.etag === undefined ? {} : { etag: record.etag }),
            ...(record.lastModified === undefined ? {} : { lastModified: record.lastModified }),
            ...(record.contentSha256 === undefined ? {} : { contentSha256: record.contentSha256 }),
            ...(record.contentLength === undefined ? {} : { contentLength: record.contentLength }),
            ...(record.statusCode === undefined ? {} : { statusCode: record.statusCode }),
        },
    };
}
/** Clamp one optional numeric option. */
function clampOption(value, fallback, min, max) {
    if (value === undefined || !Number.isFinite(value))
        return fallback;
    return Math.max(min, Math.min(max, Math.trunc(value)));
}
/** Assemble one observation, carrying previous validators forward on reuse. */
function urlRecord(target, status, checkedAt, previous, patch = {}) {
    const etag = patch.etag === null ? undefined : (patch.etag ?? previous?.etag);
    const lastModified = patch.lastModified === null ? undefined : (patch.lastModified ?? previous?.lastModified);
    const contentSha256 = patch.contentSha256 ?? previous?.contentSha256;
    const contentLength = patch.contentLength ?? previous?.contentLength;
    return {
        url: target,
        status,
        checkedAt,
        ...(etag === undefined ? {} : { etag }),
        ...(lastModified === undefined ? {} : { lastModified }),
        ...(contentSha256 === undefined ? {} : { contentSha256 }),
        ...(contentLength === undefined ? {} : { contentLength }),
        ...(patch.statusCode === undefined ? {} : { statusCode: patch.statusCode }),
    };
}
/** Read at most `maxBytes` of one response body (the stream is cancelled after). */
async function readBoundedBody(response, maxBytes) {
    const body = response.body;
    if (body === null) {
        try {
            return Buffer.from(await response.arrayBuffer()).subarray(0, maxBytes);
        }
        catch {
            return undefined;
        }
    }
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (total < maxBytes) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (value === undefined)
                continue;
            const chunk = Buffer.from(value);
            const slice = chunk.length > maxBytes - total ? chunk.subarray(0, maxBytes - total) : chunk;
            chunks.push(slice);
            total += slice.length;
            if (slice.length < chunk.length)
                break;
        }
        return Buffer.concat(chunks);
    }
    catch {
        return undefined;
    }
    finally {
        try {
            await reader.cancel();
        }
        catch { /* the stream is already closed */ }
    }
}
/**
 * Check whether one URL still serves the same content, using an HTTP
 * conditional GET with a bounded range. This never crawls: it only touches the
 * exact URL the caller passed, honors HTTP validators when the server sent
 * them, and falls back to a sha256 of the fetched prefix. Redirects are
 * followed. Proxy, cookie and authentication behaviour is the Node fetch
 * default; no robots.txt is fetched because this is a revalidation of one
 * explicit citation, not a crawl.
 *
 * Failure mapping: network error/timeout → `stale` (the target may still be
 * fine; it is unreachable), 404/410 → `missing`, a body-hash change → `stale`,
 * first observation → `fresh` baseline.
 * @param target - normalized HTTP(S) URL.
 * @param previous - prior observation used for validators/baseline.
 * @param options - timeout and body-prefix caps.
 * @returns the observation plus non-fatal warnings.
 */
export async function checkUrlFreshness(target, previous, options = {}) {
    const checkedAt = Date.now();
    let parsedUrl;
    try {
        parsedUrl = new URL(target);
    }
    catch {
        return { record: urlRecord(target, 'unknown', checkedAt, previous), warnings: ['url-invalid'] };
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return { record: urlRecord(target, 'unknown', checkedAt, previous), warnings: ['url-scheme-unsupported'] };
    }
    const timeoutMs = clampOption(options.timeoutMs, URL_FRESHNESS_TIMEOUT_MS, 100, 30_000);
    const maxBytes = clampOption(options.maxBytes, URL_FRESHNESS_MAX_BYTES, 1024, 1024 * 1024);
    const headers = {
        accept: '*/*',
        range: `bytes=0-${String(maxBytes - 1)}`,
        'user-agent': 'dsh-locator/url-freshness',
        ...(previous?.etag === undefined ? {} : { 'if-none-match': previous.etag }),
        ...(previous?.lastModified === undefined ? {} : { 'if-modified-since': previous.lastModified }),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    try {
        const response = await fetch(parsedUrl, { method: 'GET', headers, redirect: 'follow', signal: controller.signal });
        const statusCode = response.status;
        if (statusCode === 304) {
            return { record: urlRecord(target, 'fresh', checkedAt, previous, { statusCode }), warnings: [] };
        }
        if (statusCode === 404 || statusCode === 410) {
            return { record: urlRecord(target, 'missing', checkedAt, previous, { statusCode }), warnings: ['url-gone'] };
        }
        if (statusCode < 200 || statusCode >= 300) {
            // 401/403/405/5xx: reachable but unverifiable; report stale, never missing.
            return { record: urlRecord(target, 'stale', checkedAt, previous, { statusCode }), warnings: [`url-check-status-${String(statusCode)}`] };
        }
        const body = await readBoundedBody(response, maxBytes);
        if (body === undefined) {
            return { record: urlRecord(target, 'stale', checkedAt, previous, { statusCode }), warnings: ['url-check-body-unavailable'] };
        }
        const contentSha256 = createHash('sha256').update(body).digest('hex');
        const etag = response.headers.get('etag');
        const lastModified = response.headers.get('last-modified');
        const contentLengthRaw = Number(response.headers.get('content-length') ?? '');
        const patch = {
            ...(etag === null || etag === '' ? {} : { etag }),
            ...(lastModified === null || lastModified === '' ? {} : { lastModified }),
            contentSha256,
            ...(Number.isFinite(contentLengthRaw) && contentLengthRaw > 0 ? { contentLength: contentLengthRaw } : {}),
            statusCode,
        };
        if (previous?.contentSha256 === undefined) {
            return { record: urlRecord(target, 'fresh', checkedAt, previous, patch), warnings: ['url-freshness-baseline'] };
        }
        const unchanged = previous.contentSha256 === contentSha256;
        return {
            record: urlRecord(target, unchanged ? 'fresh' : 'stale', checkedAt, previous, patch),
            warnings: unchanged ? [] : ['url-content-changed'],
        };
    }
    catch (error) {
        const timedOut = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
        return { record: urlRecord(target, 'stale', checkedAt, previous), warnings: [timedOut ? 'url-check-timeout' : 'url-unreachable'] };
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=refs.js.map