import { genId } from '@/lib/id'
import type { RunEventRecord, SessionRunRecord, SessionRunStatus, SSEEvent } from '@/types'
import {
  loadRuntimeRun,
  loadRuntimeRunEvents,
  loadRuntimeRuns,
  patchRuntimeRun,
  upsertRuntimeRun,
  upsertRuntimeRunEvent,
} from '@/lib/server/storage'

const MAX_SUMMARY_CHARS = 240
const RESTART_RECOVERABLE_SOURCES = new Set([
  'heartbeat',
  'heartbeat-wake',
  'schedule',
  'task',
  'delegation',
  'subagent',
])

function now(): number {
  return Date.now()
}

function summarizeEvent(event: SSEEvent): string | undefined {
  const raw = event.text || event.toolOutput || event.toolInput || event.toolName || ''
  if (!raw) return undefined
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS) || undefined
}

export function isRestartRecoverableSource(source: string): boolean {
  return RESTART_RECOVERABLE_SOURCES.has((source || '').trim().toLowerCase())
}

export function persistRun(run: SessionRunRecord): SessionRunRecord {
  upsertRuntimeRun(run.id, run)
  return run
}

export function patchPersistedRun(
  runId: string,
  updater: (current: SessionRunRecord | null) => SessionRunRecord | null,
): SessionRunRecord | null {
  return patchRuntimeRun(runId, updater)
}

export function loadPersistedRun(runId: string): SessionRunRecord | null {
  return loadRuntimeRun(runId)
}

export function listPersistedRuns(params?: {
  sessionId?: string
  status?: SessionRunStatus
  limit?: number
}): SessionRunRecord[] {
  const limit = Math.max(1, Math.min(1000, params?.limit ?? 200))
  return Object.values(loadRuntimeRuns())
    .filter((run) => (!params?.sessionId || run.sessionId === params.sessionId) && (!params?.status || run.status === params.status))
    .sort((left, right) => {
      const queuedDelta = (right.queuedAt || 0) - (left.queuedAt || 0)
      if (queuedDelta !== 0) return queuedDelta
      const rightTs = right.endedAt || right.startedAt || 0
      const leftTs = left.endedAt || left.startedAt || 0
      return rightTs - leftTs
    })
    .slice(0, limit)
}

export function appendPersistedRunEvent(input: {
  runId: string
  sessionId: string
  phase: 'status' | 'event'
  status?: SessionRunStatus
  event: SSEEvent
  timestamp?: number
  summary?: string
}): RunEventRecord {
  const timestamp = typeof input.timestamp === 'number' && Number.isFinite(input.timestamp)
    ? Math.trunc(input.timestamp)
    : now()
  const record: RunEventRecord = {
    id: genId(12),
    runId: input.runId,
    sessionId: input.sessionId,
    timestamp,
    phase: input.phase,
    status: input.status,
    summary: input.summary || summarizeEvent(input.event),
    event: input.event,
  }
  upsertRuntimeRunEvent(record.id, record)
  return record
}

export function listPersistedRunEvents(runId: string, limit = 1000): RunEventRecord[] {
  const safeLimit = Math.max(1, Math.min(5000, Math.trunc(limit)))
  return Object.values(loadRuntimeRunEvents())
    .filter((event) => event.runId === runId)
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-safeLimit)
}

export function loadRecoverableStaleRuns(): SessionRunRecord[] {
  return Object.values(loadRuntimeRuns())
    .filter((run) => run.status === 'queued' || run.status === 'running')
    .sort((left, right) => left.queuedAt - right.queuedAt)
}
