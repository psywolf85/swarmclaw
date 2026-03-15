import { NextResponse } from 'next/server'
import { getExtensionManager } from '@/lib/server/extensions'
import { errorMessage } from '@/lib/shared-utils'

export async function POST(req: Request) {
  const body = await req.json()
  const filename = typeof body?.filename === 'string' ? body.filename : ''
  const packageManager = typeof body?.packageManager === 'string' ? body.packageManager : undefined

  if (!filename) {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 })
  }

  try {
    const result = await getExtensionManager().installExtensionDependencies(filename, {
      packageManager: packageManager as import('@/types').ExtensionPackageManager | undefined,
    })
    return NextResponse.json({ ok: true, dependencyInfo: result })
  } catch (err: unknown) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 })
  }
}
