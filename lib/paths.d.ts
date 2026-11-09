/**
 * Platform paths: engine binary lookup, default state directory and roots.
 * @module dsh-locator/paths
 */
import type { Config } from './config.ts';
/** `linux-x64`, `win32-arm64`, `darwin-arm64`, … */
export declare function platformTag(): string;
/** Engine file name for this platform. */
export declare function engineName(): string;
/** The package root, one level above the compiled `lib/` directory. */
export declare function packageRoot(): string;
/** The default snapshot directory, outside the session data tree. */
export declare function defaultStateDir(): string;
/** Absolute roots to index. An empty configuration means the home directory. */
export declare function resolveRoots(config: Config, cwd: string): string[];
/** The configured engine binary, or the bundled one for this platform. */
export declare function resolveBinary(config: Config, cwd: string): string;
/** The state directory actually used. */
export declare function resolveStateDir(config: Config, cwd: string): string;
//# sourceMappingURL=paths.d.ts.map