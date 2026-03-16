import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyProviderError } from './error-classification'

describe('classifyProviderError', () => {
  it('classifies 429 as rate_limit', () => {
    const err = Object.assign(new Error('Too Many Requests'), { status: 429 })
    assert.equal(classifyProviderError(err).reason, 'rate_limit')
    assert.equal(classifyProviderError(err).retryable, true)
  })
  it('classifies 401 as auth (retriable)', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 })
    assert.equal(classifyProviderError(err).reason, 'auth')
    assert.equal(classifyProviderError(err).shouldRotateCredential, true)
  })
  it('classifies 403 as auth_permanent (not retriable)', () => {
    const err = Object.assign(new Error('Forbidden'), { status: 403 })
    assert.equal(classifyProviderError(err).reason, 'auth_permanent')
    assert.equal(classifyProviderError(err).retryable, false)
  })
  it('classifies ECONNRESET as timeout', () => {
    assert.equal(classifyProviderError(new Error('ECONNRESET')).reason, 'timeout')
  })
  it('classifies 500 as overloaded', () => {
    const err = Object.assign(new Error('Internal Server Error'), { status: 500 })
    assert.equal(classifyProviderError(err).reason, 'overloaded')
  })
  it('extracts Retry-After header', () => {
    const err = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after': '5' },
    })
    assert.equal(classifyProviderError(err).suggestedBackoffMs, 5000)
  })
})
