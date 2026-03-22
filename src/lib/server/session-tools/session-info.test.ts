import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildSessionIdentityPayload } from '@/lib/server/session-tools/session-info'

describe('buildSessionIdentityPayload', () => {
  it('includes harness, project, provider, and delegation context for identity queries', () => {
    const payload = buildSessionIdentityPayload({
      context: { sessionId: 'session-child', agentId: 'agent-1' },
      currentSession: {
        id: 'session-child',
        name: 'Builder Chat',
        cwd: '/workspace/projects/northstar',
        provider: 'openai',
        model: 'gpt-5',
        user: 'system',
        createdAt: 1,
        lastActiveAt: 1,
        claudeSessionId: null,
        parentSessionId: 'session-parent',
        sessionType: 'human',
        agentId: 'agent-1',
        messages: [],
      } as never,
      currentAgent: {
        name: 'Builder',
        delegationTargetMode: 'selected',
        delegationTargetAgentIds: ['qa-1', 'ops-1'],
      } as never,
      activeProjectContext: {
        projectId: 'project-1',
        project: { name: 'Northstar' },
      } as never,
      enabledExtensions: ['files', 'manage_sessions', 'codex_cli'],
      toolPolicy: {
        mode: 'balanced',
        requestedExtensions: ['files', 'manage_sessions', 'codex_cli', 'manage_secrets'],
        enabledExtensions: ['files', 'manage_sessions', 'codex_cli'],
        blockedExtensions: [{ tool: 'manage_secrets', reason: 'blocked by policy', source: 'policy' }],
      },
      rootSessionId: 'session-root',
    })

    assert.equal(payload.promptMode, 'minimal')
    assert.equal(payload.projectId, 'project-1')
    assert.equal(payload.projectName, 'Northstar')
    assert.equal(payload.provider, 'openai')
    assert.equal(payload.model, 'gpt-5')
    assert.equal(payload.rootSessionId, 'session-root')
    assert.deepEqual(payload.enabledExtensions, ['files', 'manage_sessions', 'codex_cli'])
    assert.deepEqual(payload.blockedExtensions, [{ tool: 'manage_secrets', reason: 'blocked by policy', source: 'policy' }])
    assert.equal(payload.delegationEnabled, true)
    assert.equal(payload.delegationTargetMode, 'selected')
    assert.deepEqual(payload.delegationTargetAgentIds, ['qa-1', 'ops-1'])
  })
})
