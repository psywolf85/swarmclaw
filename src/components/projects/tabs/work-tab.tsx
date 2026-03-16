'use client'

import { useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { relativeDate, STATUS_STYLES } from '../project-utils'
import type { Agent, BoardTask, Mission, Project } from '@/types'

type SortKey = 'status' | 'updated' | 'agent'
type StatusFilter = 'all' | 'backlog' | 'queued' | 'running' | 'completed' | 'failed'

const STATUS_PRIORITY: Record<string, number> = {
  failed: 0, running: 1, queued: 2, backlog: 3, deferred: 4, completed: 5, cancelled: 6, archived: 7,
}

interface WorkTabProps {
  project: Project
  missions: Mission[]
}

export function WorkTab({ project, missions }: WorkTabProps) {
  const tasks = useAppStore((s) => s.tasks) as Record<string, BoardTask>
  const agents = useAppStore((s) => s.agents) as Record<string, Agent>
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)

  const [sortKey, setSortKey] = useState<SortKey>('status')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [agentFilter, setAgentFilter] = useState<string | null>(null)
  const [missionFilter, setMissionFilter] = useState<string | null>(null)
  const [missionSummaryOpen, setMissionSummaryOpen] = useState(false)

  const projectTasks = useMemo(
    () => Object.values(tasks).filter((t) => t.projectId === activeProjectFilter),
    [tasks, activeProjectFilter],
  )

  // Build taskId -> mission lookup from Mission.taskIds
  const taskIdToMission = useMemo(() => {
    const lookup: Record<string, Mission> = {}
    for (const m of missions) {
      for (const tid of m.taskIds || []) {
        lookup[tid] = m
      }
    }
    return lookup
  }, [missions])

  // Filter
  const filteredTasks = useMemo(() => {
    return projectTasks.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false
      if (agentFilter && t.agentId !== agentFilter) return false
      if (missionFilter) {
        const m = taskIdToMission[t.id]
        if (!m || m.id !== missionFilter) return false
      }
      return true
    })
  }, [projectTasks, statusFilter, agentFilter, missionFilter, taskIdToMission])

  // Sort
  const sortedTasks = useMemo(() => {
    return [...filteredTasks].sort((a, b) => {
      if (sortKey === 'status') return (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99)
      if (sortKey === 'updated') return b.updatedAt - a.updatedAt
      if (sortKey === 'agent') return (a.agentId || '').localeCompare(b.agentId || '')
      return 0
    })
  }, [filteredTasks, sortKey])

  // Unique agents in project tasks for filter dropdown
  const taskAgentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const t of projectTasks) {
      if (t.agentId) ids.add(t.agentId)
    }
    return Array.from(ids)
  }, [projectTasks])

  // Mission status summary
  const missionStatusSummary = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const m of missions) {
      counts[m.status] = (counts[m.status] || 0) + 1
    }
    return counts
  }, [missions])

  // Suppress unused warning — project prop is part of the public interface
  void project

  return (
    <div className="max-w-3xl mx-auto px-8 py-6 space-y-4">
      {/* Mission summary (collapsible) */}
      {missions.length > 0 && (
        <div className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <button
            onClick={() => setMissionSummaryOpen(!missionSummaryOpen)}
            className="w-full flex items-center justify-between px-4 py-3 cursor-pointer bg-transparent border-none text-left"
            style={{ fontFamily: 'inherit' }}
          >
            <span className="text-[12px] font-600 text-text-2">
              Missions: {Object.entries(missionStatusSummary).map(([s, c]) => `${c} ${s}`).join(', ')}
            </span>
            <svg
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              className={`text-text-3/40 transition-transform ${missionSummaryOpen ? 'rotate-180' : ''}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {missionSummaryOpen && (
            <div className="border-t border-white/[0.06] px-4 py-2 space-y-1">
              {missions.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMissionFilter(missionFilter === m.id ? null : m.id)}
                  className={`w-full flex items-center justify-between px-2 py-1.5 rounded-[8px] text-left cursor-pointer bg-transparent border-none transition-colors
                    ${missionFilter === m.id ? 'bg-accent-soft' : 'hover:bg-white/[0.04]'}`}
                  style={{ fontFamily: 'inherit' }}
                >
                  <span className="text-[12px] text-text truncate">{m.objective}</span>
                  <span className={`text-[9px] font-600 uppercase tracking-wider px-1.5 py-0.5 rounded-[4px] shrink-0 ${
                    m.status === 'active' ? 'bg-sky-500/15 text-sky-400' : 'bg-white/[0.06] text-text-3'
                  }`}>{m.status}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Controls row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {/* Sort */}
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="text-[11px] bg-white/[0.04] border border-white/[0.06] rounded-[8px] px-2 py-1.5 text-text-2 outline-none"
            style={{ fontFamily: 'inherit' }}
          >
            <option value="status">Sort: Status</option>
            <option value="updated">Sort: Updated</option>
            <option value="agent">Sort: Agent</option>
          </select>

          {/* Status filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="text-[11px] bg-white/[0.04] border border-white/[0.06] rounded-[8px] px-2 py-1.5 text-text-2 outline-none"
            style={{ fontFamily: 'inherit' }}
          >
            <option value="all">All statuses</option>
            <option value="backlog">Backlog</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>

          {/* Agent filter */}
          {taskAgentIds.length > 0 && (
            <select
              value={agentFilter || ''}
              onChange={(e) => setAgentFilter(e.target.value || null)}
              className="text-[11px] bg-white/[0.04] border border-white/[0.06] rounded-[8px] px-2 py-1.5 text-text-2 outline-none"
              style={{ fontFamily: 'inherit' }}
            >
              <option value="">All agents</option>
              {taskAgentIds.map((id) => (
                <option key={id} value={id}>{agents[id]?.name || id}</option>
              ))}
            </select>
          )}

          {/* Clear filters */}
          {(statusFilter !== 'all' || agentFilter || missionFilter) && (
            <button
              onClick={() => { setStatusFilter('all'); setAgentFilter(null); setMissionFilter(null) }}
              className="text-[10px] text-accent-bright/70 hover:text-accent-bright cursor-pointer bg-transparent border-none"
              style={{ fontFamily: 'inherit' }}
            >
              Clear filters
            </button>
          )}
        </div>

        <button
          onClick={() => { setEditingTaskId(null); setTaskSheetOpen(true) }}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer border-none"
          style={{ fontFamily: 'inherit' }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Task
        </button>
      </div>

      {/* Task list */}
      {sortedTasks.length === 0 ? (
        <div className="rounded-[12px] border border-dashed border-white/[0.08] px-5 py-8 text-center">
          <p className="text-[12px] text-text-3/40">
            {projectTasks.length === 0 ? 'No tasks yet.' : 'No tasks match the current filters.'}
          </p>
          {projectTasks.length === 0 && (
            <p className="text-[11px] text-text-3/30 mt-1">Create a task to get started.</p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {sortedTasks.map((task) => {
            const agent = task.agentId ? agents[task.agentId] : null
            const mission = taskIdToMission[task.id]
            return (
              <button
                key={task.id}
                onClick={() => { setEditingTaskId(task.id); setTaskSheetOpen(true) }}
                className="flex items-center gap-3 px-4 py-3 rounded-[10px] border border-white/[0.04] bg-white/[0.01] hover:bg-white/[0.04] hover:border-white/[0.08] transition-all cursor-pointer text-left w-full"
                style={{ fontFamily: 'inherit' }}
              >
                <span className={`shrink-0 px-2 py-0.5 rounded-[5px] text-[10px] font-600 uppercase tracking-wider ${STATUS_STYLES[task.status] || STATUS_STYLES.backlog}`}>
                  {task.status}
                </span>
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] text-text truncate block">{task.title}</span>
                  {mission && (
                    <span className="text-[10px] text-text-3/40 truncate block mt-0.5">{mission.objective}</span>
                  )}
                </div>
                {agent && (
                  <span className="shrink-0 flex items-center gap-1.5 text-[11px] text-text-3/40">
                    <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={16} />
                    {agent.name}
                  </span>
                )}
                <span className="text-[10px] text-text-3/30 shrink-0">{relativeDate(task.updatedAt)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
