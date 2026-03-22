import fs from 'node:fs'
import path from 'node:path'

import { DATA_DIR } from '@/lib/server/data-dir'
import type { DaemonAdminMetadata } from '@/lib/server/daemon/types'

function resolveHomeDir(): string {
  const configured = process.env.SWARMCLAW_HOME?.trim()
  if (configured) return path.resolve(configured)
  return path.dirname(DATA_DIR)
}

export const DAEMON_ADMIN_METADATA_PATH = path.join(resolveHomeDir(), 'daemon-admin.json')
export const DAEMON_LOG_PATH = path.join(resolveHomeDir(), 'daemon.log')

export function isProcessRunning(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function normalizeMetadata(value: unknown): DaemonAdminMetadata | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<DaemonAdminMetadata>
  const pid = typeof candidate.pid === 'number' && Number.isFinite(candidate.pid) ? Math.trunc(candidate.pid) : null
  const port = typeof candidate.port === 'number' && Number.isFinite(candidate.port) ? Math.trunc(candidate.port) : null
  const token = typeof candidate.token === 'string' ? candidate.token.trim() : ''
  if (!pid || !port || !token) return null
  return {
    pid,
    port,
    token,
    launchedAt: typeof candidate.launchedAt === 'number' && Number.isFinite(candidate.launchedAt)
      ? Math.trunc(candidate.launchedAt)
      : Date.now(),
    source: typeof candidate.source === 'string' ? candidate.source : null,
  }
}

export function readDaemonAdminMetadata(): DaemonAdminMetadata | null {
  try {
    const raw = JSON.parse(fs.readFileSync(DAEMON_ADMIN_METADATA_PATH, 'utf8'))
    return normalizeMetadata(raw)
  } catch {
    return null
  }
}

export function writeDaemonAdminMetadata(metadata: DaemonAdminMetadata): void {
  fs.mkdirSync(path.dirname(DAEMON_ADMIN_METADATA_PATH), { recursive: true })
  fs.writeFileSync(DAEMON_ADMIN_METADATA_PATH, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export function clearDaemonAdminMetadata(): void {
  try {
    fs.unlinkSync(DAEMON_ADMIN_METADATA_PATH)
  } catch {
    // Ignore missing metadata file.
  }
}
