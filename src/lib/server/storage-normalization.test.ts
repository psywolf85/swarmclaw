import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

let normalizeStoredRecord: typeof import('@/lib/server/storage-normalization').normalizeStoredRecord

const noopLoader = () => null

before(async () => {
  process.env.SWARMCLAW_BUILD_MODE = '1'
  const mod = await import('@/lib/server/storage-normalization')
  normalizeStoredRecord = mod.normalizeStoredRecord
})

after(() => {
  delete process.env.SWARMCLAW_BUILD_MODE
})

describe('storage-normalization', () => {
  // ---- Agent normalization ----
  describe('agents', () => {
    it('adds default capabilities, delegation, role, orgChart fields', () => {
      const agent = { id: 'a1', name: 'Test' } as Record<string, unknown>
      const result = normalizeStoredRecord('agents', agent, noopLoader).value as Record<string, unknown>
      assert.deepEqual(result.capabilities, [])
      assert.equal(result.role, 'worker')
      assert.equal(result.delegationEnabled, false)
      assert.equal(result.orgChart, null)
      assert.ok(Array.isArray(result.tools))
      assert.ok(Array.isArray(result.extensions))
    })

    it('preserves existing values', () => {
      const agent = {
        id: 'a1',
        name: 'Test',
        capabilities: ['web', 'code'],
        role: 'coordinator',
        delegationEnabled: true,
        delegationTargetMode: 'all',
        delegationTargetAgentIds: [],
        orgChart: { parentId: 'p1', teamLabel: 'Eng', teamColor: '#fff', x: 10, y: 20 },
      } as Record<string, unknown>
      const result = normalizeStoredRecord('agents', agent, noopLoader).value as Record<string, unknown>
      assert.deepEqual(result.capabilities, ['web', 'code'])
      assert.equal(result.role, 'coordinator')
      assert.equal(result.delegationEnabled, true)
    })

    it('coordinator always has delegation enabled', () => {
      const agent = { id: 'a1', name: 'Test', role: 'coordinator', delegationEnabled: false } as Record<string, unknown>
      const result = normalizeStoredRecord('agents', agent, noopLoader).value as Record<string, unknown>
      assert.equal(result.delegationEnabled, true)
    })

    it('migrates legacy platformAssignScope', () => {
      const agent = { id: 'a1', name: 'Test', platformAssignScope: 'all' } as Record<string, unknown>
      const result = normalizeStoredRecord('agents', agent, noopLoader).value as Record<string, unknown>
      assert.equal(result.delegationEnabled, true)
      assert.equal(result.platformAssignScope, undefined)
    })

    it('migrates legacy subAgentIds to delegationTargetAgentIds', () => {
      const agent = { id: 'a1', name: 'Test', subAgentIds: ['b1', 'b2'] } as Record<string, unknown>
      const result = normalizeStoredRecord('agents', agent, noopLoader).value as Record<string, unknown>
      assert.deepEqual(result.delegationTargetAgentIds, ['b1', 'b2'])
      assert.equal(result.delegationTargetMode, 'selected')
      assert.equal(result.subAgentIds, undefined)
    })

    it('deletes legacy plugins field', () => {
      const agent = { id: 'a1', name: 'Test', plugins: ['old'] } as Record<string, unknown>
      const result = normalizeStoredRecord('agents', agent, noopLoader).value as Record<string, unknown>
      assert.equal(result.plugins, undefined)
    })
  })

  // ---- Session normalization ----
  describe('sessions', () => {
    it('type migration orchestrated → delegated', () => {
      const session = { id: 's1', sessionType: 'orchestrated' } as Record<string, unknown>
      const result = normalizeStoredRecord('sessions', session, noopLoader).value as Record<string, unknown>
      assert.equal(result.sessionType, 'delegated')
    })

    it('defaults invalid sessionType to human', () => {
      const session = { id: 's1', sessionType: 'bogus' } as Record<string, unknown>
      const result = normalizeStoredRecord('sessions', session, noopLoader).value as Record<string, unknown>
      assert.equal(result.sessionType, 'human')
    })

    it('detects shortcut session from id prefix', () => {
      const session = { id: 'agent-thread-abc', agentId: 'a1', sessionType: 'human' } as Record<string, unknown>
      const result = normalizeStoredRecord('sessions', session, noopLoader).value as Record<string, unknown>
      assert.equal(result.shortcutForAgentId, 'a1')
    })

    it('normalizes capabilities', () => {
      const session = { id: 's1', sessionType: 'human', tools: ['web'] } as Record<string, unknown>
      const result = normalizeStoredRecord('sessions', session, noopLoader).value as Record<string, unknown>
      assert.ok(Array.isArray(result.tools))
      assert.ok(Array.isArray(result.extensions))
    })

    it('deletes legacy plugins and mainLoopState', () => {
      const session = { id: 's1', sessionType: 'human', plugins: ['old'], mainLoopState: {} } as Record<string, unknown>
      const result = normalizeStoredRecord('sessions', session, noopLoader).value as Record<string, unknown>
      assert.equal(result.plugins, undefined)
      assert.equal(result.mainLoopState, undefined)
    })
  })

  // ---- Schedule normalization ----
  describe('schedules', () => {
    it('type resolution from scheduleType', () => {
      const schedule = { id: 'sch1', scheduleType: 'cron', status: 'active' } as Record<string, unknown>
      const result = normalizeStoredRecord('schedules', schedule, noopLoader).value as Record<string, unknown>
      assert.equal(result.scheduleType, 'cron')
    })

    it('legacy type field migrated', () => {
      const schedule = { id: 'sch1', type: 'once', status: 'active' } as Record<string, unknown>
      const result = normalizeStoredRecord('schedules', schedule, noopLoader).value as Record<string, unknown>
      assert.equal(result.scheduleType, 'once')
      assert.equal(result.type, undefined)
    })

    it('invalid status defaults to active', () => {
      const schedule = { id: 'sch1', status: 'bogus' } as Record<string, unknown>
      const result = normalizeStoredRecord('schedules', schedule, noopLoader).value as Record<string, unknown>
      assert.equal(result.status, 'active')
    })

    it('timestamp parsing from number', () => {
      const schedule = { id: 'sch1', status: 'active', lastRunAt: 1700000000000 } as Record<string, unknown>
      const result = normalizeStoredRecord('schedules', schedule, noopLoader).value as Record<string, unknown>
      assert.equal(result.lastRunAt, 1700000000000)
    })
  })

  // ---- Task normalization ----
  describe('tasks', () => {
    it('subtaskIds default to empty array', () => {
      const task = { id: 't1', title: 'Test' } as Record<string, unknown>
      const result = normalizeStoredRecord('tasks', task, noopLoader).value as Record<string, unknown>
      assert.deepEqual(result.subtaskIds, [])
    })

    it('preserves existing subtaskIds', () => {
      const task = { id: 't1', title: 'Test', subtaskIds: ['t2'] } as Record<string, unknown>
      const result = normalizeStoredRecord('tasks', task, noopLoader).value as Record<string, unknown>
      assert.deepEqual(result.subtaskIds, ['t2'])
    })

    it('removes missionSummary field', () => {
      const task = { id: 't1', missionSummary: 'old' } as Record<string, unknown>
      const result = normalizeStoredRecord('tasks', task, noopLoader).value as Record<string, unknown>
      assert.equal(result.missionSummary, undefined)
    })
  })

  describe('provider_configs', () => {
    it('defaults legacy custom provider configs to enabled with normalized fields', () => {
      const providerConfig = {
        id: 'custom-llama',
        name: '  Llama.cpp  ',
        type: 'custom',
        baseUrl: ' http://localhost:8080/v1/ ',
        models: [' llama-3.1-70b ', 'llama-3.1-70b', ''],
      } as Record<string, unknown>
      const result = normalizeStoredRecord('provider_configs', providerConfig, noopLoader).value as Record<string, unknown>
      assert.equal(result.name, 'Llama.cpp')
      assert.equal(result.baseUrl, 'http://localhost:8080/v1/')
      assert.deepEqual(result.models, ['llama-3.1-70b'])
      assert.equal(result.requiresApiKey, true)
      assert.equal(result.isEnabled, true)
      assert.equal(result.credentialId, null)
    })

    it('normalizes builtin override configs without treating them as custom providers', () => {
      const providerConfig = {
        id: 'openai',
        type: 'builtin',
        isEnabled: false,
      } as Record<string, unknown>
      const result = normalizeStoredRecord('provider_configs', providerConfig, noopLoader).value as Record<string, unknown>
      assert.equal(result.type, 'builtin')
      assert.equal(result.name, 'Built-in Provider')
      assert.equal(result.baseUrl, '')
      assert.deepEqual(result.models, [])
      assert.equal(result.requiresApiKey, true)
      assert.equal(result.isEnabled, false)
      assert.equal(result.credentialId, null)
    })

    it('defaults createdAt and updatedAt for legacy records missing timestamps', () => {
      const providerConfig = {
        id: 'custom-old',
        name: 'Old Provider',
        type: 'custom',
        baseUrl: 'http://localhost:8080/v1',
        models: ['model-a'],
      } as Record<string, unknown>
      const result = normalizeStoredRecord('provider_configs', providerConfig, noopLoader).value as Record<string, unknown>
      assert.equal(typeof result.createdAt, 'number')
      assert.equal(typeof result.updatedAt, 'number')
      assert.ok((result.createdAt as number) > 0)
      assert.equal(result.updatedAt, result.createdAt)
    })
  })

  // ---- Mission normalization ----
  describe('missions', () => {
    it('defaults status/phase/sourceRef', () => {
      const mission = { id: 'm1' } as Record<string, unknown>
      const result = normalizeStoredRecord('missions', mission, noopLoader).value as Record<string, unknown>
      assert.equal(result.status, 'active')
      assert.equal(result.phase, 'planning')
      assert.deepEqual(result.sourceRef, { kind: 'manual' })
    })

    it('preserves valid status and phase', () => {
      const mission = { id: 'm1', status: 'waiting', phase: 'executing' } as Record<string, unknown>
      const result = normalizeStoredRecord('missions', mission, noopLoader).value as Record<string, unknown>
      assert.equal(result.status, 'waiting')
      assert.equal(result.phase, 'executing')
    })

    it('sourceRef from sessionId', () => {
      const mission = { id: 'm1', sessionId: 'sess-1' } as Record<string, unknown>
      const result = normalizeStoredRecord('missions', mission, noopLoader).value as Record<string, unknown>
      assert.deepEqual(result.sourceRef, { kind: 'chat', sessionId: 'sess-1' })
    })

    it('waitState defaults', () => {
      const mission = {
        id: 'm1',
        waitState: { kind: 'approval', reason: 'Needs sign-off' },
      } as Record<string, unknown>
      const result = normalizeStoredRecord('missions', mission, noopLoader).value as Record<string, unknown>
      const ws = result.waitState as Record<string, unknown>
      assert.equal(ws.kind, 'approval')
      assert.equal(ws.reason, 'Needs sign-off')
    })
  })

  // ---- DelegationJob normalization ----
  describe('delegation_jobs', () => {
    it('missionId cleanup', () => {
      const job = { id: 'j1', missionId: '  m1  ' } as Record<string, unknown>
      const result = normalizeStoredRecord('delegation_jobs', job, noopLoader).value as Record<string, unknown>
      assert.equal(result.missionId, 'm1')
    })

    it('empty missionId is deleted', () => {
      const job = { id: 'j1', missionId: '  ' } as Record<string, unknown>
      const result = normalizeStoredRecord('delegation_jobs', job, noopLoader).value as Record<string, unknown>
      assert.equal(result.missionId, undefined)
    })
  })

  // ---- Unknown collection ----
  describe('unknown collection', () => {
    it('passes through unchanged', () => {
      const data = { id: 'x1', foo: 'bar' }
      const result = normalizeStoredRecord('widgets', data, noopLoader)
      assert.deepEqual(result.value, data)
      assert.equal(result.changed, false)
    })
  })
})
