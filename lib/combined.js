/**
 * Combined search: one request for the three scopes the Web panel shows by
 * default — content (bodies and sessions), files and directories.
 *
 * The name index and the content index live in different stores, so this module
 * owns the orchestration and the merge rules as pure, injectable functions:
 * scope gating, the lazy-build guard for empty queries, per-group degradation,
 * match-option routing (content vs name engine), page counts and de-duplication
 * of a path that appears both as a body hit and a name hit.
 * @module dsh-locator/combined
 */
import { statSync } from 'node:fs';
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
/** At most this many name hits per page are hashed, keeping keystroke latency low. */
export const COMBINED_HASH_MAX_HITS = 20;
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
/** Enrich one page of name hits with freshness, permissions and an optional hash. */
async function enrichNameHits(hits) {
    const observedAt = Date.now();
    let hashed = 0;
    return await Promise.all(hits.map(async (hit) => {
        const permissions = {
            read: 'allowed',
            visibility: 'roots',
            reason: hit.dir ? 'directory hit from the configured index roots' : 'name hit from the configured index roots',
        };
        let info;
        try {
            info = statSync(hit.path);
        }
        catch {
            info = undefined;
        }
        const snapshot = hit.dir ? { mtime: hit.mtime } : { mtime: hit.mtime, size: hit.size };
        const freshness = freshnessForHit(snapshot, info === undefined ? undefined : { mtimeMs: info.mtimeMs, size: info.size }, observedAt);
        if (hit.dir || info === undefined || !info.isFile())
            return { ...hit, freshness, permissions };
        let hash;
        if (hashed < COMBINED_HASH_MAX_HITS && info.size <= COMBINED_HASH_MAX_BYTES) {
            hashed += 1;
            const computed = await sha256File(hit.path, COMBINED_HASH_MAX_BYTES);
            if (computed !== null)
                hash = computed;
        }
        return { ...hit, freshness, permissions, ...(hash === undefined ? {} : { hash }) };
    }));
}
/**
 * Enrich one page of content hits with permissions (always) and freshness when
 * the host supplies a content-index snapshot lookup; a hit that already carries
 * a hash (future find/content field) passes it through unchanged.
 */
async function enrichContentHits(hits, deps) {
    const observedAt = Date.now();
    return await Promise.all(hits.map(async (hit) => {
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
            let current;
            try {
                current = statSync(hit.path);
            }
            catch {
                current = undefined;
            }
            freshness = current === undefined ? { state: 'missing', observedAt } : freshnessFor(indexedAt, current.mtimeMs, observedAt);
        }
        const existing = hit.hash;
        return {
            ...hit,
            freshness,
            permissions,
            ...(isSha256(existing) ? { hash: existing } : {}),
        };
    }));
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
 * @param request - normalized request.
 * @returns grouped result in content → files → dirs order.
 */
export async function runCombinedSearch(deps, input) {
    const started = Date.now();
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
    const contentPromise = wantsContent ? contentGroup(deps, request, askContent) : Promise.resolve(undefined);
    const filesPromise = scopes.files ? nameGroup(deps, request, true) : Promise.resolve(undefined);
    const dirsPromise = scopes.dirs ? nameGroup(deps, request, false) : Promise.resolve(undefined);
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
    return {
        scopes,
        contentEnabled,
        ...(content === undefined ? {} : { content }),
        ...(dedupedFiles === undefined ? {} : { files: dedupedFiles }),
        ...(dirs === undefined ? {} : { dirs }),
        tookMs: Date.now() - started,
    };
}
/** Page through a directory-shaped name query. */
async function nameGroup(deps, request, files) {
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
        const hits = await enrichNameHits(selected.map(nameHitRef));
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
        return { ...empty(messageOf(error)), tookMs: Date.now() - started };
    }
}
/** Query the content store, or report its state without starting a build. */
async function contentGroup(deps, request, ask) {
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
    const options = {
        matchMode: request.matchMode,
        caseSensitive: request.caseSensitive,
        wholeWord: request.wholeWord,
        count: request.count,
        countLimit: request.countLimit,
        offset: request.contentOffset,
        ...(request.sessionId === null ? {} : { sessionId: request.sessionId }),
        ...(request.rootPrefix === null ? {} : { pathPrefix: request.rootPrefix }),
        ...(request.includeArchived ? { includeArchived: true } : {}),
    };
    try {
        deps.ensure?.();
        const result = await deps.contentSearch(request.query, request.contentLimit, options);
        const state = deps.contentStatus?.();
        const hits = await enrichContentHits(result.hits.map(contentHitRef), deps);
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
            tookMs: Date.now() - started,
            ...(result.error === undefined ? {} : { error: result.error }),
        };
    }
    catch (error) {
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