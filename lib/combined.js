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
import { checkContentQuery, decodeExtendedForNames } from "./content-search.js";
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
        sort: sortKey(body.sort),
        desc: body.desc === true,
        scopes: readScopes(body),
        matchMode: matchMode(body.matchMode),
        caseSensitive: body.caseSensitive === true,
        wholeWord: body.wholeWord === true,
        sessionId: typeof body.sessionId === 'string' && body.sessionId.trim() !== '' ? body.sessionId : null,
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
export async function runCombinedSearch(deps, request) {
    const started = Date.now();
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
            offset: 0,
            sort: request.sort,
            desc: request.desc,
            regex: request.matchMode === 'regex',
            caseSensitive: request.caseSensitive,
            wholeWord: request.wholeWord,
            filesOnly: files,
            dirsOnly: !files,
        });
        return {
            hits: result.hits,
            returned: result.hits.length,
            total: result.total,
            truncated: result.truncated,
            deduped: 0,
            count: { value: result.total, kind: 'exact' },
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
        ...(request.sessionId === null ? {} : { sessionId: request.sessionId }),
    };
    try {
        deps.ensure?.();
        const result = await deps.contentSearch(request.query, request.contentLimit, options);
        const state = deps.contentStatus?.();
        return {
            hits: result.hits,
            returned: result.hits.length,
            capped: result.hits.length >= request.contentLimit,
            count: result.count,
            warnings: result.warnings,
            building: state?.building ?? false,
            files: state?.files ?? 0,
            sessions: state?.sessions ?? 0,
            messages: state?.messages ?? 0,
            truncated: state?.truncated ?? false,
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