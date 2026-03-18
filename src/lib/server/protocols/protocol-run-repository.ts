import type { ProtocolRun, ProtocolRunEvent } from '@/types'

import {
  deleteProtocolRun as deleteStoredProtocolRun,
  deleteProtocolRunEvent as deleteStoredProtocolRunEvent,
  loadProtocolRun as loadStoredProtocolRun,
  loadProtocolRunEvent as loadStoredProtocolRunEvent,
  loadProtocolRunEvents as loadStoredProtocolRunEvents,
  loadProtocolRunEventsByRunId as loadStoredProtocolRunEventsByRunId,
  loadProtocolRuns as loadStoredProtocolRuns,
  patchProtocolRun as patchStoredProtocolRun,
  saveProtocolRunEvents as saveStoredProtocolRunEvents,
  saveProtocolRuns as saveStoredProtocolRuns,
  upsertProtocolRun as upsertStoredProtocolRun,
  upsertProtocolRunEvent as upsertStoredProtocolRunEvent,
  upsertProtocolRunEvents as upsertStoredProtocolRunEvents,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const protocolRunRepository = createRecordRepository<ProtocolRun>(
  'protocol-runs',
  {
    get(id) {
      return loadStoredProtocolRun(id) as ProtocolRun | null
    },
    list() {
      return loadStoredProtocolRuns() as Record<string, ProtocolRun>
    },
    upsert(id, value) {
      upsertStoredProtocolRun(id, value as ProtocolRun)
    },
    replace(data) {
      saveStoredProtocolRuns(data as Record<string, ProtocolRun>)
    },
    patch(id, updater) {
      return patchStoredProtocolRun(id, updater as (current: ProtocolRun | null) => ProtocolRun | null) as ProtocolRun | null
    },
    delete(id) {
      deleteStoredProtocolRun(id)
    },
  },
)

export const protocolRunEventRepository = createRecordRepository<ProtocolRunEvent>(
  'protocol-run-events',
  {
    get(id) {
      return loadStoredProtocolRunEvent(id) as ProtocolRunEvent | null
    },
    list() {
      return loadStoredProtocolRunEvents() as Record<string, ProtocolRunEvent>
    },
    upsert(id, value) {
      upsertStoredProtocolRunEvent(id, value as ProtocolRunEvent)
    },
    upsertMany(entries) {
      upsertStoredProtocolRunEvents(entries as Array<[string, ProtocolRunEvent]>)
    },
    replace(data) {
      saveStoredProtocolRunEvents(data as Record<string, ProtocolRunEvent>)
    },
    delete(id) {
      deleteStoredProtocolRunEvent(id)
    },
  },
)

export const loadProtocolRuns = () => protocolRunRepository.list()
export const loadProtocolRun = (id: string) => protocolRunRepository.get(id)
export const saveProtocolRuns = (items: Record<string, ProtocolRun | Record<string, unknown>>) => protocolRunRepository.replace(items as Record<string, ProtocolRun>)
export const upsertProtocolRun = (id: string, value: ProtocolRun | Record<string, unknown>) => protocolRunRepository.upsert(id, value as ProtocolRun)
export const patchProtocolRun = (id: string, updater: (current: ProtocolRun | null) => ProtocolRun | null) => protocolRunRepository.patch(id, updater)
export const deleteProtocolRun = (id: string) => protocolRunRepository.delete(id)

export const loadProtocolRunEvents = () => protocolRunEventRepository.list()
export const loadProtocolRunEvent = (id: string) => protocolRunEventRepository.get(id)
export const saveProtocolRunEvents = (items: Record<string, ProtocolRunEvent | Record<string, unknown>>) => protocolRunEventRepository.replace(items as Record<string, ProtocolRunEvent>)
export const upsertProtocolRunEvent = (id: string, value: ProtocolRunEvent | Record<string, unknown>) => protocolRunEventRepository.upsert(id, value as ProtocolRunEvent)
export const upsertProtocolRunEvents = (entries: Array<[string, ProtocolRunEvent | Record<string, unknown>]>) => protocolRunEventRepository.upsertMany(entries as Array<[string, ProtocolRunEvent]>)
export const deleteProtocolRunEvent = (id: string) => protocolRunEventRepository.delete(id)
export const loadProtocolRunEventsByRunId = (runId: string) => loadStoredProtocolRunEventsByRunId(runId)
