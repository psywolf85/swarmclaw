/**
 * Protocol subflow step processing.
 * Group G14 from protocol-service.ts
 */
import type {
  ProtocolRun,
  ProtocolRunSubflowState,
  ProtocolStepDefinition,
} from '@/types'
import { cleanText, now, uniqueIds } from '@/lib/server/protocols/protocol-types'
import type { ProtocolRunDeps } from '@/lib/server/protocols/protocol-types'
import { findRunStep } from '@/lib/server/protocols/protocol-normalization'
import { loadTemplate } from '@/lib/server/protocols/protocol-templates'
import {
  appendProtocolEvent,
  persistRun,
  updateRun,
} from '@/lib/server/protocols/protocol-agent-turn'
import { beginStep } from '@/lib/server/protocols/protocol-step-helpers'

export async function processSubflowStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const config = step.subflow
  if (!config) {
    throw new Error(`Subflow step "${step.label}" is missing subflow config.`)
  }

  const template = loadTemplate(config.templateId)
  if (!template) {
    throw new Error(`Subflow step "${step.label}" references unknown template: "${config.templateId}"`)
  }

  const started = beginStep(run, step, deps)

  // Build input context from inputMapping
  const childOperatorContext: string[] = []
  if (config.inputMapping) {
    for (const [contextKey, outputRef] of Object.entries(config.inputMapping)) {
      const output = started.stepOutputs?.[outputRef]
      if (output?.summary) {
        childOperatorContext.push(`[subflow input] ${contextKey}: ${output.summary}`)
      } else if (output?.structuredData) {
        childOperatorContext.push(`[subflow input] ${contextKey}: ${JSON.stringify(output.structuredData)}`)
      }
    }
  }

  const participantAgentIds = uniqueIds(
    config.participantAgentIds && config.participantAgentIds.length > 0
      ? config.participantAgentIds
      : started.participantAgentIds,
    64,
  )

  // Lazy import to avoid circular dependency
  const { createProtocolRun, requestProtocolRunExecution } = require('@/lib/server/protocols/protocol-run-lifecycle') as typeof import('@/lib/server/protocols/protocol-run-lifecycle')

  const childRun = createProtocolRun({
    title: `${started.title} — Subflow: ${template.name}`,
    templateId: config.templateId,
    participantAgentIds,
    facilitatorAgentId: config.facilitatorAgentId || participantAgentIds[0] || null,
    sessionId: started.sessionId || null,
    sourceRef: {
      kind: 'protocol_run',
      runId: started.id,
      parentRunId: started.id,
      stepId: step.id,
    },
    autoStart: false,
    createTranscript: true,
    config: {
      ...(started.config || {}),
      postSummaryToParent: false,
    },
    parentRunId: started.id,
    parentStepId: step.id,
    systemOwned: true,
  }, deps)

  if (childOperatorContext.length > 0) {
    persistRun({
      ...childRun,
      operatorContext: [...(childRun.operatorContext || []), ...childOperatorContext],
    })
  }

  const subflowState: ProtocolRunSubflowState = {
    stepId: step.id,
    childRunId: childRun.id,
    templateId: config.templateId,
    status: childRun.status,
    summary: null,
    lastError: null,
    startedAt: now(deps),
    completedAt: null,
  }

  appendProtocolEvent(run.id, {
    type: 'subflow_started',
    stepId: step.id,
    summary: `Started subflow "${template.name}" as child run.`,
    data: { childRunId: childRun.id, templateId: config.templateId },
  }, deps)

  const updated = persistRun({
    ...started,
    subflowState: {
      ...(started.subflowState || {}),
      [step.id]: subflowState,
    },
    status: 'waiting',
    waitingReason: `Waiting for subflow "${template.name}" to complete.`,
    updatedAt: now(deps),
  })

  requestProtocolRunExecution(childRun.id, deps)
  return updated
}

export function syncSubflowParentFromChildRun(
  child: ProtocolRun,
  parent: ProtocolRun,
  subState: ProtocolRunSubflowState,
  deps?: ProtocolRunDeps,
): ProtocolRun | null {
  const { isTerminalProtocolRunStatus } = require('@/lib/server/protocols/protocol-templates') as typeof import('@/lib/server/protocols/protocol-templates')

  if (!isTerminalProtocolRunStatus(child.status)) {
    // Just update status tracking
    const updatedState: ProtocolRunSubflowState = { ...subState, status: child.status }
    return updateRun(parent.id, (current) => ({
      ...current,
      subflowState: { ...(current.subflowState || {}), [child.parentStepId!]: updatedState },
      updatedAt: now(deps),
    }))
  }

  const parentStep = findRunStep(parent, child.parentStepId!)
  const config = parentStep?.subflow

  if (child.status === 'completed') {
    // Apply output mapping
    let updatedParent = parent
    if (config?.outputMapping) {
      const childOutputs = child.stepOutputs || {}
      for (const [childKey, parentKey] of Object.entries(config.outputMapping)) {
        const childOutput = childOutputs[childKey]
        if (childOutput) {
          updatedParent = {
            ...updatedParent,
            stepOutputs: {
              ...(updatedParent.stepOutputs || {}),
              [parentKey]: { ...childOutput, stepId: child.parentStepId! },
            },
          }
        }
      }
    }

    const nextSubState: ProtocolRunSubflowState = {
      ...subState,
      status: 'completed',
      summary: child.summary || null,
      completedAt: now(deps),
    }

    appendProtocolEvent(parent.id, {
      type: 'subflow_completed',
      stepId: child.parentStepId,
      summary: `Subflow completed: ${child.title}`,
      data: { childRunId: child.id },
    }, deps)

    // Advance parent past the subflow step
    const nextStepId = parentStep?.nextStepId || null
    const nextIndex = nextStepId && Array.isArray(updatedParent.steps)
      ? Math.max(0, updatedParent.steps.findIndex((s) => s.id === nextStepId))
      : Array.isArray(updatedParent.steps) ? updatedParent.steps.length : updatedParent.currentPhaseIndex + 1
    persistRun({
      ...updatedParent,
      subflowState: { ...(updatedParent.subflowState || {}), [child.parentStepId!]: nextSubState },
      status: 'running',
      currentStepId: nextStepId,
      currentPhaseIndex: nextIndex,
      waitingReason: null,
      updatedAt: now(deps),
    })
    const { requestProtocolRunExecution } = require('@/lib/server/protocols/protocol-run-lifecycle') as typeof import('@/lib/server/protocols/protocol-run-lifecycle')
    requestProtocolRunExecution(parent.id, deps)
    const { loadProtocolRunById } = require('@/lib/server/protocols/protocol-queries') as typeof import('@/lib/server/protocols/protocol-queries')
    return loadProtocolRunById(parent.id)
  }

  // Child failed or cancelled
  const failPolicy = config?.onFailure || 'fail_parent'
  const nextSubState: ProtocolRunSubflowState = {
    ...subState,
    status: child.status,
    lastError: child.lastError || null,
    completedAt: now(deps),
  }

  if (failPolicy === 'fail_parent') {
    appendProtocolEvent(parent.id, {
      type: 'subflow_failed',
      stepId: child.parentStepId,
      summary: `Subflow failed: ${child.lastError || child.status}`,
      data: { childRunId: child.id, status: child.status },
    }, deps)
    persistRun({
      ...parent,
      subflowState: { ...(parent.subflowState || {}), [child.parentStepId!]: nextSubState },
      status: 'failed',
      lastError: `Subflow "${child.title}" ${child.status}: ${child.lastError || 'no details'}`,
      endedAt: parent.endedAt || now(deps),
      updatedAt: now(deps),
    })
    const { loadProtocolRunById } = require('@/lib/server/protocols/protocol-queries') as typeof import('@/lib/server/protocols/protocol-queries')
    return loadProtocolRunById(parent.id)
  }

  // advance_with_warning
  appendProtocolEvent(parent.id, {
    type: 'warning',
    stepId: child.parentStepId,
    summary: `Subflow "${child.title}" ${child.status} but advancing with warning.`,
    data: { childRunId: child.id, status: child.status },
  }, deps)

  const nextStepId = parentStep?.nextStepId || null
  const nextIndex = nextStepId && Array.isArray(parent.steps)
    ? Math.max(0, parent.steps.findIndex((s) => s.id === nextStepId))
    : Array.isArray(parent.steps) ? parent.steps.length : parent.currentPhaseIndex + 1
  persistRun({
    ...parent,
    subflowState: { ...(parent.subflowState || {}), [child.parentStepId!]: nextSubState },
    status: 'running',
    currentStepId: nextStepId,
    currentPhaseIndex: nextIndex,
    waitingReason: null,
    updatedAt: now(deps),
  })
  const { requestProtocolRunExecution } = require('@/lib/server/protocols/protocol-run-lifecycle') as typeof import('@/lib/server/protocols/protocol-run-lifecycle')
  requestProtocolRunExecution(parent.id, deps)
  const { loadProtocolRunById } = require('@/lib/server/protocols/protocol-queries') as typeof import('@/lib/server/protocols/protocol-queries')
  return loadProtocolRunById(parent.id)
}
