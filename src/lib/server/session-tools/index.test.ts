import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSessionTools } from './index'

test('session-tools index loads and exposes buildSessionTools', () => {
  assert.equal(typeof buildSessionTools, 'function')
})
