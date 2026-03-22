import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_AGENT_EXECUTE_CONFIG,
  normalizeAgentExecuteConfig,
} from '@/lib/agent-execute-defaults'

test('normalizeAgentExecuteConfig defaults to sandbox with network enabled', () => {
  const normalized = normalizeAgentExecuteConfig(undefined)

  assert.equal(normalized.backend, 'sandbox')
  assert.equal(normalized.network?.enabled, true)
  assert.equal(normalized.timeout, DEFAULT_AGENT_EXECUTE_CONFIG.timeout)
})

test('normalizeAgentExecuteConfig preserves explicit host backend and clamps timeout', () => {
  const normalized = normalizeAgentExecuteConfig({
    backend: 'host',
    timeout: 999,
  })

  assert.equal(normalized.backend, 'host')
  assert.equal(normalized.timeout, 300)
})
