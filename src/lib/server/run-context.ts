/**
 * RunContext — Persistent structured working memory for agents.
 *
 * Survives compaction, flows through delegation, and accumulates learnings
 * from reflections. The session message history is the primary "memory" but
 * it's fragile (compaction drops old messages) and isolated (workers don't
 * see coordinator context). RunContext fixes both.
 */

import type { Message, RunContext, RunReflection, Session } from '@/types'
import { getSession, saveSession } from '@/lib/server/sessions/session-repository'
import { log } from '@/lib/server/logger'

const TAG = 'run-context'

// ---------------------------------------------------------------------------
// Array caps — enforced by pruneRunContext
// ---------------------------------------------------------------------------

const CAPS: Record<string, number> = {
  keyFacts: 20,
  discoveries: 16,
  failedApproaches: 16,
  constraints: 12,
  currentPlan: 12,
  completedSteps: 12,
  blockers: 8,
}

const PARENT_CONTEXT_BUDGET = 600
const RUN_CONTEXT_SECTION_BUDGET = 3000

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/** Return the existing RunContext or create a fresh empty one. */
export function ensureRunContext(existing: RunContext | null | undefined): RunContext {
  if (existing && typeof existing === 'object' && typeof existing.version === 'number') {
    // Backfill any missing array fields from malformed persisted data
    if (!Array.isArray(existing.constraints)) existing.constraints = []
    if (!Array.isArray(existing.keyFacts)) existing.keyFacts = []
    if (!Array.isArray(existing.discoveries)) existing.discoveries = []
    if (!Array.isArray(existing.failedApproaches)) existing.failedApproaches = []
    if (!Array.isArray(existing.currentPlan)) existing.currentPlan = []
    if (!Array.isArray(existing.completedSteps)) existing.completedSteps = []
    if (!Array.isArray(existing.blockers)) existing.blockers = []
    return existing
  }
  return {
    objective: null,
    constraints: [],
    keyFacts: [],
    discoveries: [],
    failedApproaches: [],
    currentPlan: [],
    completedSteps: [],
    blockers: [],
    parentContext: null,
    updatedAt: Date.now(),
    version: 0,
  }
}

/** Normalize whitespace, trim, and case-insensitive dedup an array of strings. */
export function dedup(arr: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of arr) {
    const normalized = raw.replace(/\s+/g, ' ').trim()
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

/** Enforce array caps on a RunContext, keeping the most recent entries. */
export function pruneRunContext(ctx: RunContext): RunContext {
  const record = ctx as unknown as Record<string, unknown>
  for (const [field, cap] of Object.entries(CAPS)) {
    const arr = record[field]
    if (Array.isArray(arr) && arr.length > cap) {
      record[field] = arr.slice(-cap)
    }
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Reflection folding
// ---------------------------------------------------------------------------

/**
 * Map reflection note fields into RunContext fields.
 *
 * | RunReflection field       | RunContext target    |
 * |---------------------------|---------------------|
 * | invariantNotes            | keyFacts            |
 * | lessonNotes               | keyFacts            |
 * | derivedNotes              | discoveries         |
 * | significantEventNotes     | discoveries         |
 * | failureNotes              | failedApproaches    |
 * | openLoopNotes             | blockers            |
 * | boundaryNotes             | constraints         |
 */
export function foldReflectionIntoRunContext(
  current: RunContext | null | undefined,
  reflection: RunReflection,
): RunContext {
  const ctx = ensureRunContext(current)

  // keyFacts <- invariantNotes + lessonNotes
  ctx.keyFacts = dedup([
    ...ctx.keyFacts,
    ...(reflection.invariantNotes || []),
    ...(reflection.lessonNotes || []),
  ])

  // discoveries <- derivedNotes + significantEventNotes
  ctx.discoveries = dedup([
    ...ctx.discoveries,
    ...(reflection.derivedNotes || []),
    ...(reflection.significantEventNotes || []),
  ])

  // failedApproaches <- failureNotes
  ctx.failedApproaches = dedup([
    ...ctx.failedApproaches,
    ...(reflection.failureNotes || []),
  ])

  // blockers <- openLoopNotes
  ctx.blockers = dedup([
    ...ctx.blockers,
    ...(reflection.openLoopNotes || []),
  ])

  // constraints <- boundaryNotes
  ctx.constraints = dedup([
    ...ctx.constraints,
    ...(reflection.boundaryNotes || []),
  ])

  ctx.version++
  ctx.updatedAt = Date.now()
  return pruneRunContext(ctx)
}

// ---------------------------------------------------------------------------
// Delegation serialization
// ---------------------------------------------------------------------------

/** Serialize a RunContext into a budget-capped summary string for delegation handoff. */
export function serializeParentContext(ctx: RunContext | null | undefined): string | null {
  if (!ctx) return null

  const parts: string[] = []
  let budget = PARENT_CONTEXT_BUDGET

  const append = (line: string): boolean => {
    if (budget - line.length - 1 < 0) return false
    parts.push(line)
    budget -= line.length + 1
    return true
  }

  if (ctx.objective) append(`Objective: ${ctx.objective}`)
  if (ctx.constraints.length > 0) append(`Constraints: ${ctx.constraints.join('; ')}`)
  if (ctx.keyFacts.length > 0) append(`Key facts: ${ctx.keyFacts.slice(-6).join('; ')}`)
  if (ctx.failedApproaches.length > 0) append(`Already tried (failed): ${ctx.failedApproaches.slice(-4).join('; ')}`)
  if (ctx.blockers.length > 0) append(`Blockers: ${ctx.blockers.join('; ')}`)
  if (ctx.discoveries.length > 0) append(`Discoveries: ${ctx.discoveries.slice(-4).join('; ')}`)

  return parts.length > 0 ? parts.join('\n') : null
}

// ---------------------------------------------------------------------------
// Pre-compaction fact extraction (regex-based, no LLM call)
// ---------------------------------------------------------------------------

const FACT_PATTERNS: RegExp[] = [
  /\b(?:important|critical|key|note|remember|must|always|never|constraint|requirement|blocker|discovered|found that|turns out)\b[:\s]+(.{10,200})/gi,
  /\b(?:error|failed|doesn't work|won't work|can't|cannot|broken)\b[:\s]+(.{10,200})/gi,
]

/** Extract lightweight facts from messages about to be compacted. */
export function extractFactsFromMessages(messages: Message[]): { keyFacts: string[]; failedApproaches: string[] } {
  const keyFacts: string[] = []
  const failedApproaches: string[] = []

  for (const msg of messages) {
    const text = msg.text || ''
    if (!text || text.length < 20) continue

    for (const pattern of FACT_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null = pattern.exec(text)
      while (match !== null) {
        const fact = match[1]?.trim()
        if (!fact || fact.length < 10) {
          match = pattern.exec(text)
          continue
        }

        if (/\b(?:error|failed|doesn't work|won't work|can't|cannot|broken)\b/i.test(match[0])) {
          failedApproaches.push(fact.slice(0, 200))
        } else {
          keyFacts.push(fact.slice(0, 200))
        }
        match = pattern.exec(text)
      }
    }
  }

  return {
    keyFacts: dedup(keyFacts).slice(-10),
    failedApproaches: dedup(failedApproaches).slice(-8),
  }
}

// ---------------------------------------------------------------------------
// Session-level update helper
// ---------------------------------------------------------------------------

/** Load-modify-save a session's RunContext with a version bump. */
export function updateSessionRunContext(
  sessionId: string,
  updater: (ctx: RunContext) => RunContext,
): void {
  try {
    const session = getSession(sessionId) as Session | undefined
    if (!session) return

    const ctx = ensureRunContext(session.runContext)
    const updated = updater(ctx)
    updated.version++
    updated.updatedAt = Date.now()
    session.runContext = pruneRunContext(updated)
    saveSession(sessionId, session)
  } catch (err: unknown) {
    log.warn(TAG, `Failed to update RunContext for session ${sessionId}:`, err instanceof Error ? err.message : String(err))
  }
}

// ---------------------------------------------------------------------------
// MainLoopState -> RunContext projection
// ---------------------------------------------------------------------------

/** Project orchestrator MainLoopState into the session's RunContext. */
export function syncMainLoopToRunContext(
  sessionId: string,
  mainLoopState: {
    goal?: string | null
    planSteps?: string[]
    completedPlanSteps?: string[]
    workingMemoryNotes?: string[]
  },
): void {
  try {
    const session = getSession(sessionId) as Session | undefined
    if (!session) return

    const ctx = ensureRunContext(session.runContext)

    if (mainLoopState.goal) ctx.objective = mainLoopState.goal
    if (Array.isArray(mainLoopState.planSteps)) ctx.currentPlan = mainLoopState.planSteps
    if (Array.isArray(mainLoopState.completedPlanSteps)) ctx.completedSteps = mainLoopState.completedPlanSteps
    if (Array.isArray(mainLoopState.workingMemoryNotes) && mainLoopState.workingMemoryNotes.length > 0) {
      ctx.keyFacts = dedup([...ctx.keyFacts, ...mainLoopState.workingMemoryNotes])
    }

    ctx.version++
    ctx.updatedAt = Date.now()
    session.runContext = pruneRunContext(ctx)
    saveSession(sessionId, session)
  } catch (err: unknown) {
    log.warn(TAG, `Failed to sync MainLoopState to RunContext for ${sessionId}:`, err instanceof Error ? err.message : String(err))
  }
}

// ---------------------------------------------------------------------------
// Prompt section rendering
// ---------------------------------------------------------------------------

/** Build the RunContext prompt section. Returns null if nothing to render or minimal prompt. */
export function buildRunContextSection(
  runContext: RunContext | null | undefined,
  isMinimalPrompt: boolean,
): string | null {
  if (isMinimalPrompt || !runContext) return null

  const lines: string[] = []
  let budget = RUN_CONTEXT_SECTION_BUDGET

  const append = (line: string): boolean => {
    if (budget - line.length - 1 < 0) return false
    lines.push(line)
    budget -= line.length + 1
    return true
  }

  // Parent coordinator context
  if (runContext.parentContext) {
    append('## Coordinator Context')
    append(runContext.parentContext)
    append('')
  }

  // Objective
  if (runContext.objective) {
    append('## Current Objective')
    append(runContext.objective)
    append('')
  }

  // Constraints
  if (runContext.constraints.length > 0) {
    append('## Constraints')
    for (const c of runContext.constraints) append(`- ${c}`)
    append('')
  }

  // Key facts — survive compaction
  if (runContext.keyFacts.length > 0) {
    append('## Key Facts')
    for (const f of runContext.keyFacts) append(`- ${f}`)
    append('')
  }

  // Failed approaches — don't repeat these
  if (runContext.failedApproaches.length > 0) {
    append('## Already Tried (Failed)')
    for (const f of runContext.failedApproaches) append(`- ${f}`)
    append('')
  }

  // Current plan
  if (runContext.currentPlan.length > 0) {
    append('## Current Plan')
    const completedSet = new Set(runContext.completedSteps.map((s) => s.toLowerCase()))
    for (const step of runContext.currentPlan) {
      const done = completedSet.has(step.toLowerCase())
      append(`- [${done ? 'x' : ' '}] ${step}`)
    }
    append('')
  }

  // Blockers
  if (runContext.blockers.length > 0) {
    append('## Blockers')
    for (const b of runContext.blockers) append(`- ${b}`)
    append('')
  }

  // Discoveries
  if (runContext.discoveries.length > 0) {
    append('## Discoveries')
    for (const d of runContext.discoveries) append(`- ${d}`)
    append('')
  }

  if (lines.length === 0) return null
  return ['## Working Memory (RunContext)', '', ...lines].join('\n')
}
