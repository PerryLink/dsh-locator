/**
 * Combined search: one request for the three scopes the Web panel shows by
 * default — content (bodies and sessions), files and directories.
 *
 * The name index and the content index live in different stores, so this module
 * owns the orchestration and the merge rules as pure, injectable functions:
 * scope gating, the lazy-build guard for empty queries, per-group degradation,
 * match-option routing (content vs name engine), page counts and de-duplication
 * of a path that appears both as a body hit and a name hit.
 *
 * 0.20.0 (P0-9) moved evidence enrichment off the synchronous path: hit
 * freshness/permissions/hash are computed with async `stat` calls under a small
 * concurrency limit and a short TTL cache, so a 9p root no longer blocks the
 * host event loop. Hashes are capped per page (default 5, `combinedHashMaxHits`)
 * and skipped on slow/network filesystems. `compact` mode (P1) skips the
 * enrichment entirely and strips the evidence fields for keystroke requests.
 * @module dsh-locator/combined
 */
import { stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { checkContentQuery, decodeExtendedForNames } from "./content-search.js";
import { encodeSessionRef, fileRef, freshnessFor, sha256File } from "./refs.js";
/** Attach the citable ref to one content hit (session URI or path snapshot). */
function contentHitRef(hit) {
    if (hit.kind === 'session' && typeof hit.sessionId === 'string' && hit.sessionId !== '') {
        return { ...hit, ref: encodeSessionRef(hit.sessionId) };
    }
    if (typeof hit.path === 'string' && hit.path !== '')
        return { ...hit, ref: fileRef({ path: hit.path }) };
    return hit;
}
/** Attach the citable ref to one name hit. */
function nameHitRef(hit) {
    return hit.dir ? hit : { ...hit, ref: fileRef({ path: hit.path, mtime: hit.mtime, size: hit.size }) };
}
/** Only files up to this size get a hash on a name hit (panel evidence detail). */
export const COMBINED_HASH_MAX_BYTES = 64 * 1024;
/** Default cap on hashed files per response (config: combinedHashMaxHits). */
export const COMBINED_HASH_MAX_HITS = 5;
/** Default parallel stat/hash enrichment limit (config: combinedEnrichConcurrency). */
export const COMBINED_ENRICH_CONCURRENCY = 8;
/** Default freshness-cache lifetime; a longer window trades staleness for latency. */
export const COMBINED_ENRICH_CACHE_TTL_MS = 1_500;
/**
 * Compare one hit snapshot (engine mtime/size) with the current stat. A page is
 * a preview, not a resolve, so the check is one stat per hit and never a read.
 * @param snapshot - engine-reported mtime, plus size for files.
 * @param current - current stat, or undefined when the path is gone.
 * @param observedAt - epoch ms of this observation.
 * @returns the additive freshness block.
 */
export function freshnessForHit(snapshot, current, observedAt) {
    if (current === undefined)
        return { state: 'missing', observedAt };
    if (snapshot.size !== undefined && current.size !== snapshot.size) {
        return { state: 'stale', observedAt, mtime: Math.trunc(current.mtimeMs) };
    }
    return freshnessFor(snapshot.mtime, current.mtimeMs, observedAt);
}
/** Whether one runtime value looks like a lowercase sha256 hex digest. */
function isSha256(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
/** Bound one async mapper to a concurrency limit, preserving input order. */
export async function mapLimit(items, limit, run) {
    const width = Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 1));
    if (items.length === 0)
        return [];
    const results = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
        for (;;) {
            const index = cursor++;
            if (index >= items.length)
                return;
            results[index] = await run(items[index], index);
        }
    };
    const workers = [];
    for (let i = 0; i < Math.min(width, items.length); i++)
        workers.push(worker());
    await Promise.all(workers);
    return results;
}
/** Filesystem types whose stat/read latency should not sit on the enrichment path. */
const NETWORK_FSTYPES = new Set([
    // WSL 9p/drvfs mounts of Windows drives, SMB/CIFS shares, NFS and network
    // FUSE filesystems: a stat is acceptable, a full read for sha256 is not.
    '9p', 'drvfs', 'cifs', 'smb3', 'smb', 'nfs', 'nfs4', 'afs', 'ceph', 'davfs',
    'glusterfs', 'fuse.sshfs', 'fuse.rclone', 'fuse.9p', 'vboxsf', 'virtiofs',
]);
const MOUNT_CACHE_TTL_MS = 60_000;
let mountCache;
/** Decode the octal escapes /proc/self/mounts uses for spaces and friends. */
function decodeMountPath(value) {
    return value
        .replace(/\\040/g, ' ')
        .replace(/\\011/g, '\t')
        .replace(/\\012/g, '\n')
        .replace(/\\134/g, '\\');
}
/** Mount points whose filesystem is slow enough to skip hashing (Linux). */
function slowMountPrefixes() {
    if (mountCache !== undefined && Date.now() - mountCache.at < MOUNT_CACHE_TTL_MS)
        return mountCache.prefixes;
    const prefixes = [];
    if (process.platform === 'linux') {
        try {
            for (const line of readFileSync('/proc/self/mounts', 'utf8').split('\n')) {
                const parts = line.split(' ');
                if (parts.length < 3)
                    continue;
                const fstype = parts[2] ?? '';
                if (!NETWORK_FSTYPES.has(fstype))
                    continue;
                const mountPoint = decodeMountPath(parts[1] ?? '').replace(/\/+$/, '');
                if (mountPoint !== '' && mountPoint !== '/')
                    prefixes.push(mountPoint);
            }
        }
        catch {
            // A container without /proc simply gets no slow-mount hints.
        }
    }
    mountCache = { at: Date.now(), prefixes };
    return prefixes;
}
/**
 * Whether hashing this path is likely expensive (9p/CIFS/NFS/sshfs mounts, UNC
 * shares). Freshness still needs one stat; only the byte-reading hash is skipped.
 * @param path - absolute path.
 * @returns true when the path lives on a slow/network filesystem.
 */
export function isSlowFilesystemPath(path) {
    if (process.platform === 'win32')
        return /^\\\\[^\\]+\\/.test(path);
    if (process.platform === 'darwin')
        return path.startsWith('/Volumes/');
    const normalized = path.replace(/\\/g, '/');
    for (const prefix of slowMountPrefixes()) {
        if (normalized === prefix || normalized.startsWith(prefix + '/'))
            return true;
    }
    return false;
}
const STAT_CACHE = new Map();
const HASH_CACHE = new Map();
const ENRICH_CACHE_MAX_ENTRIES = 4096;
/** Drop every cached enrichment observation (tests and a state-dir switch). */
export function resetCombinedEnrichCache() {
    STAT_CACHE.clear();
    HASH_CACHE.clear();
    mountCache = undefined;
}
/** Read one cache entry, dropping it when it is older than the TTL. */
function cacheGet(map, key, ttlMs) {
    if (ttlMs <= 0)
        return undefined;
    const entry = map.get(key);
    if (entry === undefined)
        return undefined;
    if (Date.now() - entry.at >= ttlMs) {
        map.delete(key);
        return undefined;
    }
    return entry;
}
/** Insert one cache entry, keeping the map bounded (oldest insertion first). */
function cacheSet(map, key, value) {
    map.set(key, value);
    if (map.size <= ENRICH_CACHE_MAX_ENTRIES)
        return;
    for (const oldest of map.keys()) {
        map.delete(oldest);
        if (map.size <= ENRICH_CACHE_MAX_ENTRIES)
            break;
    }
}
/** Current stat behind a short TTL cache; undefined when the path is gone. */
async function cachedStat(path, ttlMs) {
    const cached = cacheGet(STAT_CACHE, path, ttlMs);
    if (cached !== undefined)
        return cached;
    let entry;
    try {
        const info = await stat(path);
        entry = { at: Date.now(), mtimeMs: info.mtimeMs, size: info.size, isFile: info.isFile() };
    }
    catch {
        // Do cache a negative result: a missing page is common while files move.
        entry = { at: Date.now(), mtimeMs: 0, size: -1, isFile: false };
    }
    cacheSet(STAT_CACHE, path, entry);
    return entry;
}
/** sha256 of one small file behind a TTL cache keyed by the stat identity. */
async function cachedHash(path, mtimeMs, size, maxBytes, ttlMs) {
    const key = path + '\u0000' + String(mtimeMs) + '\u0000' + String(size);
    const cached = cacheGet(HASH_CACHE, key, ttlMs);
    if (cached !== undefined)
        return cached.hash ?? undefined;
    let hash = null;
    if (size <= maxBytes) {
        const computed = await sha256File(path, maxBytes);
        if (computed !== null && isSha256(computed))
            hash = computed;
    }
    cacheSet(HASH_CACHE, key, { at: Date.now(), hash });
    return hash ?? undefined;
}
/** Remove the evidence-rich fields from one hit (compact mode). */
function stripEvidence(hit) {
    const { ref, hash, freshness, permissions, ...rest } = hit;
    void ref;
    void hash;
    void freshness;
    void permissions;
    return rest;
}
/** Enrich one page of name hits with freshness, permissions and an optional hash. */
async function enrichNameHits(hits, options) {
    const observedAt = Date.now();
    let hashBudget = options.hashMaxHits;
    return await mapLimit(hits, options.enrichConcurrency, async (hit) => {
        const permissions = {
            read: 'allowed',
            visibility: 'roots',
            reason: hit.dir ? 'directory hit from the configured index roots' : 'name hit from the configured index roots',
        };
        const info = await cachedStat(hit.path, options.cacheTtlMs);
        const missing = info === undefined || info.size < 0;
        const snapshot = hit.dir ? { mtime: hit.mtime } : { mtime: hit.mtime, size: hit.size };
        const freshness = freshnessForHit(snapshot, missing ? undefined : { mtimeMs: info.mtimeMs, size: info.size }, observedAt);
        if (hit.dir || missing || !info.isFile)
            return { ...hit, freshness, permissions };
        let hash;
        if (hashBudget > 0 && info.size <= options.hashMaxBytes && !options.skipHash(hit.path)) {
            hashBudget -= 1;
            hash = await cachedHash(hit.path, info.mtimeMs, info.size, options.hashMaxBytes, options.cacheTtlMs);
        }
        return { ...hit, freshness, permissions, ...(hash === undefined ? {} : { hash }) };
    });
}
/**
 * Enrich one page of content hits with permissions (always) and freshness when
 * the host supplies a content-index snapshot lookup; a hit that already carries
 * a hash (find/content field) passes it through unchanged.
 */
async function enrichContentHits(hits, deps, options) {
    const observedAt = Date.now();
    return await mapLimit(hits, options.enrichConcurrency, async (hit) => {
        const permissions = hit.kind === 'session'
            ? { read: 'allowed', visibility: 'session', reason: 'session messages are scoped to the caller workspace' }
            : { read: 'allowed', visibility: 'roots', reason: 'content hit from the configured index roots' };
        let indexedAt;
        try {
            indexedAt = deps.contentIndexedMtime?.(hit);
        }
        catch {
            indexedAt = undefined;
        }
        let freshness = { state: 'unknown', observedAt };
        if (indexedAt !== undefined) {
            const info = await cachedStat(hit.path, options.cacheTtlMs);
            const missing = info === undefined || info.size < 0;
            freshness = missing ? { state: 'missing', observedAt } : freshnessFor(indexedAt, info.mtimeMs, observedAt);
        }
        const existing = hit.hash;
        return {
            ...hit,
            freshness,
            permissions,
            ...(isSha256(existing) ? { hash: existing } : {}),
        };
    });
}
/** Strip trailing separators from a root so prefix checks are unambiguous. */
function trimRoot(value) {
    return value.replace(/[\\/]+$/, '');
}
/** True when `path` is the prefix itself or a descendant of it. */
function pathUnderPrefix(path, prefix) {
    const root = trimRoot(prefix);
    const candidate = trimRoot(path);
    return candidate === root || candidate.startsWith(root + '/') || candidate.startsWith(root + '\\');
}
/**
 * Accept a requested root prefix only when it lives under a configured root;
 * the panel sends one of `status.roots`, but the route is still a trust
 * boundary, so an arbitrary path must not narrow (or fake) the search.
 * @param prefix - requested prefix from the request body.
 * @param roots - configured roots.
 * @returns the trimmed prefix, or null when it is not authorized.
 */
export function authorizedRootPrefix(prefix, roots) {
    if (prefix === null || prefix === '')
        return null;
    if (roots.length === 0)
        return trimRoot(prefix);
    for (const root of roots)
        if (pathUnderPrefix(prefix, root))
            return trimRoot(prefix);
    return null;
}
/** Resolve the per-call knobs once per request. */
function resolveOptions(options) {
    const positiveInt = (value, fallback) => {
        if (typeof value !== 'number' || !Number.isFinite(value))
            return fallback;
        return Math.max(0, Math.trunc(value));
    };
    return {
        enrichConcurrency: Math.max(1, positiveInt(options.enrichConcurrency, COMBINED_ENRICH_CONCURRENCY)),
        hashMaxHits: positiveInt(options.hashMaxHits, COMBINED_HASH_MAX_HITS),
        hashMaxBytes: positiveInt(options.hashMaxBytes, COMBINED_HASH_MAX_BYTES) || COMBINED_HASH_MAX_BYTES,
        cacheTtlMs: positiveInt(options.cacheTtlMs, COMBINED_ENRICH_CACHE_TTL_MS),
        skipHash: options.skipHash ?? isSlowFilesystemPath,
        budgetChars: positiveInt(options.budgetChars, 0),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
}
/** Whether one error is the abort rejection of a cancelled store query. */
export function isAbortError(error) {
    if (error instanceof Error && error.name === 'AbortError')
        return true;
    return typeof error === 'object' && error !== null && error.code === 'ABORT_ERR';
}
/**
 * Read the three scope flags from a request body. Anything that is not an
 * explicit `false` counts as enabled, so a panel that only sends `{ content:
 * true }` still gets the name groups.
 * @param body - parsed request body.
 * @returns normalized scopes.
 */
export function readScopes(body) {
    return {
        content: body.content !== false,
        files: body.files !== false,
        dirs: body.dirs !== false,
    };
}
/** Accept the compact spellings the panel/plan use: true, 1 and "1". */
function compactFlag(value) {
    return value === true || value === 1 || value === '1';
}
/**
 * Validate and clamp a combined request body. The two pages have separate
 * limits: content hits are heavier (bodies/snippets) than name rows.
 * @param body - parsed request body.
 * @param maxResults - the plugin's hard per-page cap.
 * @returns a normalized request.
 */
export function readCombinedRequest(body, maxResults) {
    const nameLimit = clamp(body.limit, 1, Math.max(1, maxResults), 50);
    const contentLimit = clamp(body.contentLimit, 1, 100, 30);
    return {
        query: typeof body.query === 'string' ? body.query : '',
        limit: nameLimit,
        contentLimit,
        offset: clamp(body.offset, 0, 1_000_000, 0),
        filesOffset: clamp(body.filesOffset ?? body.offset, 0, 1_000_000, 0),
        dirsOffset: clamp(body.dirsOffset ?? body.offset, 0, 1_000_000, 0),
        contentOffset: clamp(body.contentOffset, 0, 1_000_000, 0),
        sort: sortKey(body.sort),
        desc: body.desc === true,
        scopes: readScopes(body),
        matchMode: matchMode(body.matchMode),
        caseSensitive: body.caseSensitive === true,
        wholeWord: body.wholeWord === true,
        sessionId: typeof body.sessionId === 'string' && body.sessionId.trim() !== '' ? body.sessionId : null,
        rootPrefix: typeof body.root === 'string' && body.root.trim() !== '' ? body.root.trim() : null,
        includeArchived: body.includeArchived === true,
        count: countMode(body.count),
        countLimit: clamp(body.countLimit, 1, 5000, 1000),
        compact: compactFlag(body.compact),
    };
}
/**
 * Drop name hits whose path is already present in the content group. Content
 * rows carry the snippet and the jump target, so one row per path is enough;
 * directories are never dropped.
 * @param contentHits - body/session hits from the content index.
 * @param nameHits - hits from the name index.
 * @returns the kept hits and how many were dropped.
 */
export function dedupeNameHits(contentHits, nameHits) {
    const seen = new Set();
    for (const hit of contentHits)
        seen.add(hit.path);
    if (seen.size === 0)
        return { hits: [...nameHits], deduped: 0 };
    const hits = [];
    let deduped = 0;
    for (const hit of nameHits) {
        if (!hit.dir && seen.has(hit.path)) {
            deduped++;
            continue;
        }
        hits.push(hit);
    }
    return { hits, deduped };
}
/**
 * Run one combined search. Empty queries never touch the content index: the
 * panel opens with an empty box, and a lazy content build there would cost
 * minutes and gigabytes for no results. Failures are contained per group so a
 * broken content cache still shows name results.
 * @param deps - stores and the lazy-start hook.
 * @param input - normalized request.
 * @param options - per-call enrichment/budget knobs (config-backed).
 * @returns grouped result in content → files → dirs order.
 */
export async function runCombinedSearch(deps, input, options = {}) {
    const started = Date.now();
    const resolved = resolveOptions(options);
    const request = input.rootPrefix === null
        ? input
        : { ...input, rootPrefix: authorizedRootPrefix(input.rootPrefix, deps.roots ?? []) };
    const { scopes, query } = request;
    const contentEnabled = deps.contentSearch !== undefined;
    const wantsContent = scopes.content && contentEnabled;
    // Any non-empty query is evaluated against the content store; short or
    // over-limit queries are rejected by the same validator the store uses, so
    // the panel can show `content-query-too-short` without starting a build.
    const askContent = wantsContent && query.trim() !== '';
    const contentPromise = wantsContent ? contentGroup(deps, request, askContent, resolved) : Promise.resolve(undefined);
    const filesPromise = scopes.files ? nameGroup(deps, request, true, resolved) : Promise.resolve(undefined);
    const dirsPromise = scopes.dirs ? nameGroup(deps, request, false, resolved) : Promise.resolve(undefined);
    const [content, files, dirs] = await Promise.all([contentPromise, filesPromise, dirsPromise]);
    const dedupedFiles = files === undefined
        ? undefined
        : (() => {
            const result = dedupeNameHits(content?.hits ?? [], files.hits);
            return {
                ...files,
                hits: result.hits,
                returned: result.hits.length,
                deduped: result.deduped,
                truncated: files.truncated || result.deduped > 0,
            };
        })();
    const response = {
        scopes,
        contentEnabled,
        ...(content === undefined ? {} : { content }),
        ...(dedupedFiles === undefined ? {} : { files: dedupedFiles }),
        ...(dirs === undefined ? {} : { dirs }),
        ...(request.compact ? { compact: true } : {}),
        tookMs: Date.now() - started,
    };
    if (resolved.budgetChars > 0)
        applyCombinedBudget(response, resolved.budgetChars);
    return response;
}
/**
 * Fit a combined response inside a character budget by dropping the tail of the
 * lowest-priority groups first: dirs, then files, then content hits. Structural
 * fields (counts, state, warnings) are always kept; each trimmed group reports
 * `returned`/`truncated` and the response carries a {@link OutputBudget} block.
 * @param response - response to trim in place.
 * @param limitChars - soft cap on the serialized response size.
 */
export function applyCombinedBudget(response, limitChars) {
    const budget = { limitChars, usedChars: 0, truncated: false, dropped: 0 };
    response.budget = budget;
    const measure = () => JSON.stringify(response).length;
    const sizeOf = (hit) => JSON.stringify(hit).length + 1;
    const groups = [];
    if (response.dirs !== undefined)
        groups.push(response.dirs);
    if (response.files !== undefined)
        groups.push(response.files);
    if (response.content !== undefined)
        groups.push(response.content);
    // Cheap estimate first: base (no hits) plus an approximate per-hit cost.
    let estimate = measure();
    for (const group of groups) {
        for (const hit of group.hits)
            estimate += sizeOf(hit);
        estimate -= JSON.stringify(group.hits).length;
    }
    for (const group of groups) {
        if (group.hits.length === 0)
            continue;
        const hits = group.hits;
        while (hits.length > 0 && estimate > limitChars) {
            const removed = hits.pop();
            estimate -= sizeOf(removed);
            budget.dropped += 1;
            group.returned = hits.length;
            group.truncated = true;
        }
        if (measure() <= limitChars)
            break;
    }
    // The estimate ignores commas; if the real payload is still too big, trim by
    // measuring (the page is bounded, so this loop is short).
    for (const group of groups) {
        while (group.hits.length > 0 && measure() > limitChars) {
            group.hits.pop();
            budget.dropped += 1;
            group.returned = group.hits.length;
            group.truncated = true;
        }
        if (measure() <= limitChars)
            break;
    }
    const size = measure();
    budget.usedChars = size;
    budget.truncated = budget.dropped > 0 || size > limitChars;
}
/** Page through a directory-shaped name query. */
async function nameGroup(deps, request, files, options) {
    const started = Date.now();
    const empty = (error, warnings) => ({
        hits: [],
        returned: 0,
        total: 0,
        truncated: false,
        deduped: 0,
        count: { value: 0, kind: 'exact' },
        tookMs: Date.now() - started,
        ...(warnings === undefined || warnings.length === 0 ? {} : { warnings }),
        ...(error === undefined ? {} : { error }),
    });
    // The name engine understands everything except Notepad++-style escapes:
    // decode them here and drop control characters (file names cannot contain
    // them) instead of searching for a literal backslash sequence.
    let nameQuery = request.query;
    let warnings = [];
    if (request.matchMode === 'extended') {
        const decoded = decodeExtendedForNames(request.query);
        warnings = decoded.warnings;
        if (!decoded.ok)
            return empty(decoded.error ?? 'invalid-escape', warnings);
        nameQuery = decoded.text;
        // An all-control-escape query must not degrade into "match everything".
        if (nameQuery.trim() === '')
            return empty(undefined, [...new Set([...warnings, 'name-extended-empty'])]);
    }
    try {
        const result = await deps.search({
            query: nameQuery,
            limit: request.limit,
            offset: files ? request.filesOffset : request.dirsOffset,
            sort: request.sort,
            desc: request.desc,
            regex: request.matchMode === 'regex',
            caseSensitive: request.caseSensitive,
            wholeWord: request.wholeWord,
            filesOnly: files,
            dirsOnly: !files,
        });
        const prefix = request.rootPrefix;
        const selected = prefix === null ? result.hits : result.hits.filter(hit => pathUnderPrefix(hit.path, prefix));
        let hits;
        if (request.compact) {
            hits = (prefix === null ? result.hits : selected).map(hit => stripEvidence(hit));
        }
        else {
            hits = await enrichNameHits(selected.map(nameHitRef), options);
        }
        const narrowed = prefix !== null && hits.length !== result.hits.length;
        return {
            hits,
            returned: hits.length,
            total: prefix === null ? result.total : hits.length,
            truncated: result.truncated || narrowed,
            deduped: 0,
            // The engine total covers every root; a narrowed page cannot claim an exact
            // total for the selected root, so the count becomes "unknown" (the UI shows
            // the returned rows).
            count: prefix === null ? { value: result.total, kind: 'exact' } : { value: hits.length, kind: 'unknown' },
            tookMs: result.tookNs / 1e6,
            ...(warnings.length === 0 ? {} : { warnings: [...new Set(warnings)] }),
        };
    }
    catch (error) {
        if (isAbortError(error))
            throw error;
        return { ...empty(messageOf(error)), tookMs: Date.now() - started };
    }
}
/** Query the content store, or report its state without starting a build. */
async function contentGroup(deps, request, ask, options) {
    const started = Date.now();
    const empty = (warnings = []) => {
        let state;
        try {
            state = deps.contentStatus?.();
        }
        catch {
            state = undefined;
        }
        return {
            hits: [],
            returned: 0,
            capped: false,
            count: { value: 0, kind: 'unknown' },
            warnings,
            building: state?.building ?? false,
            files: state?.files ?? 0,
            sessions: state?.sessions ?? 0,
            messages: state?.messages ?? 0,
            truncated: state?.truncated ?? false,
            ...(state?.progress === undefined ? {} : { progress: state.progress }),
            tookMs: 0,
        };
    };
    // 0.9.0 never scans the whole corpus from a panel keystroke: the content
    // group pauses itself in regex mode while the name groups still run.
    if (request.matchMode === 'regex') {
        return { ...empty(['content-regex-paused']), error: 'content-regex-not-supported' };
    }
    if (!ask || deps.contentSearch === undefined)
        return empty();
    // Reject sub-trigram / over-limit / control-character queries here, before
    // deps.ensure() can start a lazy content build the store cannot answer. The
    // store performs the same check; sharing it keeps the error codes identical.
    const check = checkContentQuery(request.query, request.matchMode);
    if (!check.ok) {
        return { ...empty(check.warnings), error: check.error ?? 'content-query-invalid', tookMs: Date.now() - started };
    }
    if (check.terms.length === 0)
        return empty();
    const options_ = {
        matchMode: request.matchMode,
        caseSensitive: request.caseSensitive,
        wholeWord: request.wholeWord,
        count: request.count,
        countLimit: request.countLimit,
        offset: request.contentOffset,
        ...(request.sessionId === null ? {} : { sessionId: request.sessionId }),
        ...(request.rootPrefix === null ? {} : { pathPrefix: request.rootPrefix }),
        ...(request.includeArchived ? { includeArchived: true } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    try {
        deps.ensure?.();
        const queryStarted = Date.now();
        const result = await deps.contentSearch(request.query, request.contentLimit, options_);
        // tookMs is the store's own query cost, matching the name group's
        // engine-reported tookMs; enrichment is reported by the group's latency only.
        const queryTookMs = Date.now() - queryStarted;
        const state = deps.contentStatus?.();
        const rawHits = request.compact
            ? result.hits.map(hit => stripEvidence(hit))
            : result.hits.map(contentHitRef);
        const hits = request.compact ? rawHits : await enrichContentHits(rawHits, deps, options);
        return {
            hits,
            returned: hits.length,
            capped: hits.length >= request.contentLimit,
            count: result.count,
            warnings: result.warnings,
            building: state?.building ?? false,
            files: state?.files ?? 0,
            sessions: state?.sessions ?? 0,
            messages: state?.messages ?? 0,
            truncated: state?.truncated ?? false,
            ...(state?.progress === undefined ? {} : { progress: state.progress }),
            tookMs: queryTookMs,
            ...(result.error === undefined ? {} : { error: result.error }),
        };
    }
    catch (error) {
        if (isAbortError(error))
            throw error;
        return { ...empty(), error: messageOf(error), tookMs: Date.now() - started };
    }
}
function clamp(value, min, max, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
}
function matchMode(value) {
    return value === 'extended' || value === 'regex' ? value : 'normal';
}
function countMode(value) {
    return value === 'bounded' || value === 'none' ? value : 'exact';
}
function sortKey(value) {
    return value === 'name' || value === 'path' || value === 'size' || value === 'mtime' || value === 'ext' ? value : 'mtime';
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=combined.js.map