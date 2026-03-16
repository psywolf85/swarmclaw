/**
 * Protocol query/list/delete exports.
 * Group G17 from protocol-service.ts
 */
import type {
  ProtocolRun,
  ProtocolRunEvent,
  ProtocolRunStatus,
  ProtocolSourceRef,
  ProtocolTemplate,
} from '@/types'
import {
  loadChatrooms,
  loadMission,
  loadProtocolRun,
  loadProtocolRuns,
  loadTask,
  deleteProtocolRun,
  deleteProtocolRunEvent,
  upsertChatroom,
} from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { cleanText } from '@/lib/server/protocols/protocol-types'
import type { ProtocolRunDetail } from '@/lib/server/protocols/protocol-types'
import { normalizeProtocolRun } from '@/lib/server/protocols/protocol-normalization'
import { listAllTemplates, loadTemplate } from '@/lib/server/protocols/protocol-templates'
import { listEvents } from '@/lib/server/protocols/protocol-agent-turn'

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
  const { ensureProtocolEngineRecovered } = require('@/lib/server/protocols/protocol-run-lifecycle') as typeof import('@/lib/server/protocols/protocol-run-lifecycle')
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
