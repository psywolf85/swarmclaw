import { NextResponse } from 'next/server'
import { loadMcpServers } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { connectMcpServer, mcpToolsToLangChain, disconnectMcpServer } from '@/lib/server/mcp-client'
import { errorMessage } from '@/lib/shared-utils'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const servers = loadMcpServers()
  const server = servers[id]
  if (!server) return notFound()

  try {
    const { client, transport } = await connectMcpServer(server)
    const tools = await mcpToolsToLangChain(client, server.name)
    const toolNames = tools.map((t: any) => t.name)
    await disconnectMcpServer(client, transport)
    return NextResponse.json({ ok: true, tools: toolNames })
  } catch (err: unknown) {
    return NextResponse.json(
      { ok: false, error: errorMessage(err) || 'Connection failed' },
      { status: 500 }
    )
  }
}
