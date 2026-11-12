/**
 * dsh-locator — a self-built, cross-platform whole-disk file index for
 * DeepSeek Harness. No Everything dependency.
 * @module dsh-locator
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config as ConfigSchema, contentLimits } from './config.ts'
import type { Config } from './config.ts'
import { ContentIndex } from './content.ts'
import { makeExportTool } from './export.ts'
import { makeFindTool } from './find.ts'
import { makeReindexTool } from './reindex.ts'
import { registerHttp } from './http.ts'
import { resolveBinary, resolveRoots, resolveStateDir } from './paths.ts'
import { LocatorRuntime } from './runtime.ts'
import { makeRebuildTool, makeSearchTool, makeStatusTool } from './tools.ts'

export { ConfigSchema as Config }

/** Cordis plugin name. */
export const name = 'dsh-locator'

/** Tools are registered through the host tool registry. */
export const inject = ['tools']

/** The timer service mounted by `@deepseek-ai/cordis-plugin-timer`. */
interface TimerLike {
  timeout?: (callback: () => void, delay: number) => unknown
  interval?: (callback: () => void, delay: number) => unknown
}

/**
 * Read the optional timer service without declaring it as a hard dependency.
 * Cordis refuses direct mixin access (`ctx.timeout`) unless the plugin injects
 * `timer`, but `ctx.get()` is the documented escape hatch for optional
 * services; a profile without the timer plugin simply gets the raw fallback.
 * @param ctx - the plugin context.
 * @returns the timer service, or undefined when the profile has none.
 */
function optionalTimer(ctx: Context): TimerLike | undefined {
  const get = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get
  if (typeof get !== 'function') return undefined
  try {
    const timer = get.call(ctx, 'timer', false) as TimerLike | undefined
    return timer ?? undefined
  } catch {
    return undefined
  }
}

/** Normalize a cordis timer handle (function or `.dispose()`) to a disposer. */
function asDisposer(handle: unknown): (() => void) | undefined {
  if (typeof handle === 'function') return handle as () => void
  if (handle !== null && typeof handle === 'object' && typeof (handle as { dispose?: unknown }).dispose === 'function') {
    return () => { (handle as { dispose: () => void }).dispose() }
  }
  return undefined
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
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const cwd = process.cwd()
  const roots = resolveRoots(config, cwd)
  const stateDir = resolveStateDir(config, cwd)
  const binary = resolveBinary(config, cwd)
  const logger = ctx.logger('dsh-locator')
  const rt = new LocatorRuntime(config, roots, stateDir, binary, cwd)
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
        maxSessions: config.contentMaxSessions,
      })
    : undefined
  const timer = optionalTimer(ctx)
  let contentStarted = false
  let refreshHandle: (() => void) | undefined

  const armRefresh = (): void => {
    if (content === undefined || config.contentRefreshMs <= 0 || refreshHandle !== undefined) return
    const tick = (): void => { content.refreshNow() }
    if (typeof timer?.interval === 'function') {
      const handle = asDisposer(timer.interval(tick, config.contentRefreshMs))
      if (handle !== undefined) { refreshHandle = handle; return }
    }
    const handle = setInterval(tick, config.contentRefreshMs)
    refreshHandle = () => { clearInterval(handle) }
  }

  /**
   * Start the content half exactly once. Tools and the panel call this on
   * their first content operation so that a profile that never searches
   * bodies pays nothing for the content database.
   */
  const ensureContent = (): void => {
    if (content === undefined || contentStarted) return
    contentStarted = true
    // Surface the lazy start immediately: the first query would otherwise look
    // like a permanent "no results" until the asynchronous boot opens the DB.
    content.markPending()
    void startContent()
  }

  const startContent = async (): Promise<void> => {
    try {
      await rt.waitReady()
      for (let i = 0; i < 900; i++) {
        const status = await rt.engineStatus()
        if (status === undefined || !status.scanning) break
        await new Promise(resolve => setTimeout(resolve, 2_000))
      }
      content!.boot()
      armRefresh()
      logger.info('content index started')
    } catch (error) {
      content!.clearPending()
      logger.info(`content index skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.effect(() => {
    // Let the host finish starting before a cold scan starts reading the disk.
    const start = (): void => {
      rt.start()
      logger.info(`index roots: ${roots.join(', ')} (state ${stateDir})`)
      if (content !== undefined && config.contentLazy === false) ensureContent()
    }
    let disposeBoot: (() => void) | undefined
    if (typeof timer?.timeout === 'function') {
      disposeBoot = asDisposer(timer.timeout(start, 1500))
    }
    if (disposeBoot === undefined) {
      const handle = setTimeout(start, 1500)
      disposeBoot = () => { clearTimeout(handle) }
    }
    return () => {
      disposeBoot?.()
      refreshHandle?.()
      refreshHandle = undefined
      content?.close()
      void rt.stop()
    }
  })

  ctx.tools.register(makeSearchTool(rt))
  ctx.tools.register(makeStatusTool(rt))
  ctx.tools.register(makeRebuildTool(rt))
  ctx.tools.register(makeExportTool(rt))
  if (content !== undefined) {
    ctx.tools.register(makeFindTool(content, ensureContent, roots))
    ctx.tools.register(makeReindexTool(content, ensureContent))
  }

  // The Web GUI panel is optional: profiles without a Web server keep the
  // tools and never mount an HTTP route.
  registerHttp(ctx, rt, content, ensureContent)
}
