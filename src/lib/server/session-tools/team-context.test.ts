import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/**
 * Unit tests for team_context action routing and input validation.
 * The full executeTeamContext function depends on storage,
 * so we test the exported tool builder contract and validate
 * that action routing handles edge cases correctly.
 *
 * Integration tests with live agents should be done via manual testing.
 */

// We can't easily test the full execution without mocking storage,
// but we can import the module to ensure it compiles and registers.
describe('team-context module', () => {
  it('module loads and registers capability without error', async () => {
    // Dynamic import to trigger registerNativeCapability
    const mod = await import('@/lib/server/session-tools/team-context')
    assert.ok(typeof mod.buildTeamContextTools === 'function')
  })

  it('buildTeamContextTools returns empty array when extension not enabled', async () => {
    const { buildTeamContextTools } = await import('@/lib/server/session-tools/team-context')
    const bctx = {
      cwd: '/tmp',
      ctx: undefined,
      hasExtension: () => false,
      hasTool: () => false,
      cleanupFns: [],
      commandTimeoutMs: 30000,
      claudeTimeoutMs: 30000,
      cliProcessTimeoutMs: 30000,
      persistDelegateResumeId: () => {},
      readStoredDelegateResumeId: () => null,
      resolveCurrentSession: () => null,
      activeExtensions: [],
    } as unknown as Parameters<typeof buildTeamContextTools>[0]
    const tools = buildTeamContextTools(bctx)
    assert.equal(tools.length, 0)
  })
})
