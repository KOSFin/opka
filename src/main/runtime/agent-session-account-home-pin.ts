import { isDeepStrictEqual } from 'node:util'
import {
  isAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

export type AgentSessionAccountHomePin = {
  sessionId: string
  fence: number
  spawnToken: string
  expectedHome: AgentSessionAccountHome
  accountHome: AgentSessionAccountHome
  now: number
}

/** Only a first acquisition may choose credentials; existing history needs an explicit migration. */
export function pinAgentSessionAccountHome(
  record: AgentSessionRecord,
  pin: AgentSessionAccountHomePin
): AgentSessionRecord {
  const { lease } = record
  if (
    record.sessionId !== pin.sessionId ||
    lease.runtimeFence !== pin.fence ||
    lease.reservedSpawnToken !== pin.spawnToken ||
    lease.claimStatus !== 'reserved' ||
    lease.ownerProcess !== null ||
    lease.provenHandleLinkId !== null ||
    record.providerHandleChain.length !== 0 ||
    !isDeepStrictEqual(record.accountHome, pin.expectedHome)
  ) {
    throw new Error('Native account selection lost its unused startup reservation')
  }
  if (
    !isAgentSessionAccountHome(pin.accountHome) ||
    !('variable' in pin.accountHome) ||
    pin.accountHome.variable !==
      (record.provider === 'claude'
        ? 'CLAUDE_CONFIG_DIR'
        : record.provider === 'codex'
          ? 'CODEX_HOME'
          : null)
  ) {
    throw new Error('Native account selection does not match the provider')
  }
  return isDeepStrictEqual(record.accountHome, pin.accountHome)
    ? record
    : { ...record, accountHome: pin.accountHome, updatedAt: pin.now }
}
