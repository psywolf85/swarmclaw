'use client'

import { useState, useRef, useEffect } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/app/api-client'
import { AVAILABLE_TOOLS, PLATFORM_TOOLS } from '@/lib/tool-definitions'
import type { ToolDefinition } from '@/lib/tool-definitions'
import type { Session } from '@/types'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { getEnabledToolIds, getEnabledExtensionIds } from '@/lib/capability-selection'

interface Props {
  session: Session
}

interface ExtensionToolInfo {
  extensionId: string
  toolName: string
  label: string
  description: string
}

export function ChatToolToggles({ session }: Props) {
  const [open, setOpen] = useState(false)
  const [enabledExtensionIds, setEnabledExtensionIds] = useState<Set<string> | null>(null)
  const [externalTools, setExternalTools] = useState<ExtensionToolInfo[]>([])
  const ref = useRef<HTMLDivElement>(null)
  const refreshSession = useAppStore((s) => s.refreshSession)
  const agents = useAppStore((s) => s.agents)
  const skills = useAppStore((s) => s.skills)

  const agent = session.agentId ? agents[session.agentId] : null
  const sessionTools: string[] = getEnabledToolIds(session)
  const sessionExtensions = getEnabledExtensionIds(session)

  // Agent's skill IDs
  const agentSkillIds: string[] = agent?.skillIds || []

  // Fetch enabled extensions on mount
  useEffect(() => {
    api<{ enabledExtensionIds: string[]; externalTools: ExtensionToolInfo[] }>('GET', '/extensions/builtins')
      .then((res) => {
        if (res?.enabledExtensionIds) setEnabledExtensionIds(new Set(res.enabledExtensionIds))
        if (res?.externalTools) setExternalTools(res.externalTools)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const toggleTool = async (toolId: string) => {
    const updated = sessionTools.includes(toolId)
      ? sessionTools.filter((t) => t !== toolId)
      : [...sessionTools, toolId]
    await api('PUT', `/chats/${session.id}`, {
      tools: updated,
      extensions: sessionExtensions,
    })
    await refreshSession(session.id)
  }

  /** Check if a tool's backing extension is enabled */
  const isExtensionEnabled = (tool: ToolDefinition): boolean => {
    if (!tool.extensionId) return true // core tool, always available
    if (!enabledExtensionIds) return true // still loading, assume available
    return enabledExtensionIds.has(tool.extensionId)
  }

  const filteredAvailable = AVAILABLE_TOOLS
  const filteredPlatform = PLATFORM_TOOLS

  // Convert external extension tools into ToolDefinition-like items for display
  const extensionToolDefs: ToolDefinition[] = externalTools.map((et) => ({
    id: et.toolName,
    label: et.label,
    description: et.description,
    extensionId: et.extensionId,
  }))

  const groups: { label: string; tools: ToolDefinition[] }[] = [
    { label: 'Tools', tools: filteredAvailable },
    { label: 'Platform Tools', tools: filteredPlatform },
    ...(extensionToolDefs.length > 0 ? [{ label: 'Extension Tools', tools: extensionToolDefs }] : []),
  ]

  const allVisibleTools = groups.flatMap((g) => g.tools)
  const totalCount = allVisibleTools.length
  const enabledCount = sessionTools.filter((id) => allVisibleTools.some((t) => t.id === id)).length

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] transition-colors cursor-pointer border-none
          ${open ? 'bg-accent-soft text-accent-bright' : 'bg-white/[0.04] text-text-3 hover:bg-white/[0.07]'}`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        <span className="text-[11px] font-600">
          {enabledCount}/{totalCount}
        </span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 w-[260px] max-h-[420px] overflow-y-auto rounded-[12px] border border-white/[0.08] shadow-xl z-[120] overflow-hidden"
          style={{ animation: 'fade-in 0.15s ease', backgroundColor: '#171a2b' }}>
         <TooltipProvider delayDuration={300}>
          {groups.map((group, gi) => {
            if (group.tools.length === 0) return null
            return (
              <div key={group.label} className={`px-3 pb-1 ${gi === 0 ? 'pt-3' : 'pt-1 border-t border-white/[0.04]'}`}>
                <p className="text-[10px] font-600 text-text-3/60 uppercase tracking-wider mb-2">{group.label}</p>
                {group.tools.map((tool) => {
                  const extDisabled = !isExtensionEnabled(tool)
                  const enabled = !extDisabled && sessionTools.includes(tool.id)
                  return (
                    <Tooltip key={tool.id}>
                      <TooltipTrigger asChild>
                        <label className={`flex items-center gap-2.5 py-1.5 ${extDisabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}>
                          <div
                            onClick={() => !extDisabled && toggleTool(tool.id)}
                            className={`w-8 h-[18px] rounded-full transition-all duration-200 relative shrink-0
                              ${extDisabled ? 'bg-white/[0.04] cursor-not-allowed' : enabled ? 'bg-accent-bright cursor-pointer' : 'bg-white/[0.12] cursor-pointer'}`}
                          >
                            <div className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all duration-200
                              ${enabled ? 'left-[16px]' : 'left-[2px]'}`} />
                          </div>
                          <span className={`text-[12px] ${extDisabled ? 'text-text-3/40' : enabled ? 'text-text-2' : 'text-text-3/70'}`}>
                            {tool.label}
                          </span>
                        </label>
                      </TooltipTrigger>
                      <TooltipContent side="right" sideOffset={8} className="max-w-[200px] bg-[#1e2140] text-text-2 border border-white/[0.08] text-[11px] leading-snug px-2.5 py-1.5">
                        {extDisabled ? 'Enable in Extensions page' : tool.description}
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            )
          })}

          {agentSkillIds.length > 0 && (
            <div className="px-3 pb-2 pt-1 border-t border-white/[0.04]">
              <p className="text-[10px] font-600 text-text-3/60 uppercase tracking-wider mb-2">Skills</p>
              {agentSkillIds.map((skillId) => {
                const skill = skills[skillId]
                if (!skill) return null
                return (
                  <div key={skillId} className="flex items-center gap-2.5 py-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-bright/40 shrink-0" />
                    <span className="text-[12px] text-text-2 truncate">{skill.name}</span>
                  </div>
                )
              })}
            </div>
          )}

         </TooltipProvider>
          <div className="px-3 py-2 border-t border-white/[0.04] bg-white/[0.02]">
            <p className="text-[10px] text-text-3/70">Changes apply to the next message</p>
          </div>
        </div>
      )}
    </div>
  )
}
