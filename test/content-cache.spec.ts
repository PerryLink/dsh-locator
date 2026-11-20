/**
 * Tests for the content query cache (src/content-cache.ts): TTL, LRU
 * eviction, single-flight de-duplication, rejection handling and close().
 */
import { describe, expect, it } from 'vitest'
import { createSearchCache } from '../src/content-cache.ts'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolveFn, rejectFn) => { resolve = resolveFn; reject = rejectFn })
  return { promise, resolve, reject }
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('createSearchCache', () => {
  it('stores and returns values, and refreshes recency on get', () => {
    const cache = createSearchCache({ size: 2, ttlMs: 60_000 })
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get<number>('a')).toBe(1)
    // 'a' was read, so 'b' is now the least recently used entry.
    cache.set('c', 3)
    expect(cache.get<number>('b')).toBeUndefined()
    expect(cache.get<number>('a')).toBe(1)
    expect(cache.get<number>('c')).toBe(3)
    expect(cache.stats().evictions).toBe(1)
    cache.close()
  })

  it('expires entries after the TTL', async () => {
    const cache = createSearchCache({ size: 4, ttlMs: 20 })
    cache.set('short', 'value')
    expect(cache.get<string>('short')).toBe('value')
    await sleep(45)
    expect(cache.get<string>('short')).toBeUndefined()
    expect(cache.stats().expired).toBe(1)
    cache.close()
  })

  it('treats ttlMs <= 0 as no expiry', async () => {
    const cache = createSearchCache({ size: 4, ttlMs: 0 })
    cache.set('forever', 'value')
    await sleep(15)
    expect(cache.get<string>('forever')).toBe('value')
    cache.close()
  })

  it('shares one in-flight run between concurrent callers and caches the result', async () => {
    const cache = createSearchCache({ size: 4, ttlMs: 60_000 })
    let calls = 0
    let release!: (value: string) => void
    const gate = new Promise<string>(resolve => { release = resolve })
    const fn = (): Promise<string> => { calls++; return gate }
    const first = cache.run('key', fn)
    const second = cache.run('key', fn)
    expect(cache.stats().pending).toBe(1)
    release('shared')
    await expect(Promise.all([first, second])).resolves.toEqual(['shared', 'shared'])
    expect(calls).toBe(1)
    // A later run hits the stored value instead of calling fn again.
    await expect(cache.run('key', fn)).resolves.toBe('shared')
    expect(calls).toBe(1)
    expect(cache.stats().pending).toBe(0)
    cache.close()
  })

  it('does not cache a rejected run and lets every waiter see the rejection', async () => {
    const cache = createSearchCache({ size: 4, ttlMs: 60_000 })
    const first = deferred<string>()
    const firstRun = cache.run('key', () => first.promise)
    const secondRun = cache.run('key', () => first.promise)
    first.reject(new Error('boom'))
    await expect(firstRun).rejects.toThrow('boom')
    await expect(secondRun).rejects.toThrow('boom')
    await expect(cache.run('key', async () => 'recovered')).resolves.toBe('recovered')
    expect(cache.get<string>('key')).toBe('recovered')
    cache.close()
  })

  it('disables storage with size 0 but keeps single-flight', async () => {
    const cache = createSearchCache({ size: 0, ttlMs: 60_000 })
    let calls = 0
    const fn = async (): Promise<number> => { calls++; return calls }
    const [first, second] = await Promise.all([cache.run('key', fn), cache.run('key', fn)])
    expect(first).toBe(1)
    expect(second).toBe(1)
    expect(calls).toBe(1)
    await cache.run('key', fn)
    expect(calls).toBe(2)
    expect(cache.get('key')).toBeUndefined()
    cache.close()
  })

  it('clears entries and stops storing after close()', async () => {
    const cache = createSearchCache({ size: 4, ttlMs: 60_000 })
    cache.set('key', 'value')
    cache.close()
    expect(cache.get('key')).toBeUndefined()
    cache.set('other', 'value')
    expect(cache.get('other')).toBeUndefined()
    await expect(cache.run('third', async () => 'fresh')).resolves.toBe('fresh')
    expect(cache.get('third')).toBeUndefined()
    expect(cache.stats().closed).toBe(true)
  })

  it('reports counters through stats()', async () => {
    const cache = createSearchCache({ size: 2, ttlMs: 60_000 })
    cache.set('hit', 1)
    cache.set('hit2', 2)
    cache.get('hit')
    cache.get('miss')
    cache.set('hit3', 3)
    const stats = cache.stats()
    expect(stats.sizeLimit).toBe(2)
    expect(stats.ttlMs).toBe(60_000)
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(1)
    expect(stats.stores).toBe(3)
    expect(stats.evictions).toBe(1)
    expect(stats.size).toBe(2)
    cache.close()
  })
})