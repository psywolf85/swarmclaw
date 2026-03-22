import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildQueuedTranscriptMessages,
  createOptimisticQueuedMessage,
  clearQueuedMessagesForSession,
  listQueuedMessagesForSession,
  mergeQueuedTranscriptMessages,
  removeQueuedMessageById,
  replaceQueuedMessagesForSession,
  snapshotToQueuedMessages,
  type QueuedSessionMessage,
} from '@/lib/chat/queued-message-queue'

describe('queued-message-queue', () => {
  const queue: QueuedSessionMessage[] = [
    { runId: 'q1', sessionId: 'session-a', text: 'first a', queuedAt: 1, position: 1 },
    { runId: 'q2', sessionId: 'session-b', text: 'first b', queuedAt: 2, position: 1 },
    { runId: 'q3', sessionId: 'session-a', text: 'second a', queuedAt: 3, position: 2 },
  ]

  it('lists queued messages for a single session', () => {
    assert.deepEqual(
      listQueuedMessagesForSession(queue, 'session-a').map((item) => item.runId),
      ['q1', 'q3'],
    )
  })

  it('replaces queued items only for the requested session', () => {
    const replaced = replaceQueuedMessagesForSession(queue, 'session-a', [
      { runId: 'q4', sessionId: 'session-a', text: 'replacement', queuedAt: 4, position: 1 },
    ], { activeRunId: null })
    assert.deepEqual(
      listQueuedMessagesForSession(replaced, 'session-a').map((item) => item.runId),
      ['q4'],
    )
    assert.deepEqual(
      listQueuedMessagesForSession(replaced, 'session-b').map((item) => item.runId),
      ['q2'],
    )
  })

  it('keeps only the newly active run as a sending placeholder when it disappears from the queue snapshot', () => {
    const replaced = replaceQueuedMessagesForSession(queue, 'session-a', [
      { runId: 'q3', sessionId: 'session-a', text: 'second a', queuedAt: 3, position: 1 },
    ], { activeRunId: 'q1' })

    assert.deepEqual(
      listQueuedMessagesForSession(replaced, 'session-a').map((item) => [item.runId, item.sending === true]),
      [['q1', true], ['q3', false]],
    )
  })

  it('drops missing stale queue rows that are not the active run', () => {
    const replaced = replaceQueuedMessagesForSession(queue, 'session-a', [
      { runId: 'q3', sessionId: 'session-a', text: 'second a', queuedAt: 3, position: 1 },
    ], { activeRunId: 'run-other' })

    assert.deepEqual(
      listQueuedMessagesForSession(replaced, 'session-a').map((item) => item.runId),
      ['q3'],
    )
  })

  it('removes queued items by stable id', () => {
    assert.deepEqual(removeQueuedMessageById(queue, 'q2').map((item) => item.runId), ['q1', 'q3'])
  })

  it('clears queued items only for the given session', () => {
    assert.deepEqual(
      clearQueuedMessagesForSession(queue, 'session-a').map((item) => item.runId),
      ['q2'],
    )
  })

  it('creates optimistic queued items with the expected shape', () => {
    const optimistic = createOptimisticQueuedMessage('session-a', { text: 'queued later' }, 3)
    assert.equal(optimistic.sessionId, 'session-a')
    assert.equal(optimistic.position, 3)
    assert.equal(optimistic.optimistic, true)
  })

  it('converts queue snapshots into local queued messages', () => {
    const queued = snapshotToQueuedMessages({
      sessionId: 'session-a',
      activeRunId: 'run-active',
      activeTurn: {
        runId: 'run-active',
        sessionId: 'session-a',
        text: 'sending now',
        queuedAt: 4,
        position: 0,
      },
      queueLength: 1,
      items: [
        { runId: 'run-queued', sessionId: 'session-a', text: 'queued', queuedAt: 5, position: 1 },
      ],
    })
    assert.deepEqual(
      queued.map((item) => [item.runId, item.sending === true]),
      [['run-active', true], ['run-queued', false]],
    )
  })

  it('preserves attachment and reply metadata from queue snapshots', () => {
    const queued = snapshotToQueuedMessages({
      sessionId: 'session-a',
      activeRunId: null,
      queueLength: 1,
      items: [
        {
          runId: 'run-queued-meta',
          sessionId: 'session-a',
          text: 'queued with files',
          queuedAt: 7,
          position: 1,
          imagePath: '/tmp/image.png',
          imageUrl: '/api/uploads/image.png',
          attachedFiles: ['/tmp/notes.txt', '/tmp/spec.md'],
          replyToId: 'msg-4',
        },
      ],
    })

    assert.deepEqual(queued[0], {
      runId: 'run-queued-meta',
      sessionId: 'session-a',
      text: 'queued with files',
      queuedAt: 7,
      position: 1,
      imagePath: '/tmp/image.png',
      imageUrl: '/api/uploads/image.png',
      attachedFiles: ['/tmp/notes.txt', '/tmp/spec.md'],
      replyToId: 'msg-4',
    })
  })

  it('deduplicates an active turn when the snapshot also contains it in the queued items', () => {
    const queued = snapshotToQueuedMessages({
      sessionId: 'session-a',
      activeRunId: 'run-active',
      activeTurn: {
        runId: 'run-active',
        sessionId: 'session-a',
        text: 'already running',
        queuedAt: 6,
        position: 0,
      },
      queueLength: 1,
      items: [
        { runId: 'run-active', sessionId: 'session-a', text: 'already running', queuedAt: 6, position: 1 },
      ],
    })

    assert.deepEqual(queued.map((item) => item.runId), ['run-active'])
    assert.equal(queued[0]?.sending, true)
  })

  it('sorts queued messages by position and queued time within a session', () => {
    const unsorted: QueuedSessionMessage[] = [
      { runId: 'q4', sessionId: 'session-a', text: 'later', queuedAt: 9, position: 2 },
      { runId: 'q5', sessionId: 'session-a', text: 'earlier same pos', queuedAt: 4, position: 1 },
      { runId: 'q6', sessionId: 'session-a', text: 'later same pos', queuedAt: 8, position: 1 },
    ]

    assert.deepEqual(
      listQueuedMessagesForSession(unsorted, 'session-a').map((item) => item.runId),
      ['q5', 'q6', 'q4'],
    )
  })

  it('builds transcript-ready user messages from sending queued turns', () => {
    const transcript = buildQueuedTranscriptMessages([
      { runId: 'q1', sessionId: 'session-a', text: 'sending row', queuedAt: 20, position: 0, sending: true },
      { runId: 'q2', sessionId: 'session-a', text: 'pending row', queuedAt: 21, position: 1 },
      { runId: 'q3', sessionId: 'session-b', text: 'other session', queuedAt: 22, position: 0, sending: true },
    ], 'session-a')

    assert.deepEqual(transcript, [
      {
        role: 'user',
        text: 'sending row',
        time: 20,
        kind: 'chat',
        clientRenderId: 'queued:q1',
        imagePath: undefined,
        imageUrl: undefined,
        attachedFiles: undefined,
        replyToId: undefined,
        runId: 'q1',
      },
    ])
  })

  it('merges sending queued turns into the transcript ahead of later assistant output', () => {
    const merged = mergeQueuedTranscriptMessages([
      { role: 'assistant', text: 'Thinking...', time: 25, streaming: true, runId: 'run-active' },
    ], [
      { runId: 'run-active', sessionId: 'session-a', text: 'queued first', queuedAt: 20, position: 0, sending: true },
    ], 'session-a')

    assert.deepEqual(merged.map((message) => [message.role, message.text, message.runId]), [
      ['user', 'queued first', 'run-active'],
      ['assistant', 'Thinking...', 'run-active'],
    ])
  })

  it('preserves existing sending items when replacing queue for a session', () => {
    const queueWithSending: QueuedSessionMessage[] = [
      { runId: 'sending-1', sessionId: 'session-a', text: 'already sending', queuedAt: 1, position: 0, sending: true },
      { runId: 'q3', sessionId: 'session-a', text: 'queued', queuedAt: 2, position: 1 },
      { runId: 'q2', sessionId: 'session-b', text: 'other', queuedAt: 3, position: 1 },
    ]
    const replaced = replaceQueuedMessagesForSession(queueWithSending, 'session-a', [
      { runId: 'q4', sessionId: 'session-a', text: 'new queued', queuedAt: 4, position: 1 },
    ], { activeRunId: null })

    const forSession = listQueuedMessagesForSession(replaced, 'session-a')
    assert.deepEqual(
      forSession.map((item) => [item.runId, item.sending === true]),
      [['sending-1', true], ['q4', false]],
    )
  })

  it('deduplicates sending items that appear in nextItems', () => {
    const queueWithSending: QueuedSessionMessage[] = [
      { runId: 'run-active', sessionId: 'session-a', text: 'sending', queuedAt: 1, position: 0, sending: true },
    ]
    const replaced = replaceQueuedMessagesForSession(queueWithSending, 'session-a', [
      { runId: 'run-active', sessionId: 'session-a', text: 'sending', queuedAt: 1, position: 0, sending: true },
      { runId: 'q5', sessionId: 'session-a', text: 'next', queuedAt: 2, position: 1 },
    ], { activeRunId: 'run-active' })

    const forSession = listQueuedMessagesForSession(replaced, 'session-a')
    assert.deepEqual(
      forSession.map((item) => item.runId),
      ['run-active', 'q5'],
    )
  })

  it('inserts sending messages after last persisted message, not by timestamp', () => {
    const merged = mergeQueuedTranscriptMessages([
      { role: 'user', text: 'First', time: 100 },
      { role: 'assistant', text: 'Reply', time: 200 },
      { role: 'user', text: 'Second', time: 300 },
      { role: 'assistant', text: 'Reply 2', time: 400 },
    ], [
      // queuedAt is earlier than the last persisted message
      { runId: 'run-late', sessionId: 'session-a', text: 'queued early', queuedAt: 150, position: 0, sending: true },
    ], 'session-a')

    // Should appear at the END, not spliced into the middle at time=150
    assert.deepEqual(merged.map((msg) => msg.text), [
      'First', 'Reply', 'Second', 'Reply 2', 'queued early',
    ])
  })

  it('skips a sending queued turn once the persisted user message is already present', () => {
    const merged = mergeQueuedTranscriptMessages([
      { role: 'user', text: 'queued first', time: 20, runId: 'run-active' },
      { role: 'assistant', text: 'Thinking...', time: 25, streaming: true, runId: 'run-active' },
    ], [
      { runId: 'run-active', sessionId: 'session-a', text: 'queued first', queuedAt: 20, position: 0, sending: true },
    ], 'session-a')

    assert.deepEqual(merged.map((message) => [message.role, message.text, message.runId]), [
      ['user', 'queued first', 'run-active'],
      ['assistant', 'Thinking...', 'run-active'],
    ])
  })
})
