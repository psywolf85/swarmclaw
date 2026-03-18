/**
 * Protocol templates: built-in templates, locking, and template CRUD.
 * Groups G4 + G5 + G6 from protocol-service.ts
 */
import { genId } from '@/lib/id'
import type { ProtocolRunStatus, ProtocolTemplate } from '@/types'
import {
  deleteProtocolTemplate,
  loadProtocolTemplate,
  loadProtocolTemplates,
  patchProtocolTemplate,
  upsertProtocolTemplate,
} from '@/lib/server/protocols/protocol-template-repository'
import {
  releaseRuntimeLock,
  renewRuntimeLock,
  tryAcquireRuntimeLock,
} from '@/lib/server/runtime/runtime-lock-repository'
import { notify } from '@/lib/server/ws-hub'
import { cleanText, now, PROTOCOL_LOCK_TTL_MS, uniqueIds } from '@/lib/server/protocols/protocol-types'
import type { ProtocolRunDeps, UpsertProtocolTemplateInput } from '@/lib/server/protocols/protocol-types'
import {
  deriveDisplayPhasesFromSteps,
  normalizeProtocolTemplate,
  protocolLockName,
  resolveTemplateSteps,
} from '@/lib/server/protocols/protocol-normalization'

// ---- Module-level constants ----

const PROTOCOL_LOCK_OWNER = `protocol:${process.pid}:${genId(6)}`

// ---- Built-in templates (G4) ----

export const BUILT_IN_PROTOCOL_TEMPLATES: ProtocolTemplate[] = [
  {
    id: 'independent_collection',
    name: 'Independent Collection',
    description: 'Gather separate inputs first, then conclude with one synthesized summary.',
    builtIn: true,
    singleAgentAllowed: true,
    tags: ['neutral', 'collection', 'analysis'],
    recommendedOutputs: ['collected inputs', 'summary'],
    defaultPhases: [
      { id: 'present', kind: 'present', label: 'Open the session' },
      { id: 'collect', kind: 'collect_independent_inputs', label: 'Collect independent inputs' },
      { id: 'summarize', kind: 'summarize', label: 'Summarize the collected inputs' },
    ],
  },
  {
    id: 'facilitated_discussion',
    name: 'Facilitated Discussion',
    description: 'Walk participants through a structured round-robin, then conclude with a synthesis.',
    builtIn: true,
    singleAgentAllowed: true,
    tags: ['neutral', 'discussion'],
    recommendedOutputs: ['discussion summary'],
    defaultPhases: [
      { id: 'present', kind: 'present', label: 'Open the session' },
      { id: 'round_robin', kind: 'round_robin', label: 'Round-robin responses' },
      { id: 'summarize', kind: 'summarize', label: 'Summarize the discussion' },
    ],
  },
  {
    id: 'review_panel',
    name: 'Review Panel',
    description: 'Collect independent reviews, compare them, then conclude with a decision and summary.',
    builtIn: true,
    singleAgentAllowed: true,
    tags: ['neutral', 'review'],
    recommendedOutputs: ['comparison', 'decision', 'summary'],
    defaultPhases: [
      { id: 'present', kind: 'present', label: 'Present the subject' },
      { id: 'collect', kind: 'collect_independent_inputs', label: 'Collect independent reviews' },
      { id: 'compare', kind: 'compare', label: 'Compare the inputs' },
      { id: 'decide', kind: 'decide', label: 'Produce the current verdict' },
      { id: 'summarize', kind: 'summarize', label: 'Summarize the outcome' },
    ],
  },
  {
    id: 'decision_round',
    name: 'Decision Round',
    description: 'Move from separate positions to a single current decision.',
    builtIn: true,
    singleAgentAllowed: true,
    tags: ['neutral', 'decision'],
    recommendedOutputs: ['decision', 'summary'],
    defaultPhases: [
      { id: 'present', kind: 'present', label: 'Set the decision context' },
      { id: 'collect', kind: 'collect_independent_inputs', label: 'Collect initial positions' },
      { id: 'compare', kind: 'compare', label: 'Compare the positions' },
      { id: 'decide', kind: 'decide', label: 'Decide the current outcome' },
      { id: 'summarize', kind: 'summarize', label: 'Summarize the decision' },
    ],
  },
  {
    id: 'status_roundup',
    name: 'Status Roundup',
    description: 'Gather per-participant updates in order and conclude with a concise recap.',
    builtIn: true,
    singleAgentAllowed: true,
    tags: ['neutral', 'status'],
    recommendedOutputs: ['status recap'],
    defaultPhases: [
      { id: 'present', kind: 'present', label: 'Set the roundup context' },
      { id: 'round_robin', kind: 'round_robin', label: 'Collect per-participant updates' },
      { id: 'summarize', kind: 'summarize', label: 'Summarize the roundup' },
    ],
  },
  {
    id: 'adjudicated_compare',
    name: 'Adjudicated Compare',
    description: 'Collect competing views, compare them, and let one facilitator synthesize the current ruling.',
    builtIn: true,
    singleAgentAllowed: true,
    tags: ['neutral', 'compare'],
    recommendedOutputs: ['comparison', 'decision', 'summary'],
    defaultPhases: [
      { id: 'present', kind: 'present', label: 'Present the comparison target' },
      { id: 'collect', kind: 'collect_independent_inputs', label: 'Collect independent positions' },
      { id: 'compare', kind: 'compare', label: 'Compare the positions' },
      { id: 'decide', kind: 'decide', label: 'Adjudicate the current outcome' },
      { id: 'summarize', kind: 'summarize', label: 'Summarize the ruling' },
    ],
  },
  {
    id: 'single_agent_structured_run',
    name: 'Single-Agent Structured Run',
    description: 'A bounded structured session for one agent that still produces a durable summary.',
    builtIn: true,
    singleAgentAllowed: true,
    tags: ['neutral', 'single-agent'],
    recommendedOutputs: ['summary'],
    defaultPhases: [
      { id: 'present', kind: 'present', label: 'Set the task context' },
      { id: 'round_robin', kind: 'round_robin', label: 'Produce the agent response' },
      { id: 'summarize', kind: 'summarize', label: 'Summarize the outcome' },
    ],
  },
]

// ---- Locking (G5) ----

export function acquireProtocolLease(runId: string): (() => void) | null {
  const name = protocolLockName(runId)
  const acquired = tryAcquireRuntimeLock(name, PROTOCOL_LOCK_OWNER, PROTOCOL_LOCK_TTL_MS)
  if (!acquired) return null
  return () => releaseRuntimeLock(name, PROTOCOL_LOCK_OWNER)
}

export function renewProtocolLease(runId: string): void {
  renewRuntimeLock(protocolLockName(runId), PROTOCOL_LOCK_OWNER, PROTOCOL_LOCK_TTL_MS)
}

export function notifyProtocolTemplates(): void {
  notify('protocol_templates')
}

// ---- Template CRUD (G6) ----

export function isTerminalProtocolRunStatus(status: ProtocolRunStatus | null | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'archived'
}

export function listStoredTemplates(): ProtocolTemplate[] {
  return Object.values(loadProtocolTemplates())
    .map((template) => normalizeProtocolTemplate(template))
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
}

export function listAllTemplates(): ProtocolTemplate[] {
  return [
    ...BUILT_IN_PROTOCOL_TEMPLATES.map((template) => normalizeProtocolTemplate(template)),
    ...listStoredTemplates(),
  ]
}

export function loadTemplate(templateId: string | null | undefined): ProtocolTemplate | null {
  const normalized = cleanText(templateId, 64)
  if (!normalized) return null
  const builtIn = BUILT_IN_PROTOCOL_TEMPLATES.find((template) => template.id === normalized)
  if (builtIn) {
    return normalizeProtocolTemplate(builtIn)
  }
  const stored = loadProtocolTemplate(normalized)
  return stored ? normalizeProtocolTemplate(stored) : null
}

export function isBuiltInTemplateId(templateId: string | null | undefined): boolean {
  const normalized = cleanText(templateId, 64)
  if (!normalized) return false
  return BUILT_IN_PROTOCOL_TEMPLATES.some((template) => template.id === normalized)
}

export function loadProtocolTemplateById(templateId: string | null | undefined): ProtocolTemplate | null {
  return loadTemplate(templateId)
}

export function createProtocolTemplate(input: UpsertProtocolTemplateInput, deps?: ProtocolRunDeps): ProtocolTemplate {
  const createdAt = now(deps)
  const { steps, entryStepId } = resolveTemplateSteps({
    steps: Array.isArray(input.steps) ? input.steps : [],
    entryStepId: input.entryStepId || null,
    defaultPhases: Array.isArray(input.defaultPhases) ? input.defaultPhases : [],
  })
  const template = normalizeProtocolTemplate({
    id: genId(10),
    builtIn: false,
    name: cleanText(input.name, 120) || 'Custom Template',
    description: cleanText(input.description, 600) || 'Custom structured-session template.',
    singleAgentAllowed: input.singleAgentAllowed !== false,
    tags: uniqueIds(input.tags, 24),
    recommendedOutputs: uniqueIds(input.recommendedOutputs, 24),
    defaultPhases: deriveDisplayPhasesFromSteps(steps),
    steps,
    entryStepId,
    createdAt,
    updatedAt: createdAt,
  })
  upsertProtocolTemplate(template.id, template)
  notifyProtocolTemplates()
  return template
}

export function updateProtocolTemplate(templateId: string, input: UpsertProtocolTemplateInput, deps?: ProtocolRunDeps): ProtocolTemplate | null {
  const normalizedId = cleanText(templateId, 64)
  if (!normalizedId || isBuiltInTemplateId(normalizedId)) return null
  const updated = patchProtocolTemplate(normalizedId, (current) => {
    if (!current) return null
    const { steps, entryStepId } = resolveTemplateSteps({
      steps: Array.isArray(input.steps) && input.steps.length > 0 ? input.steps : current.steps || [],
      entryStepId: input.entryStepId || current.entryStepId || null,
      defaultPhases: Array.isArray(input.defaultPhases) && input.defaultPhases.length > 0 ? input.defaultPhases : current.defaultPhases,
    })
    return normalizeProtocolTemplate({
      ...current,
      name: cleanText(input.name, 120) || current.name,
      description: cleanText(input.description, 600) || current.description,
      singleAgentAllowed: input.singleAgentAllowed !== false,
      tags: uniqueIds(input.tags, 24),
      recommendedOutputs: uniqueIds(input.recommendedOutputs, 24),
      defaultPhases: deriveDisplayPhasesFromSteps(steps),
      steps,
      entryStepId,
      updatedAt: now(deps),
    })
  })
  if (!updated) return null
  notifyProtocolTemplates()
  return normalizeProtocolTemplate(updated)
}

export function deleteProtocolTemplateById(templateId: string): boolean {
  const normalizedId = cleanText(templateId, 64)
  if (!normalizedId || isBuiltInTemplateId(normalizedId)) return false
  const existing = loadProtocolTemplate(normalizedId)
  if (!existing) return false
  deleteProtocolTemplate(normalizedId)
  notifyProtocolTemplates()
  return true
}
