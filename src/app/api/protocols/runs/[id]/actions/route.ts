import { NextResponse } from 'next/server'
import { z } from 'zod'
import { notFound } from '@/lib/server/collection-helpers'
import { formatZodError, ProtocolRunActionSchema } from '@/lib/validation/schemas'
import {
  loadProtocolRunById,
  performProtocolRunAction,
} from '@/lib/server/protocols/protocol-service'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const run = loadProtocolRunById(id)
  if (!run) return notFound()

  const raw = await req.json().catch(() => ({}))
  const parsed = ProtocolRunActionSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }

  const updated = performProtocolRunAction(id, parsed.data)
  if (!updated) {
    return NextResponse.json({ error: 'Unable to update structured session.' }, { status: 409 })
  }
  return NextResponse.json({ ok: true, run: updated })
}
