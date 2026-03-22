export type MissionSource =
  | 'chat'
  | 'connector'
  | 'heartbeat'
  | 'main-loop-followup'
  | 'task'
  | 'schedule'
  | 'delegation'
  | 'manual'

export type MissionStatus = 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export type MissionPhase = 'intake' | 'planning' | 'dispatching' | 'executing' | 'verifying' | 'waiting' | 'completed' | 'failed'
export type MissionWaitKind =
  | 'human_reply'
  | 'approval'
  | 'external_dependency'
  | 'provider'
  | 'blocked_task'
  | 'blocked_mission'
  | 'scheduled'
  | 'other'

export type MissionPlannerDecision =
  | 'dispatch_task'
  | 'dispatch_session_turn'
  | 'spawn_child_mission'
  | 'wait'
  | 'verify_now'
  | 'complete_candidate'
  | 'replan'
  | 'fail_terminal'
  | 'cancel'

export type MissionVerificationVerdict =
  | 'continue'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'replan'

export type MissionSourceRef =
  | { kind: 'chat'; sessionId: string; messageId?: string | null }
  | { kind: 'connector'; sessionId: string; connectorId: string; channelId: string; threadId?: string | null }
  | { kind: 'schedule'; scheduleId: string; recurring: boolean }
  | { kind: 'task'; taskId: string }
  | { kind: 'delegation'; parentMissionId: string; backend?: 'agent' | 'codex' | 'claude' | 'opencode' | 'gemini' | null }
  | { kind: 'heartbeat'; sessionId: string }
  | { kind: 'manual' }

export interface MissionWaitState {
  kind: MissionWaitKind
  reason: string
  approvalId?: string | null
  untilAt?: number | null
  dependencyTaskId?: string | null
  dependencyMissionId?: string | null
  providerKey?: string | null
}

export interface MissionControllerState {
  leaseId?: string | null
  leaseExpiresAt?: number | null
  tickRequestedAt?: number | null
  tickReason?: string | null
  plannerRunId?: string | null
  verifierRunId?: string | null
  activeRunId?: string | null
  currentTaskId?: string | null
  currentChildMissionId?: string | null
  pendingWakeId?: string | null
  attemptCount?: number
  lastEvidenceAt?: number | null
}

export interface MissionPlannerState {
  lastDecision?: MissionPlannerDecision | null
  lastPlannedAt?: number | null
  planSummary?: string | null
}

export interface MissionVerificationState {
  candidate: boolean
  requiredTaskIds?: string[]
  requiredChildMissionIds?: string[]
  requiredArtifacts?: string[]
  evidenceSummary?: string | null
  lastVerdict?: MissionVerificationVerdict | null
  lastVerifiedAt?: number | null
}

export interface MissionSummary {
  id: string
  objective: string
  status: MissionStatus
  phase: MissionPhase
  source: MissionSource
  currentStep?: string | null
  waitingReason?: string | null
  sessionId?: string | null
  agentId?: string | null
  projectId?: string | null
  parentMissionId?: string | null
  rootMissionId?: string | null
  taskIds?: string[]
  openTaskCount?: number
  completedTaskCount?: number
  childCount?: number
  sourceRef?: MissionSourceRef
  updatedAt: number
}

export interface Mission {
  id: string
  source: MissionSource
  sourceRef?: MissionSourceRef
  objective: string
  successCriteria?: string[]
  status: MissionStatus
  phase: MissionPhase
  sessionId?: string | null
  agentId?: string | null
  projectId?: string | null
  rootMissionId?: string | null
  parentMissionId?: string | null
  childMissionIds?: string[]
  dependencyMissionIds?: string[]
  dependencyTaskIds?: string[]
  taskIds?: string[]
  rootTaskId?: string | null
  currentStep?: string | null
  plannerSummary?: string | null
  verifierSummary?: string | null
  blockerSummary?: string | null
  waitState?: MissionWaitState | null
  controllerState?: MissionControllerState
  plannerState?: MissionPlannerState
  verificationState?: MissionVerificationState
  lastRunId?: string | null
  sourceRunId?: string | null
  sourceMessage?: string | null
  createdAt: number
  updatedAt: number
  lastActiveAt?: number | null
  completedAt?: number | null
  failedAt?: number | null
  cancelledAt?: number | null
}

export type MissionEventType =
  | 'created'
  | 'source_triggered'
  | 'attached'
  | 'planner_decision'
  | 'dispatch_started'
  | 'task_linked'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'child_created'
  | 'child_completed'
  | 'child_failed'
  | 'run_result'
  | 'verifier_decision'
  | 'waiting'
  | 'resumed'
  | 'replanned'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'operator_action'
  | 'status_change'

export interface MissionEvent {
  id: string
  missionId: string
  type: MissionEventType
  source: MissionSource | 'system'
  summary: string
  data?: Record<string, unknown> | null
  sessionId?: string | null
  taskId?: string | null
  runId?: string | null
  createdAt: number
}
