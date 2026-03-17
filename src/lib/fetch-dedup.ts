import { hmrSingleton } from '@/lib/shared-utils'

const inflight = hmrSingleton('__swarmclaw_fetch_dedup__', () => new Map<string, Promise<Response>>())

/**
 * Deduplicates concurrent GET requests to the same URL.
 * Non-GET requests pass through without dedup.
 * Each caller receives a cloned Response so bodies can be consumed independently.
 */
export function dedupedFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method !== 'GET') return fetch(url, init)

  const existing = inflight.get(url)
  if (existing) return existing.then((r) => r.clone())

  const promise = fetch(url, init).finally(() => {
    inflight.delete(url)
  })

  inflight.set(url, promise)
  return promise.then((r) => r.clone())
}
