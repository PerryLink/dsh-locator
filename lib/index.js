/**
 * dsh-locator — a self-built, cross-platform whole-disk file index for
 * DeepSeek Harness. No Everything dependency.
 * @module dsh-locator
 */
import { Config as ConfigSchema, applyResourcePreset, contentLimits, outputBudgetChars } from "./config.js";
import { ContentIndex } from "./content.js";
import { makeAgentAdminTool } from "./agent-admin.js";
import { makeAgentFindTool } from "./agent-find.js";
import { makeAgentReadTool } from "./agent-read.js";
import { makeAgentStatusTool } from "./agent-status.js";
import { makeExploreTool } from "./explore.js";
import { makeExportTool } from "./export.js";
import { makeReindexTool } from "./reindex.js";
import { registerHttp } from "./http.js";
import { packageVersion, recordLastGoodProfile, resolveBinary, resolveRoots, resolveStateDir } from "./paths.js";
import { LocatorRuntime } from "./runtime.js";
import { makeCapabilityTools, preflightCapabilityCard, searchCapabilityCards } from "./capabilities.js";
import { makeCiteTool, makeResolveTool } from "./ref-tools.js";
import { runOcrCommand, scopeFromConfig } from "./scope.js";
import { makeOutlineTool, makeRebuildTool, makeRepoMapTool, makeSearchTool, makeSymbolTool } from "./tools.js";
export { ConfigSchema as Config };
/** Cordis plugin name. */
export const name = 'dsh-locator';
/** Tools are registered through the host tool registry. */
export const inject = ['tools'];
/**
 * Read the optional timer service without declaring it as a hard dependency.
 * Cordis refuses direct mixin access (`ctx.timeout`) unless the plugin injects
 * `timer`, but `ctx.get()` is the documented escape hatch for optional
 * services; a profile without the timer plugin simply gets the raw fallback.
 * @param ctx - the plugin context.
 * @returns the timer service, or undefined when the profile has none.
 */
function optionalTimer(ctx) {
    const get = ctx.get;
    if (typeof get !== 'function')
        return undefined;
    try {
        const timer = get.call(ctx, 'timer', false);
        return timer ?? undefined;
    }
    catch {
        return undefined;
    }
}
/** Normalize a cordis timer handle (function or `.dispose()`) to a disposer. */
function asDisposer(handle) {
    if (typeof handle === 'function')
        return handle;
    if (handle !== null && typeof handle === 'object' && typeof handle.dispose === 'function') {
        return () => { handle.dispose(); };
    }
    return undefined;
}
/**
 * Mount the locator engine and its tools.
 *
 * The name index starts right away; the content index is built lazily on the
 * first content search (or eagerly when `contentLazy` is false) because it is
 * the expensive half and most sessions never search bodies.
 * @param ctx - the plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx, config) {
    if (!config.enabled)
        return;
    // Resource presets layer on top of the explicit configuration (0.20.0).
    config = applyResourcePreset(config);
    const cwd = process.cwd();
    const roots = resolveRoots(config, cwd);
    const stateDir = resolveStateDir(config, cwd);
    const binary = resolveBinary(config, cwd);
    const logger = ctx.logger('dsh-locator');
    const rt = new LocatorRuntime(config, roots, stateDir, binary, cwd);
    // Layered ignore rules and the shared result budget are compiled once and
    // handed to every tool, the HTTP surface and the status report.
    const scope = scopeFromConfig(config);
    const budgetChars = outputBudgetChars(config);
    const content = config.contentIndex
        ? new ContentIndex(rt, {
            stateDir,
            sessionDirs: config.contentSessionDirs.length > 0 ? config.contentSessionDirs : undefined,
            excludes: config.contentExcludes,
            includeArchived: config.contentIncludeArchived,
            activeSessionDelayMs: config.contentActiveSessionDelayMs,
            searchWorker: true,
            maxFileBytes: config.contentMaxFileBytes,
            maxTotalBytes: contentLimits(config).maxTotalBytes,
            maxFiles: contentLimits(config).maxFiles,
            includeReasoning: config.contentIndexReasoning,
            includeToolResults: config.contentIndexToolResults,
            maxSessions: config.contentMaxSessions,
            extractDocuments: config.contentExtractDocuments ?? true,
            extractMaxBytes: config.contentExtractMaxBytes ?? 8_000_000,
            indexSymbols: config.contentIndexSymbols ?? true,
            symbolMaxBytes: config.contentSymbolMaxBytes ?? 524_288,
            evict: config.contentEvict ?? false,
            maxDbBytes: config.contentMaxDbBytes ?? 0,
            symbolsPerFile: config.contentSymbolsPerFile ?? 500,
            rankAdaptive: config.contentRankAdaptive ?? false,
            // 0.20.2: coverage/quality knobs (defaults keep the 0.20.1 behaviour).
            parallelPrefetch: config.contentParallelPrefetch ?? 4,
            textSniff: config.contentTextSniff !== false,
            shortQueryFallback: config.contentShortQueryFallback !== false,
            optimizeInIdle: true,
            queryCacheSize: config.contentQueryCacheSize ?? 0,
            queryCacheTtlMs: config.contentQueryCacheTtlMs ?? 0,
            sessionMaxBytes: config.contentSessionMaxBytes ?? 0,
            adaptiveRefresh: config.contentRefreshAdaptive ?? false,
            searchWorkers: 2,
            // locator_find/locator_search declare the additive format field, so the
            // content layer may attach extracted document formats to hits.
            attachHitFormats: true,
            // The indexable layer: glob matches never enter the content index, so
            // extractors skip their bytes entirely.
            isIndexable: (path) => scope.isIndexable(path),
            // P2 OCR hook: the extraction layer calls it only for a PDF with no
            // text layer, and only when the operator configured a command.
            ...(config.ocrCommand === undefined || config.ocrCommand.trim() === ''
                ? {}
                : {
                    ocr: async (path, format) => {
                        const result = await runOcrCommand(config.ocrCommand, { path, mime: format }, {
                            timeoutMs: config.requestTimeoutMs,
                            maxChars: config.contentMaxFileBytes,
                        });
                        return result.ok ? result.text : undefined;
                    },
                }),
        })
        : undefined;
    const timer = optionalTimer(ctx);
    let contentStarted = false;
    let refreshHandle;
    const armRefresh = () => {
        if (content === undefined || config.contentRefreshMs <= 0 || refreshHandle !== undefined)
            return;
        const tick = () => { content.refreshNow(); };
        if (typeof timer?.interval === 'function') {
            const handle = asDisposer(timer.interval(tick, config.contentRefreshMs));
            if (handle !== undefined) {
                refreshHandle = handle;
                return;
            }
        }
        const handle = setInterval(tick, config.contentRefreshMs);
        refreshHandle = () => { clearInterval(handle); };
    };
    /**
     * Start the content half exactly once. Tools and the panel call this on
     * their first content operation so that a profile that never searches
     * bodies pays nothing for the content database.
     */
    const ensureContent = () => {
        if (content === undefined || contentStarted)
            return;
        contentStarted = true;
        // Surface the lazy start immediately: the first query would otherwise look
        // like a permanent "no results" until the asynchronous boot opens the DB.
        content.markPending();
        void startContent();
    };
    const startContent = async () => {
        try {
            await rt.waitReady();
            for (let i = 0; i < 900; i++) {
                const status = await rt.engineStatus();
                if (status === undefined || !status.scanning)
                    break;
                await new Promise(resolve => setTimeout(resolve, 2_000));
            }
            content.boot();
            armRefresh();
            logger.info('content index started');
        }
        catch (error) {
            content.clearPending();
            logger.info(`content index skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    ctx.effect(() => {
        const start = () => {
            rt.start();
            logger.info(`index roots: ${roots.join(', ')} (state ${stateDir})`);
            // Record a known-good boot in the state directory only; doctor prints how
            // to restore it after an external profile reset. Never fails boot.
            recordLastGoodProfile(stateDir, {
                packageVersion: packageVersion(),
                roots,
                contentIndex: config.contentIndex,
                ...(rt.status?.warning === undefined ? {} : { warnings: [rt.status.warning] }),
            });
            if (content !== undefined && config.contentLazy === false)
                ensureContent();
        };
        let disposeBoot;
        if (config.prewarm !== false) {
            // Warm the engine at activation so the first tool/panel request does not
            // pay the cold-start cost (0.20.0).
            start();
        }
        else if (typeof timer?.timeout === 'function') {
            // Let the host finish starting before a cold scan starts reading the disk.
            disposeBoot = asDisposer(timer.timeout(start, 1500));
        }
        if (config.prewarm === false && disposeBoot === undefined) {
            const handle = setTimeout(start, 1500);
            disposeBoot = () => { clearTimeout(handle); };
        }
        return () => {
            disposeBoot?.();
            refreshHandle?.();
            refreshHandle = undefined;
            content?.close();
            void rt.stop();
        };
    });
    // 0.23 AI-first surface: three resident tools plus a deferred admin tool.
    // Legacy tools are opt-in via config.legacyTools (default false in 0.23),
    // which keeps the native declaration at ~4.4 KB and the PTC schema small.
    ctx.tools.register(makeAgentFindTool(rt, content, ensureContent, {
        scope,
        allowCrossWorkspaceSessions: config.allowCrossWorkspaceSessions,
        maxChars: budgetChars,
    }));
    ctx.tools.register(makeAgentStatusTool(rt, content, scope));
    ctx.tools.register(makeAgentAdminTool({ rt, ...(content === undefined ? {} : { content }), ensure: ensureContent }));
    ctx.tools.register(makeAgentReadTool(rt, content, { scope }));
    ctx.tools.register(makeResolveTool(rt, content, { urlFreshness: config.urlFreshness === true, scope }));
    // Cite detail mode reads session/file anchors through the same stores; pass
    // them explicitly so a ref carrying a line can quote that line verbatim.
    ctx.tools.register(makeCiteTool({
        ...(content === undefined ? {} : { content }),
        roots,
        scope,
    }));
    if (config.legacyTools === true) {
        ctx.tools.register(makeSearchTool(rt, {
            ...(content === undefined ? {} : { content }),
            ensure: ensureContent,
            scope,
            budgetChars,
        }));
        ctx.tools.register(makeRebuildTool(rt));
        ctx.tools.register(makeExportTool(rt));
        // locator_explore works with the name index alone; the content half is
        // added when the profile enables it (same lazy boot hook as find).
        ctx.tools.register(makeExploreTool(rt, {
            ...(content === undefined ? {} : { content }),
            ensure: ensureContent,
            roots,
            allowCrossWorkspaceSessions: config.allowCrossWorkspaceSessions,
            scope,
            budgetChars,
        }));
    }
    // Capability adapter: read the host's tool registry and skill catalog instead
    // of duplicating discovery. Optional services stay optional.
    const skillsService = ctx.get?.('skills');
    const capabilitySources = {
        tools: ctx.tools,
        ...(skillsService === undefined ? {} : { skills: skillsService }),
    };
    for (const tool of makeCapabilityTools(capabilitySources))
        ctx.tools.register(tool);
    if (content !== undefined && config.legacyTools === true) {
        ctx.tools.register(makeReindexTool(content, ensureContent));
        // Symbol data layer (P1-2): outline/symbol/repo_map are read-only views over
        // the additive symbols table and share the same scope + budget rules.
        ctx.tools.register(makeOutlineTool(content, ensureContent, roots, scope, budgetChars));
        ctx.tools.register(makeSymbolTool(content, ensureContent, scope, budgetChars));
        ctx.tools.register(makeRepoMapTool(content, ensureContent, roots, scope, budgetChars));
    }
    // The Web GUI panel is optional: profiles without a Web server keep the
    // tools and never mount an HTTP route.
    registerHttp(ctx, rt, content, ensureContent, {
        connectionOptional: config.httpConnectionOptional,
        combinedBudgetChars: config.combinedBudgetChars ?? 0,
        combinedEnrichConcurrency: config.combinedEnrichConcurrency ?? 8,
        combinedHashMaxHits: config.combinedHashMaxHits ?? 5,
    }, {
        search: async (intent, limit) => await searchCapabilityCards(capabilitySources, intent, limit === undefined ? {} : { limit }),
        preflight: async (capability, args) => await preflightCapabilityCard(capabilitySources, capability, args),
    }, scope);
}
//# sourceMappingURL=index.js.map