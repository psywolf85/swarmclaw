import { NextResponse } from 'next/server'
import { createGatewayProfile, listOpenClawGatewayProfiles } from '@/lib/server/gateways/gateway-profile-service'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(listOpenClawGatewayProfiles())
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  return NextResponse.json(createGatewayProfile(body as Record<string, unknown>))
}
