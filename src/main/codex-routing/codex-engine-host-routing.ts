import type { CodexEngineHostOptions } from './codex-engine-host-options'
import type { CodexPoolSelectionState } from './codex-pool-turn-session'
import type { EngineGrantDescriptor } from './engine-grant-files'
import { createCodexEngineNativeSessionLifetime } from './codex-engine-native-session-lifetime'
import { CodexEngineRequestRecovery } from './codex-engine-request-recovery'
import { CodexEngineHttpListener } from './codex-engine-http-listener'
import { CODEX_ROUTING_RESPONSE_HEADER_TIMEOUT_MS } from './codex-routing-http-types'
import { CodexReplaySpoolBudget } from './codex-replay-spool'

type Owner = {
  accepting(): boolean
  readState(id: string): CodexPoolSelectionState
  connection(id: string): EngineGrantDescriptor | null
  connections(): EngineGrantDescriptor[]
  closing(): boolean
  nativeClientKey(): string
  stop(): Promise<void>
  transition(parent: AbortSignal, operation: (signal: AbortSignal) => Promise<void>): Promise<void>
}

export function createCodexEngineHostRouting(options: CodexEngineHostOptions, owner: Owner) {
  const lifetime = createCodexEngineNativeSessionLifetime(
    options,
    owner.accepting,
    owner.readState,
    owner.connection,
    () => recovery.request()
  )
  const recovery = new CodexEngineRequestRecovery({
    ...lifetime,
    queueTimeoutMs: CODEX_ROUTING_RESPONSE_HEADER_TIMEOUT_MS,
    connections: owner.connections,
    accounts: () => options.listAccounts(),
    closing: owner.closing,
    transition: owner.transition
  })
  const replayBudget = options.replaySpoolDirectory
    ? new CodexReplaySpoolBudget(options.replaySpoolDirectory, 0, options.assertExclusiveProfile)
    : undefined
  const front = new CodexEngineHttpListener(
    options.maxRequestBytes,
    lifetime.sessions.prepare,
    () => {
      void owner.stop().catch(() => {})
    },
    owner.nativeClientKey,
    replayBudget,
    () => recovery.request(),
    (_token, signal) => recovery.waitForReady(signal)
  )
  return { ...lifetime, recovery, front }
}
