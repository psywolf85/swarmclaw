import type { Credential } from '@/types'

import {
  decryptKey,
  deleteCredential as deleteStoredCredential,
  encryptKey,
  loadCredentials as loadStoredCredentials,
  saveCredentials as saveStoredCredentials,
  upsertStoredItem,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export type StoredCredential = Credential & {
  encryptedKey?: string | null
  updatedAt?: number
  [key: string]: unknown
}

export const credentialRepository = createRecordRepository<StoredCredential>(
  'credentials',
  {
    get(id) {
      return (loadStoredCredentials() as Record<string, StoredCredential>)[id] || null
    },
    list() {
      return loadStoredCredentials() as Record<string, StoredCredential>
    },
    upsert(id, value) {
      upsertStoredItem('credentials', id, value)
    },
    replace(data) {
      saveStoredCredentials(data)
    },
    delete(id) {
      deleteStoredCredential(id)
    },
  },
)

export const loadCredentials = () => credentialRepository.list()
export const loadCredential = (id: string) => credentialRepository.get(id)
export const saveCredentials = (items: Record<string, StoredCredential | Record<string, unknown>>) => credentialRepository.replace(items as Record<string, StoredCredential>)
export const saveCredential = (id: string, value: StoredCredential | Record<string, unknown>) => credentialRepository.upsert(id, value as StoredCredential)
export const deleteCredential = (id: string) => credentialRepository.delete(id)

export { decryptKey, encryptKey }
