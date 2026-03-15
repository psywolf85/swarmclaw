import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { getProtocolRunDetail } from '@/lib/server/protocols/protocol-service'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const detail = getProtocolRunDetail(id)
  if (!detail) return notFound()
  return NextResponse.json(detail)
}
