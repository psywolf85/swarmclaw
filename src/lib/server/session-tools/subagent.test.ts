import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

import { buildSessionTools } from './index'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-subagent-tool-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: path.join(tempDir, 'data'),
        WORKSPACE_DIR: path.join(tempDir, 'workspace'),
        SWARMCLAW_BUILD_MODE: '1',
      },
      encoding: 'utf-8',
      timeout: 30_000,
    })
    assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
    const lines = (result.stdout || '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'))
    return JSON.parse(jsonLine || '{}')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('spawn_subagent runtime access', () => {
  it('hides spawn_subagent unless delegation is enabled', async () => {
    const built = await buildSessionTools(process.cwd(), ['spawn_subagent'], {
      sessionId: 'subagent-disabled-session',
      agentId: 'subagent-disabled-agent',
      delegationEnabled: false,
      delegationTargetMode: 'all',
      delegationTargetAgentIds: [],
    })

    try {
      assert.equal(
        built.tools.some((tool) => tool.name === 'spawn_subagent'),
        false,
      )
    } finally {
      await built.cleanup()
    }
  })

  it('rejects spawn_subagent targets outside the selected delegate list', async () => {
    const built = await buildSessionTools(process.cwd(), ['spawn_subagent'], {
      sessionId: 'subagent-selected-session',
      agentId: 'subagent-selected-agent',
      delegationEnabled: true,
      delegationTargetMode: 'selected',
      delegationTargetAgentIds: ['allowed-agent'],
    })

    try {
      const tool = built.tools.find((entry) => entry.name === 'spawn_subagent')
      assert.ok(tool, 'spawn_subagent should be available when delegation is enabled')

      const raw = await tool!.invoke({
        action: 'start',
        agentId: 'blocked-agent',
        message: 'hello',
      })

      assert.match(String(raw), /allowed delegation list/i)
    } finally {
      await built.cleanup()
    }
  })

  it('resolves best_fit start requests to the best allowed delegate', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const toolsMod = await import('./src/lib/server/session-tools')
      const storage = storageMod.default || storageMod
      const toolsApi = toolsMod.default || toolsMod

      const now = Date.now()
      storage.saveAgents({
        ceo: {
          id: 'ceo',
          name: 'CEO',
          role: 'coordinator',
          description: 'Executes through specialists',
          systemPrompt: '',
          provider: 'openai',
          model: 'gpt-test',
          capabilities: ['coordination', 'delegation', 'operations'],
          delegationEnabled: true,
          delegationTargetMode: 'selected',
          delegationTargetAgentIds: ['builder', 'writer'],
          createdAt: now,
          updatedAt: now,
        },
        builder: {
          id: 'builder',
          name: 'Builder',
          role: 'worker',
          description: 'Builds product changes',
          systemPrompt: '',
          provider: 'openai',
          model: 'gpt-test',
          capabilities: ['coding', 'implementation', 'debugging'],
          createdAt: now,
          updatedAt: now,
        },
        writer: {
          id: 'writer',
          name: 'Writer',
          role: 'worker',
          description: 'Writes and edits content',
          systemPrompt: '',
          provider: 'openai',
          model: 'gpt-test',
          capabilities: ['writing', 'editing'],
          createdAt: now,
          updatedAt: now,
        },
      })

      const built = await toolsApi.buildSessionTools(process.env.WORKSPACE_DIR, ['spawn_subagent'], {
        sessionId: 'session-best-fit',
        agentId: 'ceo',
        delegationEnabled: true,
        delegationTargetMode: 'selected',
        delegationTargetAgentIds: ['builder', 'writer'],
      })

      try {
        const tool = built.tools.find((entry) => entry.name === 'spawn_subagent')
        const raw = await tool.invoke({
          action: 'start',
          selectionMode: 'best_fit',
          message: 'Implement the API change and fix the failing tests.',
          workType: 'coding',
          requiredCapabilities: ['coding', 'debugging'],
          background: true,
        })
        console.log(JSON.stringify(JSON.parse(String(raw))))
      } finally {
        await built.cleanup()
      }
      process.exit(0)
    `)

    assert.equal(output.selectionMode, 'best_fit')
    assert.equal(output.agentId, 'builder')
    assert.equal(output.workType, 'coding')
    assert.deepEqual(output.requiredCapabilities, ['coding', 'debugging'])
  })
})
