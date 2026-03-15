import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AGENT_REGRESSION_SCENARIOS,
  DEFAULT_AGENT_REGRESSION_SCENARIO_IDS,
  resolveRegressionApprovalSettings,
  resolveRegressionExtensions,
  scoreAssertions,
} from './agent-regression'

import type { RegressionAssertion } from './agent-regression'

// ---------------------------------------------------------------------------
// scoreAssertions
// ---------------------------------------------------------------------------

describe('scoreAssertions', () => {
  it('perfect score with weighted assertions', () => {
    const assertions: RegressionAssertion[] = [
      { name: 'a', passed: true, weight: 1 },
      { name: 'b', passed: true, weight: 2 },
      { name: 'c', passed: true, weight: 3 },
      { name: 'd', passed: true, weight: 4 },
      { name: 'e', passed: true, weight: 5 },
    ]
    const result = scoreAssertions(assertions)
    assert.equal(result.score, 15)
    assert.equal(result.maxScore, 15)
    assert.equal(result.status, 'passed')
  })

  it('single failure tanks status even when most pass', () => {
    const assertions: RegressionAssertion[] = [
      { name: 'a', passed: true, weight: 1 },
      { name: 'b', passed: true, weight: 1 },
      { name: 'c', passed: true, weight: 1 },
      { name: 'd', passed: true, weight: 1 },
      { name: 'e', passed: false, weight: 1 },
    ]
    const result = scoreAssertions(assertions)
    assert.equal(result.score, 4)
    assert.equal(result.maxScore, 5)
    assert.equal(result.status, 'failed')
  })

  it('zero-weight failing assertion does not affect score or status', () => {
    const assertions: RegressionAssertion[] = [
      { name: 'high-value-1', passed: true, weight: 5 },
      { name: 'high-value-2', passed: true, weight: 5 },
      { name: 'cosmetic-check', passed: false, weight: 0 },
    ]
    const result = scoreAssertions(assertions)
    assert.equal(result.score, 10)
    assert.equal(result.maxScore, 10)
    assert.equal(result.status, 'passed')
  })

  it('defaults weight to 1 when not specified', () => {
    const assertions: RegressionAssertion[] = [
      { name: 'explicit', passed: true, weight: 3 },
      { name: 'implicit-1', passed: true },
      { name: 'implicit-2', passed: false },
    ]
    const result = scoreAssertions(assertions)
    // score: 3 (explicit) + 1 (implicit-1) = 4
    // maxScore: 3 + 1 + 1 = 5
    assert.equal(result.score, 4)
    assert.equal(result.maxScore, 5)
    assert.equal(result.status, 'failed')
  })

  it('empty assertions produce score 0/0 with passed status (vacuous truth)', () => {
    const result = scoreAssertions([])
    assert.equal(result.score, 0)
    assert.equal(result.maxScore, 0)
    assert.equal(result.status, 'passed')
  })

  it('all failures yield score 0 with failed status', () => {
    const assertions: RegressionAssertion[] = [
      { name: 'a', passed: false, weight: 2 },
      { name: 'b', passed: false, weight: 3 },
      { name: 'c', passed: false, weight: 5 },
    ]
    const result = scoreAssertions(assertions)
    assert.equal(result.score, 0)
    assert.equal(result.maxScore, 10)
    assert.equal(result.status, 'failed')
  })

  it('handles a large batch of 100 assertions correctly', () => {
    // Deterministic pseudo-random: alternate pass/fail in a pattern
    const assertions: RegressionAssertion[] = []
    let expectedScore = 0
    let expectedMaxScore = 0

    for (let i = 0; i < 100; i++) {
      const weight = (i % 7) + 1 // weights cycle 1..7
      const passed = i % 3 !== 0 // fails on every 3rd (indices 0, 3, 6, ...)
      assertions.push({ name: `assertion-${i}`, passed, weight })
      expectedMaxScore += weight
      if (passed) expectedScore += weight
    }

    const result = scoreAssertions(assertions)
    assert.equal(result.score, expectedScore)
    assert.equal(result.maxScore, expectedMaxScore)
    // At least some fail, so status should be 'failed'
    assert.equal(result.status, expectedScore === expectedMaxScore ? 'passed' : 'failed')
  })

  it('handles negative and fractional weights without clamping', () => {
    // The implementation does weight ?? 1 with no clamping, so negative
    // weights are added as-is. This test documents actual behavior.
    const assertions: RegressionAssertion[] = [
      { name: 'fractional-pass', passed: true, weight: 0.5 },
      { name: 'fractional-fail', passed: false, weight: 0.5 },
      { name: 'negative-pass', passed: true, weight: -1 },
      { name: 'zero-pass', passed: true, weight: 0 },
    ]
    const result = scoreAssertions(assertions)

    // score = 0.5 (fractional-pass) + (-1) (negative-pass) + 0 (zero-pass) = -0.5
    // maxScore = 0.5 + 0.5 + (-1) + 0 = 0
    assert.equal(result.score, -0.5)
    assert.equal(result.maxScore, 0)
    // score !== maxScore → 'failed'
    assert.equal(result.status, 'failed')
  })
})

// ---------------------------------------------------------------------------
// resolveRegressionExtensions
// ---------------------------------------------------------------------------

describe('resolveRegressionExtensions', () => {
  it('scenario mode uses scenario extensions as effective extensions', () => {
    const scenarioExtensions = ['delegate', 'browser', 'email']
    const agent = { tools: ['delegate', 'files', 'web'] }

    const result = resolveRegressionExtensions(scenarioExtensions, agent, 'scenario')

    assert.deepEqual(result.effectiveExtensions, ['delegate', 'browser', 'email'])
    assert.deepEqual(result.missingExtensions, [])
  })

  it('agent mode uses agent extensions and reports missing ones', () => {
    const scenarioExtensions = ['delegate', 'browser', 'email']
    const agent = { tools: ['delegate', 'files', 'web'] }

    const result = resolveRegressionExtensions(scenarioExtensions, agent, 'agent')

    assert.deepEqual(result.effectiveExtensions, ['delegate', 'files', 'web'])
    assert.deepEqual(result.requiredExtensions, ['delegate', 'browser', 'email'])
    // 'delegate' is present (agent has it), 'browser' and 'email' are missing
    assert.ok(result.missingExtensions.includes('browser'))
    assert.ok(result.missingExtensions.includes('email'))
    assert.ok(!result.missingExtensions.includes('delegate'))
  })

  it('reports no missing extensions when agent has all required', () => {
    const scenarioExtensions = ['delegate', 'browser']
    const agent = { tools: ['delegate', 'browser', 'email', 'files'] }

    const result = resolveRegressionExtensions(scenarioExtensions, agent, 'agent')

    assert.deepEqual(result.missingExtensions, [])
    assert.deepEqual(result.effectiveExtensions, ['delegate', 'browser', 'email', 'files'])
  })

  it('handles extension aliases — web_search resolves to canonical web', () => {
    // 'web_search' is an alias for 'web'. When the scenario requires 'web_search',
    // canonicalization maps it to 'web'. If the agent has 'web', it should not
    // appear in missingExtensions because expandExtensionIds expands 'web' to include
    // all aliases.
    const scenarioExtensions = ['web_search']
    const agent = { tools: ['web'] }

    const result = resolveRegressionExtensions(scenarioExtensions, agent, 'agent')
    assert.deepEqual(result.missingExtensions, [])
  })

  it('handles alias in scenario mode — effectiveExtensions preserves original strings', () => {
    const scenarioExtensions = ['web_search', 'claude_code']
    const agent = { tools: [] }

    const result = resolveRegressionExtensions(scenarioExtensions, agent, 'scenario')

    // In scenario mode, effectiveExtensions comes from normalizeExtensionList(requiredExtensions)
    // which preserves original strings
    assert.deepEqual(result.effectiveExtensions, ['web_search', 'claude_code'])
    assert.deepEqual(result.missingExtensions, [])
  })

  it('empty agent extensions — all scenario extensions are missing', () => {
    const scenarioExtensions = ['delegate', 'browser', 'web']
    const agent = { tools: [] }

    const result = resolveRegressionExtensions(scenarioExtensions, agent, 'agent')

    assert.deepEqual(result.effectiveExtensions, [])
    assert.equal(result.missingExtensions.length, 3)
    assert.ok(result.missingExtensions.includes('delegate'))
    assert.ok(result.missingExtensions.includes('browser'))
    assert.ok(result.missingExtensions.includes('web'))
  })

  it('undefined agent extensions — all scenario extensions are missing', () => {
    const scenarioExtensions = ['delegate', 'browser']
    const agent: Record<string, unknown> = {}

    const result = resolveRegressionExtensions(scenarioExtensions, agent, 'agent')

    assert.deepEqual(result.effectiveExtensions, [])
    assert.equal(result.missingExtensions.length, 2)
  })

  it('requiredExtensions are canonicalized in both modes', () => {
    const scenarioExtensions = ['claude_code', 'web_fetch']

    const scenarioResult = resolveRegressionExtensions(scenarioExtensions, {}, 'scenario')
    const agentResult = resolveRegressionExtensions(scenarioExtensions, { tools: [] }, 'agent')

    // 'claude_code' → canonical 'delegate', 'web_fetch' → canonical 'web'
    assert.deepEqual(scenarioResult.requiredExtensions, ['delegate', 'web'])
    assert.deepEqual(agentResult.requiredExtensions, ['delegate', 'web'])
  })
})

// ---------------------------------------------------------------------------
// resolveRegressionApprovalSettings
// ---------------------------------------------------------------------------

describe('resolveRegressionApprovalSettings', () => {
  it('manual mode no longer enables a platform approval queue', () => {
    const settings = resolveRegressionApprovalSettings('manual')
    assert.deepEqual(settings, {})
  })

  it('auto mode no longer injects auto-approve settings', () => {
    const settings = resolveRegressionApprovalSettings('auto')
    assert.deepEqual(settings, {})
  })

  it('off mode is also inert now', () => {
    const settings = resolveRegressionApprovalSettings('off')
    assert.deepEqual(settings, {})
  })
})

// ---------------------------------------------------------------------------
// AGENT_REGRESSION_SCENARIOS registry
// ---------------------------------------------------------------------------

describe('AGENT_REGRESSION_SCENARIOS registry', () => {
  it('contains the expected scenario IDs in order', () => {
    const ids = AGENT_REGRESSION_SCENARIOS.map((s) => s.id)
    assert.deepEqual(ids, [
      'approval-resume',
      'delegate-literal-artifact',
      'schedule-script',
      'open-ended-iteration',
      'mock-signup-secret-email',
      'human-verified-signup',
      'research-build-deploy',
      'blackboard-delegation-fit',
      'tool-call-efficiency',
      'file-creation-followthrough',
      'knowledge-first-file',
    ])
  })

  it('every scenario has all required fields', () => {
    for (const scenario of AGENT_REGRESSION_SCENARIOS) {
      assert.ok(typeof scenario.id === 'string' && scenario.id.length > 0,
        `scenario missing non-empty id`)
      assert.ok(typeof scenario.name === 'string' && scenario.name.length > 0,
        `scenario ${scenario.id} missing non-empty name`)
      assert.ok(Array.isArray(scenario.extensions),
        `scenario ${scenario.id} missing extensions array`)
      assert.ok(typeof scenario.run === 'function',
        `scenario ${scenario.id} missing run function`)
    }
  })

  it('default suite ids exclude exploratory regressions unless explicitly requested', () => {
    assert.ok(!DEFAULT_AGENT_REGRESSION_SCENARIO_IDS.includes('blackboard-delegation-fit'))
    assert.ok(DEFAULT_AGENT_REGRESSION_SCENARIO_IDS.includes('approval-resume'))
    assert.ok(DEFAULT_AGENT_REGRESSION_SCENARIO_IDS.includes('knowledge-first-file'))
  })

  it('no duplicate scenario IDs', () => {
    const ids = AGENT_REGRESSION_SCENARIOS.map((s) => s.id)
    const unique = new Set(ids)
    assert.equal(unique.size, ids.length, 'duplicate scenario IDs detected')
  })

  it('every scenario declares at least an empty extensions array', () => {
    for (const scenario of AGENT_REGRESSION_SCENARIOS) {
      assert.ok(Array.isArray(scenario.extensions),
        `scenario ${scenario.id}: extensions should be an array`)
      // Each extension entry should be a non-empty string
      for (const ext of scenario.extensions) {
        assert.ok(typeof ext === 'string' && ext.trim().length > 0,
          `scenario ${scenario.id}: extension entries must be non-empty strings`)
      }
    }
  })
})
