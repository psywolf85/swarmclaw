import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import {
  deleteGatewayProfileAndDetachAgents,
  updateGatewayProfile,
} from '@/lib/server/gateways/gateway-profile-service'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const result = updateGatewayProfile(id, body as Record<string, unknown>)
  if (!result) return notFound()
  return NextResponse.json(result)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!deleteGatewayProfileAndDetachAgents(id)) return notFound()
  return NextResponse.json({ ok: true })
}
