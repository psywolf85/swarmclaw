import { HumanMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { genId } from '@/lib/id'
import type {
  Agent,
  BoardTask,
  Chatroom,
  ChatroomMessage,
  MessageToolEvent,
  ProtocolBranchCase,
  ProtocolConditionDefinition,
  ProtocolForEachConfig,
  ProtocolPhaseDefinition,
  ProtocolJoinConfig,
  ProtocolParallelBranchDefinition,
  ProtocolParallelConfig,
  ProtocolRepeatConfig,
  ProtocolRun,
  ProtocolRunArtifact,
  ProtocolRunBranchDecision,
  ProtocolRunConfig,
  ProtocolRunEvent,
  ProtocolRunForEachStepState,
  ProtocolRunLoopState,
  ProtocolRunParallelBranchState,
  ProtocolRunParallelStepState,
  ProtocolRunPhaseState,
  ProtocolRunStatus,
  ProtocolRunStepState,
  ProtocolRunSubflowState,
  ProtocolRunSwarmState,
  ProtocolSourceRef,
  ProtocolStepDefinition,
  ProtocolSubflowConfig,
  ProtocolSwarmConfig,
  ProtocolTemplate,
  Schedule,
} from '@/types'
import { computeStepReadiness } from '@/lib/server/protocols/dag-scheduler'
import { normalizeStepOutputs } from '@/lib/server/protocols/step-outputs'
import {
  appendSyntheticSessionMessage,
  buildAgentSystemPromptForChatroom,
  buildChatroomSystemPrompt,
  buildHistoryForAgent,
  ensureSyntheticSession,
  resolveAgentApiEndpoint,
  resolveApiKey,
} from '@/lib/server/chatrooms/chatroom-helpers'
import { streamAgentChat } from '@/lib/server/chat-execution/stream-agent-chat'
import { shouldSuppressHiddenControlText, stripHiddenControlTokens } from '@/lib/server/agents/assistant-control'
import { resolvePrimaryAgentRoute } from '@/lib/server/agents/agent-runtime-config'
import { buildLLM } from '@/lib/server/build-llm'
import {
  loadAgents,
  loadChatrooms,
  loadMission,
  loadProtocolTemplate,
  loadProtocolTemplates,
  loadProtocolRun,
  loadProtocolRunEventsByRunId,
  loadProtocolRuns,
  loadTask,
  deleteProtocolRun,
  deleteProtocolRunEvent,
  deleteProtocolTemplate,
  patchProtocolTemplate,
  patchProtocolRun,
  tryAcquireRuntimeLock,
  releaseRuntimeLock,
  renewRuntimeLock,
  upsertChatroom,
  upsertProtocolTemplate,
  upsertProtocolRun,
  upsertProtocolRunEvent,
  upsertTask,
} from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { ensureMissionForTask, requestMissionTick } from '@/lib/server/missions/mission-service'
import { enqueueTask } from '@/lib/server/runtime/queue'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'

const PROTOCOL_LOCK_TTL_MS = 120_000
const AGENT_TURN_TIMEOUT_MS = 90_000
const PROTOCOL_LOCK_OWNER = `protocol:${process.pid}:${genId(6)}`
const protocolRecoveryState = hmrSingleton('__swarmclaw_protocol_engine_recovery__', () => ({ completed: false }))
const protocolExecutionState = hmrSingleton('__swarmclaw_protocol_engine_execution__', () => ({
  pendingRunIds: new Set<string>(),
}))

const ActionItemsSchema = z.object({
  tasks: z.array(z.object({
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    agentId: z.string().nullable().optional(),
  })).max(8).default([]),
})

export interface ProtocolRunDetail {
  run: ProtocolRun
  template: ProtocolTemplate | null
  transcript: Chatroom | null
  parentChatroom: Chatroom | null
  linkedMission: ReturnType<typeof loadMission>
  linkedTask: ReturnType<typeof loadTask>
  events: ProtocolRunEvent[]
}

export interface CreateProtocolRunInput {
  title: string
  templateId?: string | null
  phases?: ProtocolPhaseDefinition[]
  steps?: ProtocolStepDefinition[]
  entryStepId?: string | null
  participantAgentIds: string[]
  facilitatorAgentId?: string | null
  observerAgentIds?: string[]
  missionId?: string | null
  taskId?: string | null
  sessionId?: string | null
  parentRunId?: string | null
  parentStepId?: string | null
  branchId?: string | null
  parentChatroomId?: string | null
  scheduleId?: string | null
  sourceRef?: ProtocolSourceRef | null
  autoStart?: boolean
  createTranscript?: boolean
  config?: ProtocolRunConfig | null
  systemOwned?: boolean
}

export interface UpsertProtocolTemplateInput {
  name: string
  description: string
  singleAgentAllowed?: boolean
  tags?: string[]
  recommendedOutputs?: string[]
  defaultPhases?: ProtocolPhaseDefinition[]
  steps?: ProtocolStepDefinition[]
  entryStepId?: string | null
}

interface ProtocolAgentTurnResult {
  text: string
  toolEvents: MessageToolEvent[]
}

interface ProtocolRunDeps {
  now?: () => number
  executeAgentTurn?: (params: {
    run: ProtocolRun
    phase: ProtocolPhaseDefinition
    agentId: string
    prompt: string
  }) => Promise<ProtocolAgentTurnResult>
  extractActionItems?: (params: {
    run: ProtocolRun
    phase: ProtocolPhaseDefinition
    artifact: ProtocolRunArtifact
  }) => Promise<Array<{ title: string; description?: string | null; agentId?: string | null }>>
  decideBranchCase?: (params: {
    run: ProtocolRun
    step: ProtocolStepDefinition
    cases: ProtocolBranchCase[]
  }) => Promise<{ caseId: string; nextStepId: string } | null>
  decideRepeatContinuation?: (params: {
    run: ProtocolRun
    step: ProtocolStepDefinition
    repeat: ProtocolRepeatConfig
    iterationCount: number
  }) => Promise<'continue' | 'exit' | null>
}

export interface ProtocolRunActionInput {
  action: 'start' | 'pause' | 'resume' | 'retry_phase' | 'skip_phase' | 'cancel' | 'archive' | 'inject_context' | 'claim_work'
  reason?: string | null
  phaseId?: string | null
  context?: string | null
  stepId?: string | null
  agentId?: string | null
  workItemId?: string | null
}

function now(deps?: ProtocolRunDeps): number {
  return deps?.now ? deps.now() : Date.now()
}

function cleanText(value: unknown, max = 1200): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function uniqueIds(values: unknown, maxItems = 64): string[] {
  const source = Array.isArray(values) ? values : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of source) {
    const normalized = cleanText(value, 96)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
    if (out.length >= maxItems) break
  }
  return out
}

function isDiscussionStepKind(kind: ProtocolStepDefinition['kind'] | ProtocolPhaseDefinition['kind']): kind is ProtocolPhaseDefinition['kind'] {
  return [
    'present',
    'collect_independent_inputs',
    'round_robin',
    'compare',
    'decide',
    'summarize',
    'emit_tasks',
    'wait',
    'dispatch_task',
    'dispatch_delegation',
  ].includes(kind)
}

function normalizeCondition(condition: ProtocolConditionDefinition | null | undefined): ProtocolConditionDefinition | null {
  if (!condition || typeof condition !== 'object') return null
  if (condition.type === 'summary_exists') return { type: 'summary_exists' }
  if (condition.type === 'artifact_exists') {
    return {
      type: 'artifact_exists',
      artifactKind: typeof condition.artifactKind === 'string' ? condition.artifactKind : null,
    }
  }
  if (condition.type === 'artifact_count_at_least') {
    return {
      type: 'artifact_count_at_least',
      count: Math.max(0, Math.trunc(condition.count || 0)),
      artifactKind: typeof condition.artifactKind === 'string' ? condition.artifactKind : null,
    }
  }
  if (condition.type === 'created_task_count_at_least') {
    return {
      type: 'created_task_count_at_least',
      count: Math.max(0, Math.trunc(condition.count || 0)),
    }
  }
  if (condition.type === 'all' || condition.type === 'any') {
    return {
      type: condition.type,
      conditions: Array.isArray(condition.conditions)
        ? condition.conditions.map((entry) => normalizeCondition(entry)).filter(Boolean) as ProtocolConditionDefinition[]
        : [],
    }
  }
  return null
}

function normalizeBranchCase(branchCase: ProtocolBranchCase): ProtocolBranchCase {
  return {
    id: cleanText(branchCase.id, 64) || genId(),
    label: cleanText(branchCase.label, 120) || 'Case',
    nextStepId: cleanText(branchCase.nextStepId, 64),
    description: cleanText(branchCase.description, 600) || null,
    when: normalizeCondition(branchCase.when),
  }
}

function normalizeRepeatConfig(repeat: ProtocolRepeatConfig | null | undefined): ProtocolRepeatConfig | null {
  if (!repeat || typeof repeat !== 'object') return null
  return {
    bodyStepId: cleanText(repeat.bodyStepId, 64),
    nextStepId: cleanText(repeat.nextStepId, 64) || null,
    maxIterations: Math.max(1, Math.trunc(repeat.maxIterations || 1)),
    exitCondition: normalizeCondition(repeat.exitCondition),
    onExhausted: repeat.onExhausted === 'advance' ? 'advance' : 'fail',
  }
}

function normalizeParallelBranch(branch: ProtocolParallelBranchDefinition): ProtocolParallelBranchDefinition {
  const steps = Array.isArray(branch.steps) ? branch.steps.map(normalizeStep) : []
  const entryStepId = cleanText(branch.entryStepId, 64) || steps[0]?.id || null
  return {
    id: cleanText(branch.id, 64) || genId(),
    label: cleanText(branch.label, 120) || 'Branch',
    steps,
    entryStepId,
    participantAgentIds: uniqueIds(branch.participantAgentIds, 64),
    facilitatorAgentId: cleanText(branch.facilitatorAgentId, 64) || null,
    observerAgentIds: uniqueIds(branch.observerAgentIds, 32),
  }
}

function normalizeParallelConfig(parallel: ProtocolParallelConfig | null | undefined): ProtocolParallelConfig | null {
  if (!parallel || typeof parallel !== 'object') return null
  const branches = Array.isArray(parallel.branches) ? parallel.branches.map(normalizeParallelBranch) : []
  if (branches.length === 0) return null
  return { branches }
}

function normalizeJoinConfig(join: ProtocolJoinConfig | null | undefined): ProtocolJoinConfig | null {
  if (!join || typeof join !== 'object') return null
  return {
    parallelStepId: cleanText(join.parallelStepId, 64) || null,
  }
}

function phaseToStepDefinition(phase: ProtocolPhaseDefinition, nextStepId: string | null): ProtocolStepDefinition {
  return {
    id: cleanText(phase.id, 64) || genId(),
    kind: phase.kind,
    label: cleanText(phase.label, 120) || phase.kind,
    instructions: cleanText(phase.instructions, 600) || null,
    turnLimit: typeof phase.turnLimit === 'number' ? phase.turnLimit : null,
    completionCriteria: cleanText(phase.completionCriteria, 240) || null,
    nextStepId,
    branchCases: [],
    defaultNextStepId: null,
    repeat: null,
    parallel: null,
    join: null,
  }
}

function compilePhasesToSteps(phases: ProtocolPhaseDefinition[]): { steps: ProtocolStepDefinition[]; entryStepId: string | null } {
  const normalized = Array.isArray(phases) ? phases.map((phase) => ({
    id: cleanText(phase.id, 64) || genId(),
    kind: phase.kind,
    label: cleanText(phase.label, 120) || phase.kind,
    instructions: cleanText(phase.instructions, 600) || null,
    turnLimit: typeof phase.turnLimit === 'number' ? phase.turnLimit : null,
    completionCriteria: cleanText(phase.completionCriteria, 240) || null,
  })) : []
  const steps = normalized.map((phase, index) => phaseToStepDefinition(phase, normalized[index + 1]?.id || null))
  return { steps, entryStepId: steps[0]?.id || null }
}

function deriveDisplayPhasesFromSteps(steps: ProtocolStepDefinition[]): ProtocolPhaseDefinition[] {
  return steps
    .filter((step) => isDiscussionStepKind(step.kind))
    .map((step) => ({
      id: step.id,
      kind: step.kind as ProtocolPhaseDefinition['kind'],
      label: step.label,
      instructions: step.instructions || null,
      turnLimit: step.turnLimit ?? null,
      completionCriteria: step.completionCriteria || null,
    }))
}

function normalizeForEachConfig(config: ProtocolForEachConfig | null | undefined): ProtocolForEachConfig | null {
  if (!config || typeof config !== 'object') return null
  if (!config.itemsSource || !config.itemAlias || !config.branchTemplate?.steps?.length) return null
  return {
    itemsSource: config.itemsSource,
    itemAlias: config.itemAlias,
    branchTemplate: {
      steps: config.branchTemplate.steps.map(normalizeStep),
      entryStepId: cleanText(config.branchTemplate.entryStepId, 64) || config.branchTemplate.steps[0]?.id || null,
      participantAgentIds: Array.isArray(config.branchTemplate.participantAgentIds) ? config.branchTemplate.participantAgentIds : [],
      facilitatorAgentId: typeof config.branchTemplate.facilitatorAgentId === 'string' ? config.branchTemplate.facilitatorAgentId : null,
    },
    joinMode: 'all',
    maxItems: typeof config.maxItems === 'number' ? Math.min(200, Math.max(1, config.maxItems)) : 50,
    onEmpty: config.onEmpty === 'skip' || config.onEmpty === 'advance' ? config.onEmpty : 'fail',
  }
}

function normalizeSubflowConfig(config: ProtocolSubflowConfig | null | undefined): ProtocolSubflowConfig | null {
  if (!config || typeof config !== 'object') return null
  if (!config.templateId) return null
  return {
    templateId: config.templateId,
    templateVersion: typeof config.templateVersion === 'string' ? config.templateVersion : null,
    participantAgentIds: Array.isArray(config.participantAgentIds) ? config.participantAgentIds : [],
    facilitatorAgentId: typeof config.facilitatorAgentId === 'string' ? config.facilitatorAgentId : null,
    inputMapping: config.inputMapping && typeof config.inputMapping === 'object' ? config.inputMapping : null,
    outputMapping: config.outputMapping && typeof config.outputMapping === 'object' ? config.outputMapping : null,
    onFailure: config.onFailure === 'advance_with_warning' ? 'advance_with_warning' : 'fail_parent',
  }
}

function normalizeSwarmConfig(config: ProtocolSwarmConfig | null | undefined): ProtocolSwarmConfig | null {
  if (!config || typeof config !== 'object') return null
  if (!Array.isArray(config.eligibleAgentIds) || config.eligibleAgentIds.length === 0) return null
  if (!config.workItemsSource) return null
  return {
    eligibleAgentIds: config.eligibleAgentIds,
    workItemsSource: config.workItemsSource,
    claimLimitPerAgent: typeof config.claimLimitPerAgent === 'number' ? Math.min(10, Math.max(1, config.claimLimitPerAgent)) : 1,
    selectionMode: config.selectionMode === 'claim_until_empty' ? 'claim_until_empty' : 'first_claim',
    claimTimeoutSec: typeof config.claimTimeoutSec === 'number' ? Math.min(3600, Math.max(30, config.claimTimeoutSec)) : 300,
    onUnclaimed: config.onUnclaimed === 'advance' ? 'advance' : config.onUnclaimed === 'fallback_assign' ? 'fallback_assign' : 'fail',
  }
}

function normalizeStep(step: ProtocolStepDefinition): ProtocolStepDefinition {
  return {
    id: cleanText(step.id, 64) || genId(),
    kind: step.kind,
    label: cleanText(step.label, 120) || step.kind,
    instructions: cleanText(step.instructions, 600) || null,
    turnLimit: typeof step.turnLimit === 'number' ? step.turnLimit : null,
    completionCriteria: cleanText(step.completionCriteria, 240) || null,
    nextStepId: cleanText(step.nextStepId, 64) || null,
    branchCases: Array.isArray(step.branchCases) ? step.branchCases.map(normalizeBranchCase) : [],
    defaultNextStepId: cleanText(step.defaultNextStepId, 64) || null,
    repeat: normalizeRepeatConfig(step.repeat),
    parallel: normalizeParallelConfig(step.parallel),
    join: normalizeJoinConfig(step.join),
    dependsOnStepIds: Array.isArray(step.dependsOnStepIds) ? step.dependsOnStepIds.filter((id) => typeof id === 'string' && id.length > 0) : [],
    outputKey: cleanText(step.outputKey, 64) || null,
    forEach: normalizeForEachConfig(step.forEach),
    subflow: normalizeSubflowConfig(step.subflow),
    swarm: normalizeSwarmConfig(step.swarm),
  }
}

function resolveTemplateSteps(template: Partial<ProtocolTemplate>): { steps: ProtocolStepDefinition[]; entryStepId: string | null } {
  const explicitSteps = Array.isArray(template.steps) ? template.steps.map(normalizeStep) : []
  if (explicitSteps.length > 0) {
    const entryStepId = cleanText(template.entryStepId, 64) || explicitSteps[0]?.id || null
    return { steps: explicitSteps, entryStepId }
  }
  return compilePhasesToSteps(Array.isArray(template.defaultPhases) ? template.defaultPhases : [])
}

function resolveRunSteps(run: Partial<ProtocolRun>): { steps: ProtocolStepDefinition[]; entryStepId: string | null } {
  const explicitSteps = Array.isArray(run.steps) ? run.steps.map(normalizeStep) : []
  if (explicitSteps.length > 0) {
    const entryStepId = cleanText(run.entryStepId, 64) || explicitSteps[0]?.id || null
    return { steps: explicitSteps, entryStepId }
  }
  return compilePhasesToSteps(Array.isArray(run.phases) ? run.phases : [])
}

function normalizeLoopState(loopState: ProtocolRun['loopState']): Record<string, ProtocolRunLoopState> {
  const out: Record<string, ProtocolRunLoopState> = {}
  if (!loopState || typeof loopState !== 'object') return out
  for (const [stepId, state] of Object.entries(loopState)) {
    const normalizedStepId = cleanText(stepId, 64)
    if (!normalizedStepId || !state || typeof state !== 'object') continue
    out[normalizedStepId] = {
      stepId: normalizedStepId,
      iterationCount: Math.max(0, Math.trunc(state.iterationCount || 0)),
    }
  }
  return out
}

function normalizeBranchHistory(history: ProtocolRun['branchHistory']): ProtocolRunBranchDecision[] {
  if (!Array.isArray(history)) return []
  return history
    .map((entry) => ({
      stepId: cleanText(entry.stepId, 64),
      caseId: cleanText(entry.caseId, 64) || null,
      nextStepId: cleanText(entry.nextStepId, 64) || null,
      decidedAt: typeof entry.decidedAt === 'number' ? entry.decidedAt : Date.now(),
    }))
    .filter((entry) => entry.stepId)
}

function normalizeParallelState(parallelState: ProtocolRun['parallelState']): Record<string, ProtocolRunParallelStepState> {
  const out: Record<string, ProtocolRunParallelStepState> = {}
  if (!parallelState || typeof parallelState !== 'object') return out
  for (const [stepId, state] of Object.entries(parallelState)) {
    const normalizedStepId = cleanText(stepId, 64)
    if (!normalizedStepId || !state || typeof state !== 'object') continue
    const branches = Array.isArray(state.branches)
      ? state.branches.map((branch): ProtocolRunParallelBranchState => ({
        branchId: cleanText(branch.branchId, 64),
        label: cleanText(branch.label, 120) || 'Branch',
        runId: cleanText(branch.runId, 64),
        status: branch.status,
        participantAgentIds: uniqueIds(branch.participantAgentIds, 64),
        summary: cleanText(branch.summary, 4_000) || null,
        lastError: cleanText(branch.lastError, 320) || null,
        updatedAt: typeof branch.updatedAt === 'number' ? branch.updatedAt : Date.now(),
      })).filter((branch) => branch.branchId && branch.runId)
      : []
    out[normalizedStepId] = {
      stepId: normalizedStepId,
      branchRunIds: uniqueIds(state.branchRunIds, 64),
      branches,
      waitingOnBranchIds: uniqueIds(state.waitingOnBranchIds, 64),
      joinReady: state.joinReady === true,
      joinCompletedAt: typeof state.joinCompletedAt === 'number' ? state.joinCompletedAt : null,
    }
  }
  return out
}

function normalizeStepState(stepState: ProtocolRun['stepState']): Record<string, ProtocolRunStepState> {
  const out: Record<string, ProtocolRunStepState> = {}
  if (!stepState || typeof stepState !== 'object') return out
  for (const [stepId, state] of Object.entries(stepState)) {
    const normalizedStepId = cleanText(stepId, 64)
    if (!normalizedStepId || !state || typeof state !== 'object') continue
    out[normalizedStepId] = {
      stepId: normalizedStepId,
      status: state.status || 'pending',
      startedAt: typeof state.startedAt === 'number' ? state.startedAt : null,
      completedAt: typeof state.completedAt === 'number' ? state.completedAt : null,
      error: typeof state.error === 'string' ? state.error : null,
    }
  }
  return out
}

function normalizeForEachState(forEachState: ProtocolRun['forEachState']): Record<string, ProtocolRunForEachStepState> {
  const out: Record<string, ProtocolRunForEachStepState> = {}
  if (!forEachState || typeof forEachState !== 'object') return out
  for (const [stepId, state] of Object.entries(forEachState)) {
    const normalizedStepId = cleanText(stepId, 64)
    if (!normalizedStepId || !state || typeof state !== 'object') continue
    out[normalizedStepId] = {
      stepId: normalizedStepId,
      items: Array.isArray(state.items) ? state.items : [],
      branchRunIds: Array.isArray(state.branchRunIds) ? state.branchRunIds : [],
      branches: Array.isArray(state.branches) ? state.branches.map((b): ProtocolRunParallelBranchState => ({
        branchId: cleanText(b.branchId, 64),
        label: cleanText(b.label, 120) || 'Branch',
        runId: cleanText(b.runId, 64),
        status: b.status,
        participantAgentIds: uniqueIds(b.participantAgentIds, 64),
        summary: cleanText(b.summary, 4_000) || null,
        lastError: cleanText(b.lastError, 320) || null,
        updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : Date.now(),
      })).filter((b) => b.branchId && b.runId) : [],
      waitingOnBranchIds: Array.isArray(state.waitingOnBranchIds) ? state.waitingOnBranchIds : [],
      joinReady: state.joinReady === true,
      joinCompletedAt: typeof state.joinCompletedAt === 'number' ? state.joinCompletedAt : null,
    }
  }
  return out
}

function normalizeSubflowState(subflowState: ProtocolRun['subflowState']): Record<string, ProtocolRunSubflowState> {
  const out: Record<string, ProtocolRunSubflowState> = {}
  if (!subflowState || typeof subflowState !== 'object') return out
  for (const [stepId, state] of Object.entries(subflowState)) {
    const normalizedStepId = cleanText(stepId, 64)
    if (!normalizedStepId || !state || typeof state !== 'object') continue
    out[normalizedStepId] = {
      stepId: normalizedStepId,
      childRunId: state.childRunId || '',
      templateId: state.templateId || '',
      status: state.status || 'draft',
      summary: typeof state.summary === 'string' ? state.summary : null,
      lastError: typeof state.lastError === 'string' ? state.lastError : null,
      startedAt: typeof state.startedAt === 'number' ? state.startedAt : null,
      completedAt: typeof state.completedAt === 'number' ? state.completedAt : null,
    }
  }
  return out
}

function normalizeSwarmState(swarmState: ProtocolRun['swarmState']): Record<string, ProtocolRunSwarmState> {
  const out: Record<string, ProtocolRunSwarmState> = {}
  if (!swarmState || typeof swarmState !== 'object') return out
  for (const [stepId, state] of Object.entries(swarmState)) {
    const normalizedStepId = cleanText(stepId, 64)
    if (!normalizedStepId || !state || typeof state !== 'object') continue
    out[normalizedStepId] = {
      stepId: normalizedStepId,
      workItems: Array.isArray(state.workItems) ? state.workItems : [],
      claims: Array.isArray(state.claims) ? state.claims : [],
      unclaimedItemIds: Array.isArray(state.unclaimedItemIds) ? state.unclaimedItemIds : [],
      eligibleAgentIds: Array.isArray(state.eligibleAgentIds) ? state.eligibleAgentIds : [],
      claimLimitPerAgent: typeof state.claimLimitPerAgent === 'number' ? state.claimLimitPerAgent : 1,
      selectionMode: state.selectionMode === 'claim_until_empty' ? 'claim_until_empty' : 'first_claim',
      claimTimeoutSec: typeof state.claimTimeoutSec === 'number' ? state.claimTimeoutSec : 300,
      openedAt: typeof state.openedAt === 'number' ? state.openedAt : Date.now(),
      closedAt: typeof state.closedAt === 'number' ? state.closedAt : null,
      timedOut: state.timedOut === true,
    }
  }
  return out
}

function findCurrentStepId(
  steps: ProtocolStepDefinition[],
  preferred: string | null | undefined,
  entryStepId: string | null,
  currentPhaseIndex = 0,
  status?: ProtocolRunStatus,
): string | null {
  const normalized = cleanText(preferred, 64)
  if (normalized && steps.some((step) => step.id === normalized)) return normalized
  if (status === 'completed' || status === 'cancelled' || status === 'archived') return null
  if (Math.trunc(currentPhaseIndex || 0) >= steps.length) return null
  const indexed = steps[Math.max(0, Math.min(Math.trunc(currentPhaseIndex || 0), steps.length - 1))]
  return indexed?.id || entryStepId || null
}

function findRunStep(run: ProtocolRun, stepId: string | null | undefined): ProtocolStepDefinition | null {
  const normalized = cleanText(stepId, 64)
  if (!normalized || !Array.isArray(run.steps)) return null
  return run.steps.find((step) => step.id === normalized) || null
}

function protocolLockName(runId: string): string {
  return `protocol:${runId}`
}

function normalizeProtocolSourceRef(run: Partial<ProtocolRun>): ProtocolSourceRef {
  const sourceRef = run.sourceRef
  if (sourceRef && typeof sourceRef === 'object' && 'kind' in sourceRef) {
    if (sourceRef.kind === 'protocol_run') {
      return {
        kind: 'protocol_run',
        runId: cleanText(sourceRef.runId, 64),
        parentRunId: cleanText(sourceRef.parentRunId, 64) || null,
        stepId: cleanText(sourceRef.stepId, 64) || null,
        branchId: cleanText(sourceRef.branchId, 64) || null,
      }
    }
    return sourceRef
  }
  if (typeof run.parentChatroomId === 'string' && run.parentChatroomId.trim()) {
    return { kind: 'chatroom', chatroomId: run.parentChatroomId.trim() }
  }
  if (typeof run.missionId === 'string' && run.missionId.trim()) {
    return { kind: 'mission', missionId: run.missionId.trim() }
  }
  if (typeof run.taskId === 'string' && run.taskId.trim()) {
    return { kind: 'task', taskId: run.taskId.trim() }
  }
  if (typeof run.scheduleId === 'string' && run.scheduleId.trim()) {
    return { kind: 'schedule', scheduleId: run.scheduleId.trim() }
  }
  if (typeof run.sessionId === 'string' && run.sessionId.trim()) {
    return { kind: 'session', sessionId: run.sessionId.trim() }
  }
  return { kind: 'manual' }
}

function normalizeArtifact(artifact: ProtocolRunArtifact): ProtocolRunArtifact {
  return {
    ...artifact,
    title: cleanText(artifact.title, 120) || 'Artifact',
    content: cleanText(artifact.content, 12_000),
    phaseId: typeof artifact.phaseId === 'string' ? artifact.phaseId : null,
    taskIds: uniqueIds(artifact.taskIds, 32),
  }
}

function normalizeProtocolRun(run: ProtocolRun): ProtocolRun {
  const { steps, entryStepId } = resolveRunSteps(run)
  const displayPhases = deriveDisplayPhasesFromSteps(steps)
  const currentStepId = findCurrentStepId(steps, run.currentStepId, entryStepId, run.currentPhaseIndex, run.status)
  const currentPhaseIndex = currentStepId
    ? Math.max(0, steps.findIndex((step) => step.id === currentStepId))
    : steps.length
  return {
    ...run,
    sourceRef: normalizeProtocolSourceRef(run),
    participantAgentIds: uniqueIds(run.participantAgentIds, 64),
    observerAgentIds: uniqueIds(run.observerAgentIds, 64),
    facilitatorAgentId: typeof run.facilitatorAgentId === 'string' ? run.facilitatorAgentId : null,
    missionId: typeof run.missionId === 'string' ? run.missionId : null,
    taskId: typeof run.taskId === 'string' ? run.taskId : null,
    sessionId: typeof run.sessionId === 'string' ? run.sessionId : null,
    parentRunId: typeof run.parentRunId === 'string' ? run.parentRunId : null,
    parentStepId: typeof run.parentStepId === 'string' ? run.parentStepId : null,
    branchId: typeof run.branchId === 'string' ? run.branchId : null,
    parentChatroomId: typeof run.parentChatroomId === 'string' ? run.parentChatroomId : null,
    transcriptChatroomId: typeof run.transcriptChatroomId === 'string' ? run.transcriptChatroomId : null,
    scheduleId: typeof run.scheduleId === 'string' ? run.scheduleId : null,
    systemOwned: run.systemOwned === true,
    waitingReason: cleanText(run.waitingReason, 240) || null,
    pauseReason: cleanText(run.pauseReason, 240) || null,
    lastError: cleanText(run.lastError, 320) || null,
    summary: cleanText(run.summary, 4_000) || null,
    latestArtifactId: typeof run.latestArtifactId === 'string' ? run.latestArtifactId : null,
    artifacts: Array.isArray(run.artifacts) ? run.artifacts.map(normalizeArtifact) : [],
    createdTaskIds: uniqueIds(run.createdTaskIds, 64),
    operatorContext: uniqueIds(run.operatorContext, 32),
    phases: displayPhases,
    steps,
    entryStepId,
    currentStepId,
    config: run.config ? {
      goal: cleanText(run.config.goal, 600) || null,
      kickoffMessage: cleanText(run.config.kickoffMessage, 1_000) || null,
      roundLimit: typeof run.config.roundLimit === 'number' ? run.config.roundLimit : null,
      decisionMode: cleanText(run.config.decisionMode, 120) || null,
      createTranscript: run.config.createTranscript !== false,
      autoEmitTasks: run.config.autoEmitTasks === true,
      taskProjectId: typeof run.config.taskProjectId === 'string' ? run.config.taskProjectId : null,
      postSummaryToParent: run.config.postSummaryToParent !== false,
    } : null,
    phaseState: run.phaseState && typeof run.phaseState === 'object'
      ? {
          phaseId: cleanText(run.phaseState.phaseId, 64),
          respondedAgentIds: uniqueIds(run.phaseState.respondedAgentIds, 64),
          responses: Array.isArray(run.phaseState.responses)
            ? run.phaseState.responses.map((response) => ({
                agentId: cleanText(response.agentId, 64),
                text: cleanText(response.text, 4_000),
                toolEvents: Array.isArray(response.toolEvents) ? response.toolEvents : [],
              }))
            : [],
          appendedToTranscript: run.phaseState.appendedToTranscript === true,
          artifactId: typeof run.phaseState.artifactId === 'string' ? run.phaseState.artifactId : null,
        }
      : null,
    loopState: normalizeLoopState(run.loopState),
    branchHistory: normalizeBranchHistory(run.branchHistory),
    parallelState: normalizeParallelState(run.parallelState),
    stepState: normalizeStepState(run.stepState),
    completedStepIds: Array.isArray(run.completedStepIds) ? run.completedStepIds : [],
    runningStepIds: Array.isArray(run.runningStepIds) ? run.runningStepIds : [],
    readyStepIds: Array.isArray(run.readyStepIds) ? run.readyStepIds : [],
    failedStepIds: Array.isArray(run.failedStepIds) ? run.failedStepIds : [],
    stepOutputs: normalizeStepOutputs(run.stepOutputs),
    forEachState: normalizeForEachState(run.forEachState),
    subflowState: normalizeSubflowState(run.subflowState),
    swarmState: normalizeSwarmState(run.swarmState),
    currentPhaseIndex,
  }
}

function normalizeProtocolTemplate(template: ProtocolTemplate): ProtocolTemplate {
  const { steps, entryStepId } = resolveTemplateSteps(template)
  return {
    ...template,
    id: cleanText(template.id, 64) || genId(8),
    name: cleanText(template.name, 120) || 'Custom Template',
    description: cleanText(template.description, 600) || 'Custom structured-session template.',
    builtIn: template.builtIn === true,
    singleAgentAllowed: template.singleAgentAllowed !== false,
    tags: uniqueIds(template.tags, 24),
    recommendedOutputs: uniqueIds(template.recommendedOutputs, 24),
    defaultPhases: deriveDisplayPhasesFromSteps(steps),
    steps,
    entryStepId,
    createdAt: typeof template.createdAt === 'number' ? template.createdAt : Date.now(),
    updatedAt: typeof template.updatedAt === 'number' ? template.updatedAt : Date.now(),
  }
}

const BUILT_IN_PROTOCOL_TEMPLATES: ProtocolTemplate[] = [
  {
    id: 'independent_collection',
    name: 'Independent Collection',
    description: 'Gather separate inputs first, then conclude with one synthesized summary.',
    builtIn: true,
    singleAgentAllowed: true,
    tags: ['neutral', 'collection', 'analysis'],
    recommendedOutputs: ['collected inputs', 'summary'],
    defaultPhases: [
      { id: 'present', kind: 'present', label: 'Open the session' },
      { id: 'collect', kind: 'collect_independent_inputs', label: 'Collect independent inputs' },
      { id: 'summarize', kind: 'summarize', label: 'Summarize the collected inputs' },
    ],
  },
  {
    id: 'facilitated_discussion',
    name: 'Facilitated Discussion',
    description: 'Walk participants through a structured round-robin, then conclude with a synthesis.',
    builtIn: true,
    singleAgentAllowed: true,
    tags: ['neutral', 'discussion'],
    recommendedOutputs: ['discussion summary'],
    defaultPhases: [
      { id: 'present', kind: 'present', label: 'Open the session' },
      { id: 'round_robin', kind: 'round_robin', label: 'Round-robin responses' },
      { id: 'summarize', kind: 'summarize', label: 'Summarize the discussion' },
    ],
  },
  {
    id: 'review_panel',
    name: 'Review Panel',
    description: 'Collect independent reviews, compare them, then conclude with a decision and summary.',
    builtIn: true,
    singleAgentAllowed: true,
    tags: ['neutral', 'review'],
    recommendedOutputs: ['comparison', 'decision', 'summary'],
    defaultPhases: [
      { id: 'present', kind: 'present', label: 'Present the subject' },
      { id: 'collect', kind: 'collect_independent_inputs', label: 'Collect independent reviews' },
      { id: 'compare', kind: 'compare', label: 'Compare the inputs' },
      { id: 'decide', kind: 'decide', label: 'Produce the current verdict' },
      { id: 'summarize', kind: 'summarize', label: 'Summarize the outcome' },
    ],
  },
  {
    id: 'decision_round',
    name: 'Decision Round',
    description: 'Move from separate positions to a single current decision.',
    builtIn: true,
    singleAgentAllowed: true,
    tags: ['neutral', 'decision'],
    recommendedOutputs: ['decision', 'summary'],
    defaultPhases: [
      { id: 'present', kind: 'present', label: 'Set the decision context' },
      { id: 'collect', kind: 'collect_independent_inputs', label: 'Collect initial positions' },
      { id: 'compare', kind: 'compare', label: 'Compare the positions' },
      { id: 'decide', kind: 'decide', label: 'Decide the current outcome' },
      { id: 'summarize', kind: 'summarize', label: 'Summarize the decision' },
    ],
  },
  {
    id: 'status_roundup',
    name: 'Status Roundup',
    description: 'Gather per-participant updates in order and conclude with a concise recap.',
    builtIn: true,
    singleAgentAllowed: true,
    tags: ['neutral', 'status'],
    recommendedOutputs: ['status recap'],
    defaultPhases: [
      { id: 'present', kind: 'present', label: 'Set the roundup context' },
      { id: 'round_robin', kind: 'round_robin', label: 'Collect per-participant updates' },
      { id: 'summarize', kind: 'summarize', label: 'Summarize the roundup' },
    ],
  },
  {
    id: 'adjudicated_compare',
    name: 'Adjudicated Compare',
    description: 'Collect competing views, compare them, and let one facilitator synthesize the current ruling.',
    builtIn: true,
    singleAgentAllowed: true,
    tags: ['neutral', 'compare'],
    recommendedOutputs: ['comparison', 'decision', 'summary'],
    defaultPhases: [
      { id: 'present', kind: 'present', label: 'Present the comparison target' },
      { id: 'collect', kind: 'collect_independent_inputs', label: 'Collect independent positions' },
      { id: 'compare', kind: 'compare', label: 'Compare the positions' },
      { id: 'decide', kind: 'decide', label: 'Adjudicate the current outcome' },
      { id: 'summarize', kind: 'summarize', label: 'Summarize the ruling' },
    ],
  },
  {
    id: 'single_agent_structured_run',
    name: 'Single-Agent Structured Run',
    description: 'A bounded structured session for one agent that still produces a durable summary.',
    builtIn: true,
    singleAgentAllowed: true,
    tags: ['neutral', 'single-agent'],
    recommendedOutputs: ['summary'],
    defaultPhases: [
      { id: 'present', kind: 'present', label: 'Set the task context' },
      { id: 'round_robin', kind: 'round_robin', label: 'Produce the agent response' },
      { id: 'summarize', kind: 'summarize', label: 'Summarize the outcome' },
    ],
  },
]

function acquireProtocolLease(runId: string): (() => void) | null {
  const name = protocolLockName(runId)
  const acquired = tryAcquireRuntimeLock(name, PROTOCOL_LOCK_OWNER, PROTOCOL_LOCK_TTL_MS)
  if (!acquired) return null
  return () => releaseRuntimeLock(name, PROTOCOL_LOCK_OWNER)
}

function renewProtocolLease(runId: string): void {
  renewRuntimeLock(protocolLockName(runId), PROTOCOL_LOCK_OWNER, PROTOCOL_LOCK_TTL_MS)
}

function notifyProtocolTemplates(): void {
  notify('protocol_templates')
}

function isTerminalProtocolRunStatus(status: ProtocolRunStatus | null | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'archived'
}

function listStoredTemplates(): ProtocolTemplate[] {
  return Object.values(loadProtocolTemplates())
    .map((template) => normalizeProtocolTemplate(template))
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
}

function listAllTemplates(): ProtocolTemplate[] {
  return [
    ...BUILT_IN_PROTOCOL_TEMPLATES.map((template) => normalizeProtocolTemplate(template)),
    ...listStoredTemplates(),
  ]
}

function loadTemplate(templateId: string | null | undefined): ProtocolTemplate | null {
  const normalized = cleanText(templateId, 64)
  if (!normalized) return null
  const builtIn = BUILT_IN_PROTOCOL_TEMPLATES.find((template) => template.id === normalized)
  if (builtIn) {
    return normalizeProtocolTemplate(builtIn)
  }
  const stored = loadProtocolTemplate(normalized)
  return stored ? normalizeProtocolTemplate(stored) : null
}

function isBuiltInTemplateId(templateId: string | null | undefined): boolean {
  const normalized = cleanText(templateId, 64)
  if (!normalized) return false
  return BUILT_IN_PROTOCOL_TEMPLATES.some((template) => template.id === normalized)
}

export function loadProtocolTemplateById(templateId: string | null | undefined): ProtocolTemplate | null {
  return loadTemplate(templateId)
}

export function createProtocolTemplate(input: UpsertProtocolTemplateInput, deps?: ProtocolRunDeps): ProtocolTemplate {
  const createdAt = now(deps)
  const { steps, entryStepId } = resolveTemplateSteps({
    steps: Array.isArray(input.steps) ? input.steps : [],
    entryStepId: input.entryStepId || null,
    defaultPhases: Array.isArray(input.defaultPhases) ? input.defaultPhases : [],
  })
  const template = normalizeProtocolTemplate({
    id: genId(10),
    builtIn: false,
    name: cleanText(input.name, 120) || 'Custom Template',
    description: cleanText(input.description, 600) || 'Custom structured-session template.',
    singleAgentAllowed: input.singleAgentAllowed !== false,
    tags: uniqueIds(input.tags, 24),
    recommendedOutputs: uniqueIds(input.recommendedOutputs, 24),
    defaultPhases: deriveDisplayPhasesFromSteps(steps),
    steps,
    entryStepId,
    createdAt,
    updatedAt: createdAt,
  })
  upsertProtocolTemplate(template.id, template)
  notifyProtocolTemplates()
  return template
}

export function updateProtocolTemplate(templateId: string, input: UpsertProtocolTemplateInput, deps?: ProtocolRunDeps): ProtocolTemplate | null {
  const normalizedId = cleanText(templateId, 64)
  if (!normalizedId || isBuiltInTemplateId(normalizedId)) return null
  const updated = patchProtocolTemplate(normalizedId, (current) => {
    if (!current) return null
    const { steps, entryStepId } = resolveTemplateSteps({
      steps: Array.isArray(input.steps) && input.steps.length > 0 ? input.steps : current.steps || [],
      entryStepId: input.entryStepId || current.entryStepId || null,
      defaultPhases: Array.isArray(input.defaultPhases) && input.defaultPhases.length > 0 ? input.defaultPhases : current.defaultPhases,
    })
    return normalizeProtocolTemplate({
      ...current,
      name: cleanText(input.name, 120) || current.name,
      description: cleanText(input.description, 600) || current.description,
      singleAgentAllowed: input.singleAgentAllowed !== false,
      tags: uniqueIds(input.tags, 24),
      recommendedOutputs: uniqueIds(input.recommendedOutputs, 24),
      defaultPhases: deriveDisplayPhasesFromSteps(steps),
      steps,
      entryStepId,
      updatedAt: now(deps),
    })
  })
  if (!updated) return null
  notifyProtocolTemplates()
  return normalizeProtocolTemplate(updated)
}

export function deleteProtocolTemplateById(templateId: string): boolean {
  const normalizedId = cleanText(templateId, 64)
  if (!normalizedId || isBuiltInTemplateId(normalizedId)) return false
  const existing = loadProtocolTemplate(normalizedId)
  if (!existing) return false
  deleteProtocolTemplate(normalizedId)
  notifyProtocolTemplates()
  return true
}

function transcriptRoomName(title: string, parent: Chatroom | null): string {
  const base = cleanText(title, 80) || 'Structured Session'
  if (!parent) return base
  return `${cleanText(parent.name, 48) || 'Chatroom'} · ${base}`
}

function appendProtocolEvent(runId: string, event: Omit<ProtocolRunEvent, 'id' | 'runId' | 'createdAt'>, deps?: ProtocolRunDeps): ProtocolRunEvent {
  const record: ProtocolRunEvent = {
    id: genId(),
    runId,
    createdAt: now(deps),
    ...event,
  }
  upsertProtocolRunEvent(record.id, record)
  notify('protocol_runs')
  notify(`protocol_run:${runId}`)
  return record
}

function listEvents(runId: string): ProtocolRunEvent[] {
  return loadProtocolRunEventsByRunId(runId)
}

function appendTranscriptMessage(chatroomId: string, message: Omit<ChatroomMessage, 'id' | 'time'>, deps?: ProtocolRunDeps): ChatroomMessage | null {
  const chatrooms = loadChatrooms()
  const chatroom = chatrooms[chatroomId]
  if (!chatroom) return null
  const nextMessage: ChatroomMessage = {
    ...message,
    id: genId(),
    time: now(deps),
  }
  chatroom.messages = Array.isArray(chatroom.messages) ? [...chatroom.messages, nextMessage] : [nextMessage]
  chatroom.updatedAt = nextMessage.time
  upsertChatroom(chatroomId, chatroom)
  notify(`chatroom:${chatroomId}`)
  return nextMessage
}

function chooseFacilitator(run: ProtocolRun): string | null {
  if (typeof run.facilitatorAgentId === 'string' && run.facilitatorAgentId.trim()) return run.facilitatorAgentId.trim()
  return run.participantAgentIds[0] || null
}

function buildPhasePrompt(run: ProtocolRun, phase: ProtocolPhaseDefinition, agentId: string): string {
  const agentLabel = agentId
  const goal = cleanText(run.config?.goal, 400) || cleanText(run.title, 220)
  const kickoff = cleanText(run.config?.kickoffMessage, 800)
  const decisionMode = cleanText(run.config?.decisionMode, 120)
  const roundLimit = typeof run.config?.roundLimit === 'number' ? run.config?.roundLimit : null
  const phaseInstructions = cleanText(phase.instructions, 600)

  if (phase.kind === 'collect_independent_inputs') {
    return [
      `Structured session: ${run.title}`,
      `Objective: ${goal}`,
      kickoff ? `Context: ${kickoff}` : '',
      `Current phase: ${phase.label}`,
      'Provide your independent contribution for this structured session.',
      'Do not assume access to the other participants\' answers yet.',
      phaseInstructions ? `Additional instructions: ${phaseInstructions}` : '',
      `Participant: ${agentLabel}`,
    ].filter(Boolean).join('\n')
  }

  if (phase.kind === 'round_robin') {
    return [
      `Structured session: ${run.title}`,
      `Objective: ${goal}`,
      kickoff ? `Context: ${kickoff}` : '',
      `Current phase: ${phase.label}`,
      'Provide your concise turn for the structured session.',
      roundLimit ? `Current round limit: ${roundLimit}` : '',
      phaseInstructions ? `Additional instructions: ${phaseInstructions}` : '',
      `Participant: ${agentLabel}`,
    ].filter(Boolean).join('\n')
  }

  if (phase.kind === 'compare') {
    return [
      `Structured session: ${run.title}`,
      `Objective: ${goal}`,
      `Current phase: ${phase.label}`,
      'Compare the participant contributions already visible in the transcript.',
      'Highlight the strongest differences, overlaps, and tradeoffs.',
      phaseInstructions ? `Additional instructions: ${phaseInstructions}` : '',
    ].filter(Boolean).join('\n')
  }

  if (phase.kind === 'decide') {
    return [
      `Structured session: ${run.title}`,
      `Objective: ${goal}`,
      `Current phase: ${phase.label}`,
      'Produce the current decision or synthesized outcome for this structured session.',
      decisionMode ? `Decision mode: ${decisionMode}` : '',
      phaseInstructions ? `Additional instructions: ${phaseInstructions}` : '',
    ].filter(Boolean).join('\n')
  }

  if (phase.kind === 'summarize') {
    return [
      `Structured session: ${run.title}`,
      `Objective: ${goal}`,
      `Current phase: ${phase.label}`,
      'Write the concluding structured summary for this run.',
      'Include the current outcome, notable contributions, and next actions when relevant.',
      phaseInstructions ? `Additional instructions: ${phaseInstructions}` : '',
    ].filter(Boolean).join('\n')
  }

  return [
    `Structured session: ${run.title}`,
    `Objective: ${goal}`,
    `Current phase: ${phase.label}`,
    phaseInstructions || 'Continue the structured session.',
  ].join('\n')
}

async function defaultExecuteAgentTurn(params: {
  run: ProtocolRun
  phase: ProtocolPhaseDefinition
  agentId: string
  prompt: string
}): Promise<ProtocolAgentTurnResult> {
  const agents = loadAgents() as Record<string, Agent>
  const agent = agents[params.agentId]
  if (!agent) throw new Error(`Agent not found: ${params.agentId}`)
  let run = params.run
  if (!run.transcriptChatroomId) {
    const transcript = createTranscriptRoom({
      runId: run.id,
      title: run.title,
      participantAgentIds: run.participantAgentIds,
      parentChatroomId: run.parentChatroomId || null,
    })
    run = persistRun({
      ...run,
      transcriptChatroomId: transcript.id,
      updatedAt: Date.now(),
    })
  }
  const chatroom = loadChatrooms()[run.transcriptChatroomId!]
  if (!chatroom) throw new Error(`Structured session transcript room not found: ${run.transcriptChatroomId}`)

  const route = resolvePrimaryAgentRoute(agent)
  const apiKey = resolveApiKey(route?.credentialId || agent.credentialId)
  const syntheticSession = ensureSyntheticSession(agent, chatroom.id)
  syntheticSession.provider = route?.provider || syntheticSession.provider
  syntheticSession.model = route?.model || syntheticSession.model
  syntheticSession.credentialId = route?.credentialId ?? syntheticSession.credentialId ?? null
  syntheticSession.fallbackCredentialIds = route?.fallbackCredentialIds || syntheticSession.fallbackCredentialIds || []
  syntheticSession.gatewayProfileId = route?.gatewayProfileId ?? syntheticSession.gatewayProfileId ?? null
  syntheticSession.apiEndpoint = route?.apiEndpoint || resolveAgentApiEndpoint(agent)
  const protocolContext = [
    '## Structured Session Context',
    `Run title: ${params.run.title}`,
    `Template: ${params.run.templateName}`,
    `Phase: ${params.phase.label} (${params.phase.kind})`,
  ].join('\n')
  const fullSystemPrompt = [
    buildAgentSystemPromptForChatroom(agent, syntheticSession.cwd),
    buildChatroomSystemPrompt(chatroom, agents, agent.id),
    protocolContext,
  ].filter(Boolean).join('\n\n')

  appendSyntheticSessionMessage(syntheticSession.id, 'user', params.prompt)

  const MAX_RETRIES = 3
  const BASE_DELAY_MS = 2_000
  let lastError: unknown = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
      console.warn(`[protocols] retrying agent turn for ${params.agentId} (attempt ${attempt + 1}/${MAX_RETRIES + 1}, waiting ${delay}ms)`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    try {
      const result = await Promise.race([
        streamAgentChat({
          session: syntheticSession,
          message: params.prompt,
          apiKey,
          systemPrompt: fullSystemPrompt,
          write: () => {},
          history: buildHistoryForAgent(chatroom, agent.id),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Agent turn timed out after ${AGENT_TURN_TIMEOUT_MS / 1000}s (agent: ${params.agentId})`)), AGENT_TURN_TIMEOUT_MS),
        ),
      ])
      const rawText = result.finalResponse || result.fullText || ''
      const text = stripHiddenControlTokens(rawText)
      if (text.trim() && !shouldSuppressHiddenControlText(rawText)) {
        appendSyntheticSessionMessage(syntheticSession.id, 'assistant', text)
      }
      return {
        text: cleanText(text, 6_000),
        toolEvents: result.toolEvents || [],
      }
    } catch (err: unknown) {
      lastError = err
      const msg = errorMessage(err)
      const isRetryable = /\b(401|429|5\d{2}|timeout|ECONNR|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed)\b/i.test(msg)
      if (!isRetryable || attempt >= MAX_RETRIES) throw err
      console.warn(`[protocols] transient LLM error for agent ${params.agentId}: ${msg}`)
    }
  }
  throw lastError
}

function extractFirstJsonObject(text: string): string | null {
  const source = String(text || '')
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (start === -1) {
      if (char === '{') {
        start = index
        depth = 1
      }
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }
  return null
}

async function defaultExtractActionItems(params: {
  run: ProtocolRun
  phase: ProtocolPhaseDefinition
  artifact: ProtocolRunArtifact
}): Promise<Array<{ title: string; description?: string | null; agentId?: string | null }>> {
  const facilitatorId = chooseFacilitator(params.run)
  if (!facilitatorId) return []
  try {
    const { llm } = await buildLLM({
      sessionId: params.run.sessionId || null,
      agentId: facilitatorId,
    })
    const prompt = [
      'Turn the structured session output into backlog tasks.',
      'Return JSON only.',
      '',
      'Rules:',
      '- Emit at most 8 tasks.',
      '- Each task title should be short and actionable.',
      '- description is optional.',
      '- agentId is optional and should only be filled when the session output clearly points to one participant.',
      '',
      'Output shape:',
      '{"tasks":[{"title":"required","description":"optional","agentId":"optional"}]}',
      '',
      `run_title: ${JSON.stringify(cleanText(params.run.title, 200) || '(none)')}`,
      `phase: ${JSON.stringify(params.phase.label)}`,
      `summary: ${JSON.stringify(cleanText(params.artifact.content, 8_000) || '(none)')}`,
    ].join('\n')
    const response = await llm.invoke([new HumanMessage(prompt)])
    const jsonText = extractFirstJsonObject(String(response.content || ''))
    if (!jsonText) return []
    const parsed = ActionItemsSchema.safeParse(JSON.parse(jsonText))
    if (!parsed.success) return []
    return parsed.data.tasks.map((task) => ({
      title: cleanText(task.title, 140),
      description: cleanText(task.description, 600) || null,
      agentId: cleanText(task.agentId, 64) || null,
    })).filter((task) => task.title)
  } catch (err: unknown) {
    appendProtocolEvent(params.run.id, {
      type: 'warning',
      phaseId: params.phase.id,
      summary: `Action item extraction failed: ${cleanText(errorMessage(err), 200) || 'unknown error'}`,
    })
    return []
  }
}

function createTranscriptRoom(input: {
  runId: string
  title: string
  participantAgentIds: string[]
  parentChatroomId?: string | null
}, deps?: ProtocolRunDeps): Chatroom {
  const chatrooms = loadChatrooms()
  const parentChatroom = input.parentChatroomId ? chatrooms[input.parentChatroomId] || null : null
  const room: Chatroom = {
    id: genId(),
    name: transcriptRoomName(input.title, parentChatroom),
    description: 'Temporary structured session transcript',
    agentIds: [...input.participantAgentIds],
    messages: [],
    chatMode: 'sequential',
    autoAddress: false,
    temporary: true,
    hidden: true,
    archivedAt: null,
    protocolRunId: input.runId,
    parentChatroomId: input.parentChatroomId || null,
    createdAt: now(deps),
    updatedAt: now(deps),
  }
  upsertChatroom(room.id, room)
  return room
}

function createArtifact(run: ProtocolRun, phase: ProtocolPhaseDefinition, kind: ProtocolRunArtifact['kind'], title: string, content: string, deps?: ProtocolRunDeps): ProtocolRunArtifact {
  return {
    id: genId(),
    kind,
    title,
    content,
    phaseId: phase.id,
    createdAt: now(deps),
  }
}

function persistRun(run: ProtocolRun): ProtocolRun {
  const normalized = normalizeProtocolRun(run)
  upsertProtocolRun(normalized.id, normalized)
  notify('protocol_runs')
  notify(`protocol_run:${normalized.id}`)
  return normalized
}

function updateRun(runId: string, updater: (current: ProtocolRun) => ProtocolRun | null): ProtocolRun | null {
  const updated = patchProtocolRun(runId, (current) => {
    if (!current) return null
    const normalized = normalizeProtocolRun(current)
    return updater(normalized)
  })
  if (updated) {
    notify('protocol_runs')
    notify(`protocol_run:${runId}`)
  }
  return updated
}

export function requestProtocolRunExecution(runId: string, deps?: ProtocolRunDeps): boolean {
  const normalizedId = cleanText(runId, 64)
  if (!normalizedId) return false
  if (protocolExecutionState.pendingRunIds.has(normalizedId)) return false
  protocolExecutionState.pendingRunIds.add(normalizedId)
  setTimeout(() => {
    void runProtocolRun(normalizedId, deps)
      .catch((err: unknown) => {
        console.warn(`[protocols] execution failed for ${normalizedId}: ${errorMessage(err)}`)
      })
      .finally(() => {
        protocolExecutionState.pendingRunIds.delete(normalizedId)
      })
  }, 0)
  return true
}

export function wakeProtocolRunFromTaskCompletion(taskId: string, deps?: ProtocolRunDeps): void {
  const task = loadTask(taskId)
  if (!task?.protocolRunId) return
  const runId = task.protocolRunId
  const run = loadProtocolRunById(runId)
  if (!run || run.status !== 'waiting') return

  // Check if this task is part of a swarm step
  if (run.swarmState) {
    for (const state of Object.values(run.swarmState)) {
      if (state.claims.some((c) => c.taskId === taskId)) {
        syncSwarmClaimCompletion(taskId, deps)
        return
      }
    }
  }

  if (run.phaseState?.dispatchedTaskId !== taskId) return
  const terminalStatuses = ['completed', 'failed', 'cancelled']
  if (!terminalStatuses.includes(task.status)) return
  const phase = run.phaseState?.phaseId ? findRunStep(run, run.phaseState.phaseId) : null
  if (!phase || !isDiscussionStepKind(phase.kind)) return
  const phaseDefinition = phaseFromStep(phase)
  const taskResult = task.status === 'completed' ? 'completed' : task.status
  appendProtocolEvent(runId, {
    type: 'phase_completed',
    phaseId: phaseDefinition.id,
    stepId: phaseDefinition.id,
    summary: `Dispatched task ${taskResult}: ${task.title}`,
    taskId,
  }, deps)
  const step = findRunStep(run, phaseDefinition.id)
  const nextStepId = cleanText(step?.nextStepId, 64) || null
  const nextIndex = nextStepId && Array.isArray(run.steps)
    ? Math.max(0, run.steps.findIndex((entry) => entry.id === nextStepId))
    : Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex + 1
  persistRun({
    ...run,
    status: 'running',
    waitingReason: null,
    currentStepId: nextStepId,
    currentPhaseIndex: nextIndex,
    phaseState: null,
    updatedAt: now(deps),
  })
  requestProtocolRunExecution(runId, deps)
}

export function ensureProtocolEngineRecovered(deps?: ProtocolRunDeps): void {
  if (protocolRecoveryState.completed) return
  protocolRecoveryState.completed = true
  const runs = Object.values(loadProtocolRuns()).map((entry) => normalizeProtocolRun(entry))
  for (const run of runs) {
    if (run.parentRunId) {
      syncProtocolParentFromChildRun(run, deps)
    }
  }
  for (const run of runs) {
    if (run.status === 'running') {
      appendProtocolEvent(run.id, {
        type: 'recovered',
        summary: 'Recovered an interrupted structured session run after restart.',
      }, deps)
      requestProtocolRunExecution(run.id, deps)
      continue
    }
    if (run.status !== 'waiting') continue
    const hasReadyJoin = Object.values(run.parallelState || {}).some((state) => state.joinReady === true && !state.joinCompletedAt)
    if (hasReadyJoin) {
      appendProtocolEvent(run.id, {
        type: 'recovered',
        summary: 'Recovered a structured session join that was ready to continue after restart.',
      }, deps)
      requestProtocolRunExecution(run.id, deps)
      continue
    }
    // Recover DAG runs: recompute readiness from durable stepState
    if (run.stepState && Object.keys(run.stepState).length > 0) {
      const sched = computeStepReadiness(run.steps || [], run.entryStepId || null, run.stepState)
      if (sched.dagMode && sched.readyStepIds.length > 0) {
        appendProtocolEvent(run.id, {
          type: 'recovered',
          summary: 'Recovered a DAG-mode structured session with ready steps after restart.',
        }, deps)
        requestProtocolRunExecution(run.id, deps)
        continue
      }
    }
    // Recover for_each: check if all branches are terminal
    const forEachStates = Object.values(run.forEachState || {})
    const hasReadyForEach = forEachStates.some((state) => state.joinReady === true && !state.joinCompletedAt)
    if (hasReadyForEach) {
      appendProtocolEvent(run.id, {
        type: 'recovered',
        summary: 'Recovered a for-each join that was ready to continue after restart.',
      }, deps)
      requestProtocolRunExecution(run.id, deps)
      continue
    }
    // Recover subflow: check if child run is terminal
    for (const subState of Object.values(run.subflowState || {})) {
      if (subState.childRunId) {
        const childRun = loadProtocolRunById(subState.childRunId)
        if (childRun && (childRun.status === 'completed' || childRun.status === 'failed' || childRun.status === 'cancelled')) {
          appendProtocolEvent(run.id, {
            type: 'recovered',
            summary: `Recovered subflow step after child run ${childRun.status}.`,
          }, deps)
          requestProtocolRunExecution(run.id, deps)
          break
        }
      }
    }
    // Recover dispatch-waiting runs where the dispatched task has already completed
    const dispatchedTaskId = run.phaseState?.dispatchedTaskId
    if (dispatchedTaskId) {
      const dispatchedTask = loadTask(dispatchedTaskId)
      if (dispatchedTask && ['completed', 'failed', 'cancelled'].includes(dispatchedTask.status)) {
        wakeProtocolRunFromTaskCompletion(dispatchedTaskId, deps)
      }
    }
  }
}

const BranchDecisionSchema = z.object({
  caseId: z.string().min(1),
})

function phaseFromStep(step: ProtocolStepDefinition): ProtocolPhaseDefinition {
  if (!isDiscussionStepKind(step.kind)) {
    throw new Error(`Structured-session step "${step.id}" is not a discussion phase.`)
  }
  return {
    id: step.id,
    kind: step.kind,
    label: step.label,
    instructions: step.instructions || null,
    turnLimit: step.turnLimit ?? null,
    completionCriteria: step.completionCriteria || null,
    taskConfig: step.taskConfig || null,
    delegationConfig: step.delegationConfig || null,
  }
}

function currentStep(run: ProtocolRun): ProtocolStepDefinition | null {
  const explicit = findRunStep(run, run.currentStepId)
  if (explicit) return explicit
  if (!Array.isArray(run.steps) || run.steps.length === 0) return null
  if (run.currentPhaseIndex >= run.steps.length) return null
  return run.steps[Math.max(0, Math.min(run.currentPhaseIndex, run.steps.length - 1))] || null
}

function findParallelStepIdForJoin(run: ProtocolRun, joinStep: ProtocolStepDefinition): string | null {
  const explicit = cleanText(joinStep.join?.parallelStepId, 64)
  if (explicit) return explicit
  if (!Array.isArray(run.steps)) return null
  const joinIndex = run.steps.findIndex((step) => step.id === joinStep.id)
  if (joinIndex <= 0) return null
  for (let index = joinIndex - 1; index >= 0; index -= 1) {
    const candidate = run.steps[index]
    if (candidate.kind !== 'parallel') continue
    if (candidate.nextStepId === joinStep.id || run.parallelState?.[candidate.id]) return candidate.id
  }
  return null
}

function buildParallelBranchRunTitle(run: ProtocolRun, step: ProtocolStepDefinition, branch: ProtocolParallelBranchDefinition): string {
  return [
    cleanText(run.title, 120) || 'Structured Session',
    cleanText(step.label, 80) || 'Parallel Step',
    cleanText(branch.label, 80) || 'Branch',
  ].filter(Boolean).join(' · ')
}

function buildParallelBranchGoal(run: ProtocolRun, step: ProtocolStepDefinition, branch: ProtocolParallelBranchDefinition): string | null {
  const baseGoal = cleanText(run.config?.goal, 600) || cleanText(run.title, 220)
  const focus = [
    cleanText(step.label, 120),
    cleanText(branch.label, 120),
  ].filter(Boolean).join(' / ')
  if (!baseGoal && !focus) return null
  if (!baseGoal) return `Branch focus: ${focus}`
  if (!focus) return baseGoal
  return `${baseGoal}\nBranch focus: ${focus}`
}

function summarizeProtocolRunBranch(run: ProtocolRun | null): string | null {
  if (!run) return null
  const explicitSummary = cleanText(run.summary, 4_000)
  if (explicitSummary) return explicitSummary
  const latestArtifact = Array.isArray(run.artifacts) ? run.artifacts[run.artifacts.length - 1] : null
  const artifactContent = cleanText(latestArtifact?.content, 4_000)
  if (artifactContent) return artifactContent
  return cleanText(run.lastError, 320) || null
}

function buildParallelBranchState(run: ProtocolRun | null, fallback: Partial<ProtocolRunParallelBranchState> & { branchId: string; label: string; runId: string }): ProtocolRunParallelBranchState {
  return {
    branchId: cleanText(fallback.branchId, 64),
    label: cleanText(fallback.label, 120) || 'Branch',
    runId: cleanText(fallback.runId, 64),
    status: run?.status || fallback.status || 'draft',
    participantAgentIds: uniqueIds(run?.participantAgentIds || fallback.participantAgentIds, 64),
    summary: summarizeProtocolRunBranch(run) || cleanText(fallback.summary, 4_000) || null,
    lastError: cleanText(run?.lastError, 320) || cleanText(fallback.lastError, 320) || null,
    updatedAt: typeof run?.updatedAt === 'number' ? run.updatedAt : (typeof fallback.updatedAt === 'number' ? fallback.updatedAt : Date.now()),
  }
}

function buildParallelStepState(
  stepId: string,
  branches: ProtocolRunParallelBranchState[],
  joinCompletedAt?: number | null,
): ProtocolRunParallelStepState {
  const waitingOnBranchIds = branches
    .filter((branch) => !isTerminalProtocolRunStatus(branch.status))
    .map((branch) => branch.branchId)
  return {
    stepId,
    branchRunIds: branches.map((branch) => branch.runId),
    branches,
    waitingOnBranchIds,
    joinReady: waitingOnBranchIds.length === 0 && branches.length > 0,
    joinCompletedAt: typeof joinCompletedAt === 'number' ? joinCompletedAt : null,
  }
}

function syncProtocolParentFromChildRun(runOrId: ProtocolRun | string, deps?: ProtocolRunDeps): ProtocolRun | null {
  const child = typeof runOrId === 'string' ? loadProtocolRunById(runOrId) : normalizeProtocolRun(runOrId)
  if (!child?.parentRunId || !child.parentStepId) return null
  const parent = loadProtocolRunById(child.parentRunId)
  if (!parent) return null

  // Delegate to for_each sync if parent step has forEachState
  const forEachState = parent.forEachState?.[child.parentStepId]
  if (forEachState) {
    return syncForEachParentFromChildRun(child, parent, forEachState, deps)
  }

  // Delegate to subflow sync if parent step has subflowState
  const subflowState = parent.subflowState?.[child.parentStepId]
  if (subflowState && subflowState.childRunId === child.id) {
    return syncSubflowParentFromChildRun(child, parent, subflowState, deps)
  }

  const existingState = parent.parallelState?.[child.parentStepId]
  if (!existingState) return parent
  const nextBranches = existingState.branches.map((branch) => (
    branch.runId === child.id ? buildParallelBranchState(child, branch) : branch
  ))
  const nextState = buildParallelStepState(child.parentStepId, nextBranches, existingState.joinCompletedAt || null)
  const previousBranch = existingState.branches.find((branch) => branch.runId === child.id) || null
  const previousStatus = previousBranch?.status || null
  const updatedParent = updateRun(parent.id, (current) => ({
    ...current,
    parallelState: {
      ...(current.parallelState || {}),
      [child.parentStepId!]: nextState,
    },
    updatedAt: now(deps),
  }))
  if (!updatedParent) return null
  if (previousStatus !== child.status && isTerminalProtocolRunStatus(child.status)) {
    appendProtocolEvent(updatedParent.id, {
      type: child.status === 'completed' ? 'parallel_branch_completed' : 'parallel_branch_failed',
      stepId: child.parentStepId,
      summary: child.status === 'completed'
        ? `Parallel branch "${previousBranch?.label || child.branchId || child.id}" completed.`
        : `Parallel branch "${previousBranch?.label || child.branchId || child.id}" ended with ${child.status}.`,
      data: { branchId: child.branchId, childRunId: child.id, status: child.status },
    }, deps)
  }
  if (nextState.joinReady && existingState.joinReady !== true) {
    appendProtocolEvent(updatedParent.id, {
      type: 'join_ready',
      stepId: child.parentStepId,
      summary: 'All parallel branches reached a terminal state and the join can continue.',
      data: { childRunIds: nextState.branchRunIds },
    }, deps)
  }
  if (nextState.joinReady && updatedParent.status === 'waiting') {
    requestProtocolRunExecution(updatedParent.id, deps)
  }
  return loadProtocolRunById(updatedParent.id)
}

function maybeAppendLoopIterationCompleted(
  run: ProtocolRun,
  completedStep: ProtocolStepDefinition | null,
  nextStepId: string | null,
  deps?: ProtocolRunDeps,
): void {
  if (!completedStep || !nextStepId) return
  const repeatStep = findRunStep(run, nextStepId)
  if (!repeatStep || repeatStep.kind !== 'repeat' || repeatStep.repeat?.bodyStepId !== completedStep.id) return
  const iterationCount = run.loopState?.[repeatStep.id]?.iterationCount || 0
  appendProtocolEvent(run.id, {
    type: 'loop_iteration_completed',
    stepId: repeatStep.id,
    summary: `Completed loop iteration ${iterationCount} for ${repeatStep.label}.`,
    data: {
      bodyStepId: completedStep.id,
      iterationCount,
    },
  }, deps)
}

function beginPhase(run: ProtocolRun, phase: ProtocolPhaseDefinition, deps?: ProtocolRunDeps): ProtocolRun {
  if (run.phaseState?.phaseId === phase.id && run.currentStepId === phase.id) return run
  appendProtocolEvent(run.id, {
    type: 'phase_started',
    phaseId: phase.id,
    stepId: phase.id,
    summary: `Started phase: ${phase.label}`,
    data: { kind: phase.kind },
  }, deps)
  // Update DAG stepState to 'running' if applicable
  const dagUpdate: Partial<ProtocolRun> = {}
  if (run.stepState && Object.keys(run.stepState).length > 0) {
    const step = findRunStep(run, phase.id)
    if (step) {
      dagUpdate.stepState = {
        ...run.stepState,
        [step.id]: {
          stepId: step.id,
          status: 'running',
          startedAt: now(deps),
          completedAt: null,
          error: null,
        },
      }
      dagUpdate.runningStepIds = [...(run.runningStepIds || []).filter((id) => id !== step.id), step.id]
      dagUpdate.readyStepIds = (run.readyStepIds || []).filter((id) => id !== step.id)
    }
  }
  return persistRun({
    ...run,
    ...dagUpdate,
    status: run.status === 'draft' ? 'running' : run.status,
    currentStepId: phase.id,
    phaseState: {
      phaseId: phase.id,
      respondedAgentIds: [],
      responses: [],
      appendedToTranscript: false,
      artifactId: null,
    },
    updatedAt: now(deps),
  })
}

function finishPhase(run: ProtocolRun, phase: ProtocolPhaseDefinition, deps?: ProtocolRunDeps): ProtocolRun {
  const step = findRunStep(run, phase.id)
  const nextStepId = cleanText(step?.nextStepId, 64) || null
  appendProtocolEvent(run.id, {
    type: 'phase_completed',
    phaseId: phase.id,
    stepId: phase.id,
    summary: `Completed phase: ${phase.label}`,
  }, deps)
  maybeAppendLoopIterationCompleted(run, step, nextStepId, deps)

  // In DAG mode, delegate to finishStep which updates stepState and recomputes readiness
  const isDagMode = run.stepState && Object.keys(run.stepState).length > 0
  if (isDagMode && step) {
    return finishStep(
      persistRun({ ...run, phaseState: null, updatedAt: now(deps) }),
      step,
      nextStepId,
      deps,
    )
  }

  // Non-DAG mode: original cursor-based advancement
  const nextIndex = nextStepId && Array.isArray(run.steps)
    ? Math.max(0, run.steps.findIndex((entry) => entry.id === nextStepId))
    : Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex + 1
  return persistRun({
    ...run,
    currentStepId: nextStepId,
    currentPhaseIndex: nextIndex,
    phaseState: null,
    updatedAt: now(deps),
  })
}

function completeProtocolRun(run: ProtocolRun, deps?: ProtocolRunDeps, summary = 'Structured session completed.'): ProtocolRun {
  const completed = persistRun({
    ...run,
    status: 'completed',
    currentStepId: null,
    currentPhaseIndex: Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex,
    endedAt: run.endedAt || now(deps),
    updatedAt: now(deps),
    waitingReason: null,
    phaseState: null,
  })
  appendProtocolEvent(run.id, {
    type: 'completed',
    summary,
  }, deps)
  emitSummaryToParentChatroom(completed, deps)
  if (completed.missionId) {
    requestMissionTick(completed.missionId, 'protocol_run_completed', { protocolRunId: completed.id })
  }
  return completed
}

function evaluateProtocolCondition(run: ProtocolRun, condition: ProtocolConditionDefinition | null | undefined): boolean {
  if (!condition) return false
  if (condition.type === 'summary_exists') {
    return Boolean(cleanText(run.summary, 4_000))
  }
  if (condition.type === 'artifact_exists') {
    return (run.artifacts || []).some((artifact) => !condition.artifactKind || artifact.kind === condition.artifactKind)
  }
  if (condition.type === 'artifact_count_at_least') {
    const count = (run.artifacts || []).filter((artifact) => !condition.artifactKind || artifact.kind === condition.artifactKind).length
    return count >= Math.max(0, Math.trunc(condition.count || 0))
  }
  if (condition.type === 'created_task_count_at_least') {
    return (run.createdTaskIds || []).length >= Math.max(0, Math.trunc(condition.count || 0))
  }
  if (condition.type === 'all') {
    return Array.isArray(condition.conditions) && condition.conditions.length > 0 && condition.conditions.every((entry) => evaluateProtocolCondition(run, entry))
  }
  if (condition.type === 'any') {
    return Array.isArray(condition.conditions) && condition.conditions.some((entry) => evaluateProtocolCondition(run, entry))
  }
  return false
}

async function defaultDecideBranchCase(
  run: ProtocolRun,
  step: ProtocolStepDefinition,
  cases: ProtocolBranchCase[],
): Promise<{ caseId: string; nextStepId: string } | null> {
  const facilitatorId = chooseFacilitator(run)
  if (!facilitatorId || cases.length === 0) return null
  try {
    const { llm } = await buildLLM({
      sessionId: run.sessionId || null,
      agentId: facilitatorId,
    })
    const prompt = [
      'Choose the next branch for this structured session.',
      'Return JSON only.',
      '',
      'Output shape:',
      '{"caseId":"required"}',
      '',
      `run_title: ${JSON.stringify(cleanText(run.title, 200) || '(none)')}`,
      `step_label: ${JSON.stringify(step.label)}`,
      `goal: ${JSON.stringify(cleanText(run.config?.goal, 600) || '(none)')}`,
      `summary: ${JSON.stringify(cleanText(run.summary, 6_000) || '(none)')}`,
      `artifacts: ${JSON.stringify((run.artifacts || []).map((artifact) => ({ kind: artifact.kind, title: artifact.title })).slice(-12))}`,
      `created_tasks: ${JSON.stringify((run.createdTaskIds || []).slice(-16))}`,
      `operator_context: ${JSON.stringify((run.operatorContext || []).slice(-8))}`,
      `cases: ${JSON.stringify(cases.map((branchCase) => ({
        id: branchCase.id,
        label: branchCase.label,
        description: branchCase.description || null,
      })))}`,
    ].join('\n')
    const response = await llm.invoke([new HumanMessage(prompt)])
    const jsonText = extractFirstJsonObject(String(response.content || ''))
    if (!jsonText) return null
    const parsed = BranchDecisionSchema.safeParse(JSON.parse(jsonText))
    if (!parsed.success) return null
    const selected = cases.find((branchCase) => branchCase.id === parsed.data.caseId)
    return selected ? { caseId: selected.id, nextStepId: selected.nextStepId } : null
  } catch (err: unknown) {
    appendProtocolEvent(run.id, {
      type: 'warning',
      stepId: step.id,
      summary: `Branch decision failed: ${cleanText(errorMessage(err), 200) || 'unknown error'}`,
    })
    return null
  }
}

function beginStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): ProtocolRun {
  appendProtocolEvent(run.id, {
    type: 'step_started',
    stepId: step.id,
    summary: `Started step: ${step.label}`,
    data: { kind: step.kind },
  }, deps)
  const dagUpdate: Partial<ProtocolRun> = {}
  if (run.stepState && Object.keys(run.stepState).length > 0) {
    dagUpdate.stepState = {
      ...run.stepState,
      [step.id]: {
        stepId: step.id,
        status: 'running',
        startedAt: now(deps),
        completedAt: null,
        error: null,
      },
    }
    dagUpdate.runningStepIds = [...(run.runningStepIds || []).filter((id) => id !== step.id), step.id]
    dagUpdate.readyStepIds = (run.readyStepIds || []).filter((id) => id !== step.id)
  }
  return persistRun({
    ...run,
    ...dagUpdate,
    status: run.status === 'draft' ? 'running' : run.status,
    currentStepId: step.id,
    updatedAt: now(deps),
  })
}

function finishStep(run: ProtocolRun, step: ProtocolStepDefinition, nextStepId: string | null, deps?: ProtocolRunDeps): ProtocolRun {
  appendProtocolEvent(run.id, {
    type: 'step_completed',
    stepId: step.id,
    summary: `Completed step: ${step.label}`,
  }, deps)
  maybeAppendLoopIterationCompleted(run, step, nextStepId, deps)

  const isDagMode = run.stepState && Object.keys(run.stepState).length > 0
  if (isDagMode) {
    // In DAG mode, mark step completed and let scheduler recompute readiness
    const stepState = {
      ...run.stepState,
      [step.id]: {
        stepId: step.id,
        status: 'completed' as const,
        startedAt: run.stepState?.[step.id]?.startedAt || null,
        completedAt: now(deps),
        error: null,
      },
    }
    // Recompute readiness after marking this step done
    const sched = computeStepReadiness(run.steps || [], run.entryStepId || null, stepState)
    const nextReady = sched.readyStepIds[0] || nextStepId || null
    const nextIndex = nextReady && Array.isArray(run.steps)
      ? Math.max(0, run.steps.findIndex((entry) => entry.id === nextReady))
      : Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex + 1
    return persistRun({
      ...run,
      currentStepId: nextReady,
      currentPhaseIndex: nextIndex,
      waitingReason: null,
      pauseReason: null,
      phaseState: null,
      stepState: sched.stepState,
      completedStepIds: sched.completedStepIds,
      runningStepIds: sched.runningStepIds,
      readyStepIds: sched.readyStepIds,
      failedStepIds: sched.failedStepIds,
      updatedAt: now(deps),
    })
  }

  // Non-DAG mode: original cursor-based advancement
  const nextIndex = nextStepId && Array.isArray(run.steps)
    ? Math.max(0, run.steps.findIndex((entry) => entry.id === nextStepId))
    : Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex + 1
  return persistRun({
    ...run,
    currentStepId: nextStepId,
    currentPhaseIndex: nextIndex,
    waitingReason: null,
    pauseReason: null,
    phaseState: null,
    updatedAt: now(deps),
  })
}

function currentArtifact(run: ProtocolRun): ProtocolRunArtifact | null {
  if (!Array.isArray(run.artifacts) || run.artifacts.length === 0) return null
  if (run.latestArtifactId) {
    const exact = run.artifacts.find((artifact) => artifact.id === run.latestArtifactId)
    if (exact) return exact
  }
  return run.artifacts[run.artifacts.length - 1] || null
}

function appendArtifact(run: ProtocolRun, artifact: ProtocolRunArtifact, deps?: ProtocolRunDeps): ProtocolRun {
  const next = persistRun({
    ...run,
    artifacts: [...(run.artifacts || []), artifact],
    latestArtifactId: artifact.id,
    ...(artifact.kind === 'summary' ? { summary: artifact.content } : {}),
    phaseState: run.phaseState
      ? { ...run.phaseState, artifactId: artifact.id }
      : run.phaseState,
    updatedAt: now(deps),
  })
  appendProtocolEvent(run.id, {
    type: 'artifact_emitted',
    phaseId: artifact.phaseId || null,
    artifactId: artifact.id,
    summary: `Emitted ${artifact.kind.replace(/_/g, ' ')}: ${artifact.title}`,
  }, deps)
  return next
}

function emitSummaryToParentChatroom(run: ProtocolRun, deps?: ProtocolRunDeps): void {
  if (!run.parentChatroomId || !run.summary || run.config?.postSummaryToParent === false) return
  const message = [
    `[Structured session complete] ${run.title}`,
    '',
    cleanText(run.summary, 3_000),
  ].join('\n')
  const appended = appendTranscriptMessage(run.parentChatroomId, {
    senderId: 'system',
    senderName: 'System',
    role: 'assistant',
    text: message,
    mentions: [],
    reactions: [],
  }, deps)
  if (appended) {
    appendProtocolEvent(run.id, {
      type: 'summary_posted',
      summary: 'Posted the final structured-session summary back to the parent chatroom.',
      data: { parentChatroomId: run.parentChatroomId },
    }, deps)
  }
}

async function processPresentPhase(run: ProtocolRun, phase: ProtocolPhaseDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const kickoff = cleanText(run.config?.kickoffMessage, 1_000)
  const goal = cleanText(run.config?.goal, 600) || cleanText(run.title, 220)
  if (run.transcriptChatroomId && !(run.phaseState?.appendedToTranscript === true)) {
    appendTranscriptMessage(run.transcriptChatroomId, {
      senderId: 'system',
      senderName: 'System',
      role: 'assistant',
      text: [
        `Structured session: ${run.title}`,
        `Objective: ${goal}`,
        kickoff ? `Context: ${kickoff}` : '',
        phase.instructions ? `Notes: ${phase.instructions}` : '',
      ].filter(Boolean).join('\n'),
      mentions: [],
      reactions: [],
    }, deps)
    run = persistRun({
      ...run,
      phaseState: run.phaseState ? { ...run.phaseState, appendedToTranscript: true } : run.phaseState,
      updatedAt: now(deps),
    })
  }
  return finishPhase(run, phase, deps)
}

async function collectResponses(
  run: ProtocolRun,
  phase: ProtocolPhaseDefinition,
  appendImmediately: boolean,
  deps?: ProtocolRunDeps,
): Promise<ProtocolRun> {
  const executeAgentTurn = deps?.executeAgentTurn || defaultExecuteAgentTurn
  let current = run
  const responded = new Set(current.phaseState?.respondedAgentIds || [])
  const cachedResponses = Array.isArray(current.phaseState?.responses) ? [...current.phaseState.responses] : []

  for (const agentId of current.participantAgentIds) {
    if (responded.has(agentId)) continue
    renewProtocolLease(current.id)
    let response: ProtocolAgentTurnResult
    try {
      response = await executeAgentTurn({
        run: current,
        phase,
        agentId,
        prompt: buildPhasePrompt(current, phase, agentId),
      })
    } catch (err: unknown) {
      const errMsg = cleanText(errorMessage(err), 200) || 'unknown error'
      appendProtocolEvent(current.id, {
        type: 'warning',
        phaseId: phase.id,
        agentId,
        summary: `Agent ${agentId} failed during phase "${phase.label}": ${errMsg}`,
      }, deps)
      response = { text: `[Agent error: ${errMsg}]`, toolEvents: [] }
    }
    responded.add(agentId)
    cachedResponses.push({ agentId, text: response.text, toolEvents: response.toolEvents })
    current = persistRun({
      ...current,
      phaseState: {
        phaseId: phase.id,
        respondedAgentIds: Array.from(responded),
        responses: cachedResponses,
        appendedToTranscript: appendImmediately ? true : false,
        artifactId: current.phaseState?.artifactId || null,
      },
      updatedAt: now(deps),
    })
    if (appendImmediately && current.transcriptChatroomId) {
      const agents = loadAgents()
      appendTranscriptMessage(current.transcriptChatroomId, {
        senderId: agentId,
        senderName: agents[agentId]?.name || agentId,
        role: 'assistant',
        text: response.text,
        mentions: [],
        reactions: [],
        ...(response.toolEvents.length > 0 ? { toolEvents: response.toolEvents } : {}),
      }, deps)
      appendProtocolEvent(current.id, {
        type: 'participant_response',
        phaseId: phase.id,
        agentId,
        summary: `Captured a response from ${agents[agentId]?.name || agentId}.`,
      }, deps)
    }
  }

  if (!appendImmediately && current.transcriptChatroomId && current.phaseState?.appendedToTranscript !== true) {
    const agents = loadAgents()
    for (const response of cachedResponses) {
      appendTranscriptMessage(current.transcriptChatroomId, {
        senderId: response.agentId,
        senderName: agents[response.agentId]?.name || response.agentId,
        role: 'assistant',
        text: response.text,
        mentions: [],
        reactions: [],
        ...(response.toolEvents && response.toolEvents.length > 0 ? { toolEvents: response.toolEvents } : {}),
      }, deps)
      appendProtocolEvent(current.id, {
        type: 'participant_response',
        phaseId: phase.id,
        agentId: response.agentId,
        summary: `Captured an independent response from ${agents[response.agentId]?.name || response.agentId}.`,
      }, deps)
    }
    current = persistRun({
      ...current,
      phaseState: current.phaseState
        ? { ...current.phaseState, appendedToTranscript: true }
        : current.phaseState,
      updatedAt: now(deps),
    })
  }
  return finishPhase(current, phase, deps)
}

async function processFacilitatorArtifactPhase(
  run: ProtocolRun,
  phase: ProtocolPhaseDefinition,
  kind: ProtocolRunArtifact['kind'],
  deps?: ProtocolRunDeps,
): Promise<ProtocolRun> {
  const facilitatorId = chooseFacilitator(run)
  if (!facilitatorId) {
    throw new Error('Structured session has no facilitator or participants to continue.')
  }
  if (run.phaseState?.artifactId) {
    return finishPhase(run, phase, deps)
  }
  const executeAgentTurn = deps?.executeAgentTurn || defaultExecuteAgentTurn
  renewProtocolLease(run.id)
  const result = await executeAgentTurn({
    run,
    phase,
    agentId: facilitatorId,
    prompt: buildPhasePrompt(run, phase, facilitatorId),
  })
  const artifact = createArtifact(run, phase, kind, phase.label, result.text, deps)
  const agents = loadAgents()
  if (run.transcriptChatroomId) {
    appendTranscriptMessage(run.transcriptChatroomId, {
      senderId: facilitatorId,
      senderName: agents[facilitatorId]?.name || facilitatorId,
      role: 'assistant',
      text: result.text,
      mentions: [],
      reactions: [],
      ...(result.toolEvents.length > 0 ? { toolEvents: result.toolEvents } : {}),
    }, deps)
  }
  const updated = appendArtifact(run, artifact, deps)
  return finishPhase(updated, phase, deps)
}

async function processEmitTasksPhase(run: ProtocolRun, phase: ProtocolPhaseDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  if (run.phaseState?.artifactId) return finishPhase(run, phase, deps)
  const artifact = currentArtifact(run)
  if (!artifact) return finishPhase(run, phase, deps)
  const extractActionItems = deps?.extractActionItems || defaultExtractActionItems
  const extracted = await extractActionItems({ run, phase, artifact })
  const agents = loadAgents()
  const fallbackAssignee = chooseFacilitator(run) || run.participantAgentIds[0] || ''
  const createdTaskIds: string[] = []
  const linkedMissionId = typeof run.missionId === 'string' ? run.missionId : null
  const taskProjectId = run.config?.taskProjectId || null
  for (const item of extracted) {
    const assignedAgentId = item.agentId && agents[item.agentId] ? item.agentId : fallbackAssignee
    if (!assignedAgentId) continue
    const task: BoardTask = {
      id: genId(),
      title: cleanText(item.title, 160),
      description: cleanText(item.description, 1_000) || cleanText(artifact.content, 800),
      status: 'backlog',
      agentId: assignedAgentId,
      missionId: linkedMissionId,
      projectId: taskProjectId || undefined,
      createdByAgentId: chooseFacilitator(run),
      createdInSessionId: run.sessionId || null,
      createdAt: now(deps),
      updatedAt: now(deps),
      sourceType: 'manual',
      tags: ['structured-session'],
    }
    upsertTask(task.id, task)
    ensureMissionForTask(task, { source: 'manual' })
    createdTaskIds.push(task.id)
    appendProtocolEvent(run.id, {
      type: 'task_emitted',
      phaseId: phase.id,
      taskId: task.id,
      summary: `Created task: ${task.title}`,
      data: { agentId: assignedAgentId },
    }, deps)
  }
  const updated = persistRun({
    ...run,
    createdTaskIds: [...(run.createdTaskIds || []), ...createdTaskIds],
    phaseState: run.phaseState
      ? { ...run.phaseState, artifactId: artifact.id }
      : run.phaseState,
    updatedAt: now(deps),
  })
  if (createdTaskIds.length > 0) notify('tasks')
  return finishPhase(updated, phase, deps)
}

function processWaitPhase(run: ProtocolRun, phase: ProtocolPhaseDefinition, deps?: ProtocolRunDeps): ProtocolRun {
  const step = findRunStep(run, phase.id)
  const nextStepId = cleanText(step?.nextStepId, 64) || null
  const nextIndex = nextStepId && Array.isArray(run.steps)
    ? Math.max(0, run.steps.findIndex((entry) => entry.id === nextStepId))
    : Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex + 1
  const waitReason = cleanText(phase.instructions, 240) || 'Structured session is waiting for a manual resume.'
  appendProtocolEvent(run.id, {
    type: 'waiting',
    phaseId: phase.id,
    stepId: phase.id,
    summary: waitReason,
  }, deps)
  return persistRun({
    ...run,
    status: 'waiting',
    waitingReason: waitReason,
    currentStepId: nextStepId,
    currentPhaseIndex: nextIndex,
    phaseState: null,
    updatedAt: now(deps),
  })
}

async function processBranchStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const started = beginStep(run, step, deps)
  const cases = Array.isArray(step.branchCases) ? step.branchCases : []
  const deterministic = cases.find((branchCase) => branchCase.when && evaluateProtocolCondition(started, branchCase.when))
  const decider = deps?.decideBranchCase || (async ({ run: decisionRun, step: decisionStep, cases: decisionCases }) => (
    defaultDecideBranchCase(decisionRun, decisionStep, decisionCases)
  ))
  const decided = deterministic
    ? { caseId: deterministic.id, nextStepId: deterministic.nextStepId }
    : await decider({ run: started, step, cases })
  const nextStepId = cleanText(decided?.nextStepId || step.defaultNextStepId, 64) || null
  const caseId = cleanText(decided?.caseId, 64) || null
  if (!nextStepId) {
    appendProtocolEvent(run.id, {
      type: 'warning',
      stepId: step.id,
      summary: `Branch "${step.label}" could not resolve a path. Cases: ${cases.length}, LLM result: ${decided ? `caseId=${decided.caseId}` : 'null'}, defaultNextStepId: ${step.defaultNextStepId || 'none'}`,
    }, deps)
    throw new Error(`Structured session branch "${step.label}" had no satisfied path.`)
  }
  appendProtocolEvent(run.id, {
    type: 'branch_taken',
    stepId: step.id,
    summary: caseId
      ? `Branch "${step.label}" selected case ${caseId}.`
      : `Branch "${step.label}" took its default path.`,
    data: { caseId, nextStepId },
  }, deps)
  const updated = persistRun({
    ...started,
    branchHistory: [
      ...(started.branchHistory || []),
      { stepId: step.id, caseId, nextStepId, decidedAt: now(deps) },
    ],
    updatedAt: now(deps),
  })
  return finishStep(updated, step, nextStepId, deps)
}

async function processRepeatStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const repeat = step.repeat
  if (!repeat?.bodyStepId) {
    throw new Error(`Repeat step "${step.label}" is missing a body step.`)
  }
  const started = beginStep(run, step, deps)
  const currentLoop = started.loopState?.[step.id] || { stepId: step.id, iterationCount: 0 }
  const explicitDecision = deps?.decideRepeatContinuation
    ? await deps.decideRepeatContinuation({
        run: started,
        step,
        repeat,
        iterationCount: currentLoop.iterationCount,
      })
    : null
  const shouldExit = explicitDecision === 'exit'
    || (explicitDecision !== 'continue' && evaluateProtocolCondition(started, repeat.exitCondition))
  const nextAfterRepeat = cleanText(repeat.nextStepId || step.nextStepId, 64) || null
  if (shouldExit) {
    return finishStep(started, step, nextAfterRepeat, deps)
  }
  if (currentLoop.iterationCount >= repeat.maxIterations) {
    appendProtocolEvent(run.id, {
      type: 'loop_exhausted',
      stepId: step.id,
      summary: `Loop "${step.label}" exhausted its ${repeat.maxIterations} iteration limit.`,
      data: { maxIterations: repeat.maxIterations, onExhausted: repeat.onExhausted || 'fail' },
    }, deps)
    if (repeat.onExhausted === 'advance') {
      return finishStep(started, step, nextAfterRepeat, deps)
    }
    throw new Error(`Structured session loop "${step.label}" exhausted its iteration limit.`)
  }
  const nextIteration = currentLoop.iterationCount + 1
  appendProtocolEvent(run.id, {
    type: 'loop_iteration_started',
    stepId: step.id,
    summary: `Started loop iteration ${nextIteration} for ${step.label}.`,
    data: { iterationCount: nextIteration, bodyStepId: repeat.bodyStepId },
  }, deps)
  const updated = persistRun({
    ...started,
    loopState: {
      ...(started.loopState || {}),
      [step.id]: {
        stepId: step.id,
        iterationCount: nextIteration,
      },
    },
    updatedAt: now(deps),
  })
  return finishStep(updated, step, cleanText(repeat.bodyStepId, 64) || null, deps)
}

function buildJoinArtifactContent(branches: ProtocolRunParallelBranchState[]): string {
  const lines = ['Parallel branch results:']
  for (const branch of branches) {
    lines.push('')
    lines.push(`- ${branch.label} (${branch.status})`)
    if (branch.summary) lines.push(`  ${branch.summary}`)
    else if (branch.lastError) lines.push(`  ${branch.lastError}`)
  }
  return lines.join('\n')
}

async function processParallelStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const parallel = step.parallel
  if (!parallel?.branches?.length) {
    throw new Error(`Parallel step "${step.label}" is missing branches.`)
  }
  const joinStepId = cleanText(step.nextStepId, 64)
  if (!joinStepId) {
    throw new Error(`Parallel step "${step.label}" is missing a join step.`)
  }
  const joinStep = findRunStep(run, joinStepId)
  if (!joinStep || joinStep.kind !== 'join') {
    throw new Error(`Parallel step "${step.label}" must point to an explicit join step.`)
  }
  const started = beginStep(run, step, deps)
  const branches: ProtocolRunParallelBranchState[] = []
  appendProtocolEvent(run.id, {
    type: 'parallel_started',
    stepId: step.id,
    summary: `Started parallel step "${step.label}" with ${parallel.branches.length} branches.`,
    data: { joinStepId, branchCount: parallel.branches.length },
  }, deps)

  for (const branch of parallel.branches) {
    const participantAgentIds = uniqueIds(
      Array.isArray(branch.participantAgentIds) && branch.participantAgentIds.length > 0
        ? branch.participantAgentIds
        : started.participantAgentIds,
      64,
    )
    const childRun = createProtocolRun({
      title: buildParallelBranchRunTitle(started, step, branch),
      templateId: 'custom',
      steps: branch.steps,
      entryStepId: branch.entryStepId || branch.steps[0]?.id || null,
      participantAgentIds,
      facilitatorAgentId: cleanText(branch.facilitatorAgentId, 64) || participantAgentIds[0] || null,
      observerAgentIds: uniqueIds(branch.observerAgentIds, 32),
      sessionId: started.sessionId || null,
      sourceRef: {
        kind: 'protocol_run',
        runId: started.id,
        parentRunId: started.id,
        stepId: step.id,
        branchId: branch.id,
      },
      autoStart: false,
      createTranscript: true,
      config: {
        ...(started.config || {}),
        goal: buildParallelBranchGoal(started, step, branch),
        postSummaryToParent: false,
      },
      parentRunId: started.id,
      parentStepId: step.id,
      branchId: branch.id,
      systemOwned: true,
    }, deps)
    const branchState = buildParallelBranchState(childRun, {
      branchId: branch.id,
      label: branch.label,
      runId: childRun.id,
      participantAgentIds,
    })
    branches.push(branchState)
    appendProtocolEvent(run.id, {
      type: 'parallel_branch_spawned',
      stepId: step.id,
      summary: `Spawned branch "${branch.label}".`,
      data: { branchId: branch.id, childRunId: childRun.id, participantAgentIds },
    }, deps)
  }

  const parallelState = buildParallelStepState(step.id, branches)
  const progressed = finishStep(persistRun({
    ...started,
    parallelState: {
      ...(started.parallelState || {}),
      [step.id]: parallelState,
    },
    updatedAt: now(deps),
  }), step, joinStepId, deps)
  const updated = persistRun({
    ...progressed,
    status: 'waiting',
    waitingReason: `Waiting for ${parallel.branches.length} parallel branch${parallel.branches.length === 1 ? '' : 'es'} to finish before joining.`,
    updatedAt: now(deps),
  })
  for (const branch of branches) {
    requestProtocolRunExecution(branch.runId, deps)
  }
  return updated
}

async function processJoinStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const started = beginStep(run, step, deps)
  const parallelStepId = findParallelStepIdForJoin(started, step)
  if (!parallelStepId) {
    throw new Error(`Join step "${step.label}" could not resolve its parallel source step.`)
  }
  const parallelState = started.parallelState?.[parallelStepId]
  if (!parallelState) {
    throw new Error(`Join step "${step.label}" has no recorded parallel state.`)
  }
  if (!parallelState.joinReady) {
    return persistRun({
      ...started,
      status: 'waiting',
      waitingReason: `Waiting for ${parallelState.waitingOnBranchIds?.length || 0} parallel branch${parallelState.waitingOnBranchIds?.length === 1 ? '' : 'es'} to finish before joining.`,
      updatedAt: now(deps),
    })
  }
  const failedBranches = parallelState.branches.filter((branch) => branch.status !== 'completed')
  if (failedBranches.length > 0 && failedBranches.length === parallelState.branches.length) {
    throw new Error(`Structured session join "${step.label}" could not continue because all ${failedBranches.length} branch${failedBranches.length === 1 ? '' : 'es'} failed or stopped.`)
  }
  if (failedBranches.length > 0) {
    appendProtocolEvent(run.id, {
      type: 'warning',
      stepId: step.id,
      summary: `Join "${step.label}" continuing with partial results: ${failedBranches.length} of ${parallelState.branches.length} branch(es) did not complete.`,
    }, deps)
  }
  const artifact = {
    id: genId(),
    kind: 'notes' as const,
    title: `${step.label} branch merge`,
    content: buildJoinArtifactContent(parallelState.branches),
    phaseId: step.id,
    createdAt: now(deps),
  }
  appendProtocolEvent(run.id, {
    type: 'artifact_emitted',
    stepId: step.id,
    artifactId: artifact.id,
    summary: `Recorded the merged output for ${step.label}.`,
  }, deps)
  appendProtocolEvent(run.id, {
    type: 'join_completed',
    stepId: step.id,
    summary: `Joined ${parallelState.branches.length} parallel branches.`,
    data: { parallelStepId, artifactId: artifact.id },
  }, deps)
  if (started.transcriptChatroomId) {
    appendTranscriptMessage(started.transcriptChatroomId, {
      senderId: 'system',
      senderName: 'Structured Session',
      role: 'assistant',
      text: artifact.content,
      mentions: [],
      reactions: [],
    }, deps)
  }
  const updated = persistRun({
    ...started,
    artifacts: [...(started.artifacts || []), artifact],
    latestArtifactId: artifact.id,
    parallelState: {
      ...(started.parallelState || {}),
      [parallelStepId]: {
        ...parallelState,
        joinCompletedAt: now(deps),
      },
    },
    updatedAt: now(deps),
  })
  return finishStep(updated, step, cleanText(step.nextStepId, 64) || null, deps)
}

function processDispatchTaskPhase(run: ProtocolRun, phase: ProtocolPhaseDefinition, deps?: ProtocolRunDeps): ProtocolRun {
  const config = phase.taskConfig
  if (!config?.title) {
    appendProtocolEvent(run.id, {
      type: 'failed',
      phaseId: phase.id,
      summary: `dispatch_task phase "${phase.label}" has no taskConfig.title`,
    }, deps)
    return persistRun({
      ...run,
      status: 'failed',
      lastError: `dispatch_task phase "${phase.label}" has no taskConfig.title`,
      endedAt: run.endedAt || now(deps),
      updatedAt: now(deps),
    })
  }
  const agentId = config.agentId || run.facilitatorAgentId || run.participantAgentIds[0] || ''
  if (!agentId) {
    appendProtocolEvent(run.id, {
      type: 'failed',
      phaseId: phase.id,
      summary: `dispatch_task phase "${phase.label}" has no agentId`,
    }, deps)
    return persistRun({
      ...run,
      status: 'failed',
      lastError: `dispatch_task phase "${phase.label}" has no agentId`,
      endedAt: run.endedAt || now(deps),
      updatedAt: now(deps),
    })
  }
  const taskId = genId()
  const taskData: BoardTask = {
    id: taskId,
    title: config.title,
    description: config.description || '',
    status: 'queued',
    agentId,
    protocolRunId: run.id,
    missionId: run.missionId || null,
    queuedAt: now(deps),
    createdAt: now(deps),
    updatedAt: now(deps),
  }
  upsertTask(taskId, taskData)
  enqueueTask(taskId)
  const createdTaskIds = [...(run.createdTaskIds || []), taskId]
  appendProtocolEvent(run.id, {
    type: 'task_dispatched',
    summary: `Dispatched task: ${config.title}`,
    phaseId: phase.id,
    taskId,
  }, deps)
  notify('tasks')
  return persistRun({
    ...run,
    status: 'waiting',
    waitingReason: `Waiting for task: ${config.title}`,
    createdTaskIds,
    phaseState: { ...(run.phaseState || { phaseId: phase.id }), dispatchedTaskId: taskId } as ProtocolRunPhaseState,
    updatedAt: now(deps),
  })
}

function processDispatchDelegationPhase(run: ProtocolRun, phase: ProtocolPhaseDefinition, deps?: ProtocolRunDeps): ProtocolRun {
  const config = phase.delegationConfig
  if (!config?.agentId || !config?.message) {
    appendProtocolEvent(run.id, {
      type: 'failed',
      phaseId: phase.id,
      summary: `dispatch_delegation phase "${phase.label}" missing delegationConfig`,
    }, deps)
    return persistRun({
      ...run,
      status: 'failed',
      lastError: `dispatch_delegation phase "${phase.label}" missing delegationConfig`,
      endedAt: run.endedAt || now(deps),
      updatedAt: now(deps),
    })
  }
  const taskId = genId()
  const taskData: BoardTask = {
    id: taskId,
    title: `Delegation: ${phase.label}`,
    description: config.message,
    status: 'queued',
    agentId: config.agentId,
    protocolRunId: run.id,
    missionId: run.missionId || null,
    sourceType: 'delegation',
    queuedAt: now(deps),
    createdAt: now(deps),
    updatedAt: now(deps),
  }
  upsertTask(taskId, taskData)
  enqueueTask(taskId)
  const createdTaskIds = [...(run.createdTaskIds || []), taskId]
  appendProtocolEvent(run.id, {
    type: 'delegation_dispatched',
    summary: `Dispatched delegation to agent: ${config.agentId}`,
    phaseId: phase.id,
    taskId,
  }, deps)
  notify('tasks')
  return persistRun({
    ...run,
    status: 'waiting',
    waitingReason: `Waiting for delegation: ${phase.label}`,
    createdTaskIds,
    phaseState: { ...(run.phaseState || { phaseId: phase.id }), dispatchedTaskId: taskId } as ProtocolRunPhaseState,
    updatedAt: now(deps),
  })
}

// --- For-Each Step ---

async function resolveForEachItems(
  run: ProtocolRun,
  config: ProtocolForEachConfig,
): Promise<unknown[]> {
  const source = config.itemsSource
  if (source.type === 'literal') return source.items
  if (source.type === 'step_output') {
    const output = run.stepOutputs?.[source.stepId]
    if (!output?.structuredData) return []
    if (source.path) {
      const val = (output.structuredData as Record<string, unknown>)[source.path]
      return Array.isArray(val) ? val : []
    }
    const data = output.structuredData
    // If structuredData is itself an array-like value, extract items
    if (Array.isArray(data)) return data
    if ('items' in data && Array.isArray(data.items)) return data.items as unknown[]
    return [data]
  }
  if (source.type === 'artifact') {
    const artifacts = run.artifacts || []
    if (source.artifactId) {
      const found = artifacts.find((a) => a.id === source.artifactId)
      return found ? [found.content] : []
    }
    if (source.artifactKind) {
      return artifacts.filter((a) => a.kind === source.artifactKind).map((a) => a.content)
    }
    return artifacts.map((a) => a.content)
  }
  // llm_extract would require an LLM call — for now, return empty (to be extended)
  return []
}

async function processForEachStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const config = step.forEach
  if (!config) {
    throw new Error(`For-each step "${step.label}" is missing forEach config.`)
  }

  const started = beginStep(run, step, deps)
  const items = await resolveForEachItems(started, config)

  const maxItems = config.maxItems || 50
  const truncatedItems = items.slice(0, maxItems)

  if (truncatedItems.length === 0) {
    const policy = config.onEmpty || 'fail'
    if (policy === 'fail') {
      throw new Error(`For-each step "${step.label}" resolved zero items and onEmpty is "fail".`)
    }
    appendProtocolEvent(run.id, {
      type: 'for_each_expanded',
      stepId: step.id,
      summary: `For-each step "${step.label}" resolved zero items, policy: ${policy}.`,
      data: { itemCount: 0, policy },
    }, deps)
    if (policy === 'skip') {
      return finishStep(started, step, step.nextStepId || null, deps)
    }
    // 'advance'
    return finishStep(started, step, step.nextStepId || null, deps)
  }

  if (truncatedItems.length < items.length) {
    appendProtocolEvent(run.id, {
      type: 'warning',
      stepId: step.id,
      summary: `For-each items truncated from ${items.length} to ${maxItems} (maxItems limit).`,
    }, deps)
  }

  const branches: ProtocolRunParallelBranchState[] = []
  const branchRunIds: string[] = []
  const branchTemplate = config.branchTemplate

  const participantAgentIds = uniqueIds(
    branchTemplate.participantAgentIds && branchTemplate.participantAgentIds.length > 0
      ? branchTemplate.participantAgentIds
      : started.participantAgentIds,
    64,
  )

  appendProtocolEvent(run.id, {
    type: 'for_each_expanded',
    stepId: step.id,
    summary: `For-each step "${step.label}" expanding ${truncatedItems.length} items into branches.`,
    data: { itemCount: truncatedItems.length, alias: config.itemAlias },
  }, deps)

  for (let i = 0; i < truncatedItems.length; i++) {
    const item = truncatedItems[i]
    const branchId = `for_each_${i}`
    const itemLabel = typeof item === 'string' ? item.slice(0, 80) : `Item ${i + 1}`
    const childRun = createProtocolRun({
      title: `${started.title} — ${config.itemAlias}: ${itemLabel}`,
      templateId: 'custom',
      steps: branchTemplate.steps,
      entryStepId: branchTemplate.entryStepId || branchTemplate.steps[0]?.id || null,
      participantAgentIds,
      facilitatorAgentId: cleanText(branchTemplate.facilitatorAgentId, 64) || participantAgentIds[0] || null,
      sessionId: started.sessionId || null,
      sourceRef: {
        kind: 'protocol_run',
        runId: started.id,
        parentRunId: started.id,
        stepId: step.id,
        branchId,
      },
      autoStart: false,
      createTranscript: true,
      config: {
        ...(started.config || {}),
        goal: `Process ${config.itemAlias}: ${typeof item === 'string' ? item : JSON.stringify(item)}`,
        postSummaryToParent: false,
      },
      parentRunId: started.id,
      parentStepId: step.id,
      branchId,
      systemOwned: true,
    }, deps)
    // Inject item context into child run's operatorContext
    const itemContext = `[for_each] ${config.itemAlias} = ${typeof item === 'string' ? item : JSON.stringify(item)}`
    persistRun({
      ...childRun,
      operatorContext: [...(childRun.operatorContext || []), itemContext],
    })
    branchRunIds.push(childRun.id)
    branches.push(buildParallelBranchState(childRun, {
      branchId,
      label: itemLabel,
      runId: childRun.id,
      participantAgentIds,
    }))
  }

  const forEachStepState: ProtocolRunForEachStepState = {
    stepId: step.id,
    items: truncatedItems,
    branchRunIds,
    branches,
    waitingOnBranchIds: branchRunIds,
    joinReady: false,
    joinCompletedAt: null,
  }

  const updated = persistRun({
    ...started,
    forEachState: {
      ...(started.forEachState || {}),
      [step.id]: forEachStepState,
    },
    status: 'waiting',
    waitingReason: `Waiting for ${truncatedItems.length} for-each branch${truncatedItems.length === 1 ? '' : 'es'} to complete.`,
    updatedAt: now(deps),
  })

  for (const runId of branchRunIds) {
    requestProtocolRunExecution(runId, deps)
  }
  return updated
}

function syncForEachParentFromChildRun(
  child: ProtocolRun,
  parent: ProtocolRun,
  forEachState: ProtocolRunForEachStepState,
  deps?: ProtocolRunDeps,
): ProtocolRun | null {
  const nextBranches = forEachState.branches.map((branch) => (
    branch.runId === child.id ? buildParallelBranchState(child, branch) : branch
  ))
  const waitingOnBranchIds = nextBranches
    .filter((b) => !isTerminalProtocolRunStatus(b.status))
    .map((b) => b.branchId)
  const joinReady = waitingOnBranchIds.length === 0 && nextBranches.length > 0
  const nextState: ProtocolRunForEachStepState = {
    ...forEachState,
    branches: nextBranches,
    waitingOnBranchIds,
    joinReady,
    joinCompletedAt: joinReady && !forEachState.joinCompletedAt ? now(deps) : forEachState.joinCompletedAt || null,
  }

  const updatedParent = updateRun(parent.id, (current) => ({
    ...current,
    forEachState: {
      ...(current.forEachState || {}),
      [child.parentStepId!]: nextState,
    },
    updatedAt: now(deps),
  }))
  if (!updatedParent) return null

  if (isTerminalProtocolRunStatus(child.status)) {
    appendProtocolEvent(updatedParent.id, {
      type: child.status === 'completed' ? 'parallel_branch_completed' : 'parallel_branch_failed',
      stepId: child.parentStepId,
      summary: `For-each branch "${child.branchId || child.id}" ${child.status}.`,
      data: { branchId: child.branchId, childRunId: child.id, status: child.status },
    }, deps)
  }

  if (joinReady && !forEachState.joinReady) {
    appendProtocolEvent(updatedParent.id, {
      type: 'join_ready',
      stepId: child.parentStepId,
      summary: 'All for-each branches completed. Advancing parent.',
      data: { childRunIds: nextState.branchRunIds },
    }, deps)
  }

  if (joinReady && updatedParent.status === 'waiting') {
    // Advance past the for_each step
    const parentStep = findRunStep(updatedParent, child.parentStepId!)
    if (parentStep) {
      const nextStepId = parentStep.nextStepId || null
      const nextIndex = nextStepId && Array.isArray(updatedParent.steps)
        ? Math.max(0, updatedParent.steps.findIndex((s) => s.id === nextStepId))
        : Array.isArray(updatedParent.steps) ? updatedParent.steps.length : updatedParent.currentPhaseIndex + 1
      persistRun({
        ...updatedParent,
        status: 'running',
        currentStepId: nextStepId,
        currentPhaseIndex: nextIndex,
        waitingReason: null,
        updatedAt: now(deps),
      })
    }
    requestProtocolRunExecution(updatedParent.id, deps)
  }
  return loadProtocolRunById(updatedParent.id)
}

// --- Subflow Step ---

async function processSubflowStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const config = step.subflow
  if (!config) {
    throw new Error(`Subflow step "${step.label}" is missing subflow config.`)
  }

  const template = loadTemplate(config.templateId)
  if (!template) {
    throw new Error(`Subflow step "${step.label}" references unknown template: "${config.templateId}"`)
  }

  const started = beginStep(run, step, deps)

  // Build input context from inputMapping
  const childOperatorContext: string[] = []
  if (config.inputMapping) {
    for (const [contextKey, outputRef] of Object.entries(config.inputMapping)) {
      const output = started.stepOutputs?.[outputRef]
      if (output?.summary) {
        childOperatorContext.push(`[subflow input] ${contextKey}: ${output.summary}`)
      } else if (output?.structuredData) {
        childOperatorContext.push(`[subflow input] ${contextKey}: ${JSON.stringify(output.structuredData)}`)
      }
    }
  }

  const participantAgentIds = uniqueIds(
    config.participantAgentIds && config.participantAgentIds.length > 0
      ? config.participantAgentIds
      : started.participantAgentIds,
    64,
  )

  const childRun = createProtocolRun({
    title: `${started.title} — Subflow: ${template.name}`,
    templateId: config.templateId,
    participantAgentIds,
    facilitatorAgentId: config.facilitatorAgentId || participantAgentIds[0] || null,
    sessionId: started.sessionId || null,
    sourceRef: {
      kind: 'protocol_run',
      runId: started.id,
      parentRunId: started.id,
      stepId: step.id,
    },
    autoStart: false,
    createTranscript: true,
    config: {
      ...(started.config || {}),
      postSummaryToParent: false,
    },
    parentRunId: started.id,
    parentStepId: step.id,
    systemOwned: true,
  }, deps)

  if (childOperatorContext.length > 0) {
    persistRun({
      ...childRun,
      operatorContext: [...(childRun.operatorContext || []), ...childOperatorContext],
    })
  }

  const subflowState: ProtocolRunSubflowState = {
    stepId: step.id,
    childRunId: childRun.id,
    templateId: config.templateId,
    status: childRun.status,
    summary: null,
    lastError: null,
    startedAt: now(deps),
    completedAt: null,
  }

  appendProtocolEvent(run.id, {
    type: 'subflow_started',
    stepId: step.id,
    summary: `Started subflow "${template.name}" as child run.`,
    data: { childRunId: childRun.id, templateId: config.templateId },
  }, deps)

  const updated = persistRun({
    ...started,
    subflowState: {
      ...(started.subflowState || {}),
      [step.id]: subflowState,
    },
    status: 'waiting',
    waitingReason: `Waiting for subflow "${template.name}" to complete.`,
    updatedAt: now(deps),
  })

  requestProtocolRunExecution(childRun.id, deps)
  return updated
}

function syncSubflowParentFromChildRun(
  child: ProtocolRun,
  parent: ProtocolRun,
  subState: ProtocolRunSubflowState,
  deps?: ProtocolRunDeps,
): ProtocolRun | null {
  if (!isTerminalProtocolRunStatus(child.status)) {
    // Just update status tracking
    const updatedState: ProtocolRunSubflowState = { ...subState, status: child.status }
    return updateRun(parent.id, (current) => ({
      ...current,
      subflowState: { ...(current.subflowState || {}), [child.parentStepId!]: updatedState },
      updatedAt: now(deps),
    }))
  }

  const parentStep = findRunStep(parent, child.parentStepId!)
  const config = parentStep?.subflow

  if (child.status === 'completed') {
    // Apply output mapping
    let updatedParent = parent
    if (config?.outputMapping) {
      const childOutputs = child.stepOutputs || {}
      for (const [childKey, parentKey] of Object.entries(config.outputMapping)) {
        const childOutput = childOutputs[childKey]
        if (childOutput) {
          updatedParent = {
            ...updatedParent,
            stepOutputs: {
              ...(updatedParent.stepOutputs || {}),
              [parentKey]: { ...childOutput, stepId: child.parentStepId! },
            },
          }
        }
      }
    }

    const nextSubState: ProtocolRunSubflowState = {
      ...subState,
      status: 'completed',
      summary: child.summary || null,
      completedAt: now(deps),
    }

    appendProtocolEvent(parent.id, {
      type: 'subflow_completed',
      stepId: child.parentStepId,
      summary: `Subflow completed: ${child.title}`,
      data: { childRunId: child.id },
    }, deps)

    // Advance parent past the subflow step
    const nextStepId = parentStep?.nextStepId || null
    const nextIndex = nextStepId && Array.isArray(updatedParent.steps)
      ? Math.max(0, updatedParent.steps.findIndex((s) => s.id === nextStepId))
      : Array.isArray(updatedParent.steps) ? updatedParent.steps.length : updatedParent.currentPhaseIndex + 1
    persistRun({
      ...updatedParent,
      subflowState: { ...(updatedParent.subflowState || {}), [child.parentStepId!]: nextSubState },
      status: 'running',
      currentStepId: nextStepId,
      currentPhaseIndex: nextIndex,
      waitingReason: null,
      updatedAt: now(deps),
    })
    requestProtocolRunExecution(parent.id, deps)
    return loadProtocolRunById(parent.id)
  }

  // Child failed or cancelled
  const failPolicy = config?.onFailure || 'fail_parent'
  const nextSubState: ProtocolRunSubflowState = {
    ...subState,
    status: child.status,
    lastError: child.lastError || null,
    completedAt: now(deps),
  }

  if (failPolicy === 'fail_parent') {
    appendProtocolEvent(parent.id, {
      type: 'subflow_failed',
      stepId: child.parentStepId,
      summary: `Subflow failed: ${child.lastError || child.status}`,
      data: { childRunId: child.id, status: child.status },
    }, deps)
    persistRun({
      ...parent,
      subflowState: { ...(parent.subflowState || {}), [child.parentStepId!]: nextSubState },
      status: 'failed',
      lastError: `Subflow "${child.title}" ${child.status}: ${child.lastError || 'no details'}`,
      endedAt: parent.endedAt || now(deps),
      updatedAt: now(deps),
    })
    return loadProtocolRunById(parent.id)
  }

  // advance_with_warning
  appendProtocolEvent(parent.id, {
    type: 'warning',
    stepId: child.parentStepId,
    summary: `Subflow "${child.title}" ${child.status} but advancing with warning.`,
    data: { childRunId: child.id, status: child.status },
  }, deps)

  const nextStepId = parentStep?.nextStepId || null
  const nextIndex = nextStepId && Array.isArray(parent.steps)
    ? Math.max(0, parent.steps.findIndex((s) => s.id === nextStepId))
    : Array.isArray(parent.steps) ? parent.steps.length : parent.currentPhaseIndex + 1
  persistRun({
    ...parent,
    subflowState: { ...(parent.subflowState || {}), [child.parentStepId!]: nextSubState },
    status: 'running',
    currentStepId: nextStepId,
    currentPhaseIndex: nextIndex,
    waitingReason: null,
    updatedAt: now(deps),
  })
  requestProtocolRunExecution(parent.id, deps)
  return loadProtocolRunById(parent.id)
}

// --- Swarm / Self-Selection Step ---

function resolveSwarmWorkItems(
  run: ProtocolRun,
  config: ProtocolSwarmConfig,
): Array<{ id: string; label: string; description?: string | null }> {
  const source = config.workItemsSource
  if (source.type === 'literal') return source.items
  if (source.type === 'step_output') {
    const output = run.stepOutputs?.[source.stepId]
    if (!output?.structuredData) return []
    const data = source.path
      ? (output.structuredData as Record<string, unknown>)[source.path]
      : output.structuredData
    if (Array.isArray(data)) {
      return data
        .filter((item): item is { id: string; label: string; description?: string | null } =>
          typeof item === 'object' && item !== null && 'id' in item && 'label' in item,
        )
    }
    return []
  }
  return []
}

async function processSwarmStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const config = step.swarm
  if (!config) {
    throw new Error(`Swarm step "${step.label}" is missing swarm config.`)
  }

  const started = beginStep(run, step, deps)
  const workItems = resolveSwarmWorkItems(started, config)

  if (workItems.length === 0) {
    throw new Error(`Swarm step "${step.label}" resolved zero work items.`)
  }

  const claimLimit = config.claimLimitPerAgent || 1
  const agents = config.eligibleAgentIds
  const claims: import('@/types').ProtocolSwarmClaim[] = []
  const unclaimedItemIds = workItems.map((item) => item.id)
  const createdTaskIds = [...(started.createdTaskIds || [])]

  // Auto-assign: round-robin across eligible agents
  let agentIndex = 0
  const agentClaimCounts = new Map<string, number>()
  for (const agentId of agents) agentClaimCounts.set(agentId, 0)

  for (const workItem of workItems) {
    // Find next agent that hasn't hit their claim limit
    let assigned = false
    for (let attempt = 0; attempt < agents.length; attempt++) {
      const agentId = agents[agentIndex % agents.length]
      agentIndex++
      const currentCount = agentClaimCounts.get(agentId) || 0
      if (currentCount >= claimLimit) continue

      // Create a task for this claim
      const taskId = genId()
      const taskData: BoardTask = {
        id: taskId,
        title: `Swarm: ${workItem.label}`,
        description: workItem.description || `Work item from swarm step "${step.label}"`,
        status: 'queued',
        agentId,
        protocolRunId: started.id,
        missionId: started.missionId || null,
        sourceType: 'delegation',
        queuedAt: now(deps),
        createdAt: now(deps),
        updatedAt: now(deps),
      }
      upsertTask(taskId, taskData)
      enqueueTask(taskId)
      createdTaskIds.push(taskId)

      claims.push({
        id: genId(),
        workItemId: workItem.id,
        workItemLabel: workItem.label,
        agentId,
        childRunId: null,
        taskId,
        status: 'running',
        claimedAt: now(deps),
        completedAt: null,
      })
      agentClaimCounts.set(agentId, currentCount + 1)
      const idx = unclaimedItemIds.indexOf(workItem.id)
      if (idx >= 0) unclaimedItemIds.splice(idx, 1)
      assigned = true
      break
    }

    if (!assigned) {
      // All agents at capacity for this item — leave it unclaimed
      break
    }
  }

  const swarmState: ProtocolRunSwarmState = {
    stepId: step.id,
    workItems,
    claims,
    unclaimedItemIds,
    eligibleAgentIds: agents,
    claimLimitPerAgent: claimLimit,
    selectionMode: config.selectionMode,
    claimTimeoutSec: config.claimTimeoutSec,
    openedAt: now(deps),
    closedAt: null,
    timedOut: false,
  }

  appendProtocolEvent(run.id, {
    type: 'swarm_opened',
    stepId: step.id,
    summary: `Swarm step "${step.label}" opened with ${workItems.length} work items and ${claims.length} claims.`,
    data: { workItemCount: workItems.length, claimCount: claims.length, eligibleAgents: agents },
  }, deps)

  notify('tasks')

  const updated = persistRun({
    ...started,
    swarmState: {
      ...(started.swarmState || {}),
      [step.id]: swarmState,
    },
    createdTaskIds,
    status: 'waiting',
    waitingReason: `Waiting for ${claims.length} swarm claim${claims.length === 1 ? '' : 's'} to complete.`,
    updatedAt: now(deps),
  })
  return updated
}

export function claimSwarmWorkItem(
  runId: string,
  stepId: string,
  agentId: string,
  workItemId: string,
  deps?: ProtocolRunDeps,
): { success: boolean; error?: string } {
  const run = loadProtocolRunById(runId)
  if (!run) return { success: false, error: 'Run not found' }
  const state = run.swarmState?.[stepId]
  if (!state) return { success: false, error: 'No swarm state for step' }
  if (!state.unclaimedItemIds.includes(workItemId)) return { success: false, error: 'Work item already claimed or invalid' }
  if (!state.eligibleAgentIds.includes(agentId)) return { success: false, error: 'Agent not eligible' }

  const agentClaims = state.claims.filter((c) => c.agentId === agentId).length
  if (agentClaims >= state.claimLimitPerAgent) return { success: false, error: 'Agent at claim limit' }

  const workItem = state.workItems.find((item) => item.id === workItemId)
  if (!workItem) return { success: false, error: 'Work item not found' }

  const taskId = genId()
  const taskData: BoardTask = {
    id: taskId,
    title: `Swarm: ${workItem.label}`,
    description: workItem.description || '',
    status: 'queued',
    agentId,
    protocolRunId: runId,
    missionId: run.missionId || null,
    sourceType: 'delegation',
    queuedAt: now(deps),
    createdAt: now(deps),
    updatedAt: now(deps),
  }
  upsertTask(taskId, taskData)
  enqueueTask(taskId)

  const claim: import('@/types').ProtocolSwarmClaim = {
    id: genId(),
    workItemId,
    workItemLabel: workItem.label,
    agentId,
    childRunId: null,
    taskId,
    status: 'running',
    claimedAt: now(deps),
    completedAt: null,
  }

  const nextUnclaimed = state.unclaimedItemIds.filter((id) => id !== workItemId)
  updateRun(runId, (current) => ({
    ...current,
    swarmState: {
      ...(current.swarmState || {}),
      [stepId]: {
        ...state,
        claims: [...state.claims, claim],
        unclaimedItemIds: nextUnclaimed,
      },
    },
    createdTaskIds: [...(current.createdTaskIds || []), taskId],
    updatedAt: now(deps),
  }))
  appendProtocolEvent(runId, {
    type: 'swarm_claimed',
    stepId,
    summary: `Agent "${agentId}" claimed work item "${workItem.label}".`,
    data: { agentId, workItemId, taskId },
  }, deps)
  notify('tasks')
  return { success: true }
}

export function syncSwarmClaimCompletion(taskId: string, deps?: ProtocolRunDeps): void {
  const task = loadTask(taskId)
  if (!task?.protocolRunId) return
  const run = loadProtocolRunById(task.protocolRunId)
  if (!run) return
  const terminalStatuses = ['completed', 'failed', 'cancelled']
  if (!terminalStatuses.includes(task.status)) return

  for (const [stepId, state] of Object.entries(run.swarmState || {})) {
    const claimIndex = state.claims.findIndex((c) => c.taskId === taskId)
    if (claimIndex < 0) continue

    const claim = state.claims[claimIndex]
    const updatedClaim = {
      ...claim,
      status: (task.status === 'completed' ? 'completed' : 'failed') as 'completed' | 'failed',
      completedAt: now(deps),
    }
    const nextClaims = [...state.claims]
    nextClaims[claimIndex] = updatedClaim

    const allTerminal = nextClaims.every((c) => c.status === 'completed' || c.status === 'failed')
    const noUnclaimed = state.unclaimedItemIds.length === 0

    updateRun(run.id, (current) => ({
      ...current,
      swarmState: {
        ...(current.swarmState || {}),
        [stepId]: { ...state, claims: nextClaims },
      },
      updatedAt: now(deps),
    }))

    if (allTerminal && noUnclaimed) {
      appendProtocolEvent(run.id, {
        type: 'swarm_exhausted',
        stepId,
        summary: `All swarm claims completed for step.`,
        data: { completedCount: nextClaims.filter((c) => c.status === 'completed').length, failedCount: nextClaims.filter((c) => c.status === 'failed').length },
      }, deps)

      // Advance parent past the swarm step
      const parentStep = findRunStep(run, stepId)
      if (parentStep && run.status === 'waiting') {
        const nextStepId = parentStep.nextStepId || null
        const nextIndex = nextStepId && Array.isArray(run.steps)
          ? Math.max(0, run.steps.findIndex((s) => s.id === nextStepId))
          : Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex + 1
        persistRun({
          ...run,
          swarmState: { ...(run.swarmState || {}), [stepId]: { ...state, claims: nextClaims, closedAt: now(deps) } },
          status: 'running',
          currentStepId: nextStepId,
          currentPhaseIndex: nextIndex,
          waitingReason: null,
          updatedAt: now(deps),
        })
        requestProtocolRunExecution(run.id, deps)
      }
    }
    break
  }
}

export function checkSwarmTimeouts(deps?: ProtocolRunDeps): void {
  const runs = Object.values(loadProtocolRuns()).map(normalizeProtocolRun)
  const timestamp = now(deps)
  for (const run of runs) {
    if (run.status !== 'waiting') continue
    for (const [stepId, state] of Object.entries(run.swarmState || {})) {
      if (state.closedAt || state.timedOut) continue
      if (timestamp - state.openedAt < state.claimTimeoutSec * 1000) continue

      // Timed out
      const step = findRunStep(run, stepId)
      const onUnclaimed = step?.swarm?.onUnclaimed || 'fail'

      appendProtocolEvent(run.id, {
        type: 'swarm_exhausted',
        stepId,
        summary: `Swarm step timed out after ${state.claimTimeoutSec}s with ${state.unclaimedItemIds.length} unclaimed items.`,
        data: { unclaimedCount: state.unclaimedItemIds.length, policy: onUnclaimed },
      }, deps)

      if (onUnclaimed === 'fail') {
        persistRun({
          ...run,
          swarmState: { ...(run.swarmState || {}), [stepId]: { ...state, timedOut: true, closedAt: timestamp } },
          status: 'failed',
          lastError: `Swarm step "${step?.label || stepId}" timed out with unclaimed work items.`,
          endedAt: run.endedAt || timestamp,
          updatedAt: timestamp,
        })
      } else {
        // 'advance' or 'fallback_assign'
        const nextStepId = step?.nextStepId || null
        const nextIndex = nextStepId && Array.isArray(run.steps)
          ? Math.max(0, run.steps.findIndex((s) => s.id === nextStepId))
          : Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex + 1
        persistRun({
          ...run,
          swarmState: { ...(run.swarmState || {}), [stepId]: { ...state, timedOut: true, closedAt: timestamp } },
          status: 'running',
          currentStepId: nextStepId,
          currentPhaseIndex: nextIndex,
          waitingReason: null,
          updatedAt: timestamp,
        })
        requestProtocolRunExecution(run.id, deps)
      }
    }
  }
}

async function stepProtocolRun(run: ProtocolRun, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const step = currentStep(run)
  if (!step) {
    return completeProtocolRun(run, deps)
  }
  if (isDiscussionStepKind(step.kind)) {
    const phase = phaseFromStep(step)
    const started = beginPhase(run, phase, deps)
    if (phase.kind === 'present') return processPresentPhase(started, phase, deps)
    if (phase.kind === 'collect_independent_inputs') return collectResponses(started, phase, false, deps)
    if (phase.kind === 'round_robin') return collectResponses(started, phase, true, deps)
    if (phase.kind === 'compare') return processFacilitatorArtifactPhase(started, phase, 'comparison', deps)
    if (phase.kind === 'decide') return processFacilitatorArtifactPhase(started, phase, 'decision', deps)
    if (phase.kind === 'summarize') return processFacilitatorArtifactPhase(started, phase, 'summary', deps)
    if (phase.kind === 'emit_tasks') return processEmitTasksPhase(started, phase, deps)
    if (phase.kind === 'dispatch_task') return processDispatchTaskPhase(started, phase, deps)
    if (phase.kind === 'dispatch_delegation') return processDispatchDelegationPhase(started, phase, deps)
    return processWaitPhase(started, phase, deps)
  }
  if (step.kind === 'branch') return processBranchStep(run, step, deps)
  if (step.kind === 'repeat') return processRepeatStep(run, step, deps)
  if (step.kind === 'parallel') return processParallelStep(run, step, deps)
  if (step.kind === 'join') return processJoinStep(run, step, deps)
  if (step.kind === 'for_each') return processForEachStep(run, step, deps)
  if (step.kind === 'subflow') return processSubflowStep(run, step, deps)
  if (step.kind === 'swarm_claim') return processSwarmStep(run, step, deps)
  if (step.kind === 'complete') {
    const started = beginStep(run, step, deps)
    const finished = finishStep(started, step, null, deps)
    return completeProtocolRun(finished, deps)
  }
  throw new Error(`Unsupported structured-session step kind: ${step.kind}`)
}

export function listProtocolTemplates(): ProtocolTemplate[] {
  return listAllTemplates()
}

export function listProtocolRuns(options?: {
  status?: ProtocolRunStatus | null
  missionId?: string | null
  taskId?: string | null
  sessionId?: string | null
  parentChatroomId?: string | null
  scheduleId?: string | null
  sourceKind?: ProtocolSourceRef['kind'] | null
  includeSystemOwned?: boolean
  limit?: number
}): ProtocolRun[] {
  ensureProtocolEngineRecovered()
  const limit = Number.isFinite(options?.limit) ? Math.max(1, Math.trunc(options?.limit as number)) : 200
  return Object.values(loadProtocolRuns())
    .map((run) => normalizeProtocolRun(run))
    .filter((run) => !options?.status || run.status === options.status)
    .filter((run) => !options?.missionId || run.missionId === options.missionId)
    .filter((run) => !options?.taskId || run.taskId === options.taskId)
    .filter((run) => !options?.sessionId || run.sessionId === options.sessionId)
    .filter((run) => !options?.parentChatroomId || run.parentChatroomId === options.parentChatroomId)
    .filter((run) => !options?.scheduleId || run.scheduleId === options.scheduleId)
    .filter((run) => !options?.sourceKind || run.sourceRef.kind === options.sourceKind)
    .filter((run) => options?.includeSystemOwned === true || run.systemOwned !== true)
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
    .slice(0, limit)
}

export function loadProtocolRunById(runId: string | null | undefined): ProtocolRun | null {
  const normalized = cleanText(runId, 64)
  if (!normalized) return null
  const run = loadProtocolRun(normalized)
  return run ? normalizeProtocolRun(run) : null
}

export function listProtocolRunEventsForRun(runId: string, limit = 200): ProtocolRunEvent[] {
  return listEvents(runId).slice(-Math.max(1, Math.trunc(limit)))
}

export function deleteProtocolRunById(runId: string): boolean {
  const run = loadProtocolRun(runId)
  if (!run) return false

  // Recurse into child runs (parallel branches spawn child runs)
  const allRuns = loadProtocolRuns()
  for (const childRun of Object.values(allRuns)) {
    if (childRun.parentRunId === runId) {
      deleteProtocolRunById(childRun.id)
    }
  }

  // Archive transcript chatroom
  if (run.transcriptChatroomId) {
    const chatrooms = loadChatrooms()
    const transcript = chatrooms[run.transcriptChatroomId]
    if (transcript) {
      upsertChatroom(transcript.id, { ...transcript, archivedAt: transcript.archivedAt || Date.now() })
    }
  }

  // Delete events for this run
  for (const event of listEvents(runId)) {
    deleteProtocolRunEvent(event.id)
  }

  deleteProtocolRun(runId)
  notify('protocol_runs')
  return true
}

export function getProtocolRunDetail(runId: string): ProtocolRunDetail | null {
  const run = loadProtocolRunById(runId)
  if (!run) return null
  const chatrooms = loadChatrooms()
  return {
    run,
    template: loadTemplate(run.templateId),
    transcript: run.transcriptChatroomId ? chatrooms[run.transcriptChatroomId] || null : null,
    parentChatroom: run.parentChatroomId ? chatrooms[run.parentChatroomId] || null : null,
    linkedMission: run.missionId ? loadMission(run.missionId) : null,
    linkedTask: run.taskId ? loadTask(run.taskId) : null,
    events: listEvents(run.id),
  }
}

export function hasActiveProtocolRunForSchedule(scheduleId: string): boolean {
  const activeStatuses = new Set<string>(['draft', 'running', 'waiting', 'paused'])
  for (const run of Object.values(loadProtocolRuns())) {
    if (run.scheduleId === scheduleId && activeStatuses.has(run.status)) return true
  }
  return false
}

export function createProtocolRun(input: CreateProtocolRunInput, deps?: ProtocolRunDeps): ProtocolRun {
  const agents = loadAgents()
  const participantAgentIds = uniqueIds(input.participantAgentIds, 64)
  if (participantAgentIds.length === 0) {
    throw new Error('Structured sessions require at least one participant.')
  }
  const missing = participantAgentIds.filter((agentId) => !agents[agentId])
  if (missing.length > 0) {
    throw new Error(`Unknown participant agent(s): ${missing.join(', ')}`)
  }
  const template = loadTemplate(input.templateId || null)
  const defaultTemplate = loadTemplate('facilitated_discussion')!
  const { steps, entryStepId } = resolveRunSteps({
    steps: Array.isArray(input.steps) && input.steps.length > 0 ? input.steps : template?.steps || [],
    entryStepId: input.entryStepId || template?.entryStepId || null,
    phases: Array.isArray(input.phases) && input.phases.length > 0
      ? input.phases
      : template?.defaultPhases || defaultTemplate.defaultPhases,
  })
  const phases = deriveDisplayPhasesFromSteps(steps)
  const shouldCreateTranscript = input.createTranscript !== false
  const transcript = shouldCreateTranscript
    ? createTranscriptRoom({
        runId: 'pending',
        title: input.title,
        participantAgentIds,
        parentChatroomId: input.parentChatroomId || null,
      }, deps)
    : null
  const sourceRef = input.sourceRef || (
    input.parentChatroomId ? { kind: 'chatroom', chatroomId: input.parentChatroomId } as ProtocolSourceRef
      : input.missionId ? { kind: 'mission', missionId: input.missionId } as ProtocolSourceRef
        : input.taskId ? { kind: 'task', taskId: input.taskId } as ProtocolSourceRef
          : input.scheduleId ? { kind: 'schedule', scheduleId: input.scheduleId } as ProtocolSourceRef
            : input.sessionId ? { kind: 'session', sessionId: input.sessionId } as ProtocolSourceRef
              : { kind: 'manual' } as ProtocolSourceRef
  )
  const runId = genId()
  if (transcript) {
    transcript.protocolRunId = runId
    upsertChatroom(transcript.id, transcript)
  }

  const run: ProtocolRun = normalizeProtocolRun({
    id: runId,
    title: cleanText(input.title, 160) || 'Structured Session',
    templateId: template?.id || cleanText(input.templateId, 64) || 'custom',
    templateName: template?.name || 'Custom Structured Session',
    status: input.autoStart === false ? 'draft' : 'running',
    sourceRef,
    participantAgentIds,
    facilitatorAgentId: cleanText(input.facilitatorAgentId, 64) || participantAgentIds[0] || null,
    observerAgentIds: uniqueIds(input.observerAgentIds, 32),
    missionId: cleanText(input.missionId, 64) || null,
    taskId: cleanText(input.taskId, 64) || null,
    sessionId: cleanText(input.sessionId, 64) || null,
    parentRunId: cleanText(input.parentRunId, 64) || null,
    parentStepId: cleanText(input.parentStepId, 64) || null,
    branchId: cleanText(input.branchId, 64) || null,
    parentChatroomId: cleanText(input.parentChatroomId, 64) || null,
    transcriptChatroomId: transcript?.id || null,
    scheduleId: cleanText(input.scheduleId, 64) || null,
    systemOwned: input.systemOwned === true,
    phases,
    steps,
    entryStepId,
    currentStepId: entryStepId,
    config: {
      ...(input.config || {}),
      createTranscript: shouldCreateTranscript,
      autoEmitTasks: input.config?.autoEmitTasks === true,
    },
    currentPhaseIndex: 0,
    roundNumber: 0,
    artifacts: [],
    createdTaskIds: [],
    waitingReason: null,
    lastError: null,
    phaseState: null,
    createdAt: now(deps),
    updatedAt: now(deps),
    startedAt: input.autoStart === false ? null : now(deps),
    endedAt: null,
    archivedAt: null,
  })

  persistRun(run)
  appendProtocolEvent(run.id, {
    type: 'created',
    summary: `Structured session created from template "${run.templateName}".`,
    data: {
      sourceKind: run.sourceRef.kind,
      transcriptChatroomId: run.transcriptChatroomId,
    },
  }, deps)
  if (run.missionId) {
    requestMissionTick(run.missionId, 'protocol_run_created', { protocolRunId: run.id })
  }
  if (input.autoStart !== false) {
    requestProtocolRunExecution(run.id, deps)
  }
  return run
}

export async function runProtocolRun(runId: string, deps?: ProtocolRunDeps): Promise<ProtocolRun | null> {
  const release = acquireProtocolLease(runId)
  if (!release) {
    console.warn(`[protocols] could not acquire lease for run ${runId}, another execution may be active`)
    return loadProtocolRunById(runId)
  }
  try {
    let run = loadProtocolRunById(runId)
    if (!run) return null
    if (run.status === 'cancelled' || run.status === 'archived' || run.status === 'completed' || run.status === 'paused') return run
    run = persistRun({
      ...run,
      status: run.status === 'waiting' ? 'running' : run.status,
      waitingReason: null,
      pauseReason: null,
      lastError: null,
      startedAt: run.startedAt || now(deps),
      updatedAt: now(deps),
    })
    if (run.parentRunId) syncProtocolParentFromChildRun(run, deps)

    const MAX_STEP_ITERATIONS = 500
    let stepIterations = 0
    while (run.status === 'running' || run.status === 'draft') {
      stepIterations++
      if (stepIterations > MAX_STEP_ITERATIONS) {
        run = persistRun({ ...run, status: 'failed', lastError: `Exceeded maximum step iterations (${MAX_STEP_ITERATIONS}). Possible infinite loop in step graph.`, updatedAt: now(deps) })
        appendProtocolEvent(run.id, { type: 'failed', summary: `Exceeded maximum step iterations (${MAX_STEP_ITERATIONS}).` }, deps)
        break
      }
      // Yield to the event loop so the server can process other HTTP requests
      await new Promise((resolve) => setTimeout(resolve, 0))
      const latest = loadProtocolRunById(run.id)
      if (!latest) return null
      if (latest.status === 'paused' || latest.status === 'cancelled' || latest.status === 'archived' || latest.status === 'completed') {
        run = latest
        break
      }
      run = latest
      renewProtocolLease(run.id)

      // DAG scheduler: compute step readiness before stepping
      const sched = computeStepReadiness(run.steps || [], run.entryStepId || null, run.stepState)
      if (sched.dagMode) {
        run = persistRun({
          ...run,
          stepState: sched.stepState,
          completedStepIds: sched.completedStepIds,
          runningStepIds: sched.runningStepIds,
          readyStepIds: sched.readyStepIds,
          failedStepIds: sched.failedStepIds,
          updatedAt: now(deps),
        })
        if (sched.readyStepIds.length === 0 && sched.runningStepIds.length === 0) {
          // No more work — either all done or stuck
          const allSteps = run.steps || []
          const allCompleted = allSteps.every((s) => sched.stepState[s.id]?.status === 'completed')
          if (allCompleted) {
            run = completeProtocolRun(run, deps)
          } else {
            run = persistRun({ ...run, status: 'failed', lastError: 'DAG stuck: no ready steps and not all completed.', updatedAt: now(deps) })
            appendProtocolEvent(run.id, { type: 'failed', summary: 'DAG stuck: no ready steps and not all completed.' }, deps)
          }
          break
        }
        if (sched.readyStepIds.length > 0) {
          // Pick first ready step as currentStepId
          const nextReadyId = sched.readyStepIds[0]
          run = persistRun({ ...run, currentStepId: nextReadyId, updatedAt: now(deps) })
        }
      }

      run = await stepProtocolRun(run, deps)
      if (run.status === 'waiting' || run.status === 'paused' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'archived' || run.status === 'completed') break
    }
    if (run.parentRunId) syncProtocolParentFromChildRun(run, deps)
    return run
  } catch (err: unknown) {
    const failed = updateRun(runId, (current) => ({
      ...current,
      status: 'failed',
      lastError: cleanText(errorMessage(err), 320) || 'Structured session failed.',
      endedAt: current.endedAt || now(deps),
      updatedAt: now(deps),
    }))
    appendProtocolEvent(runId, {
      type: 'failed',
      summary: cleanText(errorMessage(err), 320) || 'Structured session failed.',
    }, deps)
    if (failed?.parentRunId) syncProtocolParentFromChildRun(failed, deps)
    return failed
  } finally {
    release()
  }
}

export function performProtocolRunAction(runId: string, input: ProtocolRunActionInput): ProtocolRun | null {
  const run = loadProtocolRunById(runId)
  if (!run) return null
  const action = input.action
  const reason = cleanText(input.reason, 240) || null
  const injectedContext = cleanText(input.context, 4_000) || null
  const activeStep = currentStep(run)
  if (action === 'cancel') {
    const updated = updateRun(runId, (current) => ({
      ...current,
      status: 'cancelled',
      endedAt: current.endedAt || Date.now(),
      updatedAt: Date.now(),
    }))
    if (updated) {
      appendProtocolEvent(runId, {
        type: 'cancelled',
        summary: 'Structured session cancelled.',
      })
      if (updated.parentRunId) syncProtocolParentFromChildRun(updated)
    }
    return updated
  }
  if (action === 'pause') {
    const updated = updateRun(runId, (current) => ({
      ...current,
      status: 'paused',
      pauseReason: reason || current.pauseReason || 'Paused by an operator.',
      updatedAt: Date.now(),
    }))
    if (updated) {
      appendProtocolEvent(runId, {
        type: 'paused',
        summary: updated.pauseReason || 'Structured session paused.',
      })
      if (updated.parentRunId) syncProtocolParentFromChildRun(updated)
    }
    return updated
  }
  if (action === 'archive') {
    const updated = updateRun(runId, (current) => ({
      ...current,
      status: 'archived',
      archivedAt: current.archivedAt || Date.now(),
      updatedAt: Date.now(),
    }))
    if (updated) {
      if (updated.transcriptChatroomId) {
        const chatrooms = loadChatrooms()
        const transcript = chatrooms[updated.transcriptChatroomId]
        if (transcript) {
          transcript.archivedAt = Date.now()
          upsertChatroom(transcript.id, transcript)
        }
      }
      appendProtocolEvent(runId, {
        type: 'archived',
        summary: 'Structured session archived.',
      })
      if (updated.parentRunId) syncProtocolParentFromChildRun(updated)
    }
    return updated
  }
  if (action === 'retry_phase') {
    const updated = updateRun(runId, (current) => ({
      ...current,
      status: 'running',
      waitingReason: null,
      pauseReason: null,
      lastError: null,
      phaseState: null,
      endedAt: null,
      updatedAt: Date.now(),
    }))
    if (updated) {
      appendProtocolEvent(runId, {
        type: 'phase_retried',
        phaseId: activeStep && isDiscussionStepKind(activeStep.kind) ? activeStep.id : null,
        stepId: activeStep?.id || null,
        summary: reason || `Retried the current structured-session ${activeStep ? 'step' : 'phase'}.`,
      })
      requestProtocolRunExecution(runId)
      if (updated.parentRunId) syncProtocolParentFromChildRun(updated)
    }
    return updated
  }
  if (action === 'skip_phase') {
    const updated = updateRun(runId, (current) => {
      const step = currentStep(current)
      const nextStepId = cleanText(step?.nextStepId, 64) || null
      const nextStatus: ProtocolRunStatus = nextStepId ? 'running' : 'completed'
      return {
        ...current,
        status: nextStatus,
        currentStepId: nextStepId,
        phaseState: null,
        waitingReason: null,
        pauseReason: null,
        lastError: null,
        endedAt: nextStatus === 'completed' ? (current.endedAt || Date.now()) : null,
        updatedAt: Date.now(),
      }
    })
    if (updated) {
      appendProtocolEvent(runId, {
        type: 'phase_skipped',
        phaseId: activeStep && isDiscussionStepKind(activeStep.kind) ? activeStep.id : null,
        stepId: activeStep?.id || null,
        summary: reason || `Skipped the current structured-session ${activeStep ? 'step' : 'phase'}.`,
      })
      if (updated.status === 'completed') {
        const completed = completeProtocolRun(updated, undefined, 'Structured session completed after skipping the final step.')
        if (completed.parentRunId) syncProtocolParentFromChildRun(completed)
        return completed
      } else {
        requestProtocolRunExecution(runId)
      }
      if (updated.parentRunId) syncProtocolParentFromChildRun(updated)
    }
    return updated
  }
  if (action === 'inject_context') {
    if (!injectedContext) return run
    const timestamp = Date.now()
    const updated = updateRun(runId, (current) => ({
      ...current,
      operatorContext: [...(current.operatorContext || []), injectedContext],
      status: current.status === 'waiting' || current.status === 'paused' ? 'running' : current.status,
      waitingReason: current.status === 'waiting' ? null : current.waitingReason,
      pauseReason: current.status === 'paused' ? null : current.pauseReason,
      updatedAt: timestamp,
    }))
    if (updated) {
      if (updated.transcriptChatroomId) {
        appendTranscriptMessage(updated.transcriptChatroomId, {
          senderId: 'system',
          senderName: 'Operator',
          role: 'assistant',
          text: `[Operator context]\n${injectedContext}`,
          mentions: [],
          reactions: [],
          historyExcluded: true,
        })
      }
      appendProtocolEvent(runId, {
        type: 'context_injected',
        summary: 'An operator injected additional structured-session context.',
        data: { context: injectedContext },
      })
      if (updated.status === 'running') {
        requestProtocolRunExecution(runId)
      }
      if (updated.parentRunId) syncProtocolParentFromChildRun(updated)
    }
    return updated
  }

  if (action === 'claim_work') {
    const stepId = cleanText(input.stepId, 64)
    const agentId = cleanText(input.agentId, 64)
    const workItemId = cleanText(input.workItemId, 64)
    if (!stepId || !agentId || !workItemId) return run
    const result = claimSwarmWorkItem(runId, stepId, agentId, workItemId)
    if (!result.success) return run
    return loadProtocolRunById(runId)
  }

  const resumed = updateRun(runId, (current) => ({
    ...current,
    status: 'running',
    waitingReason: null,
    pauseReason: null,
    lastError: null,
    endedAt: null,
    startedAt: current.startedAt || Date.now(),
    updatedAt: Date.now(),
  }))
  if (resumed) {
    appendProtocolEvent(runId, {
      type: 'resumed',
      summary: action === 'start' ? 'Structured session started.' : 'Structured session resumed.',
    })
    requestProtocolRunExecution(runId)
    if (resumed.parentRunId) syncProtocolParentFromChildRun(resumed)
  }
  return resumed
}

export function launchProtocolRunForSchedule(schedule: Schedule): ProtocolRun {
  const participantAgentIds = uniqueIds(schedule.protocolParticipantAgentIds, 64)
  const defaultParticipants = participantAgentIds.length > 0 ? participantAgentIds : [schedule.agentId]
  return createProtocolRun({
    title: cleanText(schedule.name, 160) || 'Scheduled Structured Session',
    templateId: schedule.protocolTemplateId || 'single_agent_structured_run',
    participantAgentIds: defaultParticipants,
    facilitatorAgentId: cleanText(schedule.protocolFacilitatorAgentId, 64) || defaultParticipants[0] || null,
    observerAgentIds: uniqueIds(schedule.protocolObserverAgentIds, 32),
    scheduleId: schedule.id,
    sessionId: schedule.createdInSessionId || null,
    missionId: schedule.linkedMissionId || null,
    sourceRef: { kind: 'schedule', scheduleId: schedule.id },
    autoStart: true,
    parentChatroomId: null,
    config: {
      goal: cleanText(schedule.taskPrompt || schedule.message || schedule.name, 600) || null,
      kickoffMessage: cleanText(schedule.message, 1_000) || null,
      autoEmitTasks: false,
      ...(schedule.protocolConfig || {}),
    },
  })
}

export function launchProtocolRunForMission(input: {
  missionId: string
  title: string
  participantAgentIds: string[]
  facilitatorAgentId?: string | null
  config?: ProtocolRunConfig | null
  templateId?: string | null
}): ProtocolRun {
  return createProtocolRun({
    title: input.title,
    templateId: input.templateId || 'facilitated_discussion',
    participantAgentIds: input.participantAgentIds,
    facilitatorAgentId: input.facilitatorAgentId || null,
    missionId: input.missionId,
    sourceRef: { kind: 'mission', missionId: input.missionId },
    config: input.config || null,
  })
}

export function launchProtocolRunForTask(input: {
  taskId: string
  title: string
  participantAgentIds: string[]
  facilitatorAgentId?: string | null
  missionId?: string | null
  config?: ProtocolRunConfig | null
  templateId?: string | null
}): ProtocolRun {
  return createProtocolRun({
    title: input.title,
    templateId: input.templateId || 'facilitated_discussion',
    participantAgentIds: input.participantAgentIds,
    facilitatorAgentId: input.facilitatorAgentId || null,
    missionId: input.missionId || null,
    taskId: input.taskId,
    sourceRef: { kind: 'task', taskId: input.taskId },
    config: input.config || null,
  })
}
