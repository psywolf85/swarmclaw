import { NextResponse } from 'next/server'
import { restoreGuardianCheckpoint } from '@/lib/server/agents/guardian'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : ''
  if (!approvalId) {
    return NextResponse.json({ error: 'approvalId is required' }, { status: 400 })
  }

  const result = restoreGuardianCheckpoint(approvalId)
  if (!result.ok) {
    return NextResponse.json({ error: result.reason || 'Restore failed' }, { status: 400 })
  }
  return NextResponse.json({ ok: true, checkpoint: result.checkpoint })
}
