import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyExactOutputContract,
  classifyExactOutputContract,
  extractExplicitExactLiteral,
  parseExactOutputContractResponse,
} from '@/lib/server/chat-execution/exact-output-contract'

describe('exact-output-contract', () => {
  it('parses an exact literal contract response', () => {
    const parsed = parseExactOutputContractResponse('{"kind":"exact_literal","confidence":0.99,"literal":"FILE_UPDATED"}')
    assert.deepEqual(parsed, {
      kind: 'exact_literal',
      confidence: 0.99,
      literal: 'FILE_UPDATED',
    })
  })

  it('extracts explicit exact literals without calling a model', () => {
    assert.equal(
      extractExplicitExactLiteral('Create the file and reply with exactly FILE_CREATED.'),
      'FILE_CREATED',
    )
    assert.equal(
      extractExplicitExactLiteral('Use live web access and reply with exactly Isle of Man.'),
      'Isle of Man',
    )
    assert.equal(
      extractExplicitExactLiteral('Return exactly `BROWSER_OK_abc123`.'),
      'BROWSER_OK_abc123',
    )
  })

  it('classifies explicit exact literal requests conservatively', async () => {
    const result = await classifyExactOutputContract({
      sessionId: 'session-exact-output',
      userMessage: 'Append the line and reply with exactly FILE_UPDATED.',
      currentResponse: 'FILE_UPDATED\n\nCompletion summary...',
      toolEvents: [],
    })

    assert.deepEqual(result, {
      kind: 'exact_literal',
      confidence: 1,
      literal: 'FILE_UPDATED',
    })
  })

  it('does not force exact output when the literal is not explicitly specified', async () => {
    const result = await classifyExactOutputContract({
      sessionId: 'session-exact-output-none',
      userMessage: 'What is my live gate marker right now? Reply with the exact marker only.',
      currentResponse: 'LIVE_MEM_ALPHA',
      toolEvents: [],
    }, {
      generateText: async () => '{"kind":"none","confidence":0.12}',
    })

    assert.deepEqual(result, {
      kind: 'none',
      confidence: 0.12,
    })
  })

  it('collapses successful tool-heavy replies to the exact literal', () => {
    const text = applyExactOutputContract({
      contract: { kind: 'exact_literal', confidence: 0.99, literal: 'FILE_UPDATED' },
      text: 'FILE_UPDATED\n\nCompletion summary...',
      errorMessage: undefined,
      toolEvents: [
        { name: 'files', input: '{}', output: 'ok' },
      ],
    })

    assert.equal(text, 'FILE_UPDATED')
  })

  it('does not collapse replies when the turn ended in error', () => {
    const text = applyExactOutputContract({
      contract: { kind: 'exact_literal', confidence: 0.99, literal: 'FILE_UPDATED' },
      text: 'Error: write failed',
      errorMessage: 'write failed',
      toolEvents: [
        { name: 'files', input: '{}', output: 'Error: write failed', error: true },
      ],
    })

    assert.equal(text, 'Error: write failed')
  })
})
