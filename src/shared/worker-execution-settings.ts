import type { GlobalSettings } from './global-settings-types'
import { resolveNestedWorkerMaxDepth } from './nested-worker-depth'
import { resolveWorkerConcurrencyLimit } from './worker-concurrency-limit'

type WorkerSettings = Pick<GlobalSettings, 'nestedWorkerMaxDepth' | 'maxConcurrentWorkers'>

export function normalizeWorkerExecutionSettings(updates: WorkerSettings): WorkerSettings {
  const normalized: WorkerSettings = {}
  if ('nestedWorkerMaxDepth' in updates) {
    normalized.nestedWorkerMaxDepth = resolveNestedWorkerMaxDepth(updates)
  }
  if ('maxConcurrentWorkers' in updates) {
    normalized.maxConcurrentWorkers =
      resolveWorkerConcurrencyLimit(updates.maxConcurrentWorkers) ?? null
  }
  return normalized
}
