import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { _checkRateLimit, _rateLimiter } from '@/lib/server/session-tools/peer-query'

/**
 * Unit tests for peer query rate limiting.
 * The full executePeerQuery function depends on storage, build-llm, etc.
 * so we test the pure rate-limiting logic directly.
 */

describe('peer-query rate limiting', () => {
  afterEach(() => {
    _rateLimiter.clear()
  })

  it('allows queries under the limit', () => {
    const result = _checkRateLimit('session-1')
    assert.equal(result.allowed, true)
    assert.equal(result.warning, null)
    assert.equal(result.count, 1)
  })

  it('counts queries per session', () => {
    for (let i = 0; i < 5; i++) {
      _checkRateLimit('session-1')
    }
    const result = _checkRateLimit('session-1')
    assert.equal(result.allowed, true)
    assert.equal(result.count, 6)
  })

  it('warns when approaching limit', () => {
    for (let i = 0; i < 7; i++) {
      _checkRateLimit('session-1')
    }
    const result = _checkRateLimit('session-1')
    assert.equal(result.allowed, true)
    assert.ok(result.warning)
    assert.ok(result.warning.includes('8/10'))
  })

  it('blocks at the limit', () => {
    for (let i = 0; i < 10; i++) {
      _checkRateLimit('session-1')
    }
    const result = _checkRateLimit('session-1')
    assert.equal(result.allowed, false)
  })

  it('isolates rate limits per session', () => {
    for (let i = 0; i < 10; i++) {
      _checkRateLimit('session-1')
    }
    // Session 2 should still be allowed
    const result = _checkRateLimit('session-2')
    assert.equal(result.allowed, true)
    assert.equal(result.count, 1)
  })

  it('slides the window — old entries expire', () => {
    // Manually set old timestamps
    const oldTime = Date.now() - 11 * 60 * 1000 // 11 minutes ago
    _rateLimiter.set('session-1', { timestamps: Array(10).fill(oldTime) })

    // Old entries should be pruned, allowing new queries
    const result = _checkRateLimit('session-1')
    assert.equal(result.allowed, true)
    assert.equal(result.count, 1) // old ones pruned, only new one remains
  })
})
