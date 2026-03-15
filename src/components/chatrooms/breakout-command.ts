import type { Chatroom, ChatroomMessage } from '@/types'
import type { StructuredSessionLaunchContext } from '@/components/protocols/structured-session-launcher'

export const BREAKOUT_COMMAND = '/breakout'

export type BreakoutCommandParseResult =
  | { kind: 'none'; query: ''; topic: '' }
  | { kind: 'candidate'; query: string; topic: '' }
  | { kind: 'command'; query: 'breakout'; topic: string }

const MAX_TITLE_LENGTH = 72
const MAX_MESSAGE_SNIPPET_LENGTH = 220
const MAX_KICKOFF_LENGTH = 1100
const MAX_KICKOFF_MESSAGES = 6

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function summarizeMessage(message: ChatroomMessage): string {
  const text = compactWhitespace(message.text || '')
  if (text) return truncate(text, MAX_MESSAGE_SNIPPET_LENGTH)

  const attachmentCount = (message.attachedFiles?.length || 0) + (message.imagePath ? 1 : 0)
  if (attachmentCount > 0) {
    return attachmentCount === 1 ? '[shared attachment]' : `[shared ${attachmentCount} attachments]`
  }

  return ''
}

export function parseBreakoutCommand(value: string): BreakoutCommandParseResult {
  const normalized = value.replace(/\r/g, '')
  if (normalized.includes('\n')) return { kind: 'none', query: '', topic: '' }

  const trimmed = normalized.trim()
  if (!trimmed.startsWith('/')) return { kind: 'none', query: '', topic: '' }

  const withoutSlash = trimmed.slice(1)
  const firstSpace = withoutSlash.indexOf(' ')
  const commandToken = (firstSpace === -1 ? withoutSlash : withoutSlash.slice(0, firstSpace)).toLowerCase()
  const topic = firstSpace === -1 ? '' : compactWhitespace(withoutSlash.slice(firstSpace + 1))

  if (!commandToken) return { kind: 'candidate', query: '', topic: '' }
  if (BREAKOUT_COMMAND.slice(1).startsWith(commandToken)) {
    if (commandToken === BREAKOUT_COMMAND.slice(1)) {
      return { kind: 'command', query: 'breakout', topic }
    }
    return { kind: 'candidate', query: commandToken, topic: '' }
  }

  return { kind: 'none', query: '', topic: '' }
}

export function completeBreakoutCommand(value: string): string {
  const parsed = parseBreakoutCommand(value)
  if (parsed.kind === 'command') {
    return parsed.topic ? `${BREAKOUT_COMMAND} ${parsed.topic}` : `${BREAKOUT_COMMAND} `
  }
  return `${BREAKOUT_COMMAND} `
}

export function buildBreakoutTitle(chatroomName: string | null | undefined, topic: string): string {
  const compactTopic = compactWhitespace(topic)
  if (compactTopic) return truncate(`Breakout: ${compactTopic}`, MAX_TITLE_LENGTH)

  const fallback = compactWhitespace(chatroomName || '') || 'Current chatroom'
  return truncate(`Breakout: ${fallback}`, MAX_TITLE_LENGTH)
}

export function buildBreakoutKickoffContext(messages: ChatroomMessage[]): string {
  const candidates = messages
    .filter((message) => message.senderId !== 'system' && message.historyExcluded !== true)
    .map((message) => {
      const summary = summarizeMessage(message)
      if (!summary) return null
      return `${message.senderName}: ${summary}`
    })
    .filter(Boolean) as string[]

  if (candidates.length === 0) return ''

  const chosen: string[] = []
  let totalLength = 0

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const entry = candidates[index]
    const nextLength = totalLength + entry.length + (chosen.length > 0 ? 2 : 0)
    if (chosen.length >= MAX_KICKOFF_MESSAGES || (nextLength > MAX_KICKOFF_LENGTH && chosen.length > 0)) {
      break
    }
    chosen.unshift(entry)
    totalLength = nextLength
  }

  return `Recent room context:\n${chosen.join('\n\n')}`
}

export function buildBreakoutLaunchContext(
  chatroom: Pick<Chatroom, 'id' | 'name' | 'agentIds' | 'messages'>,
  topic: string,
): StructuredSessionLaunchContext {
  return {
    parentChatroomId: chatroom.id,
    parentChatroomLabel: chatroom.name,
    participantAgentIds: [...chatroom.agentIds],
    facilitatorAgentId: chatroom.agentIds[0] || null,
    title: buildBreakoutTitle(chatroom.name, topic),
    goal: compactWhitespace(topic),
    kickoffMessage: buildBreakoutKickoffContext(chatroom.messages),
    autoStart: true,
    createTranscript: true,
  }
}
