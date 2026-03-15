import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { shouldShowDateSeparator } from './message-list-utils'

describe('shouldShowDateSeparator', () => {
  it('treats epoch 0 as invalid — no separator for synthetic streaming messages', () => {
    assert.equal(shouldShowDateSeparator(0, undefined), false)
    assert.equal(shouldShowDateSeparator(0, Date.now()), false)
    assert.equal(typeof shouldShowDateSeparator(0, undefined), 'boolean')
  })

  it('treats previous epoch 0 as no-previous — shows separator if current is valid', () => {
    const now = Date.now()
    assert.equal(shouldShowDateSeparator(now, 0), true)
  })

  it('returns false for missing timestamps', () => {
    assert.equal(shouldShowDateSeparator(undefined, undefined), false)
    assert.equal(shouldShowDateSeparator(Number.NaN, undefined), false)
  })

  it('compares message days when both timestamps exist', () => {
    const today = new Date('2026-03-15T10:00:00.000Z').getTime()
    const sameDay = new Date('2026-03-15T22:00:00.000Z').getTime()
    const nextDay = new Date('2026-03-16T00:10:00.000Z').getTime()

    assert.equal(shouldShowDateSeparator(today, sameDay), false)
    assert.equal(shouldShowDateSeparator(nextDay, sameDay), true)
  })
})
