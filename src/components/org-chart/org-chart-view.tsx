'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { buildOrgTree, layoutTree, computeOrgChartMove, deriveTeams, getDescendantIds, resolveTeamColor } from '@/lib/org-chart'
import type { OrgTreeNode } from '@/lib/org-chart'
import type { Agent } from '@/types'
import { OrgChartNode } from './org-chart-node'
import { OrgChartEdge } from './org-chart-edge'
import { useDelegationEdgeState, useNodeDelegationBubbles } from '@/hooks/use-delegation-edge-state'
import { OrgChartTeamRegion } from './org-chart-team-region'
import type { ResizeDirection } from './org-chart-team-region'
import { OrgChartToolbar } from './org-chart-toolbar'
import { OrgChartSidebar } from './org-chart-sidebar'
import { OrgChartContextMenu } from './org-chart-context-menu'
import { OrgChartDetailPanel } from './org-chart-detail-panel'
import { MiniChatBubble } from './mini-chat-bubble'
import { DelegationBubble } from './delegation-bubble'
import { OrgChartEdgePopover } from './org-chart-edge-popover'
import type { ContextAction } from './org-chart-context-menu'
import { useOrgChartPanZoom } from './use-org-chart-pan-zoom'
import { useOrgChartDrag } from './use-org-chart-drag'
import { useNavigate } from '@/lib/app/navigation'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'

const NODE_W = 200
const NODE_H = 110

export function OrgChartView() {
  const agents = useAppStore((s) => s.agents)
  const sessions = useAppStore((s) => s.sessions)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const batchUpdateAgents = useAppStore((s) => s.batchUpdateAgents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const containerRef = useRef<HTMLDivElement>(null)
  const navigateTo = useNavigate()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ agentId: string; x: number; y: number } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<{ agentId: string; name: string } | null>(null)
  const [linkingState, setLinkingState] = useState<{ agentId: string; direction: 'parent' | 'child' } | null>(null)
  const [selectedTeamLabel, setSelectedTeamLabel] = useState<string | null>(null)
  const [chatBubbleAgentId, setChatBubbleAgentId] = useState<string | null>(null)
  const [edgePopover, setEdgePopover] = useState<{ parentId: string; childId: string; x: number; y: number } | null>(null)
  const [toolIndicator, setToolIndicator] = useState<{ agentId: string; text: string } | null>(null)
  const toolIndicatorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const teamDragRef = useRef<{ label: string; startX: number; startY: number; agentIds: string[] } | null>(null)
  const teamResizeRef = useRef<{
    label: string; startX: number; startY: number
    agentIds: string[]
    origPositions: Map<string, { x: number; y: number }>
    anchorX: number; anchorY: number
    origW: number; origH: number
    direction: ResizeDirection
  } | null>(null)
  const sidebarTeamDragRef = useRef<{ team: { label: string; color: string | null; agentIds: string[] }; moved: boolean } | null>(null)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadAgents(); loadSessions() }, [])

  // Running agents — derived from sessions
  const runningAgentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const s of Object.values(sessions)) {
      if (s.agentId && s.active) ids.add(s.agentId)
    }
    return ids
  }, [sessions])

  // Build tree
  const { roots, unattached } = useMemo(() => buildOrgTree(agents), [agents])

  // Layout positions — use saved positions or auto-layout
  const positions = useMemo(() => {
    // Check if any agents have saved positions
    const hasSaved = Object.values(agents).some(
      (a) => a.orgChart?.x != null && a.orgChart?.y != null,
    )
    if (hasSaved) {
      const map = new Map<string, { x: number; y: number }>()
      for (const a of Object.values(agents)) {
        if (a.orgChart?.x != null && a.orgChart?.y != null) {
          map.set(a.id, { x: a.orgChart.x, y: a.orgChart.y })
        }
      }
      // Auto-layout any that don't have saved positions
      const autoLayout = layoutTree(roots)
      for (const [id, pos] of autoLayout) {
        if (!map.has(id)) map.set(id, pos)
      }
      return map
    }
    return layoutTree(roots)
  }, [agents, roots])

  // Live delegation edge state
  const edgeLiveMap = useDelegationEdgeState(agents)

  // Per-node delegation bubbles
  const { activeBubbles, lastBubbles } = useNodeDelegationBubbles(agents)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)

  // Build per-node glow from edge live state (both parent and child light up)
  const nodeGlowMap = useMemo(() => {
    const map = new Map<string, 'indigo' | 'emerald' | 'red'>()
    for (const [edgeKey, state] of edgeLiveMap) {
      if (!state.active) continue
      const [parentId, childId] = edgeKey.split('-')
      // Both ends of an active edge glow
      if (parentId && !map.has(parentId)) map.set(parentId, state.color)
      if (childId && !map.has(childId)) map.set(childId, state.color)
    }
    return map
  }, [edgeLiveMap])

  // Teams
  const teams = useMemo(() => deriveTeams(agents), [agents])

  // Descendant IDs for linking mode (dims invalid targets)
  const descendantIds = useMemo(
    () => linkingState ? getDescendantIds(roots, linkingState.agentId) : new Set<string>(),
    [roots, linkingState],
  )

  // Pan/zoom
  const { transform, handlers: panHandlers, zoomIn, zoomOut, fitToScreen } = useOrgChartPanZoom()

  // Auto-center on initial load
  const didInitialFitRef = useRef(false)
  useEffect(() => {
    if (didInitialFitRef.current || positions.size === 0) return
    didInitialFitRef.current = true
    const el = containerRef.current
    if (!el) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const pos of positions.values()) {
      if (pos.x < minX) minX = pos.x
      if (pos.y < minY) minY = pos.y
      if (pos.x + NODE_W > maxX) maxX = pos.x + NODE_W
      if (pos.y + NODE_H > maxY) maxY = pos.y + NODE_H
    }
    fitToScreen({ minX, minY, maxX, maxY }, { width: el.clientWidth, height: el.clientHeight })
  }, [positions, fitToScreen])

  // Drop target finder
  const findDropTarget = useCallback(
    (cx: number, cy: number, draggedId: string): string | null => {
      let closest: string | null = null
      let closestDist = 120 // max snap distance
      for (const [id, pos] of positions) {
        if (id === draggedId) continue
        const agent = agents[id]
        if (!agent || agent.disabled) continue
        const dx = cx - (pos.x + NODE_W / 2)
        const dy = cy - (pos.y + NODE_H / 2)
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < closestDist) {
          closestDist = dist
          closest = id
        }
      }
      return closest
    },
    [positions, agents],
  )

  // Drag handler — saves drop position so the agent appears in the canvas
  const onDrop = useCallback(
    (agentId: string, newParentId: string | null, canvasX: number, canvasY: number) => {
      // Snap to 20px grid
      const dropX = Math.round((canvasX - NODE_W / 2) / 20) * 20
      const dropY = Math.round((canvasY - NODE_H / 2) / 20) * 20

      const existingParent = agents[agentId]?.orgChart?.parentId ?? null

      // Free-drag: if no drop target but agent already has a parent, just reposition
      if (newParentId === null && existingParent) {
        batchUpdateAgents([{
          id: agentId,
          patch: { orgChart: { ...(agents[agentId]?.orgChart || {}), x: dropX, y: dropY } },
        }])
        return
      }

      const patches = computeOrgChartMove(agents, agentId, newParentId)

      // Merge drop position into the moved agent's patch
      const agentPatch = patches.find((p) => p.id === agentId)
      if (agentPatch) {
        const base = agentPatch.patch.orgChart || agents[agentId]?.orgChart || {}
        agentPatch.patch.orgChart = { ...base, x: dropX, y: dropY }
      } else {
        patches.push({
          id: agentId,
          patch: {
            orgChart: {
              ...(agents[agentId]?.orgChart || {}),
              parentId: newParentId,
              x: dropX,
              y: dropY,
            },
          },
        })
      }

      if (patches.length > 0) batchUpdateAgents(patches)
    },
    [agents, batchUpdateAgents],
  )

  const { dragState, startDrag, moveDrag, endDrag } = useOrgChartDrag({
    transform,
    containerRef,
    onDrop,
    findDropTarget,
  })

  // Auto-layout action
  const doAutoLayout = useCallback(() => {
    const autoPos = layoutTree(roots)
    const patches: Array<{ id: string; patch: Partial<Agent> }> = []
    for (const [id, pos] of autoPos) {
      const a = agents[id]
      if (!a) continue
      patches.push({
        id,
        patch: {
          orgChart: { ...(a.orgChart || {}), x: pos.x, y: pos.y },
        },
      })
    }
    if (patches.length > 0) batchUpdateAgents(patches)

    // Center the view on the new layout
    if (autoPos.size > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const pos of autoPos.values()) {
        if (pos.x < minX) minX = pos.x
        if (pos.y < minY) minY = pos.y
        if (pos.x + NODE_W > maxX) maxX = pos.x + NODE_W
        if (pos.y + NODE_H > maxY) maxY = pos.y + NODE_H
      }
      const el = containerRef.current
      if (el) fitToScreen({ minX, minY, maxX, maxY }, { width: el.clientWidth, height: el.clientHeight })
    }
  }, [roots, agents, batchUpdateAgents, fitToScreen])

  const doFitToScreen = useCallback(() => {
    if (positions.size === 0) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const pos of positions.values()) {
      if (pos.x < minX) minX = pos.x
      if (pos.y < minY) minY = pos.y
      if (pos.x + NODE_W > maxX) maxX = pos.x + NODE_W
      if (pos.y + NODE_H > maxY) maxY = pos.y + NODE_H
    }
    const el = containerRef.current
    if (!el) return
    fitToScreen({ minX, minY, maxX, maxY }, { width: el.clientWidth, height: el.clientHeight })
  }, [positions, fitToScreen])

  // Collect all edges from tree + child counts
  const { edges, childCounts } = useMemo(() => {
    const result: Array<{ parentId: string; childId: string }> = []
    const counts = new Map<string, number>()
    function walk(node: OrgTreeNode) {
      if (node.children.length > 0) counts.set(node.agent.id, node.children.length)
      for (const child of node.children) {
        result.push({ parentId: node.agent.id, childId: child.agent.id })
        walk(child)
      }
    }
    for (const root of roots) walk(root)
    return { edges: result, childCounts: counts }
  }, [roots])

  // Team region bounds
  const teamRegions = useMemo(() => {
    return teams.map((team) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const id of team.agentIds) {
        const pos = positions.get(id)
        if (!pos) continue
        if (pos.x < minX) minX = pos.x
        if (pos.y < minY) minY = pos.y
        if (pos.x + NODE_W > maxX) maxX = pos.x + NODE_W
        if (pos.y + NODE_H > maxY) maxY = pos.y + NODE_H
      }
      if (!Number.isFinite(minX)) return null
      return { ...team, x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    }).filter((r): r is NonNullable<typeof r> => r !== null)
  }, [teams, positions])

  const handleSidebarDragStart = useCallback(
    (e: React.PointerEvent, agentId: string) => {
      startDrag(e, agentId)
    },
    [startDrag],
  )

  const handleContextMenu = useCallback((e: React.MouseEvent, agentId: string) => {
    e.preventDefault()
    setContextMenu({ agentId, x: e.clientX, y: e.clientY })
  }, [])

  const handleContextAction = useCallback((action: ContextAction) => {
    const id = contextMenu?.agentId
    if (!id) return
    const agent = agents[id]
    if (!agent) return

    switch (action.type) {
      case 'open_agent':
        navigateTo('agents', id)
        break
      case 'set_role':
        batchUpdateAgents([{ id, patch: { role: action.role } }])
        break
      case 'detach': {
        const patches = computeOrgChartMove(agents, id, null)
        if (patches.length > 0) batchUpdateAgents(patches)
        break
      }
      case 'remove_from_chart':
        setConfirmRemove({ agentId: id, name: agent.name })
        break
      case 'set_team_label': {
        const teamColor = action.label ? resolveTeamColor(agents, action.label) : null
        batchUpdateAgents([{
          id,
          patch: { orgChart: { ...(agent.orgChart || {}), teamLabel: action.label || null, ...(teamColor ? { teamColor } : {}) } },
        }])
        break
      }
    }
  }, [contextMenu, agents, batchUpdateAgents, navigateTo])

  // Escape key cancels linking mode
  useEffect(() => {
    if (!linkingState) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setLinkingState(null) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [linkingState])

  // Sidebar team drag — places team at drop location
  const handleSidebarTeamDragStart = useCallback(
    (e: React.PointerEvent, team: { label: string; color: string | null; agentIds: string[] }) => {
      if (e.button !== 0) return
      e.stopPropagation()
      sidebarTeamDragRef.current = { team, moved: false }
      containerRef.current?.setPointerCapture(e.pointerId)
    },
    [],
  )

  // New handlers for explicit node affordances
  const handleDragHandlePointerDown = useCallback(
    (e: React.PointerEvent, agentId: string) => {
      if (linkingState) return
      startDrag(e, agentId)
    },
    [startDrag, linkingState],
  )

  const handlePortDragStart = useCallback(
    (agentId: string, port: 'top' | 'bottom' | 'left' | 'right') => {
      const direction = port === 'bottom' ? 'child' as const : 'parent' as const
      setLinkingState({ agentId, direction })
    },
    [],
  )

  const handleMenuClick = useCallback(
    (agentId: string, e: React.MouseEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setContextMenu({ agentId, x: rect.right, y: rect.bottom })
    },
    [],
  )

  const handleChatClick = useCallback(
    (agentId: string) => {
      setChatBubbleAgentId((prev) => (prev === agentId ? null : agentId))
    },
    [],
  )

  const handleToolActivity = useCallback(
    (agentId: string, text: string) => {
      setToolIndicator({ agentId, text })
      if (toolIndicatorTimerRef.current) clearTimeout(toolIndicatorTimerRef.current)
      toolIndicatorTimerRef.current = setTimeout(() => setToolIndicator(null), 3000)
    },
    [],
  )

  const isEmpty = positions.size === 0 && unattached.length === 0

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden bg-[#0a0a14] select-none"
      style={{ touchAction: 'none' }}
      {...panHandlers}
      onPointerMove={(e) => {
        // Sidebar team drag — just track that we moved
        if (sidebarTeamDragRef.current) {
          sidebarTeamDragRef.current.moved = true
          return
        }
        // Team drag — move all team agents
        if (teamDragRef.current) {
          const dx = (e.clientX - teamDragRef.current.startX) / transform.scale
          const dy = (e.clientY - teamDragRef.current.startY) / transform.scale
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
            teamDragRef.current.startX = e.clientX
            teamDragRef.current.startY = e.clientY
            const patches = teamDragRef.current.agentIds
              .filter((id) => agents[id]?.orgChart)
              .map((id) => ({
                id,
                patch: {
                  orgChart: {
                    ...agents[id].orgChart,
                    x: Math.round(((agents[id].orgChart?.x ?? 0) + dx) / 20) * 20,
                    y: Math.round(((agents[id].orgChart?.y ?? 0) + dy) / 20) * 20,
                  },
                } as Partial<Agent>,
              }))
            if (patches.length > 0) batchUpdateAgents(patches)
          }
          return
        }
        // Team resize — reflow agents into a grid that fits the target rectangle
        if (teamResizeRef.current) {
          const ref = teamResizeRef.current
          const rawDx = (e.clientX - ref.startX) / transform.scale
          const rawDy = (e.clientY - ref.startY) / transform.scale
          // Only apply delta for active axes, flip sign for left/top
          const dx = ref.direction.left ? -rawDx : ref.direction.right ? rawDx : 0
          const dy = ref.direction.top ? -rawDy : ref.direction.bottom ? rawDy : 0
          const targetW = Math.max(NODE_W, ref.origW + dx)
          const targetH = Math.max(NODE_H, ref.origH + dy)
          // Dynamic anchor: left/top drags shift the origin
          let anchorX = ref.anchorX
          let anchorY = ref.anchorY
          if (ref.direction.left) anchorX = ref.anchorX + ref.origW - targetW
          if (ref.direction.top) anchorY = ref.anchorY + ref.origH - targetH
          const sorted = ref.agentIds.filter((id) => ref.origPositions.has(id))
          const n = sorted.length
          if (n === 0) return
          // Sort by original position (top-to-bottom, left-to-right)
          sorted.sort((a, b) => {
            const pa = ref.origPositions.get(a)!
            const pb = ref.origPositions.get(b)!
            return pa.y !== pb.y ? pa.y - pb.y : pa.x - pb.x
          })
          // Derive grid from how many nodes fit in each dimension (min 20px gap)
          const fitCols = Math.max(1, Math.min(n, Math.floor((targetW + 20) / (NODE_W + 20))))
          const fitRows = Math.max(1, Math.min(n, Math.floor((targetH + 20) / (NODE_H + 20))))
          // Use whichever layout fills the target rect best
          const cols = Math.max(1, Math.min(fitCols, Math.ceil(n / fitRows)))
          const rows = Math.max(1, Math.ceil(n / cols))
          const gapX = cols > 1 ? (targetW - NODE_W) / (cols - 1) : 0
          const gapY = rows > 1 ? (targetH - NODE_H) / (rows - 1) : 0
          const patches = sorted.map((id, i) => ({
            id,
            patch: {
              orgChart: {
                ...agents[id]?.orgChart,
                x: Math.round((anchorX + (i % cols) * gapX) / 20) * 20,
                y: Math.round((anchorY + Math.floor(i / cols) * gapY) / 20) * 20,
              },
            } as Partial<Agent>,
          }))
          if (patches.length > 0) batchUpdateAgents(patches)
          return
        }
        panHandlers.onPointerMove(e)
        moveDrag(e)
      }}
      onPointerUp={(e) => {
        // Sidebar team drag — place at drop location
        if (sidebarTeamDragRef.current) {
          const { team, moved } = sidebarTeamDragRef.current
          sidebarTeamDragRef.current = null
          if (moved) {
            const el = containerRef.current
            if (!el) return
            const rect = el.getBoundingClientRect()
            const canvasX = (e.clientX - rect.left - transform.x) / transform.scale
            const canvasY = (e.clientY - rect.top - transform.y) / transform.scale
            const toPlace = team.agentIds.filter((id) => agents[id]?.orgChart?.x == null)
            if (toPlace.length === 0) return
            const dropX = Math.round(canvasX / 20) * 20
            const dropY = Math.round(canvasY / 20) * 20
            const cols = Math.max(2, Math.ceil(Math.sqrt(toPlace.length)))
            const colGap = NODE_W + 20
            const rowGap = NODE_H + 20
            const patches = toPlace.map((id, i) => ({
              id,
              patch: {
                orgChart: {
                  ...(agents[id]?.orgChart || {}),
                  x: dropX + (i % cols) * colGap,
                  y: dropY + Math.floor(i / cols) * rowGap,
                },
              } as Partial<Agent>,
            }))
            batchUpdateAgents(patches)
          }
          return
        }
        if (teamDragRef.current) {
          teamDragRef.current = null
          return
        }
        if (teamResizeRef.current) {
          teamResizeRef.current = null
          return
        }
        panHandlers.onPointerUp(e)
        endDrag(e)
      }}
      onClick={(e) => {
        // Click on background clears selection + linking mode
        if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'svg') {
          setSelectedTeamLabel(null)
          if (linkingState) setLinkingState(null)
        }
      }}
    >
      {/* Grid background */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ opacity: 0.4 }}>
        <defs>
          <pattern id="org-grid" width={40} height={40} patternUnits="userSpaceOnUse"
            patternTransform={`translate(${transform.x},${transform.y}) scale(${transform.scale})`}
          >
            <circle cx="20" cy="20" r="0.5" fill="rgba(255,255,255,0.1)" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#org-grid)" />
      </svg>

      {/* Canvas layer */}
      <div
        className="absolute inset-0"
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          transformOrigin: '0 0',
        }}
      >
        {/* SVG edges + team regions */}
        <svg className="absolute" style={{ overflow: 'visible', width: 1, height: 1 }}>
          {teamRegions.map((tr) => (
            <OrgChartTeamRegion
              key={tr.label}
              label={tr.label}
              color={tr.color}
              x={tr.x}
              y={tr.y}
              width={tr.width}
              height={tr.height}
              isSelected={selectedTeamLabel === tr.label}
              onClick={() => setSelectedTeamLabel(selectedTeamLabel === tr.label ? null : tr.label)}
              onDragPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                teamDragRef.current = {
                  label: tr.label,
                  startX: e.clientX,
                  startY: e.clientY,
                  agentIds: tr.agentIds,
                }
                ;(e.currentTarget as SVGElement).ownerSVGElement?.parentElement?.setPointerCapture?.(e.pointerId)
              }}
              onResizePointerDown={(e, direction) => {
                if (e.button !== 0) return
                e.stopPropagation()
                const origPositions = new Map<string, { x: number; y: number }>()
                let anchorX = Infinity, anchorY = Infinity
                let maxX = -Infinity, maxY = -Infinity
                for (const id of tr.agentIds) {
                  const a = agents[id]
                  if (a?.orgChart?.x != null && a?.orgChart?.y != null) {
                    origPositions.set(id, { x: a.orgChart.x, y: a.orgChart.y })
                    if (a.orgChart.x < anchorX) anchorX = a.orgChart.x
                    if (a.orgChart.y < anchorY) anchorY = a.orgChart.y
                    if (a.orgChart.x + NODE_W > maxX) maxX = a.orgChart.x + NODE_W
                    if (a.orgChart.y + NODE_H > maxY) maxY = a.orgChart.y + NODE_H
                  }
                }
                const origW = Math.max(NODE_W, maxX - anchorX)
                const origH = Math.max(NODE_H, maxY - anchorY)
                teamResizeRef.current = {
                  label: tr.label,
                  startX: e.clientX,
                  startY: e.clientY,
                  agentIds: tr.agentIds,
                  origPositions,
                  anchorX, anchorY,
                  origW, origH,
                  direction,
                }
                ;(e.currentTarget as SVGElement).ownerSVGElement?.parentElement?.setPointerCapture?.(e.pointerId)
              }}
            />
          ))}
          {edges.map(({ parentId, childId }) => {
            const pp = positions.get(parentId)
            const cp = positions.get(childId)
            if (!pp || !cp) return null
            const edgeKey = `${parentId}-${childId}`
            const liveState = edgeLiveMap.get(edgeKey)
            return (
              <OrgChartEdge
                key={edgeKey}
                x1={pp.x + NODE_W / 2}
                y1={pp.y + NODE_H}
                x2={cp.x + NODE_W / 2}
                y2={cp.y}
                active={liveState?.active ?? false}
                direction={liveState?.direction ?? null}
                color={liveState?.color ?? 'indigo'}
                onClick={(e) => {
                  e.stopPropagation()
                  const midX = (pp.x + NODE_W / 2 + cp.x + NODE_W / 2) / 2
                  const midY = (pp.y + NODE_H + cp.y) / 2
                  setEdgePopover({ parentId, childId, x: midX, y: midY })
                }}
              />
            )
          })}
        </svg>

        {/* Nodes */}
        {Array.from(positions.entries()).map(([id, pos]) => {
          const agent = agents[id]
          if (!agent) return null
          const isDragging = dragState?.agentId === id
          const isDropTarget = dragState?.dropTargetId === id
          const cc = childCounts.get(id) ?? 0
          const delInfo = agent.role === 'coordinator' && agent.delegationEnabled
            ? { mode: agent.delegationTargetMode || 'all' as const, count: (agent.delegationTargetAgentIds || []).length }
            : null
          const activeBubble = activeBubbles.get(id)
          const hoverBubble = !activeBubble && hoveredNodeId === id ? lastBubbles.get(id) : null
          return (
            <div
              key={id}
              className="absolute"
              style={{
                left: pos.x,
                top: pos.y,
                transition: isDragging ? 'none' : 'left 0.3s ease, top 0.3s ease',
              }}
              onMouseEnter={() => setHoveredNodeId(id)}
              onMouseLeave={() => setHoveredNodeId((prev) => prev === id ? null : prev)}
            >
              {/* Delegation bubble above node */}
              {(activeBubble || hoverBubble) && (
                <div
                  className="absolute z-30"
                  style={{
                    left: NODE_W / 2 - 140,
                    top: -12,
                    transform: 'translateY(-100%)',
                    pointerEvents: hoverBubble ? 'auto' : 'none',
                  }}
                >
                  <DelegationBubble
                    data={activeBubble || hoverBubble!}
                    isHoverOnly={!activeBubble}
                  />
                </div>
              )}
              <OrgChartNode
                agent={agent}
                isRunning={runningAgentIds.has(id)}
                isSelected={selectedId === id}
                isDragging={isDragging}
                isDropTarget={isDropTarget}
                childCount={cc}
                delegationInfo={delInfo}
                delegationGlow={nodeGlowMap.get(id) ?? null}
                isTeamHighlighted={!!selectedTeamLabel && agent.orgChart?.teamLabel === selectedTeamLabel}
                isDimmed={!!linkingState && descendantIds.has(id)}
                isLinkTarget={!!linkingState && id !== linkingState.agentId && !descendantIds.has(id)}
                onPointerDown={(e) => {
                  // Always stop propagation so pan handler doesn't capture the pointer
                  e.stopPropagation()
                  if (linkingState) {
                    // Linking mode — click applies directional link
                    if (id !== linkingState.agentId && !descendantIds.has(id)) {
                      const patches = linkingState.direction === 'child'
                        ? computeOrgChartMove(agents, id, linkingState.agentId)
                        : computeOrgChartMove(agents, linkingState.agentId, id)
                      if (patches.length > 0) batchUpdateAgents(patches)
                      setLinkingState(null)
                    }
                  }
                }}
                onDragHandlePointerDown={(e) => handleDragHandlePointerDown(e, id)}
                onPortDragStart={(port) => handlePortDragStart(id, port)}
                onMenuClick={(e) => handleMenuClick(id, e)}
                onChatClick={() => handleChatClick(id)}
                onContextMenu={(e) => handleContextMenu(e, id)}
                onClick={() => {
                  if (linkingState) return
                  setSelectedId(selectedId === id ? null : id)
                }}
              />
            </div>
          )
        })}

        {/* Dashed drag-to-link line */}
        {dragState && dragState.dropTargetId && (() => {
          const targetPos = positions.get(dragState.dropTargetId)
          if (!targetPos) return null
          const x1 = dragState.currentX
          const y1 = dragState.currentY
          const x2 = targetPos.x + NODE_W / 2
          const y2 = targetPos.y
          const midY = (y1 + y2) / 2
          return (
            <svg className="absolute pointer-events-none" style={{ overflow: 'visible', width: 1, height: 1, zIndex: 40 }}>
              <path
                d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                fill="none"
                stroke="rgba(99,102,241,0.4)"
                strokeWidth={2}
                strokeDasharray="6 4"
                strokeLinecap="round"
              />
            </svg>
          )
        })()}

        {/* Mini chat bubble — anchored above node */}
        {chatBubbleAgentId && agents[chatBubbleAgentId] && positions.get(chatBubbleAgentId) && (() => {
          const pos = positions.get(chatBubbleAgentId)!
          const bubbleW = 320
          const bubbleH = 400
          return (
            <div
              className="absolute z-40"
              style={{
                left: pos.x + NODE_W / 2 - bubbleW / 2,
                top: pos.y - bubbleH - 16,
              }}
            >
              <MiniChatBubble
                agent={agents[chatBubbleAgentId]}
                onClose={() => setChatBubbleAgentId(null)}
                onToolActivity={(text) => handleToolActivity(chatBubbleAgentId, text)}
              />
            </div>
          )
        })()}

        {/* Tool activity indicator — floating pill above node */}
        {toolIndicator && positions.get(toolIndicator.agentId) && (() => {
          const pos = positions.get(toolIndicator.agentId)!
          return (
            <div
              className="absolute pointer-events-none z-30"
              style={{
                left: pos.x + NODE_W / 2,
                top: pos.y - 24,
                transform: 'translateX(-50%)',
              }}
            >
              <span className="text-[9px] font-500 px-2 py-0.5 rounded-full bg-accent-bright/15 text-accent-bright border border-accent-bright/20 whitespace-nowrap animate-pulse overflow-hidden text-ellipsis" style={{ maxWidth: 200, display: 'inline-block' }}>
                {toolIndicator.text}
              </span>
            </div>
          )
        })()}

        {/* Edge delegation popover — shows messages between agents */}
        {edgePopover && agents[edgePopover.parentId] && agents[edgePopover.childId] && (
          <div className="absolute z-50" style={{ left: edgePopover.x, top: edgePopover.y }}>
            <OrgChartEdgePopover
              parentAgent={agents[edgePopover.parentId]}
              childAgent={agents[edgePopover.childId]}
              x={0}
              y={0}
              onClose={() => setEdgePopover(null)}
            />
          </div>
        )}
      </div>

      {/* Toolbar */}
      <OrgChartToolbar
        onAutoLayout={doAutoLayout}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onFitToScreen={doFitToScreen}
        scale={transform.scale}
      />

      {/* Linking mode banner */}
      {linkingState && agents[linkingState.agentId] && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 px-4 py-2 bg-accent-bright/20 border border-accent-bright/30 rounded-[10px] backdrop-blur-sm text-[12px] text-text flex items-center gap-3">
          <span>
            {linkingState.direction === 'child'
              ? <>Click a node to add as child of <strong>{agents[linkingState.agentId].name}</strong></>
              : <>Click a node to set as parent for <strong>{agents[linkingState.agentId].name}</strong></>}
          </span>
          <button
            onClick={() => setLinkingState(null)}
            className="text-[11px] text-text-3 hover:text-text px-2 py-0.5 rounded-[6px] border border-white/[0.08] bg-white/[0.04] cursor-pointer"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Unattached sidebar */}
      <OrgChartSidebar
        agents={unattached}
        allAgents={agents}
        teams={teams}
        onDragStart={handleSidebarDragStart}
        onTeamDragStart={handleSidebarTeamDragStart}
        onPlaceTeam={(team) => {
          // Only place members not already on the chart
          const toPlace = team.agentIds.filter((id) => agents[id]?.orgChart?.x == null)
          if (toPlace.length === 0) return

          // Find rightmost edge of existing nodes
          let maxX = 0
          for (const a of Object.values(agents)) {
            if (a.orgChart?.x != null) {
              const right = a.orgChart.x + NODE_W
              if (right > maxX) maxX = right
            }
          }
          const startX = maxX + 80
          const startY = 40
          const colGap = NODE_W + 20
          const rowGap = NODE_H + 20
          const cols = Math.max(2, Math.ceil(Math.sqrt(toPlace.length)))

          const patches = toPlace.map((id, i) => ({
            id,
            patch: {
              orgChart: {
                ...(agents[id]?.orgChart || {}),
                x: startX + (i % cols) * colGap,
                y: startY + Math.floor(i / cols) * rowGap,
              },
            } as Partial<Agent>,
          }))
          batchUpdateAgents(patches)
        }}
        onBatchPatch={batchUpdateAgents}
      />

      {/* Drag ghost — rendered outside canvas layer so it appears above the sidebar */}
      {dragState && agents[dragState.agentId] && (
        <div
          className="absolute pointer-events-none z-50"
          style={{
            left: dragState.currentX * transform.scale + transform.x - NODE_W / 2 * transform.scale,
            top: dragState.currentY * transform.scale + transform.y - NODE_H / 2 * transform.scale,
            transform: `scale(${transform.scale})`,
            transformOrigin: '0 0',
            opacity: 0.7,
          }}
        >
          <OrgChartNode agent={agents[dragState.agentId]} isDragging isDragGhost />
        </div>
      )}

      {/* Detail panel */}
      {selectedId && agents[selectedId] && (
        <OrgChartDetailPanel
          agent={agents[selectedId]}
          allAgents={agents}
          teamNames={teams.map((t) => t.label)}
          onPatch={batchUpdateAgents}
          onNavigate={(_, id) => navigateTo('agents', id)}
          onRemove={() => setConfirmRemove({ agentId: selectedId, name: agents[selectedId].name })}
          onClose={() => setSelectedId(null)}
        />
      )}

      {/* Context menu */}
      {contextMenu && agents[contextMenu.agentId] && (
        <OrgChartContextMenu
          agent={agents[contextMenu.agentId]}
          teamNames={teams.map((t) => t.label)}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onAction={handleContextAction}
        />
      )}

      {/* Confirm remove dialog */}
      <ConfirmDialog
        open={!!confirmRemove}
        title="Remove from Chart"
        message={`Remove "${confirmRemove?.name}" from the org chart? This won't delete the agent — it just removes it from the hierarchy.`}
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (confirmRemove) {
            const id = confirmRemove.agentId
            const patches: Array<{ id: string; patch: Partial<Agent> }> = []

            // Detach from parent (cleans up parent's delegationTargetAgentIds)
            const detachPatches = computeOrgChartMove(agents, id, null)
            patches.push(...detachPatches)

            // Orphan any children that point to this agent
            for (const a of Object.values(agents)) {
              if (a.orgChart?.parentId === id) {
                patches.push({
                  id: a.id,
                  patch: { orgChart: { ...a.orgChart, parentId: null } },
                })
              }
            }

            // Clear this agent's orgChart entirely
            const existing = patches.find((p) => p.id === id)
            if (existing) {
              existing.patch.orgChart = null
            } else {
              patches.push({ id, patch: { orgChart: null } })
            }

            batchUpdateAgents(patches)
          }
          setConfirmRemove(null)
        }}
        onCancel={() => setConfirmRemove(null)}
      />

      {/* Empty state */}
      {isEmpty && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center max-w-sm">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3">
                <rect x="9" y="2" width="6" height="4" rx="1" />
                <rect x="2" y="18" width="6" height="4" rx="1" />
                <rect x="9" y="18" width="6" height="4" rx="1" />
                <rect x="16" y="18" width="6" height="4" rx="1" />
                <path d="M12 6v4" /><path d="M5 14v4" /><path d="M12 14v4" /><path d="M19 14v4" />
                <path d="M5 14h14" />
              </svg>
            </div>
            <h3 className="text-[15px] font-600 text-text mb-1.5">No hierarchy yet</h3>
            <p className="text-[13px] text-text-3 leading-relaxed">
              Create agents and set their roles to <span className="text-accent-bright font-500">Coordinator</span> or <span className="text-text-2 font-500">Worker</span> to build your org chart. Drag workers under coordinators to wire up delegation.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
