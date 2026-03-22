import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('messages route serves and mutates repo-backed transcript history', () => {
  const output = runWithTempDataDir<{
    fullCount: number
    paginatedTexts: string[]
    paginatedStartIndex: number
    paginatedTotal: number
    bookmarkPersisted: boolean
    contextClearCountAfterPost: number
    finalKinds: Array<string | null>
    finalBookmarked: boolean
    blobMessageCount: number
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const routeMod = await import('./src/app/api/chats/[id]/messages/route')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod
    const route = routeMod.default || routeMod

    const now = Date.now()
    storage.saveSessions({
      sess_1: {
        id: 'sess_1',
        name: 'Repo-backed session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'tester',
        provider: 'openai',
        model: 'gpt-5',
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages: [],
        createdAt: now,
        lastActiveAt: now,
      },
    })

    repo.appendMessage('sess_1', { role: 'user', text: 'hello', time: now })
    repo.appendMessage('sess_1', { role: 'user', text: '', kind: 'context-clear', time: now + 1 })
    repo.appendMessage('sess_1', { role: 'assistant', text: 'welcome back', time: now + 2 })
    storage.patchSession('sess_1', (current) => {
      if (!current) return null
      current.messages = [{ role: 'assistant', text: 'stale blob only', time: now - 10 }]
      return current
    })

    const fullResponse = await route.GET(
      new Request('http://local/api/chats/sess_1/messages'),
      { params: Promise.resolve({ id: 'sess_1' }) },
    )
    const fullMessages = await fullResponse.json()

    const paginatedResponse = await route.GET(
      new Request('http://local/api/chats/sess_1/messages?limit=2'),
      { params: Promise.resolve({ id: 'sess_1' }) },
    )
    const paginated = await paginatedResponse.json()

    const bookmarkResponse = await route.PUT(
      new Request('http://local/api/chats/sess_1/messages', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageIndex: 2, bookmarked: true }),
      }),
      { params: Promise.resolve({ id: 'sess_1' }) },
    )
    const bookmarked = await bookmarkResponse.json()

    await route.POST(
      new Request('http://local/api/chats/sess_1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'context-clear' }),
      }),
      { params: Promise.resolve({ id: 'sess_1' }) },
    )

    const afterPost = repo.getMessages('sess_1')
    const contextClearCountAfterPost = afterPost.filter((message) => message.kind === 'context-clear').length

    await route.DELETE(
      new Request('http://local/api/chats/sess_1/messages', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageIndex: 1 }),
      }),
      { params: Promise.resolve({ id: 'sess_1' }) },
    )

    const finalMessages = repo.getMessages('sess_1')
    const sessions = storage.loadSessions()

    console.log(JSON.stringify({
      fullCount: fullMessages.length,
      paginatedTexts: paginated.messages.map((message) => message.text),
      paginatedStartIndex: paginated.startIndex,
      paginatedTotal: paginated.total,
      bookmarkPersisted: bookmarked.bookmarked === true,
      contextClearCountAfterPost,
      finalKinds: finalMessages.map((message) => message.kind || null),
      finalBookmarked: finalMessages[1]?.bookmarked === true,
      blobMessageCount: Array.isArray(sessions.sess_1.messages) ? sessions.sess_1.messages.length : -1,
    }))
  `, { prefix: 'swarmclaw-messages-route-' })

  assert.equal(output.fullCount, 3)
  assert.deepEqual(output.paginatedTexts, ['', 'welcome back'])
  assert.equal(output.paginatedStartIndex, 1)
  assert.equal(output.paginatedTotal, 3)
  assert.equal(output.bookmarkPersisted, true)
  assert.equal(output.contextClearCountAfterPost, 2)
  assert.deepEqual(output.finalKinds, [null, null, 'context-clear'])
  assert.equal(output.finalBookmarked, true)
  assert.equal(output.blobMessageCount, 1)
})
