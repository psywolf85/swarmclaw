import type { AppSettings, Message, MessageToolEvent } from '@/types'

const INJECTION_PATTERNS: Array<{ code: string; re: RegExp; note: string }> = [
  { code: 'ignore_instructions', re: /\bignore (?:all |any |the )?(?:previous|prior|above|system|developer) instructions\b/i, note: 'tries to override existing instructions' },
  { code: 'reveal_prompt', re: /\b(?:reveal|show|print|dump)\b[\s\S]{0,40}\b(?:system prompt|developer prompt|hidden prompt)\b/i, note: 'asks for hidden prompt data' },
  { code: 'credential_theft', re: /\b(?:api key|token|password|secret|credential)s?\b[\s\S]{0,40}\b(?:send|share|reveal|print|dump|exfiltrat)/i, note: 'asks for secrets or credentials' },
  { code: 'tool_override', re: /\b(?:call|use|run)\b[\s\S]{0,40}\b(?:shell|terminal|browser|http_request|web_fetch|connector_message_tool)\b[\s\S]{0,40}\b(?:without|ignore)\b/i, note: 'tries to direct tool use by bypassing policy' },
  { code: 'workflow_override', re: /\b(?:act as|pretend to be)\b[\s\S]{0,40}\b(?:system|developer|administrator|operator)\b/i, note: 'tries to impersonate a higher-priority role' },
]

const WEB_TOOL_NAMES = new Set(['browser', 'web_search', 'web_fetch', 'http_request'])

function normalizeMode(value: unknown): 'off' | 'warn' | 'block' {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (normalized === 'off' || normalized === 'block') return normalized
  return 'warn'
}

function summarizeFindings(findings: string[]): string {
  return findings.slice(0, 2).join('; ')
}

export function getUntrustedContentGuardMode(settings?: Partial<AppSettings> | null): 'off' | 'warn' | 'block' {
  return normalizeMode(settings?.untrustedContentGuardMode)
}

export function inspectUntrustedText(text: string): { suspicious: boolean; findings: string[] } {
  const findings = INJECTION_PATTERNS
    .filter((pattern) => pattern.re.test(text))
    .map((pattern) => `${pattern.code}: ${pattern.note}`)
  return {
    suspicious: findings.length > 0,
    findings,
  }
}

export function guardUntrustedText(params: {
  text: string
  source: string
  mode?: 'off' | 'warn' | 'block'
  trusted?: boolean
}): { text: string; blocked: boolean; findings: string[] } {
  const text = String(params.text || '')
  const mode = params.mode || 'warn'
  if (!text.trim() || params.trusted || mode === 'off') {
    return { text, blocked: false, findings: [] }
  }

  const inspection = inspectUntrustedText(text)
  if (!inspection.suspicious) {
    return { text, blocked: false, findings: [] }
  }

  const summary = summarizeFindings(inspection.findings)
  if (mode === 'block') {
    return {
      text: `[Blocked untrusted ${params.source} content]\n${summary}`,
      blocked: true,
      findings: inspection.findings,
    }
  }

  return {
    text: `[Untrusted ${params.source} content warning: ${summary}]\n${text}`,
    blocked: false,
    findings: inspection.findings,
  }
}

export function guardUntrustedToolEvents(params: {
  toolEvents: MessageToolEvent[]
  mode?: 'off' | 'warn' | 'block'
}): MessageToolEvent[] {
  const mode = params.mode || 'warn'
  if (mode === 'off' || !params.toolEvents.length) return params.toolEvents

  return params.toolEvents.map((event) => {
    if (!WEB_TOOL_NAMES.has((event.name || '').trim().toLowerCase())) return event
    const guarded = guardUntrustedText({
      text: typeof event.output === 'string' ? event.output : '',
      source: `tool result from ${event.name}`,
      mode,
      trusted: false,
    })
    if (!guarded.findings.length) return event
    return {
      ...event,
      output: guarded.text,
      error: guarded.blocked ? true : event.error,
    }
  })
}

export function guardUntrustedMessage(params: {
  message: Message
  mode?: 'off' | 'warn' | 'block'
  trusted?: boolean
  source: string
}): Message {
  const guardedText = guardUntrustedText({
    text: params.message.text,
    source: params.source,
    mode: params.mode,
    trusted: params.trusted,
  })
  return {
    ...params.message,
    text: guardedText.text,
    toolEvents: Array.isArray(params.message.toolEvents)
      ? guardUntrustedToolEvents({ toolEvents: params.message.toolEvents, mode: params.mode })
      : params.message.toolEvents,
  }
}
