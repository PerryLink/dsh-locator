/**
 * dsh-locator — a self-built, cross-platform whole-disk file index for
 * DeepSeek Harness. No Everything dependency.
 * @module dsh-locator
 */
import { Config as ConfigSchema } from "./config.js";
import { ContentIndex } from "./content.js";
import { makeExportTool } from "./export.js";
import { makeFindTool } from "./find.js";
import { makeReindexTool } from "./reindex.js";
import { registerHttp } from "./http.js";
import { resolveBinary, resolveRoots, resolveStateDir } from "./paths.js";
import { LocatorRuntime } from "./runtime.js";
import { makeRebuildTool, makeSearchTool, makeStatusTool } from "./tools.js";
export { ConfigSchema as Config };
/** Cordis plugin name. */
export const name = 'dsh-locator';
/** Tools are registered through the host tool registry. */
export const inject = ['tools'];
/**
 * Mount the locator engine and its three tools.
 * @param ctx - the plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx, config) {
    if (!config.enabled)
        return;
    const cwd = process.cwd();
    const roots = resolveRoots(config, cwd);
    const stateDir = resolveStateDir(config, cwd);
    const binary = resolveBinary(config, cwd);
    const logger = ctx.logger('dsh-locator');
    const rt = new LocatorRuntime(config, roots, stateDir, binary, cwd);
    const content = config.contentIndex
        ? new ContentIndex(rt, {
            stateDir,
            sessionDirs: config.contentSessionDirs.length > 0 ? config.contentSessionDirs : undefined,
            maxFileBytes: config.contentMaxFileBytes,
            maxTotalBytes: config.contentMaxTotalBytes,
            maxFiles: config.contentMaxFiles,
            maxSessions: config.contentMaxSessions,
        })
        : undefined;
    ctx.effect(() => {
        // Let the host finish starting before a cold scan starts reading the disk.
        const timer = setTimeout(() => {
            rt.start();
            logger.info(`index roots: ${roots.join(', ')} (state ${stateDir})`);
            if (content !== undefined)
                void startContent(rt, content, logger, config.contentRefreshMs);
        }, 1500);
        return () => {
            clearTimeout(timer);
            content?.close();
            void rt.stop();
        };
    });
    ctx.tools.register(makeSearchTool(rt));
    ctx.tools.register(makeStatusTool(rt));
    ctx.tools.register(makeRebuildTool(rt));
    ctx.tools.register(makeExportTool(rt));
    if (content !== undefined) {
        ctx.tools.register(makeFindTool(content));
        ctx.tools.register(makeReindexTool(content));
    }
    // The Web GUI panel is optional: profiles without a Web server keep the
    // three tools and never mount an HTTP route.
    registerHttp(ctx, rt, content);
}
async function startContent(rt, content, logger, refreshMs) {
    try {
        await rt.waitReady();
        for (let i = 0; i < 900; i++) {
            const status = await rt.engineStatus();
            if (status === undefined || !status.scanning)
                break;
            await new Promise(resolve => setTimeout(resolve, 2_000));
        }
        content.start();
        content.startAutoRefresh(refreshMs);
        logger.info('content index started');
    }
    catch (error) {
        logger.info(`content index skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
}
//# sourceMappingURL=index.js.map