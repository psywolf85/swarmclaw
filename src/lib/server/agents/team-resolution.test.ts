import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveTeam, resolveReachableAgentIds } from '@/lib/server/agents/team-resolution'
import type { Agent } from '@/types'

function fakeAgent(id: string, overrides?: Partial<Agent>): Agent {
  return {
    id,
    name: `Agent ${id}`,
    description: `Description for ${id}`,
    provider: 'openai',
    model: 'gpt-4o',
    ...overrides,
  } as Agent
}

function agentMap(...agents: Agent[]): Record<string, Agent> {
  const map: Record<string, Agent> = {}
  for (const a of agents) map[a.id] = a
  return map
}

describe('resolveTeam', () => {
  it('returns flat mode for orphan agent with no parent and no children', () => {
    const orphan = fakeAgent('orphan')
    const other = fakeAgent('other')
    const agents = agentMap(orphan, other)
    const result = resolveTeam('orphan', agents)
    assert.equal(result.mode, 'flat')
    assert.equal(result.peers.length, 0)
    assert.equal(result.coordinator, null)
    assert.equal(result.directReports.length, 0)
  })

  it('resolves worker peers and coordinator', () => {
    const coordinator = fakeAgent('coord', { role: 'coordinator' })
    const workerA = fakeAgent('workerA', { orgChart: { parentId: 'coord' } })
    const workerB = fakeAgent('workerB', { orgChart: { parentId: 'coord' } })
    const workerC = fakeAgent('workerC', { orgChart: { parentId: 'coord' } })
    const agents = agentMap(coordinator, workerA, workerB, workerC)

    const result = resolveTeam('workerA', agents)
    assert.equal(result.mode, 'team')
    assert.equal(result.coordinator?.id, 'coord')
    assert.deepEqual(
      result.peers.map((p) => p.id).sort(),
      ['workerB', 'workerC'],
    )
    assert.equal(result.directReports.length, 0)
  })

  it('resolves coordinator with direct reports and sibling coordinators', () => {
    const topCoord = fakeAgent('top', { role: 'coordinator' })
    const coordA = fakeAgent('coordA', { role: 'coordinator', orgChart: { parentId: 'top' } })
    const coordB = fakeAgent('coordB', { role: 'coordinator', orgChart: { parentId: 'top' } })
    const workerA1 = fakeAgent('workerA1', { orgChart: { parentId: 'coordA' } })
    const workerA2 = fakeAgent('workerA2', { orgChart: { parentId: 'coordA' } })
    const agents = agentMap(topCoord, coordA, coordB, workerA1, workerA2)

    const result = resolveTeam('coordA', agents)
    assert.equal(result.mode, 'team')
    assert.equal(result.coordinator?.id, 'top')
    assert.deepEqual(
      result.peers.map((p) => p.id).sort(),
      ['coordB'],
    )
    assert.deepEqual(
      result.directReports.map((r) => r.id).sort(),
      ['workerA1', 'workerA2'],
    )
  })

  it('excludes disabled and trashed agents', () => {
    const coord = fakeAgent('coord', { role: 'coordinator' })
    const workerA = fakeAgent('workerA', { orgChart: { parentId: 'coord' } })
    const workerB = fakeAgent('workerB', { orgChart: { parentId: 'coord' }, disabled: true })
    const workerC = fakeAgent('workerC', { orgChart: { parentId: 'coord' }, trashedAt: Date.now() })
    const agents = agentMap(coord, workerA, workerB, workerC)

    const result = resolveTeam('workerA', agents)
    assert.equal(result.peers.length, 0) // B disabled, C trashed
    assert.equal(result.coordinator?.id, 'coord')
  })

  it('returns flat mode if self agent does not exist', () => {
    const agents = agentMap(fakeAgent('other'))
    const result = resolveTeam('nonexistent', agents)
    assert.equal(result.mode, 'flat')
  })

  it('returns flat mode if self agent is disabled', () => {
    const disabled = fakeAgent('disabled', { disabled: true })
    const agents = agentMap(disabled)
    const result = resolveTeam('disabled', agents)
    assert.equal(result.mode, 'flat')
  })

  it('coordinator with no parent still has team mode if they have reports', () => {
    const coord = fakeAgent('coord', { role: 'coordinator' })
    const worker = fakeAgent('worker', { orgChart: { parentId: 'coord' } })
    const agents = agentMap(coord, worker)

    const result = resolveTeam('coord', agents)
    assert.equal(result.mode, 'team')
    assert.equal(result.coordinator, null) // top-level, no parent
    assert.equal(result.directReports.length, 1)
    assert.equal(result.directReports[0].id, 'worker')
  })

  it('returns null coordinator when parentId references missing agent', () => {
    const worker = fakeAgent('worker', { orgChart: { parentId: 'ghost' } })
    const agents = agentMap(worker)

    const result = resolveTeam('worker', agents)
    assert.equal(result.mode, 'team') // has parentId, not orphan
    assert.equal(result.coordinator, null) // ghost doesn't exist
  })
})

describe('resolveReachableAgentIds', () => {
  it('worker can reach peers and coordinator', () => {
    const coord = fakeAgent('coord', { role: 'coordinator' })
    const workerA = fakeAgent('workerA', { orgChart: { parentId: 'coord' } })
    const workerB = fakeAgent('workerB', { orgChart: { parentId: 'coord' } })
    const agents = agentMap(coord, workerA, workerB)

    const reachable = resolveReachableAgentIds('workerA', agents)
    assert.ok(reachable.has('workerB'))
    assert.ok(reachable.has('coord'))
    assert.ok(!reachable.has('workerA')) // not self
  })

  it('cross-team agents are not reachable', () => {
    const coordA = fakeAgent('coordA', { role: 'coordinator' })
    const coordB = fakeAgent('coordB', { role: 'coordinator' })
    const workerA = fakeAgent('workerA', { orgChart: { parentId: 'coordA' } })
    const workerB = fakeAgent('workerB', { orgChart: { parentId: 'coordB' } })
    const agents = agentMap(coordA, coordB, workerA, workerB)

    const reachable = resolveReachableAgentIds('workerA', agents)
    assert.ok(reachable.has('coordA'))
    assert.ok(!reachable.has('workerB')) // different team
    assert.ok(!reachable.has('coordB'))
  })

  it('coordinator can reach direct reports, sibling coordinators, and own coordinator', () => {
    const top = fakeAgent('top', { role: 'coordinator' })
    const coordA = fakeAgent('coordA', { role: 'coordinator', orgChart: { parentId: 'top' } })
    const coordB = fakeAgent('coordB', { role: 'coordinator', orgChart: { parentId: 'top' } })
    const workerA1 = fakeAgent('workerA1', { orgChart: { parentId: 'coordA' } })
    const agents = agentMap(top, coordA, coordB, workerA1)

    const reachable = resolveReachableAgentIds('coordA', agents)
    assert.ok(reachable.has('workerA1'))  // direct report
    assert.ok(reachable.has('coordB'))    // sibling coordinator
    assert.ok(reachable.has('top'))       // own coordinator
    assert.ok(!reachable.has('coordA'))   // not self
  })

  it('orphan agent has empty reachable set', () => {
    const orphan = fakeAgent('orphan')
    const other = fakeAgent('other')
    const agents = agentMap(orphan, other)

    const reachable = resolveReachableAgentIds('orphan', agents)
    assert.equal(reachable.size, 0)
  })
})
