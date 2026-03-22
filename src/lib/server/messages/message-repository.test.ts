import assert from 'node:assert/strict'
import test from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('appendMessage notifies both generic and per-session message topics', () => {
  const output = runWithTempDataDir<{
    genericTopics: string[]
    sessionTopics: string[]
  }>(`
    const { WebSocket } = await import('ws')
    const storageMod = await import('@/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod

    storage.saveSessions({
      'sess-notify': {
        id: 'sess-notify',
        name: 'Notify Session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'tester',
        provider: 'openai',
        model: 'gpt-5',
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      },
    })

    const genericPayloads = []
    const sessionPayloads = []
    globalThis.__swarmclaw_ws__ = {
      wss: null,
      clients: new Set([
        {
          ws: {
            readyState: WebSocket.OPEN,
            send(payload) { genericPayloads.push(JSON.parse(payload)) },
          },
          topics: new Set(['messages']),
        },
        {
          ws: {
            readyState: WebSocket.OPEN,
            send(payload) { sessionPayloads.push(JSON.parse(payload)) },
          },
          topics: new Set(['messages:sess-notify']),
        },
      ]),
    }

    repo.appendMessage('sess-notify', {
      role: 'user',
      text: 'hello',
      time: 1,
    })

    console.log(JSON.stringify({
      genericTopics: genericPayloads.map((payload) => payload.topic),
      sessionTopics: sessionPayloads.map((payload) => payload.topic),
    }))
  `, { prefix: 'swarmclaw-message-repo-notify-' })

  assert.deepEqual(output.genericTopics, ['messages'])
  assert.deepEqual(output.sessionTopics, ['messages:sess-notify'])
})
