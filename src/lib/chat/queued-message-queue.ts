import type { Message, SessionQueueSnapshot, SessionQueuedTurn } from '@/types'

export interface QueuedSessionMessage extends SessionQueuedTurn {
  optimistic?: boolean
  /** Set when the server has consumed the message but the chat hasn't shown it yet */
  sending?: boolean
}

export interface QueueMessageDraft {
  text: string
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  replyToId?: string
}

export function nextQueuedMessageId(now = Date.now(), random = Math.random): string {
  return `queued-${now}-${random().toString(36).slice(2, 8)}`
}

export function createOptimisticQueuedMessage(
  sessionId: string,
  draft: QueueMessageDraft,
  position: number,
): QueuedSessionMessage {
  return {
    runId: nextQueuedMessageId(),
    sessionId,
    text: draft.text,
    queuedAt: Date.now(),
    position,
    imagePath: draft.imagePath,
    imageUrl: draft.imageUrl,
    attachedFiles: draft.attachedFiles,
    replyToId: draft.replyToId,
    optimistic: true,
  }
}

export function snapshotToQueuedMessages(snapshot: SessionQueueSnapshot): QueuedSessionMessage[] {
  const activeRunId = typeof snapshot.activeRunId === 'string' && snapshot.activeRunId.trim()
    ? snapshot.activeRunId
    : null
  const nextItems: QueuedSessionMessage[] = []
  if (snapshot.activeTurn && activeRunId && snapshot.activeTurn.runId === activeRunId) {
    nextItems.push({
      ...snapshot.activeTurn,
      sending: true,
    })
  }
  const seenRunIds = new Set(nextItems.map((item) => item.runId))
  for (const item of snapshot.items) {
    if (seenRunIds.has(item.runId)) continue
    nextItems.push({ ...item })
    seenRunIds.add(item.runId)
  }
  return nextItems
}

interface ReplaceQueuedMessagesOptions {
  activeRunId?: string | null
}

export function replaceQueuedMessagesForSession(
  queue: QueuedSessionMessage[],
  sessionId: string,
  nextItems: QueuedSessionMessage[],
  options: ReplaceQueuedMessagesOptions = {},
): QueuedSessionMessage[] {
  const otherSessions = queue.filter((item) => item.sessionId !== sessionId)
  const previousForSession = queue.filter((item) => item.sessionId === sessionId && !item.sending)
  // Detect consumed messages: items in local state but not in server snapshot.
  // Keep only the run that actually became active visible as "sending" so it
  // doesn't vanish from the UI before the transcript refresh catches up.
  const nextRunIds = new Set(nextItems.map((item) => item.runId))
  const activeRunId = typeof options.activeRunId === 'string' && options.activeRunId.trim()
    ? options.activeRunId
    : null
  // Preserve existing "sending" items not covered by the new snapshot —
  // they'll be cleaned up later by setMessages or the timeout.
  const existingSending = queue.filter((item) =>
    item.sessionId === sessionId && item.sending && !nextRunIds.has(item.runId),
  )
  const consumed = previousForSession
    .filter((item) => !item.optimistic && !nextRunIds.has(item.runId) && activeRunId === item.runId)
    .map((item) => ({ ...item, sending: true }))
  return [
    ...otherSessions,
    ...existingSending,
    ...consumed,
    ...nextItems,
  ]
}

export function listQueuedMessagesForSession(
  queue: QueuedSessionMessage[],
  sessionId: string | null | undefined,
): QueuedSessionMessage[] {
  if (!sessionId) return []
  return queue
    .filter((item) => item.sessionId === sessionId)
    .sort((left, right) => left.position - right.position || left.queuedAt - right.queuedAt)
}

export function buildQueuedTranscriptMessages(
  queue: QueuedSessionMessage[],
  sessionId: string | null | undefined,
): Message[] {
  return listQueuedMessagesForSession(queue, sessionId)
    .filter((item) => item.sending === true)
    .map((item) => ({
      role: 'user',
      text: item.text,
      time: item.queuedAt,
      kind: 'chat',
      clientRenderId: `queued:${item.runId}`,
      imagePath: item.imagePath,
      imageUrl: item.imageUrl,
      attachedFiles: item.attachedFiles,
      replyToId: item.replyToId,
      runId: item.runId,
    }))
}

export function mergeQueuedTranscriptMessages(
  messages: Message[],
  queue: QueuedSessionMessage[],
  sessionId: string | null | undefined,
): Message[] {
  const queuedTranscript = buildQueuedTranscriptMessages(queue, sessionId)
  if (queuedTranscript.length === 0) return messages
  const merged = [...messages]
  for (const queuedMessage of queuedTranscript) {
    const queuedRunId = typeof queuedMessage.runId === 'string' && queuedMessage.runId.trim()
      ? queuedMessage.runId
      : null
    if (queuedRunId && merged.some((message) => message.role === 'user' && message.runId === queuedRunId)) {
      continue
    }
    // Place queued user message before its corresponding assistant response
    // (same runId), otherwise append after the last persisted message.
    const sameRunAssistantIndex = queuedRunId
      ? merged.findIndex((msg) => msg.role === 'assistant' && msg.runId === queuedRunId)
      : -1
    if (sameRunAssistantIndex >= 0) {
      merged.splice(sameRunAssistantIndex, 0, queuedMessage)
    } else {
      const lastPersistedIndex = merged.findLastIndex(
        (msg) => !msg.clientRenderId?.startsWith('queued:'),
      )
      const insertAt = lastPersistedIndex >= 0 ? lastPersistedIndex + 1 : merged.length
      merged.splice(insertAt, 0, queuedMessage)
    }
  }
  return merged
}

export function removeQueuedMessageById(
  queue: QueuedSessionMessage[],
  id: string,
): QueuedSessionMessage[] {
  return queue.filter((item) => item.runId !== id)
}

export function clearQueuedMessagesForSession(
  queue: QueuedSessionMessage[],
  sessionId: string | null | undefined,
): QueuedSessionMessage[] {
  if (!sessionId) return queue
  return queue.filter((item) => item.sessionId !== sessionId)
}
