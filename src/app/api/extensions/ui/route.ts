import { NextResponse } from 'next/server'
import { getExtensionManager } from '@/lib/server/extensions'
import '@/lib/server/builtin-extensions'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')

  const manager = getExtensionManager()
  const extensions = manager.getUIExtensions()

  if (type === 'sidebar') {
    const items = extensions.flatMap((ui) => ui.sidebarItems || [])
    return NextResponse.json(items)
  }

  if (type === 'header') {
    const widgets = extensions.flatMap((ui) => ui.headerWidgets || [])
    return NextResponse.json(widgets)
  }

  if (type === 'chat_actions') {
    const actions = extensions.flatMap((ui) => ui.chatInputActions || [])
    return NextResponse.json(actions)
  }

  if (type === 'connectors') {
    const connectors = manager.getConnectors()
    return NextResponse.json(connectors)
  }

  return NextResponse.json(extensions)
}
