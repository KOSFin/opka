import type { AutomationCommandDefinitionCreateV1 } from '../../../../shared/automation-command-domain'
import type { AutomationCommandDraft } from './automation-command-draft'

export type PendingCommandCreate = {
  readonly input: AutomationCommandDefinitionCreateV1
  readonly draft: AutomationCommandDraft
}

export type PendingCommandRun = {
  readonly id: string
  readonly revision: number
  readonly key: string
  readonly createdAt: number
}

export type PendingCommandCancel = {
  readonly automationId: string
  readonly runId: string
  readonly key: string
}

export type PendingRequests = {
  create: PendingCommandCreate | null
  runs: Map<string, PendingCommandRun>
  cancels: Map<string, PendingCommandCancel>
}

const requestsByHost = new Map<string, PendingRequests>()

export function commandRequestNow(): number {
  return Date.now()
}

export function pendingCommandRequests(hostKey: string): PendingRequests {
  let pending = requestsByHost.get(hostKey)
  if (!pending) {
    pending = { create: null, runs: new Map(), cancels: new Map() }
    requestsByHost.set(hostKey, pending)
  }
  return pending
}
