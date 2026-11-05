import { lstatSync } from 'node:fs'
import SyncDatabase from '../sqlite/sync-database'
import { findNewestCodexStateDbPath } from './codex-state-db'

/** Exact read-only lookup; callers still verify containment and native session metadata. */
export function readIndexedCodexRolloutPath(home: string, threadId: string): string | null {
  const path = findNewestCodexStateDbPath(home)
  if (!path) {
    return null
  }
  let db: SyncDatabase | null = null
  try {
    const metadata = lstatSync(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return null
    }
    db = new SyncDatabase(path, { readonly: true, fileMustExist: true })
    db.pragma('busy_timeout = 25')
    const row = db.prepare('SELECT rollout_path FROM threads WHERE id=? LIMIT 1').get(threadId)
    return row && typeof row.rollout_path === 'string' && row.rollout_path.length <= 8192
      ? row.rollout_path
      : null
  } catch {
    return null
  } finally {
    db?.close()
  }
}
