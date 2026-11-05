import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { CodexPoolSelectionState } from './codex-pool-turn-session'
import type { CodexEngineLifecycleOptions } from './codex-engine-lifecycle'
import type { EngineGrantAccount } from './engine-grant-files'
import type { CodexHostQuotaFailure } from './codex-host-quota-retry'
import type {
  EngineDeviceLoginOptions,
  EngineDeviceLoginOutcome
} from './engine-device-login-process'

export type CodexEngineHostOptions = CodexEngineLifecycleOptions & {
  db: OrchestrationDb
  readAccount: (id: string) => EngineGrantAccount | null
  listAccounts: () => EngineGrantAccount[]
  readSelectionState: (launchId: string) => CodexPoolSelectionState
  withAccountMutationLease: <T>(operation: () => Promise<T>) => Promise<T>
  assertEnrollmentIdle: (accountId: string) => void
  runLogin?: (options: EngineDeviceLoginOptions) => Promise<EngineDeviceLoginOutcome>
  transitionTimeoutMs?: number
  recordQuotaFailure?: (event: CodexHostQuotaFailure) => boolean
}
