import type { GatewayProfile } from '@/types'

import {
  deleteStoredItem,
  loadGatewayProfiles as loadStoredGatewayProfiles,
  loadStoredItem,
  saveGatewayProfiles as saveStoredGatewayProfiles,
  upsertStoredItem,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const gatewayProfileRepository = createRecordRepository<GatewayProfile>(
  'gatewayProfiles',
  {
    get(id) {
      return loadStoredItem('gateway_profiles', id) as GatewayProfile | null
    },
    list() {
      return loadStoredGatewayProfiles() as Record<string, GatewayProfile>
    },
    upsert(id, value) {
      upsertStoredItem('gateway_profiles', id, value)
    },
    replace(data) {
      saveStoredGatewayProfiles(data as Record<string, GatewayProfile>)
    },
    patch(id, updater) {
      const current = loadStoredItem('gateway_profiles', id) as GatewayProfile | null
      const next = updater(current)
      if (next === null) {
        deleteStoredItem('gateway_profiles', id)
        return null
      }
      upsertStoredItem('gateway_profiles', id, next)
      return next
    },
    delete(id) {
      deleteStoredItem('gateway_profiles', id)
    },
  },
)

export const loadGatewayProfiles = () => gatewayProfileRepository.list()
export const loadGatewayProfile = (id: string) => gatewayProfileRepository.get(id)
export const saveGatewayProfiles = (items: Record<string, GatewayProfile | Record<string, unknown>>) => gatewayProfileRepository.replace(items as Record<string, GatewayProfile>)
export const saveGatewayProfile = (id: string, value: GatewayProfile | Record<string, unknown>) => gatewayProfileRepository.upsert(id, value as GatewayProfile)
export const patchGatewayProfile = (id: string, updater: (current: GatewayProfile | null) => GatewayProfile | null) => gatewayProfileRepository.patch(id, updater)
export const deleteGatewayProfile = (id: string) => gatewayProfileRepository.delete(id)
