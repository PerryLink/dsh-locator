/**
 * Optional HTTP surface for the Web GUI panel.
 *
 * The panel is a browser overlay (client.js) and cannot call the stdio engine
 * directly, so the host exposes exact routes on the Web server:
 *
 *   POST /dsh-locator/search   { query, limit, offset, sort, desc, ... }
 *   POST /dsh-locator/status   {}
 *
 * Security is fail-closed. The routes only exist when the host's `connection`
 * service — the browser authentication + Host/Origin trust fence — is
 * available, so a profile without it mounts no locator HTTP surface at all.
 * Every request then asks that service for a rejection first; if the service
 * disappeared or its check fails, the route answers 503 instead of allowing
 * the call. On top of that fence each request must be a `POST` with an
 * `application/json` content type (415 otherwise), the body is capped at
 * 64 KiB, and a cross-site `Origin`/`Sec-Fetch-Site` marker is refused locally
 * as defense in depth.
 *
 * Registration is optional: headless and TUI profiles have no `webServer`
 * service, and the plugin still works there through its tools.
 * @module dsh-locator/http
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingHttpHeaders } from 'node:http';
import type { LocatorRuntime } from './runtime.ts';
import type { ContentIndex } from './content.ts';
/**
 * Mount the panel's routes when this profile runs a Web server **and** the
 * host connection trust fence. Without `connection` no route is registered:
 * an unauthenticated locator HTTP surface is never exposed.
 * @param ctx - plugin context.
 * @param rt - locator runtime backing the name search.
 * @param content - content index, when enabled.
 * @param ensure - lazy content boot hook.
 */
export declare function registerHttp(ctx: Context, rt: LocatorRuntime, content?: ContentIndex, ensure?: () => void, options?: {
    connectionOptional?: boolean;
}): void;
/**
 * The exact JSON media type required by every locator route. A charset or any
 * other parameter is tolerated (`application/json; charset=utf-8`), any other
 * essence (including `text/plain` and a missing header) is not.
 * @param value - the raw `content-type` header value.
 */
export declare function isJsonContentType(value: string | string[] | undefined): boolean;
/**
 * The local same-origin fence, defense in depth behind the host connection
 * check. A `Sec-Fetch-Site: cross-site` marker is refused; when a browser
 * attaches an `Origin`, it must name this listener's own authority. Requests
 * without browser markers (CLI clients) pass: they are already gated by
 * authentication.
 * @param headers - request headers.
 * @returns 403 when the request is provably cross-site, else undefined.
 */
export declare function originRejection(headers: IncomingHttpHeaders): 403 | undefined;
//# sourceMappingURL=http.d.ts.map