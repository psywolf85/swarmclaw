import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ALL_TOOLS } from '@/lib/tool-definitions'
import { getDefaultAgentToolIds, resolveAgentToolSelection } from './agent-default-tools'

describe('agent default tools', () => {
  it('enables every known tool by default', () => {
    const allToolIds = Array.from(new Set(ALL_TOOLS.map((tool) => tool.id)))
    const defaults = getDefaultAgentToolIds()

    assert.ok(defaults.length > 0)
    assert.deepEqual(defaults, Array.from(new Set(defaults)))
    assert.deepEqual(defaults, allToolIds)
  })

  it('uses the shared defaults when a request never chose tools', () => {
    const result = resolveAgentToolSelection({
      hasExplicitExtensions: false,
      hasExplicitTools: false,
      extensions: [],
      tools: undefined,
    })
    assert.deepEqual(result.tools, getDefaultAgentToolIds())
  })

  it('preserves an explicit empty extensions selection', () => {
    const result = resolveAgentToolSelection({
      hasExplicitExtensions: true,
      hasExplicitTools: false,
      extensions: [],
      tools: ['web'],
    })
    assert.deepEqual(result.extensions, [])
  })

  it('accepts explicit legacy tools selections', () => {
    const result = resolveAgentToolSelection({
      hasExplicitExtensions: false,
      hasExplicitTools: true,
      extensions: [],
      tools: ['web', 'browser'],
    })
    assert.deepEqual(result.tools, ['web', 'browser'])
  })
})
