'use client'

import { useCallback, useEffect, useState } from 'react'
import { useWs } from './use-ws'
import { api } from '@/lib/app/api-client'

export interface AgentLiveStatus {
  goal: string | null
  status: 'idle' | 'progress' | 'blocked' | 'ok'
  summary: string | null
  nextAction: string | null
  planSteps: string[]
  currentPlanStep: string | null
  updatedAt: number
}

interface UseAgentLiveStatusResult {
  data: AgentLiveStatus | null
  loading: boolean
}

/**
 * Subscribes to an agent's heartbeat WS topic and polls its MainLoopState.
 * Returns live status for display in the org chart detail panel.
 */
export function useAgentLiveStatus(agentId: string | null): UseAgentLiveStatusResult {
  const [data, setData] = useState<AgentLiveStatus | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!agentId) {
      setData(null)
      return
    }
    setLoading(true)
    try {
      const result = await api<AgentLiveStatus | null>('GET', `/agents/${agentId}/status`)
      setData(result)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [agentId])

  // Subscribe to heartbeat WS topic for this agent, poll every 10s as fallback.
  // useWs handles initial fetch and re-subscription when topic changes.
  useWs(agentId ? `heartbeat:agent:${agentId}` : '', refresh, 10_000)

  // Reset data when agentId changes (useWs will trigger the new fetch)
  useEffect(() => {
    setData(null)
    // Fire immediate fetch on agentId change since useWs may wait for the next poll cycle
    if (agentId) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only reset on agentId change, not refresh identity
  }, [agentId])

  return { data, loading }
}
