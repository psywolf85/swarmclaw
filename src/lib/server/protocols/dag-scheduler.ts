import type { ProtocolStepDefinition, ProtocolRunStepState, ProtocolRunStepStatus } from '@/types'

export interface StepReadinessResult {
  dagMode: boolean
  readyStepIds: string[]
  completedStepIds: string[]
  runningStepIds: string[]
  failedStepIds: string[]
  stepState: Record<string, ProtocolRunStepState>
}

/**
 * Pure function — no DB access, no side effects.
 * Computes which steps are ready to execute based on dependency edges.
 *
 * When dagMode is false (no step has dependsOnStepIds), returns early
 * so the caller falls through to the existing currentStepId cursor path.
 */
export function computeStepReadiness(
  steps: ProtocolStepDefinition[],
  entryStepId: string | null,
  existingStepState: Record<string, ProtocolRunStepState> | undefined,
): StepReadinessResult {
  const hasDeps = steps.some(
    (s) => Array.isArray(s.dependsOnStepIds) && s.dependsOnStepIds.length > 0,
  )
  if (!hasDeps) {
    return {
      dagMode: false,
      readyStepIds: [],
      completedStepIds: [],
      runningStepIds: [],
      failedStepIds: [],
      stepState: existingStepState || {},
    }
  }

  const state: Record<string, ProtocolRunStepState> = {}

  // Seed from existing durable state
  for (const step of steps) {
    const existing = existingStepState?.[step.id]
    state[step.id] = existing
      ? { ...existing }
      : { stepId: step.id, status: 'pending' as ProtocolRunStepStatus }
  }

  // Cascade failures: if any dependency failed, mark dependents as failed
  let changed = true
  while (changed) {
    changed = false
    for (const step of steps) {
      if (state[step.id].status === 'failed' || state[step.id].status === 'completed') continue
      if (state[step.id].status === 'running') continue
      const deps = step.dependsOnStepIds || []
      for (const depId of deps) {
        if (state[depId]?.status === 'failed') {
          state[step.id] = {
            ...state[step.id],
            status: 'failed',
            error: `Dependency "${depId}" failed`,
          }
          changed = true
          break
        }
      }
    }
  }

  // Compute readiness
  for (const step of steps) {
    const s = state[step.id]
    if (s.status !== 'pending') continue

    const deps = step.dependsOnStepIds || []
    const isRoot = deps.length === 0
    const allDepsMet = deps.every((depId) => state[depId]?.status === 'completed')

    if (isRoot || allDepsMet) {
      state[step.id] = { ...s, status: 'ready' }
    }
  }

  // Entry step is always a root — force ready if pending
  if (entryStepId && state[entryStepId]?.status === 'pending') {
    state[entryStepId] = { ...state[entryStepId], status: 'ready' }
  }

  const readyStepIds: string[] = []
  const completedStepIds: string[] = []
  const runningStepIds: string[] = []
  const failedStepIds: string[] = []

  for (const step of steps) {
    const s = state[step.id]
    if (s.status === 'ready') readyStepIds.push(step.id)
    else if (s.status === 'completed') completedStepIds.push(step.id)
    else if (s.status === 'running') runningStepIds.push(step.id)
    else if (s.status === 'failed') failedStepIds.push(step.id)
  }

  return { dagMode: true, readyStepIds, completedStepIds, runningStepIds, failedStepIds, stepState: state }
}
