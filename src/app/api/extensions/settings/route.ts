import { NextResponse } from 'next/server'
import { getExtensionManager } from '@/lib/server/extensions'
import '@/lib/server/builtin-extensions'
import { errorMessage } from '@/lib/shared-utils'

export const dynamic = 'force-dynamic'

function resolveExtension(extensionId: string) {
  const ext = getExtensionManager().listExtensions().find((entry) => entry.filename === extensionId)
  if (!ext) return null
  return ext
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const extensionId = searchParams.get('extensionId')
  if (!extensionId) {
    return NextResponse.json({ error: 'extensionId required' }, { status: 400 })
  }
  if (!resolveExtension(extensionId)) {
    return NextResponse.json({ error: 'Extension not found' }, { status: 400 })
  }

  return NextResponse.json(getExtensionManager().getPublicExtensionSettings(extensionId))
}

export async function PUT(req: Request) {
  const { searchParams } = new URL(req.url)
  const extensionId = searchParams.get('extensionId')
  if (!extensionId) {
    return NextResponse.json({ error: 'extensionId required' }, { status: 400 })
  }
  if (!resolveExtension(extensionId)) {
    return NextResponse.json({ error: 'Extension not found' }, { status: 400 })
  }

  try {
    const body = await req.json() as Record<string, unknown>
    const saved = getExtensionManager().setExtensionSettings(extensionId, body)
    return NextResponse.json({
      ok: true,
      values: saved,
      configuredSecretFields: getExtensionManager().getPublicExtensionSettings(extensionId).configuredSecretFields,
    })
  } catch (err: unknown) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 })
  }
}
