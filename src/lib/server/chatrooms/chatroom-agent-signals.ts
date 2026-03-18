import type { Chatroom, Agent } from '@/types'
import { patchChatroom } from '@/lib/server/chatrooms/chatroom-repository'
import { notify } from '@/lib/server/ws-hub'

/**
 * Normalizes text for comparison (lowercase, alphanumeric only)
 */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Determines if an agent was implicitly mentioned in a message.
 * Matches against name, creature, and vibe.
 */
export function isImplicitlyMentioned(text: string, agent: Agent): boolean {
  const normText = normalizeForMatch(text)
  const normName = normalizeForMatch(agent.name)
  const normCreature = agent.creature ? normalizeForMatch(agent.creature) : null
  const normVibe = agent.vibe ? normalizeForMatch(agent.vibe) : null

  if (normText.includes(normName)) return true
  if (normCreature && normText.includes(normCreature)) return true
  
  // Vibe match: only if the vibe is a distinct single word like "skeptic" or "helper"
  if (normVibe && normVibe.length > 3 && normVibe.split(' ').length === 1) {
    if (normText.includes(normVibe)) return true
  }

  return false
}

/**
 * Adds an "ack" reaction to a chatroom message on behalf of an agent.
 * Useful for acknowledging tasks or agreeing with teammates.
 */
export function addAgentReaction(chatroomId: string, messageId: string, agentId: string, emoji: string) {
  const updated = patchChatroom(chatroomId, (current) => {
    const chatroom = current as Chatroom | null
    if (!chatroom) return null
    const message = chatroom.messages.find(m => m.id === messageId)
    if (!message) return chatroom
    if (message.reactions.some(r => r.reactorId === agentId && r.emoji === emoji)) return chatroom

    return {
      ...chatroom,
      messages: chatroom.messages.map((entry) => (
        entry.id !== messageId
          ? entry
          : {
              ...entry,
              reactions: [
                ...entry.reactions,
                {
                  emoji,
                  reactorId: agentId,
                  time: Date.now(),
                },
              ],
            }
      )),
    }
  })
  if (updated) notify(`chatroom:${chatroomId}`)
}

/**
 * Parses [REACTION] tokens from agent output and applies them.
 * Format: [REACTION]{"emoji": "👍", "to": "msg_id"}
 */
export function applyAgentReactionsFromText(text: string, chatroomId: string, agentId: string) {
  const reactionRegex = /\[REACTION\]\s*(\{.*?\})/g
  let match
  while ((match = reactionRegex.exec(text)) !== null) {
    try {
      const data = JSON.parse(match[1])
      if (data.emoji && data.to) {
        addAgentReaction(chatroomId, data.to, agentId, data.emoji)
      }
    } catch { /* ignore invalid JSON */ }
  }
}
