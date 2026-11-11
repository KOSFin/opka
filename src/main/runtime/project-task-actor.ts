import { createHash } from 'node:crypto'
import type { DelegationActor } from '../../shared/project-task-delegation'
import { parseOrcaSessionAddress } from '../../shared/orca-session-address'
import { agentSessionLeaseAdmitsWriter } from '../../shared/agent-session-lease-adjudication'
import { lookupOrcaAgentSession } from './orchestration/structured-session-mail-address'
import { readAgentSessionRecordStore } from './orchestration/structured-session-lineage'
import { structuredWorkerHostScope } from './structured-worker-identity'
import { resolveOrchestrationParty } from './orchestration/orchestration-party'
import type { OrcaRuntimeService } from './orca-runtime'

function identity(kind: string, value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([kind, value]))
    .digest('hex')
}

export function resolveProjectTaskActor(
  runtime: OrcaRuntimeService,
  selector: string
): DelegationActor {
  const party = resolveOrchestrationParty(selector, runtime.getOrchestrationDb())
  const sessionId = parseOrcaSessionAddress(selector) ?? party.orcaSessionId
  const aliases: string[] = []
  if (sessionId) {
    const store = readAgentSessionRecordStore()
    const found = store && lookupOrcaAgentSession(store, sessionId)
    if (
      !found ||
      found.kind !== 'found' ||
      !structuredWorkerHostScope(found.record.location) ||
      !agentSessionLeaseAdmitsWriter(found.record.lease)
    ) {
      throw new Error('Grantee session is not verified live on this execution host')
    }
    aliases.push(identity('session', sessionId))
  }
  if (party.terminalHandle) {
    const terminal = runtime.getOrchestrationDispatchAuthority(party.terminalHandle)
    if (!terminal?.processIncarnation || terminal.hostScope.kind !== 'local') {
      if (!sessionId) {
        throw new Error('Grantee terminal incarnation is not verified on this host')
      }
    } else {
      aliases.push(identity('process', terminal.processIncarnation))
    }
  }
  const key = aliases[0]
  if (!key) {
    throw new Error('Grantee has no verified host identity')
  }
  return { key, aliases }
}
