'use client'

import { useState } from 'react'

type EdgeColor = 'indigo' | 'emerald' | 'red'
type EdgeDirection = 'down' | 'up' | null

interface Props {
  x1: number
  y1: number
  x2: number
  y2: number
  active?: boolean
  direction?: EdgeDirection
  color?: EdgeColor
  onClick?: (e: React.MouseEvent) => void
}

const COLOR_MAP: Record<EdgeColor, { stroke: string; glow: string; dot: string; text: string; border: string }> = {
  indigo: {
    stroke: 'rgba(99,102,241,0.4)',
    glow: 'rgba(99,102,241,0.15)',
    dot: 'rgba(99,102,241,0.8)',
    text: 'rgba(165,180,252,0.9)',
    border: 'rgba(99,102,241,0.2)',
  },
  emerald: {
    stroke: 'rgba(52,211,153,0.4)',
    glow: 'rgba(52,211,153,0.15)',
    dot: 'rgba(52,211,153,0.8)',
    text: 'rgba(110,231,183,0.9)',
    border: 'rgba(52,211,153,0.2)',
  },
  red: {
    stroke: 'rgba(244,63,94,0.4)',
    glow: 'rgba(244,63,94,0.15)',
    dot: 'rgba(244,63,94,0.8)',
    text: 'rgba(251,113,133,0.9)',
    border: 'rgba(244,63,94,0.2)',
  },
}

export function OrgChartEdge({ x1, y1, x2, y2, active, direction, color = 'indigo', onClick }: Props) {
  const [hovered, setHovered] = useState(false)

  // Cubic bezier from parent bottom-center to child top-center
  const midY = (y1 + y2) / 2
  const d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`

  // Midpoint for label / hover button
  const midX = (x1 + x2) / 2
  const midPtY = midY

  const colors = COLOR_MAP[color]
  const isUp = direction === 'up'

  return (
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Invisible wide hit area for hover detection */}
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        strokeLinecap="round"
        pointerEvents="stroke"
      />
      {/* Visible edge */}
      <path
        d={d}
        fill="none"
        stroke={hovered && !active ? 'rgba(255,255,255,0.2)' : active ? colors.stroke : 'rgba(255,255,255,0.08)'}
        strokeWidth={hovered && !active ? 2 : active ? 2 : 1.5}
        strokeLinecap="round"
        style={{ pointerEvents: 'none', transition: 'stroke 0.15s, stroke-width 0.15s' }}
      />
      {/* Hover glow */}
      {hovered && !active && (
        <path
          d={d}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={8}
          strokeLinecap="round"
          style={{ pointerEvents: 'none' }}
        />
      )}
      {active && (
        <>
          {/* Active glow */}
          <path
            d={d}
            fill="none"
            stroke={colors.glow}
            strokeWidth={6}
            strokeLinecap="round"
            style={{ pointerEvents: 'none' }}
          />
          {/* Traveling dot */}
          <circle r="3" fill={colors.dot} style={{ pointerEvents: 'none' }}>
            <animateMotion
              dur="1.5s"
              repeatCount="indefinite"
              path={d}
              {...(isUp ? { keyPoints: '1;0', keyTimes: '0;1' } : {})}
            />
          </circle>
        </>
      )}
      {/* Midpoint hover button — HTML so clicks bypass SVG pointer capture */}
      {hovered && onClick && (
        <foreignObject
          x={midX - 48}
          y={midPtY - 12}
          width={96}
          height={24}
          style={{ overflow: 'visible' }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation()
              onClick(e as unknown as React.MouseEvent)
            }}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              fontSize: 9,
              fontWeight: 500,
              color: 'rgba(200,200,220,0.9)',
              background: 'rgba(18,18,30,0.95)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 10,
              padding: '2px 10px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              width: 'fit-content',
              margin: '0 auto',
              display: 'block',
              transition: 'background 0.15s, border-color 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(99,102,241,0.2)'
              e.currentTarget.style.borderColor = 'rgba(99,102,241,0.3)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(18,18,30,0.95)'
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'
            }}
          >
            View activity
          </button>
        </foreignObject>
      )}
    </g>
  )
}
