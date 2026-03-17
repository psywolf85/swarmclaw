'use client'

import { AreaChart, Area, ResponsiveContainer, Tooltip } from 'recharts'
import { HintTip } from '@/components/shared/hint-tip'

interface Props {
  costTrend: Array<{ cost: number; bucket: string }>
}

export default function CostTrendChart({ costTrend }: Props) {
  return (
    <div className="mb-10 px-1" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.3s both' }}>
      <p className="text-[10px] text-text-3/50 uppercase tracking-wider mb-1 flex items-center gap-1.5">
        7-day cost trend <HintTip text="Daily API spend over the past week — hover for details" />
      </p>
      <ResponsiveContainer width="100%" height={60}>
        <AreaChart data={costTrend} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} style={{ cursor: 'crosshair' }}>
          <defs>
            <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#818CF8" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#818CF8" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null
              const d = payload[0].payload as { cost: number; bucket: string }
              const label = d.bucket
                ? new Date(d.bucket + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
                : ''
              return (
                <div className="rounded-[8px] bg-surface border border-white/[0.1] px-3 py-2 shadow-lg">
                  <p className="text-[11px] text-text-3/70 m-0">{label}</p>
                  <p className="text-[14px] font-600 text-text m-0 mt-0.5">${d.cost.toFixed(4)}</p>
                </div>
              )
            }}
            cursor={{ stroke: '#818CF8', strokeWidth: 1, strokeDasharray: '3 3' }}
          />
          <Area type="monotone" dataKey="cost" stroke="#818CF8" strokeWidth={1.5} fill="url(#costGrad)" dot={false} activeDot={{ r: 3, fill: '#818CF8', stroke: '#818CF8' }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
