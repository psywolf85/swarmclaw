import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
}

let tempDir = ''
let storage: typeof import('@/lib/server/storage')
let approvals: typeof import('@/lib/server/approvals')
let estop: typeof import('@/lib/server/runtime/estop')

function resetEstopState() {
  estop.saveEstopState({
    level: 'none',
    reason: null,
    engagedAt: null,
    engagedBy: null,
    resumeApprovalId: null,
    updatedAt: Date.now(),
  })
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-estop-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')

  storage = await import('@/lib/server/storage')
  approvals = await import('@/lib/server/approvals')
  estop = await import('@/lib/server/runtime/estop')
})

beforeEach(() => {
  storage.saveSettings({})
  for (const id of Object.keys(storage.loadApprovals())) {
    storage.deleteApproval(id)
  }
  resetEstopState()
})

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('estop resume approvals', () => {
  it('defaults to direct resume when no setting is persisted', () => {
    estop.engageEstop({ level: 'autonomy', engagedBy: 'test' })

    assert.equal(estop.areEstopResumeApprovalsEnabled(), false)

    const resumed = estop.resumeEstop({ bypassApproval: true })
    assert.equal(resumed.level, 'none')
    assert.equal(resumed.resumeApprovalId, null)
  })

  it('requires an approved human-loop decision when the policy is enabled', async () => {
    storage.saveSettings({ autonomyResumeApprovalsEnabled: true })
    estop.engageEstop({ level: 'all', engagedBy: 'test' })

    assert.equal(estop.areEstopResumeApprovalsEnabled(), true)

    const request = estop.requestEstopResumeApproval({ requester: 'test' })
    assert.ok(request.approval)
    assert.equal(request.state.resumeApprovalId, request.approval?.id)

    assert.throws(() => estop.resumeEstop({ approvalId: request.approval?.id }), /not approved yet/i)

    await approvals.submitDecision(request.approval!.id, true)
    const resumed = estop.resumeEstop({ approvalId: request.approval!.id })

    assert.equal(resumed.level, 'none')
    assert.equal(resumed.resumeApprovalId, request.approval!.id)
  })

  it('retires pending estop approvals when the operator bypasses them', () => {
    storage.saveSettings({ autonomyResumeApprovalsEnabled: true })
    const engaged = estop.engageEstop({ level: 'autonomy', engagedBy: 'test' })
    const request = estop.requestEstopResumeApproval({ requester: 'test' })

    assert.equal(engaged.level, 'autonomy')
    assert.equal(request.approval?.status, 'pending')

    const resumed = estop.resumeEstop({ bypassApproval: true })
    const clearedApproval = estop.findEstopResumeApproval(request.approval!.id)

    assert.equal(resumed.level, 'none')
    assert.equal(clearedApproval?.status, 'rejected')
  })
})
