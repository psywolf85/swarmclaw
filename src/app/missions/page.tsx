'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { api } from '@/lib/app/api-client'
import { useWs } from '@/hooks/use-ws'
import { useAppStore } from '@/stores/use-app-store'
import { FilterPill } from '@/components/ui/filter-pill'
import { StatCard } from '@/components/ui/stat-card'
import { StructuredSessionLauncher } from '@/components/protocols/structured-session-launcher'
import { timeAgo } from '@/lib/time-format'
import { getMissionPath } from '@/lib/app/navigation'
import type {
  ApprovalRequest,
  BoardTask,
  Mission,
  MissionEvent,
  MissionPhase,
  MissionStatus,
  MissionSummary,
  SessionQueuedTurn,
  SessionRunRecord,
} from '@/types'

type MissionDetailResponse = {
  mission: Mission
  summary: MissionSummary
  parent: MissionSummary | null
  children: MissionSummary[]
  linkedTasks: BoardTask[]
  recentRuns: SessionRunRecord[]
  queuedTurns: SessionQueuedTurn[]
  approvals: ApprovalRequest[]
  events: MissionEvent[]
}

type MissionStatusFilter = 'all' | MissionStatus
type MissionWaitKind = NonNullable<Mission['waitState']>['kind']

function missionStatusTone(status: MissionStatus): string {
  if (status === 'completed') return 'text-emerald-300 bg-emerald-500/12 border-emerald-500/18'
  if (status === 'waiting') return 'text-amber-300 bg-amber-500/12 border-amber-500/18'
  if (status === 'failed') return 'text-red-300 bg-red-500/12 border-red-500/18'
  if (status === 'cancelled') return 'text-text-3 bg-white/[0.06] border-white/[0.08]'
  return 'text-sky-300 bg-sky-500/12 border-sky-500/18'
}

function phaseTone(phase: MissionPhase): string {
  if (phase === 'completed') return 'text-emerald-300'
  if (phase === 'failed') return 'text-red-300'
  if (phase === 'waiting') return 'text-amber-300'
  if (phase === 'verifying') return 'text-violet-300'
  if (phase === 'dispatching') return 'text-sky-300'
  return 'text-text-2'
}

function sourceLabel(mission: MissionSummary | Mission): string {
  const kind = mission.sourceRef?.kind || mission.source
  return kind.replace(/_/g, ' ')
}

async function postMissionAction(
  missionId: string,
  body: {
    action: 'resume' | 'replan' | 'cancel' | 'retry_verification' | 'wait'
    reason?: string
    waitKind?: MissionWaitKind
    untilAt?: number | null
  },
): Promise<void> {
  await api('POST', `/missions/${missionId}/actions`, body)
}

function missionRouteId(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] !== 'missions') return null
  return parts[1] ? decodeURIComponent(parts[1]) : null
}

export default function MissionsPage() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const missionHumanLoopEnabled = useAppStore((state) => state.appSettings.missionHumanLoopEnabled === true)
  const loadSettings = useAppStore((state) => state.loadSettings)
  const [missions, setMissions] = useState<Mission[]>([])
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null)
  const [selectedMission, setSelectedMission] = useState<MissionDetailResponse | null>(null)
  const [statusFilter, setStatusFilter] = useState<MissionStatusFilter>('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [policyPending, setPolicyPending] = useState(false)
  const [structuredSessionOpen, setStructuredSessionOpen] = useState(false)
  const [linkedRun, setLinkedRun] = useState<{ id: string; status: string } | null>(null)
  const [waitReason, setWaitReason] = useState('')
  const [waitKind, setWaitKind] = useState<MissionWaitKind>('other')
  const [waitUntil, setWaitUntil] = useState('')
  const requestedMissionId = missionRouteId(pathname) || searchParams.get('missionId')

  const loadList = useCallback(async () => {
    try {
      const missionList = await api<Mission[]>('GET', '/missions?limit=120')
      const normalized = Array.isArray(missionList) ? missionList : []
      setMissions(normalized)
      setSelectedMissionId((current) => {
        if (requestedMissionId && normalized.some((mission) => mission.id === requestedMissionId)) {
          return requestedMissionId
        }
        if (current && normalized.some((mission) => mission.id === current)) return current
        return normalized[0]?.id || null
      })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load missions.')
    } finally {
      setLoading(false)
    }
  }, [requestedMissionId])

  const loadDetail = useCallback(async (missionId: string | null) => {
    if (!missionId) {
      setSelectedMission(null)
      return
    }
    setDetailLoading(true)
    try {
      const detail = await api<MissionDetailResponse>('GET', `/missions/${missionId}`)
      setSelectedMission(detail)
      setActionError(null)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to load mission detail.')
      setSelectedMission(null)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  useEffect(() => {
    void loadDetail(selectedMissionId)
  }, [loadDetail, selectedMissionId])

  useWs('missions', loadList, 2000)

  const refreshLinkedRun = useCallback(() => {
    if (!selectedMissionId) {
      setLinkedRun(null)
      return
    }
    void api<Array<{ id: string; status: string }>>('GET', `/protocols/runs?missionId=${encodeURIComponent(selectedMissionId)}&limit=6`)
      .then((runs) => {
        const active = (Array.isArray(runs) ? runs : []).find((run) => !['completed', 'failed', 'cancelled', 'archived'].includes(run.status))
        setLinkedRun(active ? { id: active.id, status: active.status } : null)
      })
      .catch(() => setLinkedRun(null))
  }, [selectedMissionId])

  useEffect(() => {
    void refreshLinkedRun()
  }, [refreshLinkedRun])

  useWs(selectedMissionId ? 'protocol_runs' : '', refreshLinkedRun, 2000)

  const filtered = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    return missions.filter((mission) => {
      if (statusFilter !== 'all' && mission.status !== statusFilter) return false
      if (!normalizedSearch) return true
      return [
        mission.objective,
        mission.currentStep,
        mission.waitState?.reason,
        mission.plannerSummary,
        mission.verifierSummary,
      ].some((value) => typeof value === 'string' && value.toLowerCase().includes(normalizedSearch))
    })
  }, [missions, search, statusFilter])

  const stats = useMemo(() => ({
    active: missions.filter((mission) => mission.status === 'active').length,
    waiting: missions.filter((mission) => mission.status === 'waiting').length,
    failed: missions.filter((mission) => mission.status === 'failed').length,
    completed: missions.filter((mission) => mission.status === 'completed').length,
  }), [missions])

  const handleAction = useCallback(async (action: 'resume' | 'replan' | 'cancel' | 'retry_verification') => {
    if (!selectedMission?.mission.id) return
    setPendingAction(action)
    try {
      await postMissionAction(selectedMission.mission.id, { action })
      await Promise.all([loadList(), loadDetail(selectedMission.mission.id)])
      setActionError(null)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to update mission.')
    } finally {
      setPendingAction(null)
    }
  }, [loadDetail, loadList, selectedMission])

  const handleWaitAction = useCallback(async () => {
    if (!selectedMission?.mission.id) return
    const reason = waitReason.trim()
    if (!reason) {
      setActionError('A wait reason is required.')
      return
    }
    setPendingAction('wait')
    try {
      await postMissionAction(selectedMission.mission.id, {
        action: 'wait',
        reason,
        waitKind,
        untilAt: waitUntil ? Date.parse(waitUntil) : null,
      })
      await Promise.all([loadList(), loadDetail(selectedMission.mission.id)])
      setActionError(null)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to update mission.')
    } finally {
      setPendingAction(null)
    }
  }, [loadDetail, loadList, selectedMission, waitKind, waitReason, waitUntil])

  const handleMissionHumanLoopToggle = useCallback(async () => {
    setPolicyPending(true)
    try {
      await api('PUT', '/settings', {
        missionHumanLoopEnabled: !missionHumanLoopEnabled,
      })
      await loadSettings()
      setActionError(null)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to update mission policy.')
    } finally {
      setPolicyPending(false)
    }
  }, [loadSettings, missionHumanLoopEnabled])

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-app px-4 py-5 md:px-6 md:py-6">
      <div className="mx-auto max-w-[1600px] space-y-5">
        <section className="rounded-[24px] border border-white/[0.06] bg-white/[0.03] p-5 md:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-[760px]">
              <div className="inline-flex rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[11px] font-700 uppercase tracking-[0.18em] text-text-3/70">
                Mission Control
              </div>
              <h1 className="mt-4 font-display text-[34px] font-700 tracking-[-0.03em] text-text">Durable Objectives</h1>
              <p className="mt-3 max-w-[720px] text-[15px] leading-relaxed text-text-3/72">
                Inspect the agent&apos;s active objectives, blocked work, delegated branches, verification state, and queued follow-ups in one place.
              </p>
            </div>
            <div className="w-full max-w-[360px] rounded-[20px] border border-white/[0.06] bg-surface/70 p-4">
              <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">List Filters</div>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search objective, wait reason, or step"
                className="mt-3 w-full rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {(['all', 'active', 'waiting', 'failed', 'completed'] as MissionStatusFilter[]).map((filter) => (
                  <FilterPill
                    key={filter}
                    label={filter === 'all' ? 'All' : filter}
                    active={statusFilter === filter}
                    onClick={() => setStatusFilter(filter)}
                  />
                ))}
              </div>
              <div className="mt-4 rounded-[14px] border border-white/[0.06] bg-white/[0.03] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[12px] font-700 text-text-2">Mission human loop</div>
                    <div className="mt-1 text-[12px] leading-relaxed text-text-3/68">
                      {missionHumanLoopEnabled
                        ? 'Missions may stay open and wait for a human follow-up.'
                        : 'Off by default. Generic “waiting for your next instruction” handoffs close instead of lingering as open missions.'}
                    </div>
                    <div className="mt-2 text-[11px] leading-relaxed text-text-3/50">
                      Explicit tool approvals and real external blockers still apply.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleMissionHumanLoopToggle()}
                    disabled={policyPending}
                    aria-pressed={missionHumanLoopEnabled}
                    aria-label={missionHumanLoopEnabled ? 'Disable mission human loop' : 'Enable mission human loop'}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${missionHumanLoopEnabled ? 'bg-accent-bright/80' : 'bg-white/[0.12]'} ${policyPending ? 'opacity-60' : ''}`}
                  >
                    <span
                      className={`absolute left-[3px] top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-transform ${missionHumanLoopEnabled ? 'translate-x-[20px]' : 'translate-x-0'}`}
                    />
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Active" value={stats.active} index={0} className="bg-surface-2 border-white/[0.05]" />
            <StatCard label="Waiting" value={stats.waiting} index={1} className="bg-surface-2 border-white/[0.05]" />
            <StatCard label="Failed" value={stats.failed} index={2} className="bg-surface-2 border-white/[0.05]" />
            <StatCard label="Completed" value={stats.completed} index={3} className="bg-surface-2 border-white/[0.05]" />
          </div>
        </section>

        {error && (
          <div className="rounded-[16px] border border-red-500/18 bg-red-500/8 px-4 py-3 text-[13px] text-red-200">
            {error}
          </div>
        )}

        <section className="grid gap-5 xl:grid-cols-[420px_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col rounded-[22px] border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="flex items-center justify-between px-2 pb-2">
              <div>
                <div className="text-[12px] font-700 uppercase tracking-[0.1em] text-text-3/55">Missions</div>
                <div className="text-[12px] text-text-3/45">{filtered.length} visible</div>
              </div>
            </div>
            <div className="max-h-[70vh] min-h-0 space-y-2 overflow-y-auto pr-1">
              {loading ? (
                <div className="px-3 py-4 text-[13px] text-text-3/55">Loading missions…</div>
              ) : filtered.length === 0 ? (
                <div className="px-3 py-4 text-[13px] text-text-3/55">No missions match the current filters.</div>
              ) : filtered.map((mission) => {
                const selected = mission.id === selectedMissionId
                return (
                  <button
                    key={mission.id}
                    type="button"
                    onClick={() => {
                      setSelectedMissionId(mission.id)
                      router.push(getMissionPath(mission.id))
                    }}
                    className={`w-full rounded-[18px] border px-4 py-3 text-left transition-all cursor-pointer ${
                      selected
                        ? 'border-accent-bright/30 bg-accent-bright/10'
                        : 'border-white/[0.06] bg-surface/70 hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="line-clamp-2 text-[14px] font-700 text-text">{mission.objective}</div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.08em] ${missionStatusTone(mission.status)}`}>
                            {mission.status}
                          </span>
                          <span className="rounded-full border border-white/[0.08] px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.08em] text-text-3/70">
                            {sourceLabel(mission)}
                          </span>
                        </div>
                      </div>
                      <div className="shrink-0 text-[11px] text-text-3/45">{timeAgo(mission.updatedAt)}</div>
                    </div>
                    <div className={`mt-3 text-[12px] font-600 ${phaseTone(mission.phase)}`}>{mission.phase}</div>
                    <div className="mt-1 text-[12px] leading-relaxed text-text-3/72 line-clamp-2">
                      {mission.waitState?.reason || mission.currentStep || mission.verifierSummary || mission.plannerSummary || 'Mission active.'}
                    </div>
                    <div className="mt-3 flex gap-3 text-[11px] text-text-3/45">
                      <span>{mission.taskIds?.length || 0} tasks</span>
                      <span>{mission.childMissionIds?.length || 0} child missions</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="rounded-[22px] border border-white/[0.06] bg-white/[0.02] p-4 md:p-5">
            {!selectedMissionId ? (
              <div className="rounded-[18px] border border-dashed border-white/[0.08] px-5 py-8 text-[14px] text-text-3/60">
                Select a mission to inspect its detail, linked work, and operator actions.
              </div>
            ) : detailLoading && !selectedMission ? (
              <div className="px-2 py-4 text-[13px] text-text-3/55">Loading mission detail…</div>
            ) : selectedMission ? (
              <div className="space-y-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap gap-2">
                      <span className={`rounded-full border px-2.5 py-1 text-[10px] font-700 uppercase tracking-[0.1em] ${missionStatusTone(selectedMission.mission.status)}`}>
                        {selectedMission.mission.status}
                      </span>
                      <span className="rounded-full border border-white/[0.08] px-2.5 py-1 text-[10px] font-700 uppercase tracking-[0.1em] text-text-3/70">
                        {sourceLabel(selectedMission.mission)}
                      </span>
                      <span className={`rounded-full border border-white/[0.08] px-2.5 py-1 text-[10px] font-700 uppercase tracking-[0.1em] ${phaseTone(selectedMission.mission.phase)}`}>
                        {selectedMission.mission.phase}
                      </span>
                    </div>
                    <h2 className="mt-3 font-display text-[28px] font-700 tracking-[-0.03em] text-text">
                      {selectedMission.mission.objective}
                    </h2>
                    <p className="mt-2 text-[13px] text-text-3/58">
                      Updated {timeAgo(selectedMission.mission.updatedAt)}
                      {selectedMission.parent ? ` · child of ${selectedMission.parent.objective}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {linkedRun && (
                      <button
                        type="button"
                        onClick={() => router.push(`/protocols?runId=${encodeURIComponent(linkedRun.id)}`)}
                        className="rounded-[12px] border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-[12px] font-700 text-sky-100 transition-colors hover:bg-sky-500/16"
                      >
                        Open Session
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setStructuredSessionOpen(true)}
                      className="rounded-[12px] bg-accent-bright px-3 py-2 text-[12px] font-700 text-black transition-colors hover:opacity-90"
                    >
                      {linkedRun ? 'Run Another Structured Session' : 'Run Structured Session'}
                    </button>
                    {([
                      ['resume', 'Resume'],
                      ['replan', 'Replan'],
                      ['retry_verification', 'Retry Verification'],
                      ['cancel', 'Cancel'],
                    ] as const).map(([action, label]) => (
                      <button
                        key={action}
                        type="button"
                        onClick={() => void handleAction(action)}
                        disabled={pendingAction !== null}
                        className="rounded-[12px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-700 text-text-2 transition-colors hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {pendingAction === action ? 'Working…' : label}
                      </button>
                    ))}
                  </div>
                </div>

                {actionError && (
                  <div className="rounded-[16px] border border-red-500/18 bg-red-500/8 px-4 py-3 text-[13px] text-red-200">
                    {actionError}
                  </div>
                )}

                <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)]">
                  <div className="space-y-4">
                    {(selectedMission.parent || selectedMission.children.length > 0) && (
                      <div className="rounded-[18px] border border-white/[0.06] bg-surface/70 p-4">
                        <div className="text-[11px] font-700 uppercase tracking-[0.1em] text-text-3/55">Mission Graph</div>
                        <div className="mt-3 space-y-3">
                          {selectedMission.parent && (
                            <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.03] px-3 py-2">
                              <div className="text-[11px] uppercase tracking-[0.08em] text-text-3/45">Parent</div>
                              <div className="mt-1 flex items-start justify-between gap-3">
                                <div>
                                  <div className="text-[12px] font-700 text-text">{selectedMission.parent.objective}</div>
                                  <div className="mt-1 text-[11px] text-text-3/55">{selectedMission.parent.status} · {selectedMission.parent.phase}</div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedMissionId(selectedMission.parent?.id || null)
                                    if (selectedMission.parent?.id) router.push(getMissionPath(selectedMission.parent.id))
                                  }}
                                  className="rounded-[10px] border border-white/[0.08] bg-transparent px-2.5 py-1 text-[11px] font-700 text-text-2 transition-colors hover:bg-white/[0.05]"
                                >
                                  Open
                                </button>
                              </div>
                            </div>
                          )}
                          {selectedMission.children.length > 0 && (
                            <div>
                              <div className="mb-2 text-[12px] font-700 text-text-2">Children</div>
                              <div className="space-y-2">
                                {selectedMission.children.map((child) => (
                                  <div key={child.id} className="rounded-[14px] border border-white/[0.06] bg-white/[0.03] px-3 py-2">
                                    <div className="flex items-start justify-between gap-3">
                                      <div>
                                        <div className="text-[12px] font-700 text-text">{child.objective}</div>
                                        <div className="mt-1 text-[11px] text-text-3/55">{child.status} · {child.phase}</div>
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setSelectedMissionId(child.id)
                                          router.push(getMissionPath(child.id))
                                        }}
                                        className="rounded-[10px] border border-white/[0.08] bg-transparent px-2.5 py-1 text-[11px] font-700 text-text-2 transition-colors hover:bg-white/[0.05]"
                                      >
                                        Open
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="rounded-[18px] border border-white/[0.06] bg-surface/70 p-4">
                      <div className="text-[11px] font-700 uppercase tracking-[0.1em] text-text-3/55">Current Lane</div>
                      <div className="mt-3 space-y-2 text-[13px] text-text-2">
                        <div><span className="text-text-3/55">Current step:</span> {selectedMission.mission.currentStep || 'Not set'}</div>
                        <div><span className="text-text-3/55">Planner summary:</span> {selectedMission.mission.plannerSummary || 'None recorded'}</div>
                        <div><span className="text-text-3/55">Verifier summary:</span> {selectedMission.mission.verifierSummary || 'None recorded'}</div>
                      </div>
                    </div>

                    <div className="rounded-[18px] border border-white/[0.06] bg-surface/70 p-4">
                      <div className="text-[11px] font-700 uppercase tracking-[0.1em] text-text-3/55">Linked Work</div>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <div>
                          <div className="mb-2 text-[12px] font-700 text-text-2">Tasks</div>
                          <div className="space-y-2">
                            {selectedMission.linkedTasks.length === 0 ? (
                              <div className="text-[12px] text-text-3/55">No linked tasks.</div>
                            ) : selectedMission.linkedTasks.map((task) => (
                              <div key={task.id} className="rounded-[14px] border border-white/[0.06] bg-white/[0.03] px-3 py-2">
                                <div className="text-[12px] font-700 text-text">{task.title}</div>
                                <div className="mt-1 text-[11px] text-text-3/55">{task.status}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className="mb-2 text-[12px] font-700 text-text-2">Queued Turns</div>
                          <div className="space-y-2">
                            {selectedMission.queuedTurns.length === 0 ? (
                              <div className="text-[12px] text-text-3/55">No queued turns.</div>
                            ) : selectedMission.queuedTurns.map((turn) => (
                              <div key={turn.runId} className="rounded-[14px] border border-white/[0.06] bg-white/[0.03] px-3 py-2">
                                <div className="line-clamp-2 text-[12px] text-text">{turn.text || '(attachment only)'}</div>
                                <div className="mt-1 text-[11px] text-text-3/55">Position {turn.position} · {timeAgo(turn.queuedAt)}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-[18px] border border-white/[0.06] bg-surface/70 p-4">
                      <div className="text-[11px] font-700 uppercase tracking-[0.1em] text-text-3/55">Recent Runs</div>
                      <div className="mt-3 space-y-2">
                        {selectedMission.recentRuns.length === 0 ? (
                          <div className="text-[12px] text-text-3/55">No linked runs yet.</div>
                        ) : selectedMission.recentRuns.map((run) => (
                          <div key={run.id} className="rounded-[14px] border border-white/[0.06] bg-white/[0.03] px-3 py-2">
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-[12px] font-700 text-text">{run.status}</div>
                              <div className="text-[11px] text-text-3/45">{timeAgo(run.queuedAt)}</div>
                            </div>
                            <div className="mt-1 line-clamp-2 text-[12px] text-text-3/68">{run.messagePreview || run.resultPreview || run.error || 'No summary recorded.'}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-[18px] border border-white/[0.06] bg-surface/70 p-4">
                      <div className="text-[11px] font-700 uppercase tracking-[0.1em] text-text-3/55">Wait and Verification</div>
                      <div className="mt-3 space-y-2 text-[13px] text-text-2">
                        <div><span className="text-text-3/55">Waiting reason:</span> {selectedMission.mission.waitState?.reason || 'Not waiting'}</div>
                        <div><span className="text-text-3/55">Wait kind:</span> {selectedMission.mission.waitState?.kind || 'None'}</div>
                        <div><span className="text-text-3/55">Verification candidate:</span> {selectedMission.mission.verificationState?.candidate ? 'Yes' : 'No'}</div>
                        <div><span className="text-text-3/55">Evidence:</span> {selectedMission.mission.verificationState?.evidenceSummary || 'No evidence summary yet'}</div>
                      </div>
                      <div className="mt-4 rounded-[14px] border border-white/[0.06] bg-white/[0.03] p-3">
                        <div className="text-[12px] font-700 text-text-2">Mark Waiting</div>
                        <div className="mt-3 space-y-2">
                          <select
                            value={waitKind}
                            onChange={(event) => setWaitKind(event.target.value as typeof waitKind)}
                            className="w-full rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2 text-[13px] text-text outline-none"
                          >
                            {(['human_reply', 'approval', 'external_dependency', 'provider', 'blocked_task', 'blocked_mission', 'scheduled', 'other'] as const).map((kind) => (
                              <option key={kind} value={kind}>{kind.replace(/_/g, ' ')}</option>
                            ))}
                          </select>
                          <textarea
                            value={waitReason}
                            onChange={(event) => setWaitReason(event.target.value)}
                            placeholder="Why should this mission wait?"
                            rows={3}
                            className="w-full rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2 text-[13px] text-text outline-none placeholder:text-text-3/35"
                          />
                          <input
                            type="datetime-local"
                            value={waitUntil}
                            onChange={(event) => setWaitUntil(event.target.value)}
                            className="w-full rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2 text-[13px] text-text outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => void handleWaitAction()}
                            disabled={pendingAction !== null}
                            className="rounded-[12px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-700 text-text-2 transition-colors hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {pendingAction === 'wait' ? 'Working…' : 'Set Wait State'}
                          </button>
                        </div>
                      </div>
                      {selectedMission.approvals.length > 0 && (
                        <div className="mt-4">
                          <div className="mb-2 text-[12px] font-700 text-text-2">Approvals</div>
                          <div className="space-y-2">
                            {selectedMission.approvals.slice(0, 4).map((approval) => (
                              <div key={approval.id} className="rounded-[14px] border border-white/[0.06] bg-white/[0.03] px-3 py-2">
                                <div className="text-[12px] font-700 text-text">{approval.status}</div>
                                <div className="mt-1 text-[11px] text-text-3/55">{approval.title || approval.id}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="flex min-h-0 flex-col rounded-[18px] border border-white/[0.06] bg-surface/70 p-4">
                      <div className="text-[11px] font-700 uppercase tracking-[0.1em] text-text-3/55">Timeline</div>
                      <div className="mt-3 max-h-[420px] min-h-0 space-y-2 overflow-y-auto pr-1">
                        {selectedMission.events.length === 0 ? (
                          <div className="text-[12px] text-text-3/55">No mission events recorded yet.</div>
                        ) : selectedMission.events.map((event) => (
                          <div key={event.id} className="rounded-[14px] border border-white/[0.06] bg-white/[0.03] px-3 py-2">
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-[12px] font-700 text-text">{event.summary}</div>
                              <div className="text-[11px] text-text-3/45">{timeAgo(event.createdAt)}</div>
                            </div>
                            <div className="mt-1 text-[11px] uppercase tracking-[0.08em] text-text-3/45">
                              {event.type} · {event.source}
                            </div>
                          </div>
                        ))}
                        <a
                          href={`/api/missions/${selectedMission.mission.id}/events?limit=200`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex text-[12px] font-700 text-accent-bright hover:underline"
                        >
                          Open raw event stream
                        </a>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-[18px] border border-dashed border-white/[0.08] px-5 py-8 text-[14px] text-text-3/60">
                Select a mission to inspect it.
              </div>
            )}
          </div>
        </section>
      </div>
      <StructuredSessionLauncher
        open={structuredSessionOpen}
        onClose={() => setStructuredSessionOpen(false)}
        onCreated={(run) => {
          router.push(`/protocols?runId=${encodeURIComponent(run.id)}`)
        }}
        initialContext={{
          missionId: selectedMission?.mission.id || null,
          missionLabel: selectedMission?.mission.objective || null,
          participantAgentIds: selectedMission?.mission.agentId ? [selectedMission.mission.agentId] : [],
          facilitatorAgentId: selectedMission?.mission.agentId || null,
          title: selectedMission ? `Structured session: ${selectedMission.mission.objective}` : null,
          goal: selectedMission?.mission.objective || null,
        }}
      />
    </div>
  )
}
