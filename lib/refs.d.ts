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
/** Kinds of addressable objects this release understands. */
export type RefKind = 'file' | 'session' | 'url' | 'session-event' | 'spill' | 'attachment';
/** Where a hit/ref came from. */
export interface RefProvenance {
    origin: 'index' | 'tool' | 'session' | 'web';
    path?: string;
    sessionId?: string;
    messageId?: string;
    callId?: string;
    url?: string;
    /** Epoch ms when the index last stored this object. */
    indexedAt?: number;
}
/** Whether the referenced bytes still match what was observed. */
export interface RefFreshness {
    state: 'fresh' | 'stale' | 'missing' | 'unknown';
    observedAt: number;
    mtime?: number;
}
/**
 * Lifecycle status of one evidence ref, reported additively by
 * `locator_resolve`/`locator_cite`. It is coarser than {@link RefFreshness}:
 * `tombstoned` means a previous resolve persisted a "missing" marker in the
 * content index, so the target is known gone instead of merely unobserved.
 */
export type RefStatus = 'fresh' | 'stale' | 'missing' | 'tombstoned' | 'unknown';
/**
 * Character anchor of one exact excerpt. `line` is 1-based; `charStart` and
 * `charEnd` are 0-based character offsets (end exclusive).
 */
export interface RefAnchor {
    line?: number;
    charStart?: number;
    charEnd?: number;
}
/** Map a freshness state onto the lifecycle status (missing markers are caller-owned). */
export declare function refStatusForFreshness(state: RefFreshness['state']): RefStatus;
/** The caller's read permission as computed at resolve time (never persisted). */
export interface RefPermissions {
    read: 'allowed' | 'denied';
    visibility: 'workspace' | 'roots' | 'session' | 'external';
    reason: string;
}
/** Metadata returned with a hit or a resolve call. */
export interface RefMeta {
    ref: string;
    kind: RefKind;
    hash?: {
        algo: 'sha256';
        value: string;
    } | null;
    size?: number;
    title?: string;
    provenance: RefProvenance;
    freshness: RefFreshness;
    permissions: RefPermissions;
}
/** Canonical session URI scheme, identical to the host's session-reference. */
export declare const SESSION_REFERENCE_SCHEME = "dsh-session:";
/**
 * Encode a session id as the host-compatible canonical `dsh-session:` URI.
 * @param sessionId - opaque session id.
 * @returns canonical session ref.
 */
export declare function encodeSessionRef(sessionId: string): string;
/**
 * Decode a canonical `dsh-session:` URI back to the session id.
 * @param ref - candidate ref.
 * @returns the session id, or undefined when this is not a canonical session ref.
 */
export declare function decodeSessionRef(ref: string): string | undefined;
/** Inputs for one file ref. */
export interface FileRefInput {
    path: string;
    mtime?: number;
    size?: number;
    sha256?: string | null;
    /** 1-based line of the cited match inside the file, when the hit knows it. */
    line?: number;
    /** 0-based character start of the cited fragment on that line. */
    charStart?: number;
    /** 0-based exclusive character end of the cited fragment on that line. */
    charEnd?: number;
}
/**
 * Build a file ref. The path is a locator, not identity: the optional sha256
 * names the bytes; without it the ref identifies the path snapshot.
 * @param input - path plus optional snapshot fields.
 * @returns canonical `ref://file` URI.
 */
export declare function fileRef(input: FileRefInput): string;
/** Inputs for one addressable session event. */
export interface SessionEventRefInput {
    sessionId: string;
    seq: number;
}
/**
 * Build a ref for one session event. The canonical `dsh-session:` URI cannot
 * carry a sequence, so event refs use the locator's own scheme.
 * @param input - session id and event sequence.
 * @returns canonical `ref://session-event` URI.
 */
export declare function sessionEventRef(input: SessionEventRefInput): string;
/** Build a ref for one spill file (locator plus optional session ownership). */
export declare function spillRef(input: {
    path: string;
    sessionId?: string;
    seq?: number;
}): string;
/** Build a ref for one attachment (identity is the attachment digest). */
export declare function attachmentRef(input: {
    sha256: string;
}): string;
/** Decode a base64url JSON string id (session-event/spill `sid` parameter). */
export declare function decodeSessionIdParam(value: string | null): string | undefined;
/** One parsed ref. */
export type ParsedRef = {
    kind: 'session';
    ref: string;
    sessionId: string;
} | {
    kind: 'file';
    ref: string;
    path: string;
    sha256?: string;
    /** Snapshot mtime (epoch ms) carried by the ref, when it was built from a hit. */
    mtime?: number;
    /** Snapshot byte size carried by the ref. */
    size?: number;
    /** 1-based cited line, when the hit that built the ref knew it. */
    line?: number;
    charStart?: number;
    charEnd?: number;
} | {
    kind: 'url';
    ref: string;
    url: string;
    sha256?: string;
} | {
    kind: 'session-event';
    ref: string;
    sessionId: string;
    seq: number;
} | {
    kind: 'spill';
    ref: string;
    path: string;
    sessionId?: string;
    seq?: number;
} | {
    kind: 'attachment';
    ref: string;
    sha256: string;
};
/**
 * Parse any ref this release understands.
 * @param ref - ref string from a hit, citation or user input.
 * @returns the parsed identity, or undefined for an unsupported/invalid ref.
 */
export declare function parseRef(ref: string): ParsedRef | undefined;
/** Build a URL ref from one URL string (identity = sha256 of the normalized URL). */
export declare function urlRef(raw: string): string;
/** Trim, lowercase the scheme/host and drop the fragment of one URL for identity. */
export declare function normalizeUrl(raw: string): string;
/**
 * Hash one file's bytes with a size cap so a huge artifact cannot stall a
 * tool call. The cap is deliberately generous (8 MiB) for source-like files.
 * @param path - absolute file path.
 * @param maxBytes - files larger than this return null instead of being read.
 * @returns lowercase sha256 hex, or null when unreadable/too large.
 */
export declare function sha256File(path: string, maxBytes?: number): Promise<string | null>;
/**
 * Compare an indexed mtime with the current one and label freshness.
 * @param indexedMtime - mtime recorded by the index.
 * @param currentMtime - mtime read now (undefined when the file/session is gone).
 * @param observedAt - epoch ms of this observation.
 * @returns freshness block.
 */
export declare function freshnessFor(indexedMtime: number | undefined, currentMtime: number | undefined, observedAt?: number): RefFreshness;
/** Human title for a file ref (basename) used by citation rendering. */
export declare function fileRefTitle(path: string): string;
/** Meta key used inside the additive `refs.meta` JSON column for URL freshness. */
export declare const URL_FRESHNESS_META_KEY = "urlFreshness";
/**
 * One URL freshness observation: HTTP validators plus the hash of the fetched
 * prefix, persisted in `refs.meta` (or the in-process fallback cache) so the
 * next resolve can use a conditional request and report a status.
 */
export interface UrlFreshnessRecord {
    /** Normalized URL that was checked (empty when read back from a bounded meta row). */
    url: string;
    status: RefStatus;
    /** Epoch ms of this observation. */
    checkedAt: number;
    /** Strong validator returned by the server. */
    etag?: string;
    /** Weak validator returned by the server. */
    lastModified?: string;
    /** sha256 of the fetched prefix (bounded), used when ETag/Last-Modified are absent. */
    contentSha256?: string;
    /** Content-Length reported by the 2xx response, when present. */
    contentLength?: number;
    /** HTTP status of the last check (absent after a network failure). */
    statusCode?: number;
}
/** Knobs for {@link checkUrlFreshness}; both are clamped. */
export interface UrlFreshnessCheckOptions {
    /** Whole-request deadline in milliseconds (default 5000, min 100, max 30000). */
    timeoutMs?: number;
    /** Cap on bytes read for the body hash (default 65536, min 1024, max 1048576). */
    maxBytes?: number;
}
/** Result of one URL freshness check. */
export interface UrlFreshnessCheck {
    record: UrlFreshnessRecord;
    /** Non-fatal warnings (`url-unreachable`, `url-content-changed`, ...). */
    warnings: string[];
}
/** Default per-request deadline for a URL freshness check. */
export declare const URL_FRESHNESS_TIMEOUT_MS = 5000;
/** Default cap on the body prefix hashed for a URL freshness check. */
export declare const URL_FRESHNESS_MAX_BYTES: number;
/**
 * Remember one URL observation for the rest of this process. Bounded LRU-ish:
 * the oldest inserted entry is evicted once the cache is full.
 * @param refKey - complete `ref://url` key.
 * @param record - latest observation.
 */
export declare function rememberUrlFreshness(refKey: string, record: UrlFreshnessRecord): void;
/**
 * Recall the last in-process URL observation.
 * @param refKey - complete `ref://url` key.
 * @returns the cached observation, or undefined.
 */
export declare function recallUrlFreshness(refKey: string): UrlFreshnessRecord | undefined;
/**
 * Drop one or all cached URL observations (tests and `locator_rebuild` reuse).
 * @param refKey - omit to clear the whole cache.
 */
export declare function forgetUrlFreshness(refKey?: string): void;
/**
 * Read the additive URL freshness block out of one `refs.meta` JSON string.
 * Unparseable/legacy metadata yields undefined; the block is optional.
 * @param meta - raw `refs.meta` column value.
 * @returns the stored observation, or undefined.
 */
export declare function parseUrlFreshnessMeta(meta: string | null | undefined): UrlFreshnessRecord | undefined;
/**
 * Build the `refs.meta` patch for one URL observation. The URL itself is left
 * out because the ref key already encodes it and `refs.meta` is capped at 400
 * characters by the content index.
 * @param record - observation to persist.
 * @returns a JSON patch object ready for a `setRefMeta`-style writer.
 */
export declare function urlFreshnessMetaPatch(record: UrlFreshnessRecord): Record<string, unknown>;
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
export declare function checkUrlFreshness(target: string, previous?: UrlFreshnessRecord, options?: UrlFreshnessCheckOptions): Promise<UrlFreshnessCheck>;
//# sourceMappingURL=refs.d.ts.map