/**
 * Tracks continuation budget counters and their maximums for each
 * continuation type in the agent chat loop.
 */
import type { ContinuationType } from '@/lib/server/chat-execution/stream-continuation'

/** Continuation types that have budget counters. */
type BudgetedContinuation = Exclude<ContinuationType, false>

interface LimitEntry {
  count: number
  max: number
}

// ---------------------------------------------------------------------------
// Default budget constants
// ---------------------------------------------------------------------------

/** Max recursion continuations (transient error retries, etc.) */
const MAX_RECURSION = 3
const MAX_TRANSIENT = 3

/** Max required-tool reminder nudges */
const MAX_REQUIRED_TOOL = 2

/** Max memory-write followthrough iterations */
const MAX_MEMORY_WRITE_FOLLOWTHROUGH = 2

/** Max execution followthrough (zero for connector sessions) */
const MAX_EXECUTION_FOLLOWTHROUGH = 1

/** Max execution kickoff followthrough */
const MAX_EXECUTION_KICKOFF_FOLLOWTHROUGH = 1

/** Max attachment followthrough (zero for connector sessions) */
const MAX_ATTACHMENT_FOLLOWTHROUGH = 1

/** Max deliverable followthrough (zero for connector sessions) */
const MAX_DELIVERABLE_FOLLOWTHROUGH = 2

/** Max unfinished tool followthrough */
const MAX_UNFINISHED_TOOL_FOLLOWTHROUGH = 2

/** Max tool error recovery iterations */
const MAX_TOOL_ERROR_FOLLOWTHROUGH = 2

/** Max tool summary continuations */
const MAX_TOOL_SUMMARY = 2

/** Max coordinator synthesis continuations */
const MAX_COORDINATOR_SYNTHESIS = 3

/** Max coordinator delegation nudge (once is enough — don't nag) */
const MAX_COORDINATOR_DELEGATION_NUDGE = 1

/** Max loop recovery continuations (tool_frequency limit resets) */
const MAX_LOOP_RECOVERY = 2

/** Max context overflow retries (emergency context reduction) */
const MAX_CONTEXT_OVERFLOW = 2

// ---------------------------------------------------------------------------

export class ContinuationLimits {
  private readonly limits: Record<BudgetedContinuation, LimitEntry>

  constructor(isConnectorSession: boolean) {
    let maxDeliverableFollowthroughs = MAX_DELIVERABLE_FOLLOWTHROUGH
    let maxExecutionFollowthroughs = MAX_EXECUTION_FOLLOWTHROUGH
    let maxAttachmentFollowthroughs = MAX_ATTACHMENT_FOLLOWTHROUGH
    let maxUnfinishedToolFollowthroughs = MAX_UNFINISHED_TOOL_FOLLOWTHROUGH
    let maxToolSummaryRetries = MAX_TOOL_SUMMARY

    if (isConnectorSession) {
      maxDeliverableFollowthroughs = 0
      maxExecutionFollowthroughs = 0
      maxAttachmentFollowthroughs = 0
      maxToolSummaryRetries = 1
      maxUnfinishedToolFollowthroughs = 1
    }

    this.limits = {
      recursion: { count: 0, max: MAX_RECURSION },
      transient: { count: 0, max: MAX_TRANSIENT },
      context_overflow: { count: 0, max: MAX_CONTEXT_OVERFLOW },
      required_tool: { count: 0, max: MAX_REQUIRED_TOOL },
      memory_write_followthrough: { count: 0, max: MAX_MEMORY_WRITE_FOLLOWTHROUGH },
      execution_followthrough: { count: 0, max: maxExecutionFollowthroughs },
      execution_kickoff_followthrough: { count: 0, max: MAX_EXECUTION_KICKOFF_FOLLOWTHROUGH },
      attachment_followthrough: { count: 0, max: maxAttachmentFollowthroughs },
      deliverable_followthrough: { count: 0, max: maxDeliverableFollowthroughs },
      unfinished_tool_followthrough: { count: 0, max: maxUnfinishedToolFollowthroughs },
      tool_error_followthrough: { count: 0, max: MAX_TOOL_ERROR_FOLLOWTHROUGH },
      tool_summary: { count: 0, max: maxToolSummaryRetries },
      coordinator_synthesis: { count: 0, max: MAX_COORDINATOR_SYNTHESIS },
      coordinator_delegation_nudge: { count: 0, max: MAX_COORDINATOR_DELEGATION_NUDGE },
      loop_recovery: { count: 0, max: MAX_LOOP_RECOVERY },
    }
  }

  /** Returns whether this continuation type has budget remaining. */
  canContinue(type: BudgetedContinuation): boolean {
    const entry = this.limits[type]
    return entry.count < entry.max
  }

  /** Increments the counter for a type, returns the new count. */
  increment(type: BudgetedContinuation): number {
    const entry = this.limits[type]
    entry.count++
    return entry.count
  }

  /** Access current count and max for status messages. */
  getStatus(type: BudgetedContinuation): { count: number; max: number } {
    const entry = this.limits[type]
    return { count: entry.count, max: entry.max }
  }

  /** Total max iterations (sum of all limits). */
  get maxIterations(): number {
    let total = 0
    for (const key of Object.keys(this.limits) as BudgetedContinuation[]) {
      total += this.limits[key].max
    }
    return total
  }
}
