'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AgentAvatar } from '@/components/agents/agent-avatar'

export interface DelegationBubbleData {
  senderAgent: { id: string; name: string; avatarSeed?: string; avatarUrl?: string | null }
  receiverAgent: { id: string; name: string; avatarSeed?: string; avatarUrl?: string | null }
  task: string | null
  result: string | null
  color: 'indigo' | 'emerald' | 'red'
  timestamp: number
}

interface Props {
  data: DelegationBubbleData
  isHoverOnly?: boolean
}

const ACCENT: Record<string, { border: string }> = {
  indigo: { border: 'rgba(99,102,241,0.25)' },
  emerald: { border: 'rgba(52,211,153,0.25)' },
  red: { border: 'rgba(244,63,94,0.25)' },
}

export function DelegationBubble({ data, isHoverOnly }: Props) {
  const accent = ACCENT[data.color] || ACCENT.indigo

  return (
    <div
      className={isHoverOnly ? '' : 'pointer-events-none'}
      style={{
        width: 280,
        ...(isHoverOnly
          ? { opacity: 0.85 }
          : { animation: 'delegationBubbleFade 5s ease-out forwards' }),
      }}
      onWheel={isHoverOnly ? (e) => e.stopPropagation() : undefined}
    >
      <div
        className="rounded-[8px] px-3 py-2 shadow-lg"
        style={{
          background: '#12121e',
          border: `1px solid ${accent.border}`,
          maxHeight: 120,
          overflowY: isHoverOnly ? 'auto' : 'hidden',
        }}
      >
        {/* Sender line — left-aligned */}
        <div className="flex items-start gap-1.5 mb-1">
          <AgentAvatar
            seed={data.senderAgent.avatarSeed || null}
            avatarUrl={data.senderAgent.avatarUrl}
            name={data.senderAgent.name}
            size={16}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[9px] font-semibold text-white/70 mb-0.5">{data.senderAgent.name}</div>
            <div className="text-[11px] text-white/90 break-words prose prose-invert prose-sm max-w-none [&_p]:m-0 [&_p]:leading-snug [&_ul]:m-0 [&_ol]:m-0 [&_li]:m-0 [&_code]:text-[10px] [&_code]:bg-white/10 [&_code]:px-1 [&_code]:rounded">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {data.task || '...'}
              </ReactMarkdown>
            </div>
          </div>
        </div>

        {/* Receiver line — right-aligned */}
        {(data.result || data.color !== 'indigo') && (
          <div className="flex items-start gap-1.5 justify-end">
            <div className="min-w-0 flex-1 text-right">
              <div className="text-[11px] text-white/80 break-words prose prose-invert prose-sm max-w-none [&_p]:m-0 [&_p]:leading-snug [&_ul]:m-0 [&_ol]:m-0 [&_li]:m-0 [&_code]:text-[10px] [&_code]:bg-white/10 [&_code]:px-1 [&_code]:rounded">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {data.result || (data.color === 'emerald' ? 'Done' : 'Failed')}
                </ReactMarkdown>
              </div>
              <div className="text-[9px] font-semibold text-white/70 mt-0.5">{data.receiverAgent.name}</div>
            </div>
            <AgentAvatar
              seed={data.receiverAgent.avatarSeed || null}
              avatarUrl={data.receiverAgent.avatarUrl}
              name={data.receiverAgent.name}
              size={16}
            />
          </div>
        )}
      </div>

      {/* Down-pointing caret */}
      <div className="flex justify-center">
        <div
          className="w-0 h-0"
          style={{
            borderLeft: '6px solid transparent',
            borderRight: '6px solid transparent',
            borderTop: `6px solid ${accent.border}`,
          }}
        />
      </div>
    </div>
  )
}
