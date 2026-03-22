import { HumanMessage } from '@langchain/core/messages'
import type { Agent, Chatroom, ChatroomRoutingRule } from '@/types'
import { buildLLM } from '@/lib/server/build-llm'
import { log } from '@/lib/server/logger'

const TAG = 'chatroom-routing'
const SELECTOR_TIMEOUT_MS = 4_000

interface ChatroomRecipientSelection {
  agentIds: string[]
}

function normalizeGuidance(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || null
}

function extractFirstJsonObject(text: string): string | null {
  const source = String(text || '').trim()
  if (!source) return null
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (start === -1) {
      if (char === '{') {
        start = index
        depth = 1
      }
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }
  return null
}

function extractModelText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') ? part.text : '')
    .join('')
}

function parseRecipientSelection(text: string, allowedAgentIds: Set<string>): string[] {
  const jsonText = extractFirstJsonObject(text)
  if (!jsonText) return []
  try {
    const parsed = JSON.parse(jsonText) as Partial<ChatroomRecipientSelection>
    if (!Array.isArray(parsed.agentIds)) return []
    const seen = new Set<string>()
    const selected: string[] = []
    for (const value of parsed.agentIds) {
      if (typeof value !== 'string') continue
      const agentId = value.trim()
      if (!agentId || !allowedAgentIds.has(agentId) || seen.has(agentId)) continue
      seen.add(agentId)
      selected.push(agentId)
    }
    return selected
  } catch {
    return []
  }
}

function formatLegacyRule(rule: ChatroomRoutingRule, agentsById: Record<string, Agent | undefined>): string | null {
  const agentName = agentsById[rule.agentId]?.name || rule.agentId
  if (rule.type === 'keyword') {
    const parts = [
      Array.isArray(rule.keywords) && rule.keywords.length > 0
        ? `topics or phrases like ${rule.keywords.map((keyword) => `"${keyword}"`).join(', ')}`
        : null,
      rule.pattern ? `messages matching ${JSON.stringify(rule.pattern)}` : null,
    ].filter(Boolean)
    if (parts.length === 0) return null
    return `Priority ${rule.priority}: route ${parts.join(' or ')} to ${agentName}.`
  }
  if (!rule.pattern) return null
  return `Priority ${rule.priority}: prefer ${agentName} when the request best fits capability area ${JSON.stringify(rule.pattern)}.`
}

export function synthesizeRoutingGuidanceFromRules(
  rules: ChatroomRoutingRule[] | null | undefined,
  agentsById: Record<string, Agent | undefined>,
): string | null {
  if (!Array.isArray(rules) || rules.length === 0) return null
  const lines = rules
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .map((rule) => formatLegacyRule(rule, agentsById))
    .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
  if (lines.length === 0) return null
  return [
    'Legacy routing guidance synthesized from older routing rules. Earlier priorities take precedence when multiple agents could fit.',
    ...lines,
  ].join('\n')
}

export function resolveChatroomRoutingGuidance(
  chatroom: Chatroom,
  agentsById: Record<string, Agent | undefined>,
): string | null {
  return normalizeGuidance(chatroom.routingGuidance)
    || synthesizeRoutingGuidanceFromRules(chatroom.routingRules, agentsById)
}

export function ensureChatroomRoutingGuidance(
  chatroom: Chatroom,
  agentsById: Record<string, Agent | undefined>,
): boolean {
  const guidance = resolveChatroomRoutingGuidance(chatroom, agentsById)
  const nextGuidance = normalizeGuidance(guidance)
  const hadRules = Array.isArray(chatroom.routingRules) && chatroom.routingRules.length > 0
  const guidanceChanged = nextGuidance !== normalizeGuidance(chatroom.routingGuidance)
  if (!guidanceChanged && !hadRules) return false
  chatroom.routingGuidance = nextGuidance
  delete chatroom.routingRules
  return guidanceChanged || hadRules
}

function buildRecipientSelectionPrompt(params: {
  text: string
  chatroom: Chatroom
  guidance: string
  members: Array<{
    id: string
    name: string
    description: string
    capabilities: string[]
  }>
}): string {
  return [
    'Choose which chatroom members should receive the latest message.',
    'Return JSON only.',
    'Use only agent IDs from the provided member list.',
    'Prefer the smallest relevant set. Return an empty array when no routing guidance clearly applies.',
    'Respect explicit routing guidance over generic capability overlap.',
    '',
    'Output shape:',
    '{"agentIds":["agent-id-1","agent-id-2"]}',
    '',
    `Chatroom description: ${JSON.stringify(params.chatroom.description || '')}`,
    `Routing guidance: ${JSON.stringify(params.guidance)}`,
    `Latest message: ${JSON.stringify(params.text)}`,
    'Members:',
    JSON.stringify(params.members),
  ].join('\n')
}

export async function selectChatroomRecipients(
  params: {
    text: string
    chatroom: Chatroom
    agentsById: Record<string, Agent | undefined>
  },
  hooks?: {
    generateText?: (prompt: string) => Promise<string>
  },
): Promise<string[]> {
  const guidance = resolveChatroomRoutingGuidance(params.chatroom, params.agentsById)
  if (!guidance) return []

  const members = params.chatroom.agentIds
    .map((agentId) => {
      const agent = params.agentsById[agentId]
      if (!agent) return null
      return {
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        capabilities: Array.isArray(agent.capabilities) ? agent.capabilities.slice(0, 12) : [],
      }
    })
    .filter((member): member is NonNullable<typeof member> => member !== null)
  if (members.length === 0) return []

  const prompt = buildRecipientSelectionPrompt({
    text: params.text,
    chatroom: params.chatroom,
    guidance,
    members,
  })
  const allowedAgentIds = new Set(members.map((member) => member.id))

  try {
    const responseText = await Promise.race([
      hooks?.generateText
        ? hooks.generateText(prompt)
        : (async () => {
            const { llm } = await buildLLM()
            const response = await llm.invoke([new HumanMessage(prompt)])
            return extractModelText(response.content)
          })(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('chatroom-recipient-selector-timeout')), SELECTOR_TIMEOUT_MS)
      }),
    ])
    return parseRecipientSelection(responseText, allowedAgentIds)
  } catch (error: unknown) {
    log.warn(TAG, 'Failed to select chatroom recipients from routing guidance', {
      error: error instanceof Error ? error.message : 'unknown',
      chatroomId: params.chatroom.id,
    })
    return []
  }
}
