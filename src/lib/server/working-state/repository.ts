import { perf } from '@/lib/server/runtime/perf'
import {
  deletePersistedWorkingState as deleteStoredWorkingState,
  loadPersistedWorkingState as loadStoredWorkingState,
  upsertPersistedWorkingState as upsertStoredWorkingState,
} from '@/lib/server/storage'

export type PersistedWorkingState = Record<string, unknown>

export function loadPersistedWorkingState(sessionId: string): PersistedWorkingState | null {
  return perf.measureSync(
    'repository',
    'working-state.get',
    () => loadStoredWorkingState(sessionId) as PersistedWorkingState | null,
    { sessionId },
  )
}

export function upsertPersistedWorkingState(
  sessionId: string,
  value: PersistedWorkingState,
): void {
  perf.measureSync(
    'repository',
    'working-state.upsert',
    () => upsertStoredWorkingState(sessionId, value),
    { sessionId },
  )
}

export function deletePersistedWorkingState(sessionId: string): void {
  perf.measureSync(
    'repository',
    'working-state.delete',
    () => deleteStoredWorkingState(sessionId),
    { sessionId },
  )
}
