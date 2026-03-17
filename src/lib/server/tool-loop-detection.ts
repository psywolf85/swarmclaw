/**
 * Tool loop detection.
 *
 * Seven detectors run on every on_tool_end event:
 * 1. Generic repeat      — same (name, inputHash) seen N+ times
 * 2. Polling stall       — repeated poll-like calls with identical output
 * 3. Ping-pong           — two tools alternating with identical results
 * 4. Circuit breaker     — absolute cap on identical calls regardless of type
 * 5. Tool frequency      — per-tool call count cap
 * 6. Output stagnation   — sliding window of output hashes; too many identical = stalled
 * 7. Error convergence   — too many consecutive error outputs = infra failure cascade
 *
 * Each detector returns a severity: 'ok' | 'warning' | 'critical'.
 * The caller decides what to do (log, inject guidance, abort).
 */

import { createHash } from 'crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  name: string
  inputHash: string
  outputHash: string
  /** first 200 chars of input for diagnostics */
  inputPreview: string
  /** first 200 chars of output for logging */
  outputPreview: string
  timestamp: number
}

export type LoopSeverity = 'ok' | 'warning' | 'critical'

export interface LoopDetectionResult {
  severity: LoopSeverity
  detector: 'generic_repeat' | 'polling_stall' | 'ping_pong' | 'circuit_breaker' | 'tool_frequency' | 'output_stagnation' | 'error_convergence'
  message: string
  /** The tool name that triggered the detection (set by tool_frequency detector). */
  toolName?: string
}

export interface LoopDetectionThresholds {
  /** Generic repeat: warn after this many identical (name, input) calls. Default 3. */
  repeatWarn: number
  /** Generic repeat: critical after this many. Default 6. */
  repeatCritical: number
  /** Polling stall: warn after N poll-like calls with identical output. Default 4. */
  pollWarn: number
  /** Polling stall: critical after this many. Default 8. */
  pollCritical: number
  /** Ping-pong: how many alternating-pair cycles trigger warning. Default 3. */
  pingPongWarn: number
  /** Ping-pong: critical after this many cycles. Default 5. */
  pingPongCritical: number
  /** Circuit breaker: absolute cap on any identical call. Default 20. */
  circuitBreaker: number
  /** Per-tool frequency: warn after this many calls to the same tool (any input). Default 15. */
  toolFrequencyWarn: number
  /** Per-tool frequency: critical after this many calls to the same tool (any input). Default 30. */
  toolFrequencyCritical: number
}

// Thresholds tuned down from 6/12 to 3/6 to catch loops earlier — agents rarely
// need more than 3 identical calls before recognizing the approach isn't working.
const DEFAULT_THRESHOLDS: LoopDetectionThresholds = {
  repeatWarn: 3,
  repeatCritical: 6,
  pollWarn: 4,
  pollCritical: 8,
  pingPongWarn: 3,
  pingPongCritical: 5,
  circuitBreaker: 20,
  toolFrequencyWarn: 15,
  toolFrequencyCritical: 30,
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

function quickHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

export function hashToolInput(input: unknown): string {
  const str = typeof input === 'string' ? input : JSON.stringify(input ?? '')
  return quickHash(str)
}

export function hashToolOutput(output: unknown): string {
  const str = typeof output === 'string' ? output : JSON.stringify(output ?? '')
  return quickHash(str)
}

// ---------------------------------------------------------------------------
// Error output detection (shared with error_convergence detector)
// ---------------------------------------------------------------------------

function looksLikeToolErrorOutput(output: string): boolean {
  const trimmed = String(output || '').trim()
  if (!trimmed) return false
  if (/^(Error(?::|\s*\(exit\b[^)]*\):?)|error:)/i.test(trimmed)) return true
  if (/\b(MCP error|ECONNREFUSED|ETIMEDOUT|ERR_CONNECTION_REFUSED|ENOENT|EACCES|AbortError)\b/i.test(trimmed)) return true
  if (/\b(timeout|timed?\s*out|aborted|target closed|execution context was destroyed|temporarily unavailable)\b/i.test(trimmed)) return true
  return false
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export class ToolLoopTracker {
  private history: ToolCallRecord[] = []
  private thresholds: LoopDetectionThresholds
  /** Per-tool-name call count for O(1) checkToolFrequency */
  private nameCount: Map<string, number> = new Map()
  /** Per name:inputHash call count for O(1) checkCircuitBreaker and checkGenericRepeat */
  private keyCount: Map<string, number> = new Map()

  constructor(thresholds?: Partial<LoopDetectionThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds }
  }

  /** Record a completed tool call and run all detectors. */
  record(name: string, input: unknown, output: unknown): LoopDetectionResult | null {
    const inputHash = hashToolInput(input)
    const inputStr = typeof input === 'string' ? input : JSON.stringify(input ?? '')
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output ?? '')
    const outputHash = hashToolOutput(output)
    const record: ToolCallRecord = {
      name,
      inputHash,
      outputHash,
      inputPreview: inputStr.slice(0, 200),
      outputPreview: outputStr.slice(0, 200),
      timestamp: Date.now(),
    }
    this.history.push(record)

    // Increment counter maps
    this.nameCount.set(name, (this.nameCount.get(name) || 0) + 1)
    const key = `${name}:${inputHash}`
    this.keyCount.set(key, (this.keyCount.get(key) || 0) + 1)

    // Run detectors in severity order (most severe first)
    return this.checkCircuitBreaker(record)
      ?? this.checkToolFrequency(record)
      ?? this.checkGenericRepeat(record)
      ?? this.checkPollingStall(record)
      ?? this.checkPingPong()
      ?? this.checkOutputStagnation()
      ?? this.checkErrorConvergence()
      ?? null
  }

  /**
   * Preview whether the next tool call should be warned or blocked before it executes.
   * Pre-call checks only use detectors that do not depend on tool output.
   */
  preview(name: string, input: unknown): LoopDetectionResult | null {
    const inputStr = typeof input === 'string' ? input : JSON.stringify(input ?? '')
    const current: ToolCallRecord = {
      name,
      inputHash: hashToolInput(input),
      outputHash: '',
      inputPreview: inputStr.slice(0, 200),
      outputPreview: '',
      timestamp: Date.now(),
    }
    return this.checkCircuitBreakerPreview(current)
      ?? this.checkToolFrequencyPreview(current)
      ?? this.checkGenericRepeatPreview(current)
      ?? null
  }

  /** Reset call history (used after loop_recovery continuation to give the agent a fresh budget). */
  reset(): void {
    this.history = []
    this.nameCount.clear()
    this.keyCount.clear()
  }

  /** Get the full call history (for diagnostics). */
  getHistory(): ReadonlyArray<ToolCallRecord> {
    return this.history
  }

  /** Total recorded calls. */
  get size(): number {
    return this.history.length
  }

  // -------------------------------------------------------------------------
  // Detectors
  // -------------------------------------------------------------------------

  private checkToolFrequency(current: ToolCallRecord): LoopDetectionResult | null {
    const count = this.nameCount.get(current.name) || 0
    if (count >= this.thresholds.toolFrequencyCritical) {
      return {
        severity: 'critical',
        detector: 'tool_frequency',
        toolName: current.name,
        message: `Tool "${current.name}" called ${count} times this turn. Excessive repetition — wrap up with available results.`,
      }
    }
    if (count >= this.thresholds.toolFrequencyWarn) {
      return {
        severity: 'warning',
        detector: 'tool_frequency',
        toolName: current.name,
        message: `Tool "${current.name}" called ${count} times. Consider whether more calls are needed.`,
      }
    }
    return null
  }

  private checkToolFrequencyPreview(current: ToolCallRecord): LoopDetectionResult | null {
    const count = (this.nameCount.get(current.name) || 0) + 1
    if (count >= this.thresholds.toolFrequencyCritical) {
      return {
        severity: 'critical',
        detector: 'tool_frequency',
        toolName: current.name,
        message: `Tool "${current.name}" would be called ${count} times this turn. Excessive repetition — wrap up with available results.`,
      }
    }
    if (count >= this.thresholds.toolFrequencyWarn) {
      return {
        severity: 'warning',
        detector: 'tool_frequency',
        toolName: current.name,
        message: `Tool "${current.name}" is nearing overuse (${count} calls this turn). Consider whether another call is needed.`,
      }
    }
    return null
  }

  private checkCircuitBreaker(current: ToolCallRecord): LoopDetectionResult | null {
    const key = `${current.name}:${current.inputHash}`
    const count = this.keyCount.get(key) || 0
    if (count >= this.thresholds.circuitBreaker) {
      return {
        severity: 'critical',
        detector: 'circuit_breaker',
        message: `Circuit breaker: "${current.name}" called ${count} times with identical input. Halting to prevent runaway.`,
      }
    }
    return null
  }

  private checkCircuitBreakerPreview(current: ToolCallRecord): LoopDetectionResult | null {
    const key = `${current.name}:${current.inputHash}`
    const count = (this.keyCount.get(key) || 0) + 1
    if (count >= this.thresholds.circuitBreaker) {
      return {
        severity: 'critical',
        detector: 'circuit_breaker',
        message: `Circuit breaker: "${current.name}" would be called ${count} times with identical input. Halting before another runaway call.`,
      }
    }
    return null
  }

  private checkGenericRepeat(current: ToolCallRecord): LoopDetectionResult | null {
    const key = `${current.name}:${current.inputHash}`
    const count = this.keyCount.get(key) || 0
    const inputHint = current.inputPreview ? ` Input: "${current.inputPreview.slice(0, 80)}"` : ''
    if (count >= this.thresholds.repeatCritical) {
      return {
        severity: 'critical',
        detector: 'generic_repeat',
        message: `You called "${current.name}" ${count} times with identical input.${inputHint} — State your blocker or deliver what you have.`,
      }
    }
    if (count >= this.thresholds.repeatWarn) {
      return {
        severity: 'warning',
        detector: 'generic_repeat',
        message: `You called "${current.name}" ${count} times with identical input.${inputHint} — Try a fundamentally different approach or deliver partial results.`,
      }
    }
    return null
  }

  private checkGenericRepeatPreview(current: ToolCallRecord): LoopDetectionResult | null {
    const key = `${current.name}:${current.inputHash}`
    const count = (this.keyCount.get(key) || 0) + 1
    const inputHint = current.inputPreview ? ` Input: "${current.inputPreview.slice(0, 80)}"` : ''
    if (count >= this.thresholds.repeatCritical) {
      return {
        severity: 'critical',
        detector: 'generic_repeat',
        message: `"${current.name}" would repeat the same input ${count} times.${inputHint} — State your blocker or deliver what you have.`,
      }
    }
    if (count >= this.thresholds.repeatWarn) {
      return {
        severity: 'warning',
        detector: 'generic_repeat',
        message: `"${current.name}" is about to repeat the same input ${count} times.${inputHint} — Try a different approach.`,
      }
    }
    return null
  }

  private checkPollingStall(current: ToolCallRecord): LoopDetectionResult | null {
    // Look for recent sequential calls to the same tool with identical output
    const recent = this.history.slice(-this.thresholds.pollCritical)
    const pollRuns = recent.filter(
      (r) => r.name === current.name && r.outputHash === current.outputHash,
    )
    if (pollRuns.length >= this.thresholds.pollCritical) {
      return {
        severity: 'critical',
        detector: 'polling_stall',
        message: `Polling stall: "${current.name}" returned identical output ${pollRuns.length} times consecutively. The polled resource is not changing.`,
      }
    }
    if (pollRuns.length >= this.thresholds.pollWarn) {
      return {
        severity: 'warning',
        detector: 'polling_stall',
        message: `Polling stall: "${current.name}" returned identical output ${pollRuns.length} times. The state may not be progressing.`,
      }
    }
    return null
  }

  private checkPingPong(): LoopDetectionResult | null {
    const len = this.history.length
    if (len < 4) return null

    // Check if the last N calls form an A-B-A-B pattern with identical results
    const last = this.history[len - 1]
    const prev = this.history[len - 2]
    if (last.name === prev.name) return null // same tool — not ping-pong

    let cycles = 0
    for (let i = len - 2; i >= 1; i -= 2) {
      const a = this.history[i]
      const b = this.history[i - 1]
      if (
        a.name === last.name && a.outputHash === last.outputHash
        && b.name === prev.name && b.outputHash === prev.outputHash
      ) {
        cycles++
      } else {
        break
      }
    }

    if (cycles >= this.thresholds.pingPongCritical) {
      return {
        severity: 'critical',
        detector: 'ping_pong',
        message: `Ping-pong: "${prev.name}" and "${last.name}" are alternating with identical results (${cycles} cycles). Breaking the loop.`,
      }
    }
    if (cycles >= this.thresholds.pingPongWarn) {
      return {
        severity: 'warning',
        detector: 'ping_pong',
        message: `Ping-pong: "${prev.name}" and "${last.name}" may be stuck in an alternating loop (${cycles} cycles).`,
      }
    }
    return null
  }

  /**
   * Output stagnation — sliding window of output hashes.
   * Catches agents calling different tools/inputs that all return the same result.
   */
  private checkOutputStagnation(): LoopDetectionResult | null {
    const windowSize = 8
    if (this.history.length < windowSize) return null
    const recent = this.history.slice(-windowSize)
    const outputCounts = new Map<string, number>()
    for (const r of recent) {
      if (!r.outputHash) continue
      outputCounts.set(r.outputHash, (outputCounts.get(r.outputHash) || 0) + 1)
    }
    let maxCount = 0
    for (const count of outputCounts.values()) {
      if (count > maxCount) maxCount = count
    }
    if (maxCount >= windowSize) {
      return {
        severity: 'critical',
        detector: 'output_stagnation',
        message: `Output stagnation: last ${windowSize} tool calls all produced identical output. The approach is not working — try something fundamentally different or report the blocker.`,
      }
    }
    if (maxCount >= 6) {
      return {
        severity: 'warning',
        detector: 'output_stagnation',
        message: `Output stagnation: ${maxCount} of the last ${windowSize} tool calls produced identical output. Your tools may not be making progress.`,
      }
    }
    return null
  }

  /**
   * Error convergence — detects cascading error patterns.
   * If most recent tool outputs are errors, the agent is likely hitting an infra issue.
   */
  private checkErrorConvergence(): LoopDetectionResult | null {
    const windowSize = 6
    if (this.history.length < windowSize) return null
    const recent = this.history.slice(-windowSize)
    let errorCount = 0
    for (const r of recent) {
      if (looksLikeToolErrorOutput(r.outputPreview)) errorCount++
    }
    if (errorCount >= 5) {
      return {
        severity: 'critical',
        detector: 'error_convergence',
        message: `Error convergence: ${errorCount} of the last ${windowSize} tool calls returned errors. Stop retrying and report the underlying issue (likely an infrastructure or configuration problem).`,
      }
    }
    if (errorCount >= 4) {
      return {
        severity: 'warning',
        detector: 'error_convergence',
        message: `Error convergence: ${errorCount} of the last ${windowSize} tool calls returned errors. You may be hitting a systemic issue — consider a different approach or report the blocker.`,
      }
    }
    return null
  }
}
