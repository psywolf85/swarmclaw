import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { getExtensionManager, normalizeMarketplaceExtensionUrl, sanitizeExtensionFilename } from './extensions'
import { canonicalizeExtensionId, expandExtensionIds, extensionIdMatches } from './tool-aliases'
import { DATA_DIR } from './data-dir'
import type { Session } from '@/types'

let testExtensionSeq = 0

function uniqueExtensionId(prefix: string): string {
  testExtensionSeq += 1
  return `${prefix}_${Date.now()}_${testExtensionSeq}`
}

describe('extension id canonicalization', () => {
  it('normalizes built-in aliases to canonical extension families', () => {
    assert.equal(canonicalizeExtensionId('session_info'), 'manage_sessions')
    assert.equal(canonicalizeExtensionId('connectors'), 'manage_connectors')
    assert.equal(canonicalizeExtensionId('subagent'), 'spawn_subagent')
    assert.equal(canonicalizeExtensionId('http'), 'web')
    assert.equal(canonicalizeExtensionId('human_loop'), 'ask_human')
    assert.equal(canonicalizeExtensionId('gws'), 'google_workspace')
  })

  it('expands aliases to include the canonical family id', () => {
    const expanded = expandExtensionIds(['session_info', 'http', 'human_loop'])
    assert.equal(expanded.includes('manage_sessions'), true)
    assert.equal(expanded.includes('session_info'), true)
    assert.equal(expanded.includes('http_request'), true)
    assert.equal(expanded.includes('http'), true)
    assert.equal(expanded.includes('ask_human'), true)
    assert.equal(expanded.includes('human_loop'), true)
  })

  it('matches Google Workspace aliases across canonical and CLI-facing names', () => {
    const expanded = expandExtensionIds(['google_workspace'])
    assert.equal(expanded.includes('google_workspace'), true)
    assert.equal(expanded.includes('gws'), true)
    assert.equal(expanded.includes('google-workspace'), true)
    assert.equal(extensionIdMatches(['google_workspace'], 'gws'), true)
    assert.equal(extensionIdMatches(['gws'], 'google-workspace'), true)
  })

  it('does not expand a specific platform tool back into manage_platform', () => {
    const expanded = expandExtensionIds(['manage_schedules'])
    assert.equal(expanded.includes('manage_schedules'), true)
    assert.equal(expanded.includes('manage_platform'), false)
    assert.equal(extensionIdMatches(['manage_platform'], 'manage_schedules'), true)
    assert.equal(extensionIdMatches(['manage_schedules'], 'manage_platform'), false)
  })
})

describe('extension install helpers', () => {
  it('rewrites legacy marketplace URLs to the canonical raw source', () => {
    const normalized = normalizeMarketplaceExtensionUrl('https://github.com/swarmclawai/swarmforge/blob/master/foo/bar.js')
    assert.equal(normalized, 'https://raw.githubusercontent.com/swarmclawai/swarmforge/main/foo/bar.js')
  })

  it('allows .js and .mjs extension filenames and blocks traversal', () => {
    assert.equal(sanitizeExtensionFilename('plugin.js'), 'plugin.js')
    assert.equal(sanitizeExtensionFilename('plugin.mjs'), 'plugin.mjs')
    assert.throws(() => sanitizeExtensionFilename('../plugin.js'), /Invalid filename/)
    assert.throws(() => sanitizeExtensionFilename('plugin'), /Filename must end/)
  })
})

describe('extension manager hook execution', () => {
  it('applies beforeToolExec mutations only for explicitly enabled extensions', async () => {
    const extensionId = uniqueExtensionId('before_tool_exec')
    getExtensionManager().registerBuiltin(extensionId, {
      name: 'Before Tool Exec Test',
      hooks: {
        beforeToolExec: ({ input }) => ({ ...(input || {}), patched: true }),
      },
    })

    const withoutEnable = await getExtensionManager().runBeforeToolExec(
      { toolName: 'shell', input: { original: true } },
      {},
    )
    assert.deepEqual(withoutEnable, { original: true })

    const withEnable = await getExtensionManager().runBeforeToolExec(
      { toolName: 'shell', input: { original: true } },
      { enabledIds: [extensionId] },
    )
    assert.deepEqual(withEnable, { original: true, patched: true })
  })

  it('merges beforePromptBuild context and preserves first system prompt override', async () => {
    const extA = uniqueExtensionId('before_prompt_build_a')
    const extB = uniqueExtensionId('before_prompt_build_b')
    const session = {
      id: 'prompt-hook-session',
      name: 'Prompt Hook Session',
      cwd: process.cwd(),
      user: 'tester',
      provider: 'openai',
      model: 'gpt-test',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      extensions: [extA, extB],
    } as unknown as Session

    getExtensionManager().registerBuiltin(extA, {
      name: 'Before Prompt Build A',
      hooks: {
        beforePromptBuild: () => ({
          systemPrompt: 'system A',
          prependContext: 'context A',
          prependSystemContext: 'prepend A',
        }),
      },
    })
    getExtensionManager().registerBuiltin(extB, {
      name: 'Before Prompt Build B',
      hooks: {
        beforePromptBuild: () => ({
          systemPrompt: 'system B',
          prependContext: 'context B',
          appendSystemContext: 'append B',
        }),
      },
    })

    const result = await getExtensionManager().runBeforePromptBuild(
      {
        session,
        prompt: 'base prompt',
        message: 'hello',
        history: [],
        messages: [],
      },
      { enabledIds: [extA, extB] },
    )

    assert.deepEqual(result, {
      systemPrompt: 'system A',
      prependContext: 'context A\n\ncontext B',
      prependSystemContext: 'prepend A',
      appendSystemContext: 'append B',
    })
  })

  it('applies beforeToolCall params merges and block results before legacy beforeToolExec', async () => {
    const extA = uniqueExtensionId('before_tool_call_a')
    const extB = uniqueExtensionId('before_tool_call_b')
    const session = {
      id: 'tool-hook-session',
      name: 'Tool Hook Session',
      cwd: process.cwd(),
      user: 'tester',
      provider: 'openai',
      model: 'gpt-test',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      extensions: [extA, extB],
    } as unknown as Session

    getExtensionManager().registerBuiltin(extA, {
      name: 'Before Tool Call A',
      hooks: {
        beforeToolCall: () => ({
          params: { patched: true },
          warning: 'tool warning',
        }),
      },
    })
    getExtensionManager().registerBuiltin(extB, {
      name: 'Before Tool Call B',
      hooks: {
        beforeToolCall: ({ input }) => ({
          block: true,
          blockReason: `blocked with patched=${String(input?.patched)}`,
        }),
        beforeToolExec: () => ({ shouldNotRun: true }),
      },
    })

    const result = await getExtensionManager().runBeforeToolCall(
      {
        session,
        toolName: 'shell',
        input: { original: true },
        runId: 'run-1',
      },
      { enabledIds: [extA, extB] },
    )

    assert.deepEqual(result, {
      input: { original: true, patched: true },
      blockReason: 'blocked with patched=true',
      warning: 'tool warning',
    })
  })

  it('applies beforeModelResolve overrides in extension order', async () => {
    const extA = uniqueExtensionId('before_model_resolve_a')
    const extB = uniqueExtensionId('before_model_resolve_b')
    const session = {
      id: 'model-resolve-session',
      name: 'Model Resolve Session',
      cwd: process.cwd(),
      user: 'tester',
      provider: 'openai',
      model: 'gpt-test',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      extensions: [extA, extB],
    } as unknown as Session

    getExtensionManager().registerBuiltin(extA, {
      name: 'Before Model Resolve A',
      hooks: {
        beforeModelResolve: () => ({
          providerOverride: 'ollama',
          modelOverride: 'llama-a',
        }),
      },
    })
    getExtensionManager().registerBuiltin(extB, {
      name: 'Before Model Resolve B',
      hooks: {
        beforeModelResolve: () => ({
          modelOverride: 'llama-b',
          apiEndpointOverride: 'http://127.0.0.1:11434',
        }),
      },
    })

    const result = await getExtensionManager().runBeforeModelResolve(
      {
        session,
        prompt: 'base prompt',
        message: 'hello',
        provider: session.provider,
        model: session.model,
        apiEndpoint: null,
      },
      { enabledIds: [extA, extB] },
    )

    assert.deepEqual(result, {
      providerOverride: 'ollama',
      modelOverride: 'llama-b',
      apiEndpointOverride: 'http://127.0.0.1:11434',
    })
  })

  it('chains toolResultPersist and beforeMessageWrite hooks', async () => {
    const extA = uniqueExtensionId('tool_result_persist_a')
    const extB = uniqueExtensionId('before_message_write_b')
    const session = {
      id: 'message-write-session',
      name: 'Message Write Session',
      cwd: process.cwd(),
      user: 'tester',
      provider: 'openai',
      model: 'gpt-test',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      extensions: [extA, extB],
    } as unknown as Session

    getExtensionManager().registerBuiltin(extA, {
      name: 'Tool Result Persist A',
      hooks: {
        toolResultPersist: ({ message, toolName }) => ({
          ...message,
          text: `${message.text} [tool:${toolName}]`,
        }),
      },
    })
    getExtensionManager().registerBuiltin(extB, {
      name: 'Before Message Write B',
      hooks: {
        beforeMessageWrite: ({ message }) => ({
          message: {
            ...message,
            text: `${message.text} [persisted]`,
          },
        }),
      },
    })

    const persisted = await getExtensionManager().runToolResultPersist(
      {
        session,
        message: {
          role: 'assistant',
          text: 'tool output',
          time: Date.now(),
        },
        toolName: 'shell',
        toolCallId: 'call-1',
      },
      { enabledIds: [extA, extB] },
    )
    const writeResult = await getExtensionManager().runBeforeMessageWrite(
      {
        session,
        message: persisted,
        phase: 'assistant_final',
        runId: 'run-1',
      },
      { enabledIds: [extA, extB] },
    )

    assert.equal(writeResult.block, false)
    assert.equal(writeResult.message.text, 'tool output [tool:shell] [persisted]')
  })

  it('blocks subagent spawning when an extension hook rejects it', async () => {
    const extensionId = uniqueExtensionId('subagent_spawning')

    getExtensionManager().registerBuiltin(extensionId, {
      name: 'Subagent Spawning Hook',
      hooks: {
        subagentSpawning: () => ({
          status: 'error',
          error: 'blocked by lifecycle hook',
        }),
      },
    })

    const result = await getExtensionManager().runSubagentSpawning(
      {
        parentSessionId: 'parent-1',
        agentId: 'agent-1',
        agentName: 'Agent One',
        message: 'do the work',
        cwd: process.cwd(),
        mode: 'run',
        threadRequested: false,
      },
      { enabledIds: [extensionId] },
    )

    assert.deepEqual(result, {
      status: 'error',
      error: 'blocked by lifecycle hook',
    })
  })

  it('chains text transforms in extension order', async () => {
    const extA = uniqueExtensionId('transform_a')
    const extB = uniqueExtensionId('transform_b')
    getExtensionManager().registerBuiltin(extA, {
      name: 'Transform A',
      hooks: {
        transformOutboundMessage: ({ text }) => `${text} A`,
      },
    })
    getExtensionManager().registerBuiltin(extB, {
      name: 'Transform B',
      hooks: {
        transformOutboundMessage: ({ text }) => `${text} B`,
      },
    })

    const transformed = await getExtensionManager().transformText(
      'transformOutboundMessage',
      {
        session: {
          id: 's1',
          name: 'Test Session',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          extensions: [extA, extB],
        } as unknown as Session,
        text: 'base',
      },
      { enabledIds: [extA, extB] },
    )

    assert.equal(transformed, 'base A B')
  })

  it('does not run generic extension hooks unless scope is provided explicitly', async () => {
    const extensionId = uniqueExtensionId('scoped_hook')
    let callCount = 0
    getExtensionManager().registerBuiltin(extensionId, {
      name: 'Scoped Hook Test',
      hooks: {
        afterChatTurn: () => {
          callCount += 1
        },
      },
    })

    await getExtensionManager().runHook(
      'afterChatTurn',
      {
        session: {
          id: 's2',
          name: 'Scoped Hook Session',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        },
        message: 'hi',
        response: 'hello',
        source: 'chat',
        internal: false,
      },
      {},
    )
    assert.equal(callCount, 0)

    await getExtensionManager().runHook(
      'afterChatTurn',
      {
        session: {
          id: 's3',
          name: 'Scoped Hook Session Enabled',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          extensions: [extensionId],
        } as unknown as Session,
        message: 'hi',
        response: 'hello',
        source: 'chat',
        internal: false,
      },
      { enabledIds: [extensionId] },
    )
    assert.equal(callCount, 1)
  })

  it('stores dependency-aware extensions in managed workspaces', async () => {
    const filename = `${uniqueExtensionId('workspace_extension')}.js`
    const manager = getExtensionManager()

    await manager.saveExtensionSource(
      filename,
      'module.exports = { name: "Workspace Extension", tools: [] }',
      {
        packageJson: {
          name: 'workspace-extension',
          dependencies: {
            lodash: '^4.17.21',
          },
        },
        packageManager: 'npm',
      },
    )

    const meta = manager.listExtensions().find((ext) => ext.filename === filename)
    assert.equal(meta?.isBuiltin, false)
    assert.equal(meta?.hasDependencyManifest, true)
    assert.equal(meta?.dependencyCount, 1)
    assert.equal(meta?.packageManager, 'npm')
    assert.equal(manager.readExtensionSource(filename).includes('Workspace Extension'), true)

    const shimPath = path.join(DATA_DIR, 'extensions', filename)
    assert.equal(fs.readFileSync(shimPath, 'utf8').includes('Auto-generated extension workspace shim'), true)

    assert.equal(manager.deleteExtension(filename), true)
  })
})
