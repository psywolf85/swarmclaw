import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { Agent, Session } from '@/types'
import { useAppStore } from './use-app-store'
import { useChatStore } from './use-chat-store'

const originalFetch = global.fetch
const originalChatState = useChatStore.getState()
const originalAppState = {
  agents: useAppStore.getState().agents,
  sessions: useAppStore.getState().sessions,
  currentAgentId: useAppStore.getState().currentAgentId,
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Agent One',
    description: '',
    systemPrompt: '',
    provider: 'openai',
    model: 'gpt-5',
    plugins: ['memory'],
    createdAt: 1,
    updatedAt: 1,
    threadSessionId: 'session-1',
    ...overrides,
  } as Agent
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'Session One',
    cwd: '/tmp',
    user: 'default',
    provider: 'openai',
    model: 'gpt-5',
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
    messages: [],
    createdAt: 1,
    lastActiveAt: 1,
    plugins: ['memory'],
    ...overrides,
  } as Session
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`))
      }
      controller.close()
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

afterEach(() => {
  global.fetch = originalFetch
  useChatStore.setState({
    streaming: originalChatState.streaming,
    streamingSessionId: originalChatState.streamingSessionId,
    streamText: originalChatState.streamText,
    assistantRenderId: originalChatState.assistantRenderId,
    streamPhase: originalChatState.streamPhase,
    streamToolName: originalChatState.streamToolName,
    displayText: originalChatState.displayText,
    agentStatus: originalChatState.agentStatus,
    messages: originalChatState.messages,
    toolEvents: originalChatState.toolEvents,
    lastUsage: originalChatState.lastUsage,
    pendingFiles: originalChatState.pendingFiles,
    replyingTo: originalChatState.replyingTo,
    thinkingText: originalChatState.thinkingText,
    thinkingStartTime: originalChatState.thinkingStartTime,
    queuedMessages: originalChatState.queuedMessages,
    hasMoreMessages: originalChatState.hasMoreMessages,
    loadingMore: originalChatState.loadingMore,
    totalMessages: originalChatState.totalMessages,
  })
  useAppStore.setState({
    agents: originalAppState.agents,
    sessions: originalAppState.sessions,
    currentAgentId: originalAppState.currentAgentId,
  })
})

describe('useChatStore control-token hygiene', () => {
  it('does not add a visible assistant bubble for a control-token-only direct reply', async () => {
    const session = makeSession()
    useAppStore.setState({
      agents: { 'agent-1': makeAgent() },
      sessions: { [session.id]: session },
      currentAgentId: 'agent-1',
    })
    useChatStore.setState({
      messages: [],
      pendingFiles: [],
      replyingTo: null,
      toolEvents: [],
      streamText: '',
      displayText: '',
      streaming: false,
      streamingSessionId: null,
      assistantRenderId: null,
      streamPhase: 'thinking',
      streamToolName: '',
      thinkingText: '',
      thinkingStartTime: 0,
      queuedMessages: [],
      agentStatus: null,
      lastUsage: null,
      hasMoreMessages: false,
      loadingMore: false,
      totalMessages: 0,
    })

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/session-1/chat') {
        return sseResponse([
          { t: 'r', text: 'NO_MESSAGE' },
          { t: 'done' },
        ])
      }
      if (url === '/api/chats/session-1') {
        return new Response(JSON.stringify(session), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    await useChatStore.getState().sendMessage('Hello', { sessionId: 'session-1' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const messages = useChatStore.getState().messages
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.role, 'user')
    assert.equal(messages[0]?.text, 'Hello')
    assert.equal(useChatStore.getState().streamText, '')
    assert.equal(useChatStore.getState().displayText, '')
  })

  it('keeps a stable client render id on the completed assistant message', async () => {
    const session = makeSession()
    useAppStore.setState({
      agents: { 'agent-1': makeAgent() },
      sessions: { [session.id]: session },
      currentAgentId: 'agent-1',
    })
    useChatStore.setState({
      messages: [],
      pendingFiles: [],
      replyingTo: null,
      toolEvents: [],
      streamText: '',
      displayText: '',
      streaming: false,
      streamingSessionId: null,
      assistantRenderId: null,
      streamPhase: 'thinking',
      streamToolName: '',
      thinkingText: '',
      thinkingStartTime: 0,
      queuedMessages: [],
      agentStatus: null,
      lastUsage: null,
      hasMoreMessages: false,
      loadingMore: false,
      totalMessages: 0,
    })

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/session-1/chat') {
        return sseResponse([
          { t: 'r', text: 'Stable final answer' },
          { t: 'done' },
        ])
      }
      if (url === '/api/chats/session-1') {
        return new Response(JSON.stringify(session), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    await useChatStore.getState().sendMessage('Hello', { sessionId: 'session-1' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const state = useChatStore.getState()
    const assistantMessage = state.messages.find((message) => message.role === 'assistant')
    assert.equal(state.streaming, false)
    assert.equal(typeof state.assistantRenderId, 'string')
    assert.equal(assistantMessage?.clientRenderId, state.assistantRenderId)
  })

  it('atomically swaps a queued chip into the live transcript when dequeuing', () => {
    const session = makeSession()
    useAppStore.setState({
      agents: { 'agent-1': makeAgent() },
      sessions: { [session.id]: session },
      currentAgentId: 'agent-1',
    })
    useChatStore.setState({
      messages: [
        { role: 'user', text: 'First', time: 1 },
        { role: 'assistant', text: 'Replying', time: 2 },
      ],
      pendingFiles: [],
      replyingTo: null,
      toolEvents: [],
      streamText: '',
      displayText: '',
      streaming: false,
      streamingSessionId: null,
      assistantRenderId: null,
      streamPhase: 'thinking',
      streamToolName: '',
      thinkingText: '',
      thinkingStartTime: 0,
      queuedMessages: [
        { id: 'queued-1', sessionId: 'session-1', text: 'Queued hello' },
      ],
      agentStatus: null,
      lastUsage: null,
      hasMoreMessages: false,
      loadingMore: false,
      totalMessages: 2,
    })

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/session-1/chat') {
        return new Promise<Response>(() => {})
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    void useChatStore.getState().sendMessage('Queued hello', {
      sessionId: 'session-1',
      fromQueue: true,
      queuedMessageId: 'queued-1',
    })

    const state = useChatStore.getState()
    assert.equal(state.streaming, true)
    assert.equal(state.queuedMessages.length, 0)
    assert.equal(state.messages.at(-1)?.role, 'user')
    assert.equal(state.messages.at(-1)?.text, 'Queued hello')
  })

  it('preserves the assistant render id across a reconciled message refresh', () => {
    useChatStore.setState({
      messages: [
        { role: 'user', text: 'Hello', time: 1 },
        { role: 'assistant', text: 'Stable final answer', time: 2, clientRenderId: 'render-1' },
      ],
      assistantRenderId: 'render-1',
      toolEvents: [],
      streamText: '',
      displayText: '',
      streaming: false,
      streamingSessionId: null,
      streamPhase: 'thinking',
      streamToolName: '',
      thinkingText: '',
      thinkingStartTime: 0,
      queuedMessages: [],
      agentStatus: null,
      lastUsage: null,
      hasMoreMessages: false,
      loadingMore: false,
      totalMessages: 2,
    })

    useChatStore.getState().setMessages([
      { role: 'user', text: 'Hello', time: 10 },
      { role: 'assistant', text: 'Stable final answer', time: 20 },
    ])

    const state = useChatStore.getState()
    assert.equal(state.assistantRenderId, 'render-1')
    assert.equal(state.messages[1]?.clientRenderId, 'render-1')
  })
})
