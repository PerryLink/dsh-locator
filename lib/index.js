/**
 * dsh-locator — a self-built, cross-platform whole-disk file index for
 * DeepSeek Harness. No Everything dependency.
 * @module dsh-locator
 */
import { Config as ConfigSchema } from "./config.js";
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
    ctx.effect(() => {
        // Let the host finish starting before a cold scan starts reading the disk.
        const timer = setTimeout(() => {
            rt.start();
            logger.info(`index roots: ${roots.join(', ')} (state ${stateDir})`);
        }, 1500);
        return () => {
            clearTimeout(timer);
            void rt.stop();
        };
    });
    ctx.tools.register(makeSearchTool(rt));
    ctx.tools.register(makeStatusTool(rt));
    ctx.tools.register(makeRebuildTool(rt));
    // The Web GUI panel is optional: profiles without a Web server keep the
    // three tools and never mount an HTTP route.
    registerHttp(ctx, rt);
}
//# sourceMappingURL=index.js.map