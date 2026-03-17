import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { dedupedFetch } from './fetch-dedup'

// We test against real fetch using a data: URL to avoid network.
// For dedup testing we track call counts with a simple wrapper.

describe('dedupedFetch', () => {
  // Use globalThis.__fetchCallCount to track calls
  let realFetch: typeof globalThis.fetch
  let callCount: number

  afterEach(() => {
    if (realFetch) globalThis.fetch = realFetch
  })

  function mockFetch(delay = 10) {
    callCount = 0
    realFetch = globalThis.fetch
    globalThis.fetch = (() => {
      callCount++
      return new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response('ok', { status: 200 })), delay)
      })
    }) as unknown as typeof fetch
  }

  it('GET request: deduplicates concurrent identical URLs and both bodies are consumable', async () => {
    mockFetch(50)
    const p1 = dedupedFetch('http://test/a')
    const p2 = dedupedFetch('http://test/a')
    // Cloned responses are different promise references
    const [r1, r2] = await Promise.all([p1, p2])
    // Both callers can independently consume the body
    assert.equal(await r1.text(), 'ok')
    assert.equal(await r2.text(), 'ok')
    // Only one actual fetch was made
    assert.equal(callCount, 1)
  })

  it('GET request: separate promises for different URLs', async () => {
    mockFetch(10)
    const p1 = dedupedFetch('http://test/x')
    const p2 = dedupedFetch('http://test/y')
    assert.notEqual(p1, p2)
    await Promise.all([p1, p2])
    assert.equal(callCount, 2)
  })

  it('GET request: cleanup after resolve allows new request', async () => {
    mockFetch(5)
    await dedupedFetch('http://test/cleanup')
    assert.equal(callCount, 1)
    // After resolve, a new call should trigger a new fetch
    await dedupedFetch('http://test/cleanup')
    assert.equal(callCount, 2)
  })

  it('GET request: cleanup after rejection', async () => {
    callCount = 0
    realFetch = globalThis.fetch
    globalThis.fetch = (() => {
      callCount++
      return Promise.reject(new Error('network'))
    }) as unknown as typeof fetch
    try {
      await dedupedFetch('http://test/fail')
    } catch {
      // expected
    }
    assert.equal(callCount, 1)
    // Should be cleaned up — a new call triggers new fetch
    try {
      await dedupedFetch('http://test/fail')
    } catch {
      // expected
    }
    assert.equal(callCount, 2)
  })

  it('POST request: passes through without dedup', async () => {
    mockFetch(10)
    const p1 = dedupedFetch('http://test/post', { method: 'POST' })
    const p2 = dedupedFetch('http://test/post', { method: 'POST' })
    // Both should be separate fetches
    assert.notEqual(p1, p2)
    await Promise.all([p1, p2])
    assert.equal(callCount, 2)
  })

  it('explicit method override: POST skips dedup', async () => {
    mockFetch(10)
    const p1 = dedupedFetch('http://test/method', { method: 'POST' })
    const p2 = dedupedFetch('http://test/method', { method: 'POST' })
    assert.notEqual(p1, p2)
    await Promise.all([p1, p2])
    assert.equal(callCount, 2)
  })
})
