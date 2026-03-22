/**
 * Prompt mode resolution for system prompt assembly.
 *
 * Determines how much of the system prompt to include based on
 * session context (interactive chat vs delegation subagent vs heartbeat).
 */
import type { Session } from '@/types'

export type PromptMode = 'full' | 'minimal' | 'none'

/**
 * Resolve the prompt mode for a session.
 *
 * - `full` — interactive chats, connector chats (current behavior)
 * - `minimal` — delegation/subagent sessions (has parentSessionId).
 *   Keeps: identity (name only), datetime, soul (truncated 300 chars),
 *   systemPrompt, tool section, core execution policy.
 *   Skips: identity continuity, project context, skills, workspace context,
 *   agent awareness, situational awareness, suggestions, tool access audit,
 *   proactive memory, thinking guidance
 * - `none` — reserved for bare identity (light heartbeat path)
 */
export function resolvePromptMode(
  session: Session,
  options?: { preferMinimalPrompt?: boolean },
): PromptMode {
  if (session.parentSessionId) return 'minimal'
  if (options?.preferMinimalPrompt) return 'minimal'
  return 'full'
}
