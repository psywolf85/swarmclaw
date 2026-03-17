'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWs } from './use-ws'
import { api } from '@/lib/app/api-client'
import type { Agent, DelegationJobRecord } from '@/types'

export interface EdgeLiveState {
  active: boolean
  direction: 'down' | 'up'
  snippet: string | null
  color: 'indigo' | 'emerald' | 'red'
}

export interface NodeBubbleState {
  senderAgent: { id: string; name: string; avatarSeed?: string; avatarUrl?: string | null }
  receiverAgent: { id: string; name: string; avatarSeed?: string; avatarUrl?: string | null }
  task: string | null
  result: string | null
  color: 'indigo' | 'emerald' | 'red'
  timestamp: number
}

function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null
  return s.length > max ? s.slice(0, max) + '...' : s
}

/**
 * Subscribes to delegation job changes and derives per-edge live state
 * for animating org chart edges during active delegation.
 */
export function useDelegationEdgeState(agents: Record<string, Agent>): Map<string, EdgeLiveState> {
  const [edgeMap, setEdgeMap] = useState<Map<string, EdgeLiveState>>(() => new Map())
  const fadeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const refresh = useCallback(async () => {
    let jobs: DelegationJobRecord[]
    try {
      jobs = await api<DelegationJobRecord[]>('GET', '/delegation-jobs')
    } catch {
      return
    }
    if (!jobs || jobs.length === 0) {
      setEdgeMap((prev) => prev.size === 0 ? prev : new Map())
      return
    }

    const next = new Map<string, EdgeLiveState>()

    for (const job of jobs) {
      const childId = job.agentId
      if (!childId) continue
      const child = agents[childId]
      if (!child) continue
      const parentId = child.orgChart?.parentId
      if (!parentId || !agents[parentId]) continue

      const edgeKey = `${parentId}-${childId}`
      const status = job.status

      let direction: 'down' | 'up' = 'down'
      let snippet: string | null = null
      let color: 'indigo' | 'emerald' | 'red' = 'indigo'

      switch (status) {
        case 'queued':
        case 'running':
          direction = 'down'
          snippet = truncate(job.task, 100)
          color = 'indigo'
          break
        case 'completed':
          direction = 'up'
          snippet = truncate(job.resultPreview, 100)
          color = 'emerald'
          break
        case 'failed':
        case 'cancelled':
          direction = 'up'
          snippet = status
          color = 'red'
          break
      }

      next.set(edgeKey, { active: true, direction, snippet, color })
    }

    setEdgeMap((prev) => {
      // Cancel stale fade timers for keys that are now active again
      for (const [key, state] of next) {
        if (state.color === 'indigo' && fadeTimers.current.has(key)) {
          clearTimeout(fadeTimers.current.get(key))
          fadeTimers.current.delete(key)
        }
      }

      // Schedule fade timers for terminal jobs
      for (const [key, state] of next) {
        if (state.color === 'emerald' || state.color === 'red') {
          if (!fadeTimers.current.has(key)) {
            fadeTimers.current.set(key, setTimeout(() => {
              fadeTimers.current.delete(key)
              setEdgeMap((current) => {
                const updated = new Map(current)
                updated.delete(key)
                return updated
              })
            }, 4000))
          }
        }
      }

      // Merge: keep existing fade entries that aren't in next
      const merged = new Map(next)
      for (const [key, state] of prev) {
        if (!merged.has(key) && fadeTimers.current.has(key)) {
          merged.set(key, state)
        }
      }
      return merged
    })
  }, [agents])

  useWs('delegation_jobs', refresh, 3000)

  // Initial fetch
  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cleanup timers on unmount
  useEffect(() => {
    const ref = fadeTimers
    return () => {
      for (const timer of ref.current.values()) clearTimeout(timer)
      ref.current.clear()
    }
  }, [])

  return edgeMap
}

/**
 * Derives per-node delegation bubble state from the delegation jobs API.
 * Both parent and child nodes get the same bubble for each active delegation.
 * Active bubbles auto-clear after 5s. `lastBubble` persists for hover display.
 */
export function useNodeDelegationBubbles(agents: Record<string, Agent>): {
  activeBubbles: Map<string, NodeBubbleState>
  lastBubbles: Map<string, NodeBubbleState>
} {
  const [activeBubbles, setActiveBubbles] = useState<Map<string, NodeBubbleState>>(() => new Map())
  const lastBubblesRef = useRef<Map<string, NodeBubbleState>>(new Map())
  const [lastBubblesVer, setLastBubblesVer] = useState(0)
  const fadeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const refresh = useCallback(async () => {
    let jobs: DelegationJobRecord[]
    try {
      jobs = await api<DelegationJobRecord[]>('GET', '/delegation-jobs')
    } catch {
      return
    }
    if (!jobs || jobs.length === 0) {
      setActiveBubbles((prev) => prev.size === 0 ? prev : new Map())
      return
    }

    const next = new Map<string, NodeBubbleState>()

    for (const job of jobs) {
      const childId = job.agentId
      if (!childId) continue
      const child = agents[childId]
      if (!child) continue
      const parentId = child.orgChart?.parentId
      if (!parentId || !agents[parentId]) continue

      const parent = agents[parentId]
      const status = job.status

      let color: 'indigo' | 'emerald' | 'red' = 'indigo'
      let result: string | null = null

      switch (status) {
        case 'queued':
        case 'running':
          color = 'indigo'
          break
        case 'completed':
          color = 'emerald'
          result = job.resultPreview || null
          break
        case 'failed':
        case 'cancelled':
          color = 'red'
          result = status
          break
      }

      const bubble: NodeBubbleState = {
        senderAgent: {
          id: parentId,
          name: parent.name,
          avatarSeed: parent.avatarSeed,
          avatarUrl: parent.avatarUrl,
        },
        receiverAgent: {
          id: childId,
          name: child.name,
          avatarSeed: child.avatarSeed,
          avatarUrl: child.avatarUrl,
        },
        task: job.task || null,
        result,
        color,
        timestamp: job.updatedAt || job.createdAt,
      }

      // Show bubble only on the worker (child) node
      next.set(childId, bubble)
    }

    setActiveBubbles((prev) => {
      // Persist to lastBubbles
      for (const [nodeId, bubble] of next) {
        lastBubblesRef.current.set(nodeId, bubble)
      }
      setLastBubblesVer((v) => v + 1)

      // Cancel stale fade timers for nodes that are now active again
      for (const [nodeId, bubble] of next) {
        if (bubble.color === 'indigo' && fadeTimers.current.has(nodeId)) {
          clearTimeout(fadeTimers.current.get(nodeId))
          fadeTimers.current.delete(nodeId)
        }
      }

      // Schedule fade timers for terminal states
      for (const [nodeId, bubble] of next) {
        if (bubble.color === 'emerald' || bubble.color === 'red') {
          if (!fadeTimers.current.has(nodeId)) {
            fadeTimers.current.set(nodeId, setTimeout(() => {
              fadeTimers.current.delete(nodeId)
              setActiveBubbles((current) => {
                const updated = new Map(current)
                updated.delete(nodeId)
                return updated
              })
            }, 5000))
          }
        }
      }

      // Merge: keep fading entries
      const merged = new Map(next)
      for (const [key, state] of prev) {
        if (!merged.has(key) && fadeTimers.current.has(key)) {
          merged.set(key, state)
        }
      }
      return merged
    })
  }, [agents])

  useWs('delegation_jobs', refresh, 3000)

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const ref = fadeTimers
    return () => {
      for (const timer of ref.current.values()) clearTimeout(timer)
      ref.current.clear()
    }
  }, [])

  // Return a stable reference for lastBubbles keyed by version
  // eslint-disable-next-line react-hooks/exhaustive-deps -- lastBubblesVer is the intentional signal to re-snapshot the ref
  const lastBubbles = useMemo(() => new Map(lastBubblesRef.current), [lastBubblesVer])

  return { activeBubbles, lastBubbles }
}
