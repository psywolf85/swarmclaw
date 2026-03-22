import type { Session } from '@/types'
import { loadSession } from '@/lib/server/sessions/session-repository'

export interface SessionLineageIds {
  parentSessionId: string | null
  rootSessionId: string | null
}

export function resolveSessionLineageIds(
  session: Pick<Session, 'id' | 'parentSessionId'> | null | undefined,
  opts?: {
    loadSessionById?: (id: string) => Session | null
    maxDepth?: number
  },
): SessionLineageIds {
  const parentSessionId = typeof session?.parentSessionId === 'string' && session.parentSessionId.trim()
    ? session.parentSessionId.trim()
    : null
  const currentSessionId = typeof session?.id === 'string' && session.id.trim()
    ? session.id.trim()
    : null

  if (!currentSessionId) {
    return {
      parentSessionId,
      rootSessionId: parentSessionId,
    }
  }

  const loadSessionById = opts?.loadSessionById || loadSession
  const maxDepth = typeof opts?.maxDepth === 'number' && opts.maxDepth > 0 ? opts.maxDepth : 25
  const seen = new Set<string>([currentSessionId])

  let rootSessionId = currentSessionId
  let cursor = parentSessionId
  let depth = 0

  while (cursor && depth < maxDepth) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    rootSessionId = cursor
    const parent = loadSessionById(cursor)
    const nextParentId = typeof parent?.parentSessionId === 'string' && parent.parentSessionId.trim()
      ? parent.parentSessionId.trim()
      : null
    if (!nextParentId) break
    cursor = nextParentId
    depth += 1
  }

  return {
    parentSessionId,
    rootSessionId,
  }
}
