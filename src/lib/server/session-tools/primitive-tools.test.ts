import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { Session } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let workspaceDir = ''
let buildMailboxTools: typeof import('./mailbox').buildMailboxTools
let buildHumanLoopTools: typeof import('./human-loop').buildHumanLoopTools
let coerceSubagentActionArgs: typeof import('./subagent').coerceSubagentActionArgs
let watchJobs: typeof import('@/lib/server/runtime/watch-jobs')
let storage: typeof import('../storage')

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: 'session_1',
    name: 'Test Session',
    cwd: workspaceDir,
    user: 'tester',
    provider: 'ollama',
    model: 'qwen3.5',
    apiEndpoint: 'http://localhost:11434',
    claudeSessionId: null,
    messages: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    extensions: [],
    ...overrides,
  }
}

function makeBuildContext(overrides?: {
  cwd?: string
  session?: Session
}) {
  const session = overrides?.session || makeSession()
  return {
    cwd: overrides?.cwd || workspaceDir,
    ctx: {
      sessionId: session.id,
      agentId: session.agentId || 'agent_1',
    },
    hasExtension: () => true,
    hasTool: () => true,
    cleanupFns: [],
    commandTimeoutMs: 5000,
    claudeTimeoutMs: 5000,
    cliProcessTimeoutMs: 5000,
    persistDelegateResumeId: () => {},
    readStoredDelegateResumeId: () => null,
    resolveCurrentSession: () => session,
    activeExtensions: [],
  }
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-primitive-tools-'))
  workspaceDir = path.join(tempDir, 'workspace')
  fs.mkdirSync(workspaceDir, { recursive: true })
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.SWARMCLAW_BUILD_MODE = '1'
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })

  ;({ buildMailboxTools } = await import('./mailbox'))
  ;({ buildHumanLoopTools } = await import('./human-loop'))
  ;({ coerceSubagentActionArgs } = await import('./subagent'))
  watchJobs = await import('@/lib/server/runtime/watch-jobs')
  storage = await import('../storage')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('primitive tools', () => {
  it('human-loop tool creates durable mailbox waits', async () => {
    const [humanTool] = buildHumanLoopTools(makeBuildContext())
    const sessions = storage.loadSessions()
    sessions.session_1 = makeSession({ id: 'session_1', agentId: 'agent_1' })
    storage.saveSessions(sessions)

    const requestInput = JSON.parse(String(await humanTool.invoke({
      action: 'request_input',
      question: 'Ship it?',
      correlationId: 'corr_123',
    })))
    assert.equal(requestInput.ok, true)
    assert.equal(requestInput.nextAction?.action, 'wait_for_reply')
    assert.equal(requestInput.nextAction?.correlationId, 'corr_123')
    assert.match(String(requestInput.nextAction?.guidance || ''), /Do not request the same pending input again/i)
    const duplicateRequestInput = JSON.parse(String(await humanTool.invoke({
      action: 'request_input',
      question: '  ship it? ',
      correlationId: 'corr_456',
    })))
    assert.equal(duplicateRequestInput.envelope.id, requestInput.envelope.id)
    assert.equal(duplicateRequestInput.correlationId, requestInput.correlationId)

    const replyWatch = JSON.parse(String(await humanTool.invoke({
      action: 'wait_for_reply',
      correlationId: 'corr_123',
    })))
    assert.equal(watchJobs.getWatchJob(replyWatch.id)?.status, 'active')
    const duplicateReplyWatch = JSON.parse(String(await humanTool.invoke({
      action: 'wait_for_reply',
      correlationId: 'corr_123',
    })))
    assert.equal(duplicateReplyWatch.id, replyWatch.id)
    const replyEnvelope = {
      id: 'env_reply_1',
      type: 'human_reply',
      payload: 'yes',
      fromSessionId: null,
      fromAgentId: null,
      toSessionId: 'session_1',
      toAgentId: null,
      correlationId: 'corr_123',
      status: 'new' as const,
      createdAt: Date.now(),
      expiresAt: null,
      ackAt: null,
    }
    const sessionsAfterReply = storage.loadSessions()
    sessionsAfterReply.session_1.mailbox = [...(sessionsAfterReply.session_1.mailbox || []), replyEnvelope]
    storage.saveSessions(sessionsAfterReply)
    assert.equal(replyEnvelope.correlationId, 'corr_123')

    const ackedReply = JSON.parse(String(await humanTool.invoke({
      action: 'ack_mailbox',
    })))
    assert.equal(ackedReply.id, replyEnvelope.id)
    assert.equal(ackedReply.status, 'ack')

    const followupWatch = JSON.parse(String(await humanTool.invoke({
      action: 'wait_for_reply',
      correlationId: 'corr_followup',
    })))
    assert.equal(watchJobs.getWatchJob(followupWatch.id)?.status, 'active')
    const followupReply = {
      id: 'env_reply_2',
      type: 'human_reply',
      payload: JSON.stringify({ approved: true }),
      fromSessionId: null,
      fromAgentId: null,
      toSessionId: 'session_1',
      toAgentId: null,
      correlationId: 'corr_followup',
      status: 'new' as const,
      createdAt: Date.now(),
      expiresAt: null,
      ackAt: null,
    }
    const sessionsAfterFollowup = storage.loadSessions()
    sessionsAfterFollowup.session_1.mailbox = [...(sessionsAfterFollowup.session_1.mailbox || []), followupReply]
    storage.saveSessions(sessionsAfterFollowup)
    assert.equal(followupReply.correlationId, 'corr_followup')
  })

  it('mailbox tool reports configuration status without requiring network', async () => {
    const [mailboxTool] = buildMailboxTools(makeBuildContext())
    const status = JSON.parse(String(await mailboxTool.invoke({ action: 'status' })))
    assert.equal(status.configured, false)
    assert.equal(status.folder, 'INBOX')
  })

  it('coerces wrapped subagent swarm arguments into typed arrays and booleans', () => {
    const args = coerceSubagentActionArgs({
      input: JSON.stringify({
        action: 'swarm',
        waitForCompletion: 'false',
        tasks: JSON.stringify([
          { agentId: 'agent_a', message: 'First task' },
          { agentId: 'agent_b', message: 'Second task' },
        ]),
      }),
    })

    assert.equal(args.action, 'swarm')
    assert.equal(args.waitForCompletion, false)
    assert.ok(Array.isArray(args.tasks))
    assert.equal((args.tasks as Array<unknown>).length, 2)
  })
})
