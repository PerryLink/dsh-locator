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
export type RefKind = 'file' | 'session' | 'url';
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
}
/**
 * Build a file ref. The path is a locator, not identity: the optional sha256
 * names the bytes; without it the ref identifies the path snapshot.
 * @param input - path plus optional snapshot fields.
 * @returns canonical `ref://file` URI.
 */
export declare function fileRef(input: FileRefInput): string;
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
} | {
    kind: 'url';
    ref: string;
    url: string;
    sha256?: string;
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
//# sourceMappingURL=refs.d.ts.map