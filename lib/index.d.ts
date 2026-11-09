/**
 * dsh-locator — a self-built, cross-platform whole-disk file index for
 * DeepSeek Harness. No Everything dependency.
 * @module dsh-locator
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config as ConfigSchema } from './config.ts';
import type { Config } from './config.ts';
export { ConfigSchema as Config };
/** Cordis plugin name. */
export declare const name = "dsh-locator";
/** Tools are registered through the host tool registry. */
export declare const inject: string[];
/**
 * Mount the locator engine and its three tools.
 * @param ctx - the plugin context.
 * @param config - validated configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map