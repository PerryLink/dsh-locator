/**
 * Optional HTTP surface for the Web GUI panel.
 *
 * The panel is a browser overlay (client.js) and cannot call the stdio engine
 * directly, so the host exposes two exact routes on the Web server:
 *
 *   POST /dsh-locator/search   { query, limit, offset, sort, desc, ... }
 *   POST /dsh-locator/status   {}
 *
 * Registration is optional: headless and TUI profiles have no `webServer`
 * service, and the plugin still works there through its tools.
 * @module dsh-locator/http
 */
import type { Context } from '@deepseek-ai/cordis';
import type { LocatorRuntime } from './runtime.ts';
/** Mount the panel's routes when this profile runs a Web server. */
export declare function registerHttp(ctx: Context, rt: LocatorRuntime): void;
//# sourceMappingURL=http.d.ts.map