import type { ProtocolTemplate } from '@/types'

import {
  deleteProtocolTemplate as deleteStoredProtocolTemplate,
  loadProtocolTemplate as loadStoredProtocolTemplate,
  loadProtocolTemplates as loadStoredProtocolTemplates,
  patchProtocolTemplate as patchStoredProtocolTemplate,
  saveProtocolTemplates as saveStoredProtocolTemplates,
  upsertProtocolTemplate as upsertStoredProtocolTemplate,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const protocolTemplateRepository = createRecordRepository<ProtocolTemplate>(
  'protocol-templates',
  {
    get(id) {
      return loadStoredProtocolTemplate(id) as ProtocolTemplate | null
    },
    list() {
      return loadStoredProtocolTemplates() as Record<string, ProtocolTemplate>
    },
    upsert(id, value) {
      upsertStoredProtocolTemplate(id, value as ProtocolTemplate)
    },
    replace(data) {
      saveStoredProtocolTemplates(data as Record<string, ProtocolTemplate>)
    },
    patch(id, updater) {
      return patchStoredProtocolTemplate(id, updater as (current: ProtocolTemplate | null) => ProtocolTemplate | null) as ProtocolTemplate | null
    },
    delete(id) {
      deleteStoredProtocolTemplate(id)
    },
  },
)

export const loadProtocolTemplates = () => protocolTemplateRepository.list()
export const loadProtocolTemplate = (id: string) => protocolTemplateRepository.get(id)
export const saveProtocolTemplates = (items: Record<string, ProtocolTemplate | Record<string, unknown>>) => protocolTemplateRepository.replace(items as Record<string, ProtocolTemplate>)
export const upsertProtocolTemplate = (id: string, value: ProtocolTemplate | Record<string, unknown>) => protocolTemplateRepository.upsert(id, value as ProtocolTemplate)
export const patchProtocolTemplate = (id: string, updater: (current: ProtocolTemplate | null) => ProtocolTemplate | null) => protocolTemplateRepository.patch(id, updater)
export const deleteProtocolTemplate = (id: string) => protocolTemplateRepository.delete(id)
