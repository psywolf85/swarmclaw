/**
 * Team Resolution Utility
 *
 * Pure functions that resolve an agent's reachable team based on org chart hierarchy.
 * Used by ask_peer, team_context, and team awareness prompt sections.
 */

import type { Agent } from '@/types'

export interface TeamResolution {
  /** Agents sharing the same parentId (excluding self) */
  peers: Agent[]
  /** The parent coordinator agent (for workers) */
  coordinator: Agent | null
  /** Agents whose parentId is this agent (for coordinators) */
  directReports: Agent[]
  /** 'team' = org chart scoped, 'flat' = orphan fallback (no team) */
  mode: 'team' | 'flat'
}

function isLiveAgent(agent: Agent): boolean {
  return !agent.disabled && !agent.trashedAt
}

/**
 * Resolve an agent's team based on org chart hierarchy.
 *
 * Scoping rules:
 * - Workers: peers (same parentId) + coordinator (parentId itself)
 * - Coordinators: direct reports + sibling coordinators (same parentId) + own coordinator
 * - Orphan (no parentId, no children): mode='flat', empty team
 */
export function resolveTeam(agentId: string, agents: Record<string, Agent>): TeamResolution {
  const self = agents[agentId]
  if (!self || !isLiveAgent(self)) {
    return { peers: [], coordinator: null, directReports: [], mode: 'flat' }
  }

  const parentId = self.orgChart?.parentId || null
  const liveAgents = Object.values(agents).filter((a) => a.id !== agentId && isLiveAgent(a))

  // Find direct reports (agents whose parentId is this agent)
  const directReports = liveAgents.filter((a) => a.orgChart?.parentId === agentId)

  // Determine if this agent is an orphan (no parent, no children)
  const isOrphan = !parentId && directReports.length === 0

  if (isOrphan) {
    return { peers: [], coordinator: null, directReports: [], mode: 'flat' }
  }

  // Find coordinator (parent agent)
  const coordinator = parentId ? (agents[parentId] ?? null) : null
  const liveCoordinator = coordinator && isLiveAgent(coordinator) ? coordinator : null

  // Find peers (same parentId, excluding self)
  const peers = parentId
    ? liveAgents.filter((a) => a.orgChart?.parentId === parentId)
    : []

  return {
    peers,
    coordinator: liveCoordinator,
    directReports,
    mode: 'team',
  }
}

/**
 * Resolve the set of agent IDs that the given agent can reach (query or view context for).
 *
 * Workers: peers + coordinator
 * Coordinators: direct reports + sibling coordinators + own coordinator
 * Orphan: empty set (no team)
 */
export function resolveReachableAgentIds(agentId: string, agents: Record<string, Agent>): Set<string> {
  const team = resolveTeam(agentId, agents)

  if (team.mode === 'flat') {
    return new Set<string>()
  }

  const reachable = new Set<string>()

  for (const peer of team.peers) {
    reachable.add(peer.id)
  }
  if (team.coordinator) {
    reachable.add(team.coordinator.id)
  }
  for (const report of team.directReports) {
    reachable.add(report.id)
  }

  return reachable
}
