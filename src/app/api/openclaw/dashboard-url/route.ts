import { NextResponse } from 'next/server'
import { getAgent } from '@/lib/server/agents/agent-repository'
import { getGatewayProfile } from '@/lib/server/agents/agent-runtime-config'
import { resolveCredentialSecret } from '@/lib/server/credentials/credential-service'

/** GET ?agentId=X — resolve the tokenized dashboard URL for an OpenClaw agent's gateway */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const agentId = searchParams.get('agentId')
  if (!agentId) {
    return NextResponse.json({ error: 'Missing agentId' }, { status: 400 })
  }

  const agent = getAgent(agentId)
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }
  if (agent.provider !== 'openclaw') {
    return NextResponse.json({ error: 'Not an OpenClaw agent' }, { status: 400 })
  }

  // Resolve the gateway endpoint
  let endpoint = agent.apiEndpoint || ''
  let credentialId = agent.credentialId || null

  // If agent has a gatewayProfileId, prefer its endpoint and credential
  if (agent.gatewayProfileId) {
    const gw = getGatewayProfile(agent.gatewayProfileId)
    if (gw) {
      endpoint = gw.endpoint || endpoint
      credentialId = gw.credentialId || credentialId
    }
  }

  if (!endpoint) endpoint = 'http://localhost:18789'

  // Build the base dashboard URL (strip path, use http)
  let dashboardUrl: string
  try {
    const parsed = new URL(/^(https?|wss?):\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`)
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
    parsed.pathname = ''
    parsed.search = ''
    parsed.hash = ''
    dashboardUrl = parsed.toString().replace(/\/+$/, '')
  } catch {
    dashboardUrl = 'http://localhost:18789'
  }

  // Decrypt the token if we have a credential
  if (credentialId) {
    const token = resolveCredentialSecret(credentialId)
    if (token) {
      dashboardUrl = `${dashboardUrl}?token=${encodeURIComponent(token)}`
    }
  }

  return NextResponse.json({ url: dashboardUrl })
}
