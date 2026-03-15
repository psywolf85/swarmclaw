import { HumanMessage } from '@langchain/core/messages'
import { z } from 'zod'
import type { MessageToolEvent } from '@/types'
import { buildLLM } from '@/lib/server/build-llm'

const ExactOutputContractResponseSchema = z.object({
  kind: z.enum(['none', 'exact_literal']),
  confidence: z.number().min(0).max(1).optional(),
  literal: z.string().optional().nullable(),
})

export type ExactOutputContract =
  | { kind: 'none'; confidence: number }
  | { kind: 'exact_literal'; confidence: number; literal: string }

export interface ExactOutputContractClassifierInput {
  sessionId: string
  agentId?: string | null
  userMessage: string
  currentResponse?: string | null
  toolEvents?: MessageToolEvent[]
}

const EXACT_LITERAL_MARKERS = [
  'reply with exactly ',
  'respond with exactly ',
  'return exactly ',
  'output exactly ',
]

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function extractModelText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') ? part.text : '')
    .join('')
}

function extractFirstJsonObject(text: string): string | null {
  const source = normalizeText(text)
  if (!source) return null
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (start === -1) {
      if (char === '{') {
        start = index
        depth = 1
      }
      continue
    }
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }
  return null
}

export function parseExactOutputContractResponse(text: string): ExactOutputContract | null {
  const jsonText = extractFirstJsonObject(text)
  if (!jsonText) return null
  let raw: unknown = null
  try {
    raw = JSON.parse(jsonText)
  } catch {
    return null
  }
  const parsed = ExactOutputContractResponseSchema.safeParse(raw)
  if (!parsed.success) return null
  const confidence = typeof parsed.data.confidence === 'number' ? parsed.data.confidence : 0
  if (parsed.data.kind === 'none') return { kind: 'none', confidence }
  const literal = normalizeText(parsed.data.literal)
  if (!literal) return null
  return {
    kind: 'exact_literal',
    confidence,
    literal,
  }
}

function buildExactOutputContractPrompt(input: ExactOutputContractClassifierInput): string {
  const userMessage = normalizeText(input.userMessage) || '(empty)'
  const currentResponse = normalizeText(input.currentResponse) || '(none)'
  const toolCalls = Array.isArray(input.toolEvents) && input.toolEvents.length > 0
    ? input.toolEvents
      .map((event) => {
        const name = normalizeText(event?.name) || 'unknown'
        const output = normalizeText(event?.output)
        return output ? `${name}: ${output.slice(0, 120)}` : name
      })
      .join(', ')
    : '(none)'

  return [
    'Decide whether the latest user turn imposes a hard exact final-response contract.',
    'Return JSON only.',
    '',
    'Rules:',
    '- Choose "exact_literal" only when the user explicitly requires one exact literal final response, token, phrase, or single line.',
    '- The exact literal must be copied from the user turn. Do not paraphrase it.',
    '- Choose "none" for general formatting requests, summaries, bullet counts, tone requests, or cases where the final wording is not fully specified.',
    '- If the user says "reply with exactly FILE_DONE", return literal "FILE_DONE".',
    '- If the user says "reply with the exact marker only" but does not specify the literal marker in the turn, return "none".',
    '- Be conservative. If unsure, return {"kind":"none","confidence":0}.',
    '',
    'Output shape:',
    '{"kind":"none|exact_literal","confidence":0-1,"literal":"required when kind=exact_literal"}',
    '',
    `user_message: ${JSON.stringify(userMessage)}`,
    `current_response: ${JSON.stringify(currentResponse)}`,
    `tool_evidence: ${JSON.stringify(toolCalls)}`,
  ].join('\n')
}

function stripTrailingLiteralPunctuation(value: string): string {
  let out = value.trim()
  while (out.length > 0 && ['.', '!', '?', ')'].includes(out[out.length - 1])) {
    out = out.slice(0, -1).trimEnd()
  }
  return out.trim()
}

export function extractExplicitExactLiteral(userMessage: string): string | null {
  const message = String(userMessage || '')
  const lower = message.toLowerCase()

  for (const marker of EXACT_LITERAL_MARKERS) {
    const index = lower.lastIndexOf(marker)
    if (index === -1) continue
    let remainder = message.slice(index + marker.length).trim()
    if (!remainder) continue

    const opener = remainder[0]
    if (opener === '"' || opener === '\'' || opener === '`') {
      const closingIndex = remainder.indexOf(opener, 1)
      if (closingIndex > 1) {
        const quoted = remainder.slice(1, closingIndex).trim()
        if (quoted) return quoted
      }
    }

    const newlineIndex = remainder.indexOf('\n')
    if (newlineIndex !== -1) remainder = remainder.slice(0, newlineIndex)

    for (const separator of ['. ', '! ', '? ']) {
      const boundary = remainder.indexOf(separator)
      if (boundary !== -1) {
        remainder = remainder.slice(0, boundary + 1)
        break
      }
    }

    const literal = stripTrailingLiteralPunctuation(remainder)
    if (literal) return literal
  }

  return null
}

export async function classifyExactOutputContract(
  input: ExactOutputContractClassifierInput,
  options?: {
    generateText?: (prompt: string) => Promise<string>
  },
): Promise<ExactOutputContract | null> {
  const explicitLiteral = extractExplicitExactLiteral(input.userMessage)
  if (explicitLiteral) {
    return {
      kind: 'exact_literal',
      confidence: 1,
      literal: explicitLiteral,
    }
  }
  const prompt = buildExactOutputContractPrompt(input)
  const responseText = options?.generateText
    ? await options.generateText(prompt)
    : await (async () => {
      const { llm } = await buildLLM({
        sessionId: input.sessionId,
        agentId: input.agentId || null,
      })
      const response = await llm.invoke([new HumanMessage(prompt)])
      return extractModelText(response.content)
    })()
  return parseExactOutputContractResponse(responseText)
}

export function applyExactOutputContract(params: {
  contract: ExactOutputContract | null | undefined
  text: string
  errorMessage?: string | null
  toolEvents?: MessageToolEvent[] | null | undefined
}): string {
  if (!params.contract || params.contract.kind !== 'exact_literal') return params.text
  if (normalizeText(params.errorMessage)) return params.text
  if (!normalizeText(params.text)) return params.text
  if (Array.isArray(params.toolEvents) && params.toolEvents.some((event) => event?.error === true)) return params.text
  return params.contract.literal
}
