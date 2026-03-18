import type { Chatroom } from '@/types'

import {
  deleteStoredItem,
  loadChatroom as loadStoredChatroom,
  loadChatrooms as loadStoredChatrooms,
  patchStoredItem,
  saveChatrooms as saveStoredChatrooms,
  upsertChatroom as upsertStoredChatroom,
  upsertStoredItems,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const chatroomRepository = createRecordRepository<Chatroom>(
  'chatrooms',
  {
    get(id) {
      return loadStoredChatroom(id) as Chatroom | null
    },
    list() {
      return loadStoredChatrooms() as Record<string, Chatroom>
    },
    upsert(id, value) {
      upsertStoredChatroom(id, value as Chatroom)
    },
    upsertMany(entries) {
      upsertStoredItems('chatrooms', entries as Array<[string, Chatroom]>)
    },
    patch(id, updater) {
      return patchStoredItem('chatrooms', id, updater as (current: Chatroom | null) => Chatroom | null) as Chatroom | null
    },
    replace(data) {
      saveStoredChatrooms(data)
    },
    delete(id) {
      deleteStoredItem('chatrooms', id)
    },
  },
)

export const loadChatrooms = () => chatroomRepository.list()
export const loadChatroom = (id: string) => chatroomRepository.get(id)
export const loadChatroomMany = (ids: string[]) => chatroomRepository.getMany(ids)
export const saveChatrooms = (items: Record<string, Chatroom | Record<string, unknown>>) => chatroomRepository.replace(items as Record<string, Chatroom>)
export const upsertChatroom = (id: string, value: Chatroom | Record<string, unknown>) => chatroomRepository.upsert(id, value as Chatroom)
export const upsertChatrooms = (entries: Array<[string, Chatroom | Record<string, unknown>]>) => chatroomRepository.upsertMany(entries as Array<[string, Chatroom]>)
export const patchChatroom = (id: string, updater: (current: Chatroom | null) => Chatroom | null) => chatroomRepository.patch(id, updater)
export const deleteChatroom = (id: string) => chatroomRepository.delete(id)
