import Database from 'better-sqlite3'

function normalizeLockTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return 1_000
  return Math.max(1_000, Math.trunc(ttlMs))
}

/**
 * Attempt to acquire a named runtime lock.
 * Returns true if the lock was acquired (or renewed for the same owner),
 * false if another owner holds an active lock.
 */
export function tryAcquireRuntimeLock(db: Database.Database, name: string, owner: string, ttlMs: number): boolean {
  let acquired = false
  const now = Date.now()
  const expiresAt = now + normalizeLockTtlMs(ttlMs)
  const transaction = db.transaction(() => {
    const row = db.prepare('SELECT owner, expires_at FROM runtime_locks WHERE name = ?').get(name) as
      | { owner: string; expires_at: number }
      | undefined
    if (!row || row.owner === owner || row.expires_at <= now) {
      db.prepare(`
        INSERT OR REPLACE INTO runtime_locks (name, owner, expires_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(name, owner, expiresAt, now)
      acquired = true
    }
  })
  transaction()
  return acquired
}

/** Renew an existing lock for the given owner. Returns true if renewed. */
export function renewRuntimeLock(db: Database.Database, name: string, owner: string, ttlMs: number): boolean {
  const now = Date.now()
  const expiresAt = now + normalizeLockTtlMs(ttlMs)
  const result = db.prepare(`
    UPDATE runtime_locks
    SET expires_at = ?, updated_at = ?
    WHERE name = ? AND owner = ?
  `).run(expiresAt, now, name, owner)
  return result.changes > 0
}

/** Read the current state of a runtime lock. */
export function readRuntimeLock(db: Database.Database, name: string): { owner: string; expiresAt: number; updatedAt: number } | null {
  const row = db.prepare('SELECT owner, expires_at, updated_at FROM runtime_locks WHERE name = ?').get(name) as
    | { owner: string; expires_at: number; updated_at: number }
    | undefined
  if (!row) return null
  return {
    owner: row.owner,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  }
}

/** Check whether a named lock is currently held by any owner. */
export function isRuntimeLockActive(db: Database.Database, name: string): boolean {
  const row = readRuntimeLock(db, name)
  return Boolean(row && row.expiresAt > Date.now())
}

/** Release a lock held by the given owner. */
export function releaseRuntimeLock(db: Database.Database, name: string, owner: string): void {
  db.prepare('DELETE FROM runtime_locks WHERE name = ? AND owner = ?').run(name, owner)
}
