import type { ExtensionHooks, ExtensionToolDef } from '@/types'
import { canonicalizeExtensionId, expandExtensionIds } from './tool-aliases'
import { dedup } from '@/lib/shared-utils'

type ApprovalGuidanceHook = NonNullable<ExtensionHooks['getApprovalGuidance']>

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeApprovalGuidanceLines(
  value: string | string[] | null | undefined,
): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : []
  }
  if (!Array.isArray(value)) return []
  return value
    .map((line) => (typeof line === 'string' ? line.trim() : ''))
    .filter(Boolean)
}

function dedupeApprovalGuidanceLines(lines: string[]): string[] {
  return dedup(lines.map((line) => line.trim()).filter(Boolean))
}

function formatApprovalToolLabel(toolNames: string[]): string {
  const uniqueNames = dedup(toolNames.map((name) => name.trim()).filter(Boolean))
  if (uniqueNames.length === 0) return 'its tools'
  if (uniqueNames.length === 1) return `\`${uniqueNames[0]}\``
  if (uniqueNames.length === 2) return `\`${uniqueNames[0]}\` and \`${uniqueNames[1]}\``
  return `${uniqueNames.slice(0, -1).map((name) => `\`${name}\``).join(', ')}, and \`${uniqueNames.at(-1)}\``
}

function buildDefaultExtensionApprovalGuidance(params: {
  extensionId: string
  extensionName: string
  tools: ExtensionToolDef[]
}): ApprovalGuidanceHook {
  const toolNames = params.tools
    .map((tool) => (typeof tool?.name === 'string' ? tool.name.trim() : ''))
    .filter(Boolean)
  const toolLabel = formatApprovalToolLabel(toolNames)
  const matchIds = new Set(
    dedupeApprovalGuidanceLines([
      params.extensionId,
      ...toolNames,
      ...expandExtensionIds([params.extensionId]),
      ...toolNames.flatMap((toolName) => expandExtensionIds([toolName])),
    ]).map((value) => canonicalizeExtensionId(value) || value.toLowerCase()),
  )

  return ({ approval, phase, approved }) => {
    if (approval.category !== 'tool_access') return null
    const requestedIds = [
      trimString(approval.data.extensionId),
      trimString(approval.data.toolId),
      trimString(approval.data.toolName),
    ].filter(Boolean)
    const matchesExtension = requestedIds.some((value) => {
      const candidates = [value, ...expandExtensionIds([value])]
      return candidates.some((candidate) => matchIds.has(canonicalizeExtensionId(candidate) || candidate.toLowerCase()))
    })
    if (!matchesExtension) return null

    if (phase === 'connector_reminder') {
      return `Approving this lets the agent use ${toolLabel} from ${params.extensionName}.`
    }
    if (approved === true) {
      return [
        `Access to ${params.extensionName} is approved. Continue with ${toolLabel} on the next turn.`,
        'Do not request the same access again in prose once it has been approved.',
      ]
    }
    if (approved === false) {
      return `Do not request access to ${params.extensionName} again unless the task or required capability materially changes.`
    }
    return [
      `If access to ${params.extensionName} is granted, continue with ${toolLabel} on the next turn.`,
      'Do not ask for the same access again in prose while this approval is pending.',
    ]
  }
}

function composeApprovalGuidance(
  defaultHook: ApprovalGuidanceHook,
  customHook?: ExtensionHooks['getApprovalGuidance'],
): ApprovalGuidanceHook {
  return (ctx) => {
    const combined = dedupeApprovalGuidanceLines([
      ...normalizeApprovalGuidanceLines(defaultHook(ctx)),
      ...normalizeApprovalGuidanceLines(customHook?.(ctx)),
    ])
    return combined.length > 0 ? combined : null
  }
}

export function buildExtensionHooks(
  extensionId: string,
  extensionName: string,
  hooks: ExtensionHooks | undefined,
  tools: ExtensionToolDef[] | undefined,
): ExtensionHooks {
  const nextHooks: ExtensionHooks = { ...(hooks || {}) }
  nextHooks.getApprovalGuidance = composeApprovalGuidance(
    buildDefaultExtensionApprovalGuidance({
      extensionId,
      extensionName,
      tools: tools || [],
    }),
    hooks?.getApprovalGuidance,
  )
  return nextHooks
}
