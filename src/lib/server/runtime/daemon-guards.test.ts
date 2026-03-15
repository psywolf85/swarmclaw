import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
  SWARMCLAW_DAEMON_AUTOSTART: process.env.SWARMCLAW_DAEMON_AUTOSTART,
  SWARMCLAW_DAEMON_BACKGROUND_SERVICES: process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES,
}

let tempDir = ''
let mod: typeof import('@/lib/server/runtime/daemon-state')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-daemon-guards-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  process.env.SWARMCLAW_DAEMON_AUTOSTART = '0'
  mod = await import('@/lib/server/runtime/daemon-state')
})

after(async () => {
  try { await mod.stopDaemon({ source: 'test-cleanup' }) } catch { /* ignore */ }
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
})

// ── getDaemonStatus includes guards ──────────────────────────────────────

describe('getDaemonStatus guards field', () => {
  it('includes guards key with expected shape', () => {
    const status = mod.getDaemonStatus()
    assert.ok('guards' in status, 'status should have guards field')
    const { guards } = status
    assert.equal(typeof guards.healthCheckRunning, 'boolean')
    assert.equal(typeof guards.connectorHealthCheckRunning, 'boolean')
    assert.equal(typeof guards.shuttingDown, 'boolean')
    assert.equal(typeof guards.providerCircuitBreakers, 'number')
  })

  it('guards defaults are all false/zero when idle', () => {
    const { guards } = mod.getDaemonStatus()
    assert.equal(guards.healthCheckRunning, false)
    assert.equal(guards.connectorHealthCheckRunning, false)
    assert.equal(guards.shuttingDown, false)
    assert.equal(guards.providerCircuitBreakers, 0)
  })
})

// ── shuttingDown flag lifecycle ──────────────────────────────────────────

describe('shuttingDown flag', () => {
  it('resets to false after stopDaemon completes', async () => {
    mod.startDaemon({ source: 'test', manualStart: true })
    await mod.stopDaemon({ source: 'test' })
    const { guards } = mod.getDaemonStatus()
    assert.equal(guards.shuttingDown, false)
  })

  it('double stopDaemon calls do not throw', async () => {
    mod.startDaemon({ source: 'test', manualStart: true })
    await mod.stopDaemon({ source: 'first' })
    await assert.doesNotReject(() => mod.stopDaemon({ source: 'second' }))
    assert.equal(mod.getDaemonStatus().running, false)
  })
})
