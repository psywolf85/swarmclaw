/**
 * Prompt budget management — prevents unbounded system prompt growth.
 *
 * Applies end-truncation to the assembled prompt parts so that the most
 * important sections (identity, datetime, systemPrompt — added first)
 * are preserved while lower-priority sections (memory recall, suggestions)
 * are truncated first.
 */

export interface PromptBudget {
  maxTotalChars: number
  warnThresholdRatio: number
}

export const DEFAULT_PROMPT_BUDGET: PromptBudget = {
  maxTotalChars: 60_000,
  warnThresholdRatio: 0.85,
}

export const MINIMAL_PROMPT_BUDGET: PromptBudget = {
  maxTotalChars: 20_000,
  warnThresholdRatio: 0.90,
}

export interface PromptBudgetResult {
  prompt: string
  truncated: boolean
  originalChars: number
}

/**
 * Join prompt parts and enforce a character budget.
 *
 * Parts are joined with double newlines. If the total exceeds
 * `budget.maxTotalChars`, the prompt is truncated from the end
 * (preserving high-priority sections added first) with a trailing
 * `[prompt truncated]` marker.
 */
export function applyPromptBudget(
  parts: string[],
  budget: PromptBudget,
): PromptBudgetResult {
  const joined = parts.join('\n\n')
  const originalChars = joined.length

  if (originalChars <= budget.maxTotalChars) {
    return { prompt: joined, truncated: false, originalChars }
  }

  const marker = '\n\n[prompt truncated — budget exceeded]'
  const truncatedPrompt = joined.slice(0, budget.maxTotalChars - marker.length) + marker
  return { prompt: truncatedPrompt, truncated: true, originalChars }
}

/**
 * Check whether the prompt exceeds the warning threshold without truncation.
 */
export function isOverWarningThreshold(charCount: number, budget: PromptBudget): boolean {
  return charCount >= budget.maxTotalChars * budget.warnThresholdRatio
}
