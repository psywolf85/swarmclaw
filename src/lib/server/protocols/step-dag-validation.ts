import type { ProtocolStepDefinition } from '@/types'

interface StepDagResult {
  valid: boolean
  cycle?: string[]
}

/**
 * DFS cycle detection for step dependency graphs.
 * Walks dependsOnStepIds edges and returns { valid: false, cycle } if a cycle is found.
 */
export function validateStepDag(steps: ProtocolStepDefinition[]): StepDagResult {
  const stepIds = new Set(steps.map((s) => s.id))
  const adjacency = new Map<string, string[]>()
  for (const step of steps) {
    adjacency.set(step.id, (step.dependsOnStepIds || []).filter((id) => stepIds.has(id)))
  }

  const visited = new Set<string>()
  const inStack = new Set<string>()
  const path: string[] = []

  function dfs(nodeId: string): string[] | null {
    if (inStack.has(nodeId)) {
      // Found cycle — extract it from path
      const cycleStart = path.indexOf(nodeId)
      return [...path.slice(cycleStart), nodeId]
    }
    if (visited.has(nodeId)) return null
    visited.add(nodeId)
    inStack.add(nodeId)
    path.push(nodeId)

    for (const depId of adjacency.get(nodeId) || []) {
      const cycle = dfs(depId)
      if (cycle) return cycle
    }

    path.pop()
    inStack.delete(nodeId)
    return null
  }

  for (const step of steps) {
    const cycle = dfs(step.id)
    if (cycle) return { valid: false, cycle }
  }

  return { valid: true }
}

/**
 * Validates that all step references (dependsOnStepIds, nextStepId, etc.)
 * point to existing step IDs within the set.
 * Returns a list of invalid reference IDs.
 */
export function validateStepRefs(steps: ProtocolStepDefinition[]): string[] {
  const validIds = new Set(steps.map((s) => s.id))
  const invalid: string[] = []

  for (const step of steps) {
    for (const depId of step.dependsOnStepIds || []) {
      if (!validIds.has(depId)) invalid.push(depId)
    }
    if (step.nextStepId && !validIds.has(step.nextStepId)) {
      invalid.push(step.nextStepId)
    }
    if (step.defaultNextStepId && !validIds.has(step.defaultNextStepId)) {
      invalid.push(step.defaultNextStepId)
    }
    for (const bc of step.branchCases || []) {
      if (bc.nextStepId && !validIds.has(bc.nextStepId)) invalid.push(bc.nextStepId)
    }
    if (step.repeat?.bodyStepId && !validIds.has(step.repeat.bodyStepId)) {
      invalid.push(step.repeat.bodyStepId)
    }
    if (step.repeat?.nextStepId && !validIds.has(step.repeat.nextStepId)) {
      invalid.push(step.repeat.nextStepId)
    }
    if (step.join?.parallelStepId && !validIds.has(step.join.parallelStepId)) {
      invalid.push(step.join.parallelStepId)
    }
  }

  return [...new Set(invalid)]
}
