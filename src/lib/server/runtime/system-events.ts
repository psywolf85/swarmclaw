/**
 * In-memory event queue for heartbeat context injection.
 * Events are accumulated between heartbeat ticks and drained into heartbeat prompts.
 */

import { hmrSingleton } from '@/lib/shared-utils'

export interface SystemEvent {
  text: string
  timestamp: number
  contextKey?: string
}

const MAX_EVENTS_PER_SESSION = 20
const MAX_ORCHESTRATOR_EVENTS = 30

const queues: Map<string, SystemEvent[]> = hmrSingleton('__swarmclaw_system_events__', () => new Map<string, SystemEvent[]>())
const orchestratorQueues: Map<string, SystemEvent[]> = hmrSingleton('__swarmclaw_orchestrator_events__', () => new Map<string, SystemEvent[]>())

/** Push an event for a session. Deduplicates consecutive identical text, caps at MAX_EVENTS_PER_SESSION. */
export function enqueueSystemEvent(sessionId: string, text: string, contextKey?: string): void {
  let queue = queues.get(sessionId)
  if (!queue) {
    queue = []
    queues.set(sessionId, queue)
  }

  // Deduplicate consecutive identical text
  const last = queue[queue.length - 1]
  if (last && last.text === text) return

  queue.push({ text, timestamp: Date.now(), contextKey })

  // Cap at max
  if (queue.length > MAX_EVENTS_PER_SESSION) {
    queue.splice(0, queue.length - MAX_EVENTS_PER_SESSION)
  }
}

/** Destructive read — returns and clears all events for a session. */
export function drainSystemEvents(sessionId: string): SystemEvent[] {
  const queue = queues.get(sessionId)
  if (!queue || queue.length === 0) return []
  queues.delete(sessionId)
  return queue
}

/** Non-destructive read — returns current events without clearing. */
export function peekSystemEvents(sessionId: string): SystemEvent[] {
  return queues.get(sessionId) || []
}

// --- Agent-scoped orchestrator event queue ---

/** Push an event for an orchestrator agent. Same dedup + cap logic as session events. */
export function enqueueOrchestratorEvent(agentId: string, text: string, contextKey?: string): void {
  let queue = orchestratorQueues.get(agentId)
  if (!queue) {
    queue = []
    orchestratorQueues.set(agentId, queue)
  }

  const last = queue[queue.length - 1]
  if (last && last.text === text) return

  queue.push({ text, timestamp: Date.now(), contextKey })

  if (queue.length > MAX_ORCHESTRATOR_EVENTS) {
    queue.splice(0, queue.length - MAX_ORCHESTRATOR_EVENTS)
  }
}

/** Destructive read — returns and clears all orchestrator events for an agent. */
export function drainOrchestratorEvents(agentId: string): SystemEvent[] {
  const queue = orchestratorQueues.get(agentId)
  if (!queue || queue.length === 0) return []
  orchestratorQueues.delete(agentId)
  return queue
}

/** Non-destructive read — returns current orchestrator events without clearing. */
export function peekOrchestratorEvents(agentId: string): SystemEvent[] {
  return orchestratorQueues.get(agentId) || []
}

// --- Pruning for dead sessions/agents ---

/** Remove session event queues for sessions that no longer exist. */
export function pruneSystemEventQueues(liveSessionIds: Set<string>): void {
  for (const sessionId of queues.keys()) {
    if (!liveSessionIds.has(sessionId)) queues.delete(sessionId)
  }
}

/** Remove orchestrator event queues for agents that no longer exist. */
export function pruneOrchestratorEventQueues(liveAgentIds: Set<string>): void {
  for (const agentId of orchestratorQueues.keys()) {
    if (!liveAgentIds.has(agentId)) orchestratorQueues.delete(agentId)
  }
}
