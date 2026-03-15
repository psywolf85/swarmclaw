import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import {
  listProtocolRunEventsForRun,
  loadProtocolRunById,
} from '@/lib/server/protocols/protocol-service'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const run = loadProtocolRunById(id)
  if (!run) return notFound()
  const { searchParams } = new URL(req.url)
  const limitParam = searchParams.get('limit')
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined
  return NextResponse.json(listProtocolRunEventsForRun(id, Number.isFinite(limit) ? limit : undefined))
}
