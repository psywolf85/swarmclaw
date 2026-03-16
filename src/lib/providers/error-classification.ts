import { errorMessage } from '@/lib/shared-utils'

export type FailoverReason =
  | 'rate_limit'       // 429
  | 'billing'          // 402
  | 'auth'             // 401 (retriable — rotate credential)
  | 'auth_permanent'   // 403 (not retriable)
  | 'overloaded'       // 500/502/503
  | 'timeout'          // ETIMEDOUT, ECONNRESET, socket hang up
  | 'model_not_found'  // 404 + "model" in message
  | 'format'           // 400 Bad Request
  | 'unknown'

export interface ClassifiedError {
  reason: FailoverReason
  retryable: boolean
  shouldRotateCredential: boolean
  suggestedBackoffMs: number
}

export function classifyProviderError(err: unknown): ClassifiedError {
  const msg = errorMessage(err).toLowerCase()
  const status = extractStatus(err)

  if (status === 402 || msg.includes('billing') || msg.includes('payment'))
    return { reason: 'billing', retryable: false, shouldRotateCredential: true, suggestedBackoffMs: 0 }

  if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests'))
    return { reason: 'rate_limit', retryable: true, shouldRotateCredential: true, suggestedBackoffMs: extractRetryAfterMs(err) || 2000 }

  if (status === 401 || msg.includes('unauthorized') || msg.includes('invalid api key'))
    return { reason: 'auth', retryable: true, shouldRotateCredential: true, suggestedBackoffMs: 0 }

  if (status === 403 || msg.includes('forbidden'))
    return { reason: 'auth_permanent', retryable: false, shouldRotateCredential: false, suggestedBackoffMs: 0 }

  if (status === 404 && (msg.includes('model') || msg.includes('not found')))
    return { reason: 'model_not_found', retryable: false, shouldRotateCredential: false, suggestedBackoffMs: 0 }

  if (status === 400)
    return { reason: 'format', retryable: false, shouldRotateCredential: false, suggestedBackoffMs: 0 }

  if (status && status >= 500 && status < 600)
    return { reason: 'overloaded', retryable: true, shouldRotateCredential: true, suggestedBackoffMs: 1000 }

  if (/timeout|etimedout|econnreset|econnrefused|socket hang up|network/i.test(msg))
    return { reason: 'timeout', retryable: true, shouldRotateCredential: false, suggestedBackoffMs: 1000 }

  return { reason: 'unknown', retryable: true, shouldRotateCredential: true, suggestedBackoffMs: 500 }
}

function extractStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const e = err as Record<string, unknown>
  const s = e.status ?? e.statusCode ?? (e.response as Record<string, unknown> | undefined)?.status
  return typeof s === 'number' ? s : null
}

function extractRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const e = err as Record<string, unknown>
  const headers = (e.headers ?? (e.response as Record<string, unknown> | undefined)?.headers) as Record<string, unknown> | undefined
  if (!headers) return null
  const ra = headers['retry-after']
  if (typeof ra === 'string') {
    const secs = Number(ra)
    if (Number.isFinite(secs) && secs > 0 && secs < 120) return secs * 1000
  }
  return null
}
