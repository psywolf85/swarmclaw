import { NextResponse } from 'next/server'
import { probeOpenClawHealth, persistGatewayHealthResult } from '@/lib/server/openclaw/health'
import { loadGatewayProfile } from '@/lib/server/gateways/gateway-profile-repository'
import { notFound } from '@/lib/server/collection-helpers'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const gateway = loadGatewayProfile(id)
  if (!gateway) return notFound()

  const result = await probeOpenClawHealth({
    endpoint: gateway.endpoint,
    credentialId: gateway.credentialId || null,
  })

  persistGatewayHealthResult(id, result)

  return NextResponse.json(result)
}
