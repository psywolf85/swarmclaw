import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { Agent } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let memDb: typeof import('@/lib/server/memory/memory-db')
let storage: typeof import('@/lib/server/storage')
let consolidation: typeof import('@/lib/server/memory/memory-consolidation')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-memory-consolidation-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'

  memDb = await import('@/lib/server/memory/memory-db')
  storage = await import('@/lib/server/storage')
  consolidation = await import('@/lib/server/memory/memory-consolidation')
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

test('runDailyConsolidation skips orphaned and CLI-only agent namespaces without reporting errors', async () => {
  const db = memDb.getMemoryDb()
  const now = Date.now()
  const orphanId = 'live-orphan-agent'
  const cliOnlyId = 'live-cli-agent'

  storage.saveAgents({
    [cliOnlyId]: {
      id: cliOnlyId,
      name: 'CLI-only Agent',
      description: '',
      systemPrompt: '',
      provider: 'claude-cli',
      model: 'claude-sonnet-4-5',
      credentialId: null,
      fallbackCredentialIds: [],
      apiEndpoint: null,
      createdAt: now,
      updatedAt: now,
    } as Agent,
  })

  for (let index = 0; index < 5; index += 1) {
    db.add({
      agentId: orphanId,
      category: 'note',
      title: `Orphan note ${index + 1}`,
      content: `orphan content ${index + 1}`,
    })
    db.add({
      agentId: cliOnlyId,
      category: 'note',
      title: `CLI note ${index + 1}`,
      content: `cli content ${index + 1}`,
    })
  }

  const stats = await consolidation.runDailyConsolidation()
  const digestTitle = `Daily digest: ${new Date().toISOString().slice(0, 10)}`

  assert.deepEqual(stats.errors, [])
  assert.equal(
    db.search(digestTitle, orphanId).some((entry) => entry.category === 'daily_digest'),
    false,
  )
  assert.equal(
    db.search(digestTitle, cliOnlyId).some((entry) => entry.category === 'daily_digest'),
    false,
  )
})
