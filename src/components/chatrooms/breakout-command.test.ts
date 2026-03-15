import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChatroomMessage } from '@/types'
import {
  BREAKOUT_COMMAND,
  buildBreakoutKickoffContext,
  buildBreakoutLaunchContext,
  buildBreakoutTitle,
  completeBreakoutCommand,
  parseBreakoutCommand,
} from './breakout-command'

function message(overrides: Partial<ChatroomMessage>): ChatroomMessage {
  return {
    id: overrides.id || 'msg-1',
    senderId: overrides.senderId || 'user',
    senderName: overrides.senderName || 'Wayde',
    role: overrides.role || 'user',
    text: overrides.text || '',
    mentions: overrides.mentions || [],
    reactions: overrides.reactions || [],
    time: overrides.time || 1,
    attachedFiles: overrides.attachedFiles,
    imagePath: overrides.imagePath,
    replyToId: overrides.replyToId,
    source: overrides.source,
    historyExcluded: overrides.historyExcluded,
  }
}

test('parseBreakoutCommand recognizes candidate and command states', () => {
  assert.deepEqual(parseBreakoutCommand('hello room'), { kind: 'none', query: '', topic: '' })
  assert.deepEqual(parseBreakoutCommand('/bre'), { kind: 'candidate', query: 'bre', topic: '' })
  assert.deepEqual(parseBreakoutCommand('/breakout   release review  '), {
    kind: 'command',
    query: 'breakout',
    topic: 'release review',
  })
})

test('completeBreakoutCommand fills the breakout command shell', () => {
  assert.equal(completeBreakoutCommand('/br'), `${BREAKOUT_COMMAND} `)
  assert.equal(completeBreakoutCommand('/breakout notes'), `${BREAKOUT_COMMAND} notes`)
})

test('buildBreakoutKickoffContext keeps recent visible messages and excludes system noise', () => {
  const kickoff = buildBreakoutKickoffContext([
    message({ id: 'sys', senderId: 'system', senderName: 'System', text: 'Wayde joined the room' }),
    message({ id: '1', senderName: 'Wayde', text: 'Need a focused plan for the next release.' }),
    message({ id: '2', senderId: 'agent-1', senderName: 'Hal', text: 'I can draft the rollout checklist.' }),
    message({ id: '3', senderId: 'agent-2', senderName: 'QA', text: '', attachedFiles: ['uploads/report.txt'] }),
    message({ id: '4', senderName: 'Wayde', text: 'Ignore this old context', historyExcluded: true }),
  ])

  assert.equal(
    kickoff,
    'Recent room context:\nWayde: Need a focused plan for the next release.\n\nHal: I can draft the rollout checklist.\n\nQA: [shared attachment]',
  )
})

test('buildBreakoutLaunchContext pre-fills a chatroom breakout run', () => {
  const context = buildBreakoutLaunchContext(
    {
      id: 'room-1',
      name: 'Release Room',
      agentIds: ['agent-a', 'agent-b'],
      messages: [
        message({ id: '1', senderName: 'Wayde', text: 'Let us isolate the release discussion.' }),
      ],
    },
    'release checklist',
  )

  assert.equal(context.parentChatroomId, 'room-1')
  assert.deepEqual(context.participantAgentIds, ['agent-a', 'agent-b'])
  assert.equal(context.facilitatorAgentId, 'agent-a')
  assert.equal(context.title, 'Breakout: release checklist')
  assert.equal(context.goal, 'release checklist')
  assert.match(context.kickoffMessage || '', /Recent room context:/)
  assert.equal(context.createTranscript, true)
  assert.equal(context.autoStart, true)
})

test('buildBreakoutTitle falls back to the chatroom name when no topic is provided', () => {
  assert.equal(buildBreakoutTitle('Ops Room', ''), 'Breakout: Ops Room')
})
