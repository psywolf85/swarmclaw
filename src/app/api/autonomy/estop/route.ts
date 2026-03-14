import { NextResponse } from 'next/server'
import { cancelAllRuns } from '@/lib/server/runtime/session-run-manager'
import { startDaemon, stopDaemon } from '@/lib/server/runtime/daemon-state'
import {
  areEstopResumeApprovalsEnabled,
  engageEstop,
  findEstopResumeApproval,
  loadEstopState,
  requestEstopResumeApproval,
  resumeEstop,
} from '@/lib/server/runtime/estop'

export const dynamic = 'force-dynamic'

function buildStateResponse(state = loadEstopState()) {
  const approval = state.resumeApprovalId ? findEstopResumeApproval(state.resumeApprovalId) : null
  return {
    ...state,
    resumeRequiresApproval: areEstopResumeApprovalsEnabled(),
    approval,
  }
}

export async function GET() {
  return NextResponse.json(buildStateResponse())
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : 'status'

    if (action === 'engage') {
      const level = body.level === 'autonomy' ? 'autonomy' : 'all'
      const state = engageEstop({
        level,
        reason: typeof body.reason === 'string' ? body.reason : null,
        engagedBy: typeof body.engagedBy === 'string' ? body.engagedBy : 'user',
      })
      stopDaemon({ source: `api/autonomy/estop:${level}` })
      const cancelled = level === 'all'
        ? cancelAllRuns('Cancelled because all estop is engaged.')
        : { cancelledQueued: 0, abortedRunning: 0 }
      return NextResponse.json({ ok: true, state: buildStateResponse(state), cancelled })
    }

    if (action === 'resume') {
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId : null
      const requiresApproval = areEstopResumeApprovalsEnabled()
      const state = loadEstopState()

      if (state.level === 'none') {
        return NextResponse.json({ ok: true, state: buildStateResponse(state) })
      }

      if (!requiresApproval) {
        const resumed = resumeEstop({ bypassApproval: true })
        startDaemon({ source: 'api/autonomy/estop:resume', manualStart: true })
        return NextResponse.json({ ok: true, state: buildStateResponse(resumed) })
      }

      if (!approvalId) {
        const existingApproval = state.resumeApprovalId ? findEstopResumeApproval(state.resumeApprovalId) : null
        if (existingApproval?.status === 'approved') {
          const resumed = resumeEstop({ approvalId: existingApproval.id })
          startDaemon({ source: 'api/autonomy/estop:resume', manualStart: true })
          return NextResponse.json({ ok: true, state: buildStateResponse(resumed) })
        }

        const result = requestEstopResumeApproval({
          requester: typeof body.requester === 'string' ? body.requester : 'user',
        })
        return NextResponse.json({
          ok: false,
          requiresApproval: true,
          state: buildStateResponse(result.state),
          approval: result.approval,
        }, { status: 202 })
      }

      const resumed = resumeEstop({ approvalId })
      startDaemon({ source: 'api/autonomy/estop:resume', manualStart: true })
      return NextResponse.json({ ok: true, state: buildStateResponse(resumed) })
    }

    return NextResponse.json(buildStateResponse())
  } catch (err: unknown) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'Failed to update estop state',
    }, { status: 400 })
  }
}
