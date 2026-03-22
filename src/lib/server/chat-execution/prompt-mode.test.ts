import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolvePromptMode } from '@/lib/server/chat-execution/prompt-mode'

describe('resolvePromptMode', () => {
  it('returns full for root sessions by default', () => {
    assert.equal(resolvePromptMode({ id: 'root' } as never), 'full')
  })

  it('prefers minimal mode for lightweight direct-chat turns', () => {
    assert.equal(
      resolvePromptMode({ id: 'root' } as never, { preferMinimalPrompt: true }),
      'minimal',
    )
  })

  it('keeps delegated child sessions in minimal mode', () => {
    assert.equal(
      resolvePromptMode({ id: 'child', parentSessionId: 'parent' } as never, { preferMinimalPrompt: false }),
      'minimal',
    )
  })
})
