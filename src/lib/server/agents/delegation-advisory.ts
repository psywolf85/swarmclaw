import type { Agent } from '@/types'
import type { MessageClassification } from '@/lib/server/chat-execution/message-classifier'
import { capabilityMatchScore } from '@/lib/server/agents/capability-match'
import { getAgentDirectory, type AgentDirectoryEntry } from '@/lib/server/agents/agent-registry'

export type DelegationWorkType =
  | 'coding'
  | 'research'
  | 'writing'
  | 'review'
  | 'operations'
  | 'general'

export interface DelegationTaskProfile {
  workType: DelegationWorkType
  requiredCapabilities: string[]
  substantial: boolean
}

export interface DelegationCandidateFit {
  agentId: string
  agentName: string
  score: number
  availability: 'idle' | 'working' | 'unknown'
  matchedCapabilities: string[]
  reasons: string[]
}

export interface DelegationAdvisory {
  profile: DelegationTaskProfile
  current: DelegationCandidateFit | null
  recommended: DelegationCandidateFit | null
  shouldDelegate: boolean
  style: 'managerial' | 'advisory'
}

const WORK_TYPE_CAPABILITIES: Record<DelegationWorkType, string[]> = {
  coding: ['coding', 'implementation', 'debugging'],
  research: ['research', 'analysis', 'summarization'],
  writing: ['writing', 'messaging', 'structuring', 'editing'],
  review: ['review', 'testing', 'risk assessment'],
  operations: ['coordination', 'delegation', 'operations'],
  general: [],
}

function normalizeCapabilityList(value: string[] | undefined | null): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    const trimmed = typeof entry === 'string' ? entry.trim() : ''
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

function normalizeWorkType(value: unknown): DelegationWorkType {
  if (
    value === 'coding'
    || value === 'research'
    || value === 'writing'
    || value === 'review'
    || value === 'operations'
  ) {
    return value
  }
  return 'general'
}

function matchedCapabilities(agentCapabilities: string[] | undefined, requiredCapabilities: string[]): string[] {
  if (!requiredCapabilities.length || !Array.isArray(agentCapabilities) || !agentCapabilities.length) return []
  const agentSet = new Set(agentCapabilities.map((entry) => entry.toLowerCase()))
  return requiredCapabilities.filter((entry) => agentSet.has(entry.toLowerCase()))
}

function roleAdjustment(agent: Agent, profile: DelegationTaskProfile): number {
  const role = agent.role === 'coordinator' ? 'coordinator' : 'worker'
  if (profile.workType === 'operations') {
    return role === 'coordinator' ? 0.28 : -0.04
  }
  if (profile.workType === 'general') {
    return role === 'coordinator' ? -0.03 : 0
  }
  return role === 'coordinator' ? -0.18 : 0.16
}

function selfExecutionPenalty(agent: Agent, profile: DelegationTaskProfile, isSelf: boolean): number {
  if (!isSelf) return 0
  if (agent.role !== 'coordinator') return 0
  if (!profile.substantial) return 0
  if (profile.workType === 'operations') return 0
  return -0.42
}

function availabilityAdjustment(
  availability: DelegationCandidateFit['availability'],
  isSelf: boolean,
  directoryEntry?: AgentDirectoryEntry,
): number {
  if (availability === 'idle') return 0.08
  if (availability === 'working') {
    // The current live chat session should not count as a self-load penalty.
    if (isSelf && !directoryEntry?.statusDetail) return 0.08
    return -0.08
  }
  return 0
}

function buildAvailabilityMap(): Map<string, AgentDirectoryEntry> {
  return new Map(getAgentDirectory().map((entry) => [entry.id, entry]))
}

function buildCandidateFit(
  agent: Agent,
  profile: DelegationTaskProfile,
  directory: Map<string, AgentDirectoryEntry>,
  isSelf = false,
): DelegationCandidateFit {
  const directoryEntry = directory.get(agent.id)
  const availability = directoryEntry?.status || 'unknown'
  const matched = matchedCapabilities(agent.capabilities, profile.requiredCapabilities)
  const capabilityScore = profile.requiredCapabilities.length > 0
    ? capabilityMatchScore(agent.capabilities, profile.requiredCapabilities) * 1.45
    : 0
  const score = capabilityScore
    + roleAdjustment(agent, profile)
    + availabilityAdjustment(availability, isSelf, directoryEntry)
    + selfExecutionPenalty(agent, profile, isSelf)

  const reasons: string[] = []
  if (matched.length > 0) reasons.push(`capability match: ${matched.join(', ')}`)
  if (profile.workType === 'operations' && agent.role === 'coordinator') reasons.push('coordinator role fits operations work')
  if (profile.workType !== 'operations' && profile.workType !== 'general' && agent.role !== 'coordinator') reasons.push('worker role fits execution-heavy work')
  if (availability === 'idle') reasons.push('currently idle')
  if (availability === 'working' && directoryEntry?.statusDetail) reasons.push(directoryEntry.statusDetail)
  if (isSelf && selfExecutionPenalty(agent, profile, true) < 0) reasons.push('coordinator should prefer orchestration over direct execution')

  return {
    agentId: agent.id,
    agentName: agent.name,
    score,
    availability,
    matchedCapabilities: matched,
    reasons,
  }
}

function isAllowedDelegateTarget(
  agentId: string,
  opts?: { delegationTargetMode?: 'all' | 'selected'; delegationTargetAgentIds?: string[] },
): boolean {
  if (opts?.delegationTargetMode !== 'selected') return true
  const allowed = new Set(normalizeCapabilityList(opts.delegationTargetAgentIds))
  return allowed.size === 0 || allowed.has(agentId)
}

export function resolveDelegationWorkType(
  classification: MessageClassification | null | undefined,
): DelegationWorkType {
  return normalizeWorkType(classification?.workType)
}

export function buildDelegationTaskProfile(params: {
  classification?: MessageClassification | null
  workType?: DelegationWorkType | null
  requiredCapabilities?: string[] | null
}): DelegationTaskProfile {
  const workType = params.workType
    ? normalizeWorkType(params.workType)
    : resolveDelegationWorkType(params.classification)
  const explicitRequirements = normalizeCapabilityList(params.requiredCapabilities)
  const requiredCapabilities = explicitRequirements.length > 0
    ? explicitRequirements
    : WORK_TYPE_CAPABILITIES[workType]
  const substantial = explicitRequirements.length > 0
    || Boolean(params.classification?.isBroadGoal)
    || Boolean(params.classification?.isDeliverableTask)
    || Boolean(params.classification?.isResearchSynthesis)
    || workType !== 'general'
  return {
    workType,
    requiredCapabilities,
    substantial,
  }
}

export function resolveBestDelegateTarget(params: {
  currentAgentId?: string | null
  agents: Record<string, Agent>
  profile: DelegationTaskProfile
  delegationTargetMode?: 'all' | 'selected'
  delegationTargetAgentIds?: string[]
}): DelegationCandidateFit | null {
  const directory = buildAvailabilityMap()
  const candidates = Object.values(params.agents)
    .filter((agent) => agent.id !== params.currentAgentId)
    .filter((agent) => !agent.disabled && !agent.trashedAt)
    .filter((agent) => isAllowedDelegateTarget(agent.id, params))
    .map((agent) => buildCandidateFit(agent, params.profile, directory))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return left.agentName.localeCompare(right.agentName)
    })
  return candidates[0] || null
}

export function resolveDelegationAdvisory(params: {
  currentAgent: Agent | null | undefined
  agents: Record<string, Agent>
  profile: DelegationTaskProfile
  delegationTargetMode?: 'all' | 'selected'
  delegationTargetAgentIds?: string[]
}): DelegationAdvisory {
  const directory = buildAvailabilityMap()
  const current = params.currentAgent && !params.currentAgent.disabled && !params.currentAgent.trashedAt
    ? buildCandidateFit(params.currentAgent, params.profile, directory, true)
    : null
  const recommended = resolveBestDelegateTarget({
    currentAgentId: params.currentAgent?.id || null,
    agents: params.agents,
    profile: params.profile,
    delegationTargetMode: params.delegationTargetMode,
    delegationTargetAgentIds: params.delegationTargetAgentIds,
  })
  const currentScore = current?.score ?? 0
  const recommendedScore = recommended?.score ?? Number.NEGATIVE_INFINITY
  const shouldDelegate = Boolean(
    params.profile.substantial
    && recommended
    && recommendedScore >= currentScore + 0.3
    && recommendedScore >= 0.25,
  )
  const style = params.currentAgent?.role === 'coordinator' && params.profile.workType !== 'operations'
    ? 'managerial'
    : 'advisory'
  return {
    profile: params.profile,
    current,
    recommended,
    shouldDelegate,
    style,
  }
}

export function formatDelegationRationale(candidate: DelegationCandidateFit | null | undefined): string {
  if (!candidate || candidate.reasons.length === 0) return 'better fit for this work'
  return candidate.reasons.slice(0, 2).join('; ')
}
