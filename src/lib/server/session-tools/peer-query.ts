import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { loadAgents } from '../storage'
import { resolveReachableAgentIds } from '../agents/team-resolution'
import { resolvePrimaryAgentRoute } from '../agents/agent-runtime-config'
import { resolveApiKey } from '../chatrooms/chatroom-helpers'
import { buildChatModel } from '../build-llm'
import { NON_LANGGRAPH_PROVIDER_IDS } from '@/lib/provider-sets'
import { hmrSingleton } from '@/lib/shared-utils'
import { log } from '../logger'
import { debug } from '../debug'
import { logExecution } from '../execution-log'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { registerNativeCapability } from '../native-capabilities'
import type { ToolBuildContext } from './context'
import type { Agent, Extension, ExtensionHooks } from '@/types'

const RATE_WINDOW_MS = 10 * 60 * 1000 // 10 minutes
const RATE_LIMIT = 10
const RATE_WARN_THRESHOLD = 8
const MAX_RESPONSE_CHARS = 4000
/** Evict stale rate limiter entries every N calls */
const EVICTION_INTERVAL = 50

interface RateEntry {
  timestamps: number[]
}

const rateLimiter = hmrSingleton<Map<string, RateEntry>>(
  '__swarmclaw_peer_query_rate__',
  () => new Map(),
)

let rateLimiterCallCount = 0

function evictStaleRateLimiterEntries(now: number): void {
  for (const [key, entry] of rateLimiter) {
    const fresh = entry.timestamps.filter((t) => now - t < RATE_WINDOW_MS)
    if (fresh.length === 0) {
      rateLimiter.delete(key)
    } else {
      entry.timestamps = fresh
    }
  }
}

function checkRateLimit(sessionId: string): { allowed: boolean; warning: string | null; count: number } {
  const now = Date.now()

  // Lazy eviction: prune stale entries periodically
  rateLimiterCallCount++
  if (rateLimiterCallCount % EVICTION_INTERVAL === 0) {
    evictStaleRateLimiterEntries(now)
  }

  const entry = rateLimiter.get(sessionId) || { timestamps: [] }

  // Slide the window
  entry.timestamps = entry.timestamps.filter((t) => now - t < RATE_WINDOW_MS)

  if (entry.timestamps.length >= RATE_LIMIT) {
    return { allowed: false, warning: null, count: entry.timestamps.length }
  }

  entry.timestamps.push(now)
  rateLimiter.set(sessionId, entry)

  const warning = entry.timestamps.length >= RATE_WARN_THRESHOLD
    ? `Approaching rate limit: ${entry.timestamps.length}/${RATE_LIMIT} peer queries in the last 10 minutes.`
    : null

  return { allowed: true, warning, count: entry.timestamps.length }
}

function buildTargetSystemPrompt(target: Agent, callerName: string): string {
  const lines = [
    `You are ${target.name}.`,
  ]
  if (target.description) lines.push(target.description)
  lines.push('')
  lines.push('## Peer Query')
  lines.push(`Your teammate **${callerName}** is asking you a quick question.`)
  lines.push('This is context exchange — not a task assignment.')
  lines.push('')
  lines.push('## Guidelines')
  lines.push('- Answer concisely and directly')
  lines.push('- Share what you know from your expertise and context')
  lines.push('- If you don\'t know, say so')
  lines.push('- Keep response under 300 words')
  lines.push('- Do not attempt to use tools or delegate work')
  return lines.join('\n')
}

async function executePeerQuery(
  args: Record<string, unknown>,
  context: { agentId?: string | null; sessionId?: string | null },
): Promise<string> {
  const normalized = normalizeToolInputArgs(args)
  const targetAgentId = (normalized.targetAgentId ?? normalized.target_agent_id) as string | undefined
  const question = normalized.question as string | undefined

  if (!targetAgentId?.trim()) {
    return JSON.stringify({ ok: false, error: 'targetAgentId is required' })
  }
  if (!question?.trim()) {
    return JSON.stringify({ ok: false, error: 'question is required' })
  }
  if (!context.agentId) {
    return JSON.stringify({ ok: false, error: 'ask_peer requires an agent context' })
  }

  const trimmedTargetId = targetAgentId.trim()
  const trimmedQuestion = question.trim()

  // Self-query check
  if (trimmedTargetId === context.agentId) {
    return JSON.stringify({ ok: false, error: 'Cannot query yourself. Use your own knowledge directly.' })
  }

  // Rate limit check
  const sessionKey = context.sessionId || context.agentId
  const rateCheck = checkRateLimit(sessionKey)
  if (!rateCheck.allowed) {
    log.warn('peer-query', 'Rate limit exceeded', { sessionKey, count: rateCheck.count })
    return JSON.stringify({
      ok: false,
      error: `Rate limit exceeded: ${RATE_LIMIT} peer queries per 10-minute window. Wait a few minutes before querying again.`,
    })
  }

  const agents = loadAgents() as Record<string, Agent>

  // Scope check
  const reachable = resolveReachableAgentIds(context.agentId, agents)
  if (!reachable.has(trimmedTargetId)) {
    const target = agents[trimmedTargetId]
    if (!target) {
      return JSON.stringify({ ok: false, error: `Agent "${trimmedTargetId}" not found.` })
    }
    return JSON.stringify({
      ok: false,
      error: `Agent "${target.name}" is not on your team. You can only query peers, your coordinator, or direct reports.`,
    })
  }

  const target = agents[trimmedTargetId]
  if (!target) {
    return JSON.stringify({ ok: false, error: `Agent "${trimmedTargetId}" not found.` })
  }

  // Resolve target's LLM config
  const route = resolvePrimaryAgentRoute(target)
  if (!route) {
    return JSON.stringify({ ok: false, error: `Cannot resolve LLM config for "${target.name}". Check their provider settings.` })
  }

  // CLI providers can't be queried via LangChain
  if (NON_LANGGRAPH_PROVIDER_IDS.has(route.provider)) {
    return JSON.stringify({
      ok: false,
      error: `"${target.name}" uses a CLI provider (${route.provider}) which doesn't support direct queries. Use a chatroom or task instead.`,
    })
  }

  // Resolve API key
  const apiKey = resolveApiKey(route.credentialId)
  if (!apiKey) {
    return JSON.stringify({ ok: false, error: `No API key configured for "${target.name}". Check provider credentials.` })
  }

  const caller = agents[context.agentId]
  const callerName = caller?.name || 'A teammate'

  try {
    const model = buildChatModel({
      provider: route.provider,
      model: route.model,
      ollamaMode: route.ollamaMode,
      apiKey,
      credentialId: route.credentialId,
      apiEndpoint: route.apiEndpoint,
    })

    const systemPrompt = buildTargetSystemPrompt(target, callerName)

    const response = await model.invoke([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: trimmedQuestion },
    ])

    const answer = typeof response.content === 'string'
      ? response.content
      : Array.isArray(response.content)
        ? response.content.map((c) => (typeof c === 'string' ? c : (c as Record<string, unknown>).text || '')).join('')
        : String(response.content)

    const truncatedAnswer = answer.length > MAX_RESPONSE_CHARS
      ? answer.slice(0, MAX_RESPONSE_CHARS) + '... [truncated]'
      : answer

    const result: Record<string, unknown> = {
      ok: true,
      respondent: { id: target.id, name: target.name },
      answer: truncatedAnswer,
    }

    if (rateCheck.warning) {
      result.warning = rateCheck.warning
    }

    log.info('peer-query', 'Peer query completed', {
      callerId: context.agentId,
      targetId: trimmedTargetId,
      questionLength: trimmedQuestion.length,
      answerLength: truncatedAnswer.length,
    })
    logExecution(sessionKey, 'peer_query', `${context.agentId} → ${trimmedTargetId}`, {
      detail: { callerId: context.agentId, targetId: trimmedTargetId, questionLen: trimmedQuestion.length, answerLen: truncatedAnswer.length },
    })
    debug.verbose('peer-query', 'Exchange', { question: trimmedQuestion, answer: truncatedAnswer })

    return JSON.stringify(result)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('peer-query', 'Peer query failed', {
      callerId: context.agentId,
      targetId: trimmedTargetId,
      error: msg,
    })
    logExecution(sessionKey, 'peer_query', `Failed: ${context.agentId} → ${trimmedTargetId}`, {
      detail: { callerId: context.agentId, targetId: trimmedTargetId, error: msg },
    })
    return JSON.stringify({
      ok: false,
      error: `Failed to query "${target.name}": ${msg}`,
    })
  }
}

const PeerQueryExtension: Extension = {
  name: 'Core Peer Query',
  description: 'Ask quick context questions to team peers via ask_peer.',
  hooks: {
    getCapabilityDescription: () =>
      'Ask quick context questions to team peers (`ask_peer`). Queries a teammate\'s LLM directly for fast context exchange without creating chatrooms or tasks.',
    getOperatingGuidance: () => [
      'Use `ask_peer` for quick context questions to teammates — "what approach are you using for X?" or "do you have context on Y?"',
      'This is NOT for task assignment. Use `spawn_subagent` for delegation.',
      'You can only query agents on your team (peers, coordinator, or direct reports based on org chart).',
    ].join(' '),
  } as ExtensionHooks,
  tools: [
    {
      name: 'ask_peer',
      description: [
        'Ask a quick question to a teammate for context exchange.',
        'The target agent\'s LLM responds directly — no chatroom or task needed.',
        'Only works with agents on your team (peers, coordinator, direct reports).',
        'Params: targetAgentId (required), question (required).',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          targetAgentId: { type: 'string', description: 'The ID of the teammate to query' },
          question: { type: 'string', description: 'The question to ask' },
        },
        required: ['targetAgentId', 'question'],
      },
      execute: async (args, context) => executePeerQuery(args, {
        agentId: context.session.agentId,
        sessionId: context.session.id,
      }),
    },
  ],
}

registerNativeCapability('peer_query', PeerQueryExtension)

export function buildPeerQueryTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasExtension('peer_query')) return []
  return [
    tool(
      async (args) => executePeerQuery(args, {
        agentId: bctx.ctx?.agentId,
        sessionId: bctx.ctx?.sessionId,
      }),
      {
        name: 'ask_peer',
        description: PeerQueryExtension.tools![0].description,
        schema: z.object({
          targetAgentId: z.string().describe('The ID of the teammate to query'),
          question: z.string().describe('The question to ask'),
        }).passthrough(),
      },
    ),
  ]
}

// Exported for testing
export { checkRateLimit as _checkRateLimit, rateLimiter as _rateLimiter }
