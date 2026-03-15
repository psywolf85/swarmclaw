import { NextResponse } from 'next/server'
import { z } from 'zod'
import { formatZodError, ProtocolRunCreateSchema } from '@/lib/validation/schemas'
import {
  createProtocolRun,
  listProtocolRuns,
  type CreateProtocolRunInput,
} from '@/lib/server/protocols/protocol-service'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status')
  const missionId = searchParams.get('missionId')
  const taskId = searchParams.get('taskId')
  const sessionId = searchParams.get('sessionId')
  const parentChatroomId = searchParams.get('parentChatroomId')
  const scheduleId = searchParams.get('scheduleId')
  const sourceKind = searchParams.get('sourceKind')
  const includeSystemOwned = searchParams.get('includeSystemOwned') === 'true'
  const limitParam = searchParams.get('limit')
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined
  return NextResponse.json(listProtocolRuns({
    ...(status ? { status: status as never } : {}),
    ...(missionId ? { missionId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(parentChatroomId ? { parentChatroomId } : {}),
    ...(scheduleId ? { scheduleId } : {}),
    ...(sourceKind ? { sourceKind: sourceKind as never } : {}),
    ...(includeSystemOwned ? { includeSystemOwned: true } : {}),
    ...(Number.isFinite(limit) ? { limit } : {}),
  }))
}

export async function POST(req: Request) {
  const raw = await req.json().catch(() => ({}))
  const parsed = ProtocolRunCreateSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }
  try {
    const run = createProtocolRun(parsed.data as CreateProtocolRunInput)
    return NextResponse.json(run)
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'Unable to create structured session.',
    }, { status: 400 })
  }
}
