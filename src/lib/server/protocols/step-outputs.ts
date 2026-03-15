import type { ProtocolRun, ProtocolRunStepOutput } from '@/types'

export function normalizeStepOutput(output: ProtocolRunStepOutput): ProtocolRunStepOutput {
  return {
    stepId: output.stepId,
    outputKey: typeof output.outputKey === 'string' ? output.outputKey : null,
    summary: typeof output.summary === 'string' ? output.summary : null,
    artifactIds: Array.isArray(output.artifactIds) ? output.artifactIds : [],
    taskIds: Array.isArray(output.taskIds) ? output.taskIds : [],
    childRunIds: Array.isArray(output.childRunIds) ? output.childRunIds : [],
    structuredData: output.structuredData && typeof output.structuredData === 'object'
      ? output.structuredData
      : null,
  }
}

export function normalizeStepOutputs(
  outputs: Record<string, ProtocolRunStepOutput> | undefined,
): Record<string, ProtocolRunStepOutput> {
  const out: Record<string, ProtocolRunStepOutput> = {}
  if (!outputs || typeof outputs !== 'object') return out
  for (const [stepId, output] of Object.entries(outputs)) {
    if (!stepId || !output || typeof output !== 'object') continue
    out[stepId] = normalizeStepOutput(output)
  }
  return out
}

export function emitStepOutput(
  run: ProtocolRun,
  stepId: string,
  partial: Partial<ProtocolRunStepOutput>,
): ProtocolRun {
  const existing = run.stepOutputs?.[stepId] || { stepId }
  const merged = normalizeStepOutput({ ...existing, ...partial, stepId })
  return {
    ...run,
    stepOutputs: {
      ...(run.stepOutputs || {}),
      [stepId]: merged,
    },
  }
}

export function resolveOutputByKeyOrId(
  run: ProtocolRun,
  ref: string,
): ProtocolRunStepOutput | null {
  const outputs = run.stepOutputs || {}
  // Direct step ID match
  if (outputs[ref]) return outputs[ref]
  // Search by outputKey
  for (const output of Object.values(outputs)) {
    if (output.outputKey === ref) return output
  }
  return null
}
