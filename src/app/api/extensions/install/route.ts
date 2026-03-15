import { NextResponse } from 'next/server'
import { getExtensionManager, sanitizeExtensionFilename } from '@/lib/server/extensions'
import { errorMessage } from '@/lib/shared-utils'
import {
  inferExtensionInstallSourceFromUrl,
  inferExtensionPublisherSourceFromUrl,
  normalizeExtensionInstallSource,
  normalizeExtensionPublisherSource,
} from '@/lib/extension-sources'
import {
  buildExtensionInstallCorsHeaders,
  resolveExtensionInstallCorsOrigin,
} from '@/lib/extension-install-cors'

function json(body: Record<string, unknown>, status: number, origin: string | null) {
  return NextResponse.json(body, {
    status,
    headers: buildExtensionInstallCorsHeaders(origin),
  })
}

export async function OPTIONS(req: Request) {
  const origin = resolveExtensionInstallCorsOrigin(req.headers.get('origin'))
  if (!origin) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 })
  return new NextResponse(null, {
    status: 204,
    headers: buildExtensionInstallCorsHeaders(origin),
  })
}

export async function POST(req: Request) {
  const origin = resolveExtensionInstallCorsOrigin(req.headers.get('origin'))
  const body = await req.json()
  const url = typeof body?.url === 'string' ? body.url : ''
  const filename = typeof body?.filename === 'string' ? body.filename : ''
  const installMethod = body?.installMethod === 'marketplace' ? 'marketplace' : 'manual'
  const sourceLabel = normalizeExtensionPublisherSource(body?.sourceLabel)
    || inferExtensionPublisherSourceFromUrl(url)
    || 'manual'
  const installSource = normalizeExtensionInstallSource(body?.installSource)
    || inferExtensionInstallSourceFromUrl(url)
    || 'manual'

  if (!url || !url.startsWith('https://')) {
    return json({ error: 'URL must be a valid HTTPS URL' }, 400, origin)
  }

  try {
    const sanitizedFilename = sanitizeExtensionFilename(filename)
    const installed = await getExtensionManager().installExtensionFromUrl(url, sanitizedFilename, {
      source: installMethod,
      sourceLabel,
      installSource,
    })
    return json({ ok: true, filename: installed.filename, hash: installed.sourceHash }, 200, origin)
  } catch (err: unknown) {
    const msg = errorMessage(err)
    const isTimeout = /abort|timeout/i.test(msg)
    const status = /valid HTTPS URL|Filename|Invalid filename|HTML page|too large/i.test(msg)
      ? 400
      : isTimeout
        ? 504
        : 500
    return json(
      { error: isTimeout ? 'Download timed out — the extension URL may be unreachable' : msg },
      status,
      origin,
    )
  }
}
