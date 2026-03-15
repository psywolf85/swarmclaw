import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SSEEvent } from '@/types'
import {
  resolveRequestedToolPreflightResponse,
  runExclusiveDirectMemoryPreflight,
  runPostLlmToolRouting,
} from '@/lib/server/chat-execution/chat-turn-tool-routing'
import { resolveSessionToolPolicy } from '@/lib/server/tool-capability-policy'

describe('chat-turn-tool-routing', () => {
  it('preflights an exclusive direct memory store before model execution', async () => {
    const events: SSEEvent[] = []
    const result = await runExclusiveDirectMemoryPreflight({
      session: {
        cwd: process.cwd(),
        tools: ['memory'],
      },
      sessionId: 'preflight-memory-store',
      message: 'Please remember that my launch marker is ALPHA-9.',
      effectiveMessage: 'Please remember that my launch marker is ALPHA-9.',
      enabledExtensions: ['memory'],
      toolPolicy: resolveSessionToolPolicy(['memory'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: (event) => { events.push(event) },
    }, {
      classifyDirectMemoryIntent: async () => ({
        action: 'store',
        confidence: 0.99,
        title: 'Launch marker',
        value: 'Launch marker: ALPHA-9',
        acknowledgement: 'I\'ll remember that.',
        exclusiveCompletion: true,
      }),
      invokeTool: async (_ctx, toolName, args, _failurePrefix, calledNames) => {
        calledNames.add(toolName)
        events.push({ t: 'tool_call', toolName, toolInput: JSON.stringify(args), toolCallId: 'call-1' })
        events.push({ t: 'tool_result', toolName, toolOutput: 'Stored memory "Launch marker".', toolCallId: 'call-1' })
        return {
          invoked: true,
          responseOverride: null,
          toolOutputText: 'Stored memory "Launch marker".',
        }
      },
    })

    assert.equal(result?.fullResponse, 'I\'ll remember that.')
    assert.equal(result?.calledNames.has('memory_store'), true)
  })

  it('does not preflight composite turns that also asked for other work', async () => {
    const result = await runExclusiveDirectMemoryPreflight({
      session: {
        cwd: process.cwd(),
        tools: ['memory'],
      },
      sessionId: 'preflight-memory-composite',
      message: 'Remember that my launch marker is ALPHA-9 and then make a file called notes.txt.',
      effectiveMessage: 'Remember that my launch marker is ALPHA-9 and then make a file called notes.txt.',
      enabledExtensions: ['memory'],
      toolPolicy: resolveSessionToolPolicy(['memory'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: () => {},
    }, {
      classifyDirectMemoryIntent: async () => ({
        action: 'store',
        confidence: 0.98,
        title: 'Launch marker',
        value: 'Launch marker: ALPHA-9',
        acknowledgement: 'I\'ll remember that.',
        exclusiveCompletion: false,
      }),
    })

    assert.equal(result, null)
  })

  it('fails open when direct-memory preflight classification times out', async () => {
    const started = Date.now()
    const result = await runExclusiveDirectMemoryPreflight({
      session: {
        cwd: process.cwd(),
        tools: ['memory'],
      },
      sessionId: 'preflight-memory-timeout',
      message: 'Please remember that my launch marker is ALPHA-9.',
      effectiveMessage: 'Please remember that my launch marker is ALPHA-9.',
      enabledExtensions: ['memory'],
      toolPolicy: resolveSessionToolPolicy(['memory'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: () => {},
    }, {
      classifyDirectMemoryIntent: async () => new Promise<never>(() => {}),
      memoryIntentTimeoutMs: 1,
    })

    assert.equal(result, null)
    assert.ok((Date.now() - started) < 250, 'preflight timeout should fail open quickly')
  })

  it('fails fast before model execution when an explicitly requested tool is unavailable', () => {
    const response = resolveRequestedToolPreflightResponse({
      message: 'Use delegate_to_codex_cli. task: "Say hi in one sentence."',
      enabledExtensions: ['shell', 'files'],
      toolPolicy: resolveSessionToolPolicy(['shell', 'files'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
    })

    assert.match(String(response || ''), /couldn't use delegation/i)
    assert.match(String(response || ''), /not enabled/i)
  })

  it('fails fast before model execution when delegation is disabled on the agent even if the delegate capability is enabled in the session', () => {
    const response = resolveRequestedToolPreflightResponse({
      message: 'Use delegate_to_codex_cli right now to say hello from a delegated worker.',
      enabledExtensions: ['delegate', 'shell'],
      toolPolicy: resolveSessionToolPolicy(['delegate', 'shell'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      session: {
        agentId: '9a4fefaf',
      },
    })

    assert.match(String(response || ''), /couldn't use delegation/i)
    assert.match(String(response || ''), /not enabled/i)
  })

  it('returns a user-safe response when an explicitly requested delegation tool is policy-blocked', async () => {
    const events: SSEEvent[] = []
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: [],
      },
      sessionId: 'session-1',
      message: 'Use delegate_to_codex_cli. task: "Summarize the repo state."',
      effectiveMessage: 'Use delegate_to_codex_cli. task: "Summarize the repo state."',
      enabledExtensions: [],
      toolPolicy: resolveSessionToolPolicy([], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: (event) => { events.push(event) },
    }, '', undefined)

    assert.match(result.fullResponse, /couldn't use delegation/i)
    assert.equal(result.missedRequestedTools.length, 0)
    assert.equal(events.some((event) => event.t === 'err' && String((event as { text?: string }).text || '').includes('Capability policy blocked')), false)
  })

  it('returns a user-safe response when delegation is unavailable in the current session', async () => {
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: ['delegate'],
      },
      sessionId: 'session-2',
      message: 'Use delegate_to_codex_cli. task: "Say hi in one sentence."',
      effectiveMessage: 'Use delegate_to_codex_cli. task: "Say hi in one sentence."',
      enabledExtensions: ['delegate'],
      toolPolicy: resolveSessionToolPolicy(['delegate'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: () => {},
    }, '', 'Connection error.')

    assert.match(result.fullResponse, /couldn't use delegation/i)
    assert.match(result.fullResponse, /not enabled for this agent/i)
    assert.equal(result.missedRequestedTools.length, 0)
    assert.equal(result.errorMessage, undefined)
  })

  it('overrides improvised alternate-tool output when an explicitly requested tool is unavailable', async () => {
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: ['shell'],
      },
      sessionId: 'session-3',
      message: 'Use delegate_to_codex_cli. task: "Say hi in one sentence."',
      effectiveMessage: 'Use delegate_to_codex_cli. task: "Say hi in one sentence."',
      enabledExtensions: ['shell'],
      toolPolicy: resolveSessionToolPolicy(['shell'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [
        {
          name: 'shell',
          input: '{"action":"execute","command":"codex exec ..."}',
          output: 'Hi.',
        },
      ],
      emit: () => {},
    }, 'Task completed via shell fallback.', undefined)

    assert.match(result.fullResponse, /couldn't use delegation/i)
    assert.doesNotMatch(result.fullResponse, /Task completed via shell fallback/)
    assert.equal(result.missedRequestedTools.length, 0)
  })

  it('forces explicit delegation even when the user does not provide a task: payload', async () => {
    const invocations: Array<{ toolName: string; args: Record<string, unknown> }> = []
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: ['delegate', 'shell'],
      },
      sessionId: 'session-delegate-freeform',
      message: 'Use delegate_to_codex_cli right now to say hello from a delegated worker.',
      effectiveMessage: 'Use delegate_to_codex_cli right now to say hello from a delegated worker.',
      enabledExtensions: ['delegate', 'shell'],
      toolPolicy: resolveSessionToolPolicy(['delegate', 'shell'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [
        {
          name: 'shell',
          input: '{"command":"codex exec echo hello"}',
          output: 'Hello from shell.',
        },
      ],
      emit: () => {},
    }, 'Hello from shell.', undefined, {
      invokeTool: async (_ctx, toolName, args, _failurePrefix, calledNames) => {
        invocations.push({ toolName, args })
        calledNames.add(toolName)
        return {
          invoked: true,
          responseOverride: 'Delegated cleanly.',
          toolOutputText: JSON.stringify({ response: 'Delegated cleanly.' }),
        }
      },
    })

    assert.equal(invocations.length, 1)
    assert.equal(invocations[0].toolName, 'delegate_to_codex_cli')
    assert.deepEqual(invocations[0].args, {
      task: 'Use delegate_to_codex_cli right now to say hello from a delegated worker.',
    })
    assert.equal(result.fullResponse, 'Delegated cleanly.')
    assert.equal(result.missedRequestedTools.length, 0)
    assert.equal(result.calledNames.has('delegate_to_codex_cli'), true)
  })

  it('uses classifier-backed memory store fallback without heuristic parsing', async () => {
    const invocations: Array<{ toolName: string; args: Record<string, unknown> }> = []
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: ['memory'],
      },
      sessionId: 'session-memory-store',
      message: 'Please remember that my launch marker is ALPHA-7 for future conversations.',
      effectiveMessage: 'Please remember that my launch marker is ALPHA-7 for future conversations.',
      enabledExtensions: ['memory'],
      toolPolicy: resolveSessionToolPolicy(['memory'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: () => {},
    }, 'Got it.', undefined, {
      classifyDirectMemoryIntent: async () => ({
        action: 'store',
        confidence: 0.98,
        title: 'Launch marker',
        value: 'My launch marker is ALPHA-7',
        acknowledgement: 'I\'ll remember that your launch marker is ALPHA-7.',
        exclusiveCompletion: true,
      }),
      invokeTool: async (_ctx, toolName, args, _failurePrefix, calledNames) => {
        invocations.push({ toolName, args })
        calledNames.add(toolName)
        return {
          invoked: true,
          responseOverride: null,
          toolOutputText: 'Stored memory "Launch marker" (id: mem-1).',
        }
      },
    })

    assert.equal(invocations.length, 1)
    assert.equal(invocations[0].toolName, 'memory_store')
    assert.deepEqual(invocations[0].args, {
      title: 'Launch marker',
      value: 'My launch marker is ALPHA-7',
    })
    assert.equal(result.fullResponse, 'I\'ll remember that your launch marker is ALPHA-7.')
    assert.equal(result.errorMessage, undefined)
    assert.equal(result.calledNames.has('memory_store'), true)
  })

  it('uses classifier-backed memory update fallback and surfaces tool errors directly', async () => {
    const invocations: Array<{ toolName: string; args: Record<string, unknown> }> = []
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: ['memory'],
      },
      sessionId: 'session-memory-update',
      message: 'Correction: my launch marker is ALPHA-8 now.',
      effectiveMessage: 'Correction: my launch marker is ALPHA-8 now.',
      enabledExtensions: ['memory'],
      toolPolicy: resolveSessionToolPolicy(['memory'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: () => {},
    }, '', undefined, {
      classifyDirectMemoryIntent: async () => ({
        action: 'update',
        confidence: 0.97,
        title: 'Launch marker',
        value: 'My launch marker is ALPHA-8',
        acknowledgement: 'I\'ll use your updated launch marker going forward.',
        exclusiveCompletion: true,
      }),
      invokeTool: async (_ctx, toolName, args, _failurePrefix, calledNames) => {
        invocations.push({ toolName, args })
        calledNames.add(toolName)
        return {
          invoked: true,
          responseOverride: null,
          toolOutputText: 'Error: canonical memory entry not found.',
        }
      },
    })

    assert.equal(invocations.length, 1)
    assert.equal(invocations[0].toolName, 'memory_update')
    assert.deepEqual(invocations[0].args, {
      title: 'Launch marker',
      value: 'My launch marker is ALPHA-8',
    })
    assert.equal(result.fullResponse, 'Error: canonical memory entry not found.')
    assert.equal(result.calledNames.has('memory_update'), true)
  })

  it('uses classifier-backed recall fallback and returns a natural answer', async () => {
    const invocations: Array<{ toolName: string; args: Record<string, unknown> }> = []
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: ['memory'],
      },
      sessionId: 'session-memory-recall',
      message: 'What is my launch marker right now?',
      effectiveMessage: 'What is my launch marker right now?',
      enabledExtensions: ['memory'],
      toolPolicy: resolveSessionToolPolicy(['memory'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: () => {},
    }, '', 'Connection error.', {
      classifyDirectMemoryIntent: async () => ({
        action: 'recall',
        confidence: 0.94,
        query: 'launch marker',
        missResponse: 'I do not have your launch marker in memory yet.',
      }),
      invokeTool: async (_ctx, toolName, args, _failurePrefix, calledNames) => {
        invocations.push({ toolName, args })
        calledNames.add(toolName)
        return {
          invoked: true,
          responseOverride: null,
          toolOutputText: '[mem_123] (agent:agent-1) knowledge/facts/Launch marker: My launch marker is ALPHA-7',
        }
      },
    })

    assert.equal(invocations.length, 1)
    assert.equal(invocations[0].toolName, 'memory_search')
    assert.deepEqual(invocations[0].args, {
      query: 'launch marker',
      scope: 'auto',
    })
    assert.equal(result.fullResponse, 'Your launch marker is ALPHA-7.')
    assert.equal(result.errorMessage, undefined)
    assert.equal(result.calledNames.has('memory_search'), true)
  })

  it('returns the classifier miss response when recall finds no durable memory', async () => {
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: ['memory'],
      },
      sessionId: 'session-memory-miss',
      message: 'What is my launch marker right now?',
      effectiveMessage: 'What is my launch marker right now?',
      enabledExtensions: ['memory'],
      toolPolicy: resolveSessionToolPolicy(['memory'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: () => {},
    }, '', undefined, {
      classifyDirectMemoryIntent: async () => ({
        action: 'recall',
        confidence: 0.94,
        query: 'launch marker',
        missResponse: 'I do not have your launch marker in memory yet.',
      }),
      invokeTool: async (_ctx, toolName, _args, _failurePrefix, calledNames) => {
        calledNames.add(toolName)
        return {
          invoked: true,
          responseOverride: null,
          toolOutputText: 'No memories found.',
        }
      },
    })

    assert.equal(result.fullResponse, 'I do not have your launch marker in memory yet.')
    assert.equal(result.errorMessage, undefined)
    assert.equal(result.calledNames.has('memory_search'), true)
  })

  it('fails open when post-LLM memory classification times out', async () => {
    let invoked = false
    const started = Date.now()
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: ['memory'],
      },
      sessionId: 'session-memory-timeout',
      message: 'What is my launch marker right now?',
      effectiveMessage: 'What is my launch marker right now?',
      enabledExtensions: ['memory'],
      toolPolicy: resolveSessionToolPolicy(['memory'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: () => {},
    }, 'Current response.', undefined, {
      classifyDirectMemoryIntent: async () => new Promise<never>(() => {}),
      memoryIntentTimeoutMs: 1,
      invokeTool: async () => {
        invoked = true
        throw new Error('should not invoke a tool when classification times out')
      },
    })

    assert.equal(result.fullResponse, 'Current response.')
    assert.equal(result.errorMessage, undefined)
    assert.equal(invoked, false)
    assert.ok((Date.now() - started) < 250, 'post-LLM timeout should fail open quickly')
  })
})
