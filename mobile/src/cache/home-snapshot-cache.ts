// Why: persist the data needed to render the home page so cold-start /
// resume-from-background paints instantly with the last known good
// values, then updates in place when fresh RPC data arrives. Without
// this, Resume and Account-usage cards flash empty for ~1s while the
// WebSocket reconnects and the first responses come back.
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { AccountsSnapshot } from '../components/AccountUsage'
// Why: the canonical shape, so persisted counts keep carrying countsProvenAt — the home card
// needs it to know whether a rehydrated count is minutes or days old.
import type { HostWorktreeInfo } from '../worktree/home-worktree-info'

const STORAGE_KEY = 'orca:home-snapshot:v1'
const MAX_SNAPSHOT_AGE_MS = 10 * 60_000
const MAX_SNAPSHOT_HOSTS = 20
const MAX_SNAPSHOT_CHARACTERS = 1024 * 1024

export type HomeSnapshot = {
  worktreeInfo: Record<string, HostWorktreeInfo>
  accountsByHost: Record<string, AccountsSnapshot>
  savedAt: number
}

let memoryCache: HomeSnapshot | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null

function validSnapshot(value: unknown, now: number): value is HomeSnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('worktreeInfo' in value) ||
    !('accountsByHost' in value) ||
    !('savedAt' in value)
  ) {
    return false
  }
  return (
    typeof value.worktreeInfo === 'object' &&
    value.worktreeInfo !== null &&
    !Array.isArray(value.worktreeInfo) &&
    typeof value.accountsByHost === 'object' &&
    value.accountsByHost !== null &&
    !Array.isArray(value.accountsByHost) &&
    typeof value.savedAt === 'number' &&
    Number.isFinite(value.savedAt) &&
    value.savedAt <= now &&
    now - value.savedAt <= MAX_SNAPSHOT_AGE_MS
  )
}

function retainRecentHosts<T>(records: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(records).slice(-MAX_SNAPSHOT_HOSTS))
}

export async function loadHomeSnapshot(): Promise<HomeSnapshot | null> {
  if (memoryCache && validSnapshot(memoryCache, Date.now())) {
    return memoryCache
  }
  memoryCache = null
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (!raw || raw.length > MAX_SNAPSHOT_CHARACTERS) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    if (!validSnapshot(parsed, Date.now())) {
      return null
    }
    memoryCache = {
      ...parsed,
      worktreeInfo: retainRecentHosts(parsed.worktreeInfo),
      accountsByHost: retainRecentHosts(parsed.accountsByHost)
    }
    return memoryCache
  } catch {
    return null
  }
}

// Why: throttle writes so a flurry of streamed account-snapshot updates
// (one per provider fetch finishing) doesn't hammer AsyncStorage.
export function saveHomeSnapshot(snapshot: HomeSnapshot): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
  }
  const bounded = {
    ...snapshot,
    worktreeInfo: retainRecentHosts(snapshot.worktreeInfo),
    accountsByHost: retainRecentHosts(snapshot.accountsByHost)
  }
  const serialized = JSON.stringify(bounded)
  if (serialized.length > MAX_SNAPSHOT_CHARACTERS) {
    memoryCache = null
    writeTimer = null
    void AsyncStorage.removeItem(STORAGE_KEY).catch(() => {})
    return
  }
  memoryCache = bounded
  writeTimer = setTimeout(() => {
    writeTimer = null
    void AsyncStorage.setItem(STORAGE_KEY, serialized).catch(() => {})
  }, 250)
}
