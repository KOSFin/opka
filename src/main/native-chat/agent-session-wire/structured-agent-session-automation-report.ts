import { resolve } from 'node:path'
import type {
  AutomationCommandDefinitionV1,
  AutomationCommandReportTargetOption
} from '../../../shared/automation-command-domain'
import type { AutomationRun } from '../../../shared/automations-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { ProjectHostSetup } from '../../../shared/project-types'

type ReportTarget = NonNullable<AutomationCommandDefinitionV1['execution']['reportTarget']>
export type AutomationReportDelivery = 'delivered' | 'undelivered' | 'unverifiable'

function chatVisible(store: StructuredAgentSessionHostDeps['store'], sessionId: string): boolean {
  const index = store.getVisibleSessionTabIndex?.()
  return index?.present === true && index.sessionIds.includes(sessionId)
}

export async function listStructuredAutomationReportTargets(input: {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'resolveWorkspacePath'>
  runtimeId: string
  setups: readonly ProjectHostSetup[]
}): Promise<AutomationCommandReportTargetOption[]> {
  if (!input.deps.resolveWorkspacePath || input.deps.store.readOnly) {
    return []
  }
  const result: AutomationCommandReportTargetOption[] = []
  for (const record of input.deps.store.listRecords()) {
    if (
      record.location.executionHostId !== 'local' ||
      record.location.wslDistro !== null ||
      !chatVisible(input.deps.store, record.sessionId) ||
      !Number.isSafeInteger(record.lease.runtimeFence) ||
      record.lease.runtimeFence < 1
    ) {
      continue
    }
    let root: string
    try {
      root = await input.deps.resolveWorkspacePath(record.location.workspaceId)
    } catch {
      continue
    }
    const current = input.deps.store.getRecord(record.sessionId)
    if (
      current?.lease.runtimeFence !== record.lease.runtimeFence ||
      current.location.workspaceId !== record.location.workspaceId ||
      current.location.executionHostId !== 'local' ||
      current.location.wslDistro !== null ||
      !chatVisible(input.deps.store, record.sessionId)
    ) {
      continue
    }
    for (const setup of input.setups) {
      if (
        setup.hostId !== 'local' ||
        setup.setupState !== 'ready' ||
        resolve(setup.path) !== resolve(root)
      ) {
        continue
      }
      result.push({
        setupId: setup.id,
        label: record.conversationName ?? `Chat ${record.sessionId.slice(0, 8)}`,
        target: {
          runtimeId: input.runtimeId,
          hostId: 'local',
          workspaceId: record.location.workspaceId,
          chatSessionId: record.sessionId,
          registrationGeneration: record.lease.runtimeFence
        }
      })
    }
  }
  return result
}

export async function supportsStructuredAutomationReportTarget(input: {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'resolveWorkspacePath'>
  runtimeId: string
  target: ReportTarget
  workspaceId: string | null
  runPath: string | null
}): Promise<boolean> {
  const { deps, runtimeId, target, workspaceId, runPath } = input
  const record = deps.store.getRecord(target.chatSessionId)
  if (
    runtimeId !== target.runtimeId ||
    target.hostId !== 'local' ||
    workspaceId !== target.workspaceId ||
    !runPath ||
    !deps.resolveWorkspacePath ||
    deps.store.readOnly ||
    record?.sessionId !== target.chatSessionId ||
    record.location.executionHostId !== target.hostId ||
    record.location.wslDistro !== null ||
    record.location.workspaceId !== target.workspaceId ||
    record.lease.runtimeFence !== target.registrationGeneration ||
    !chatVisible(deps.store, target.chatSessionId)
  ) {
    return false
  }
  try {
    const root = await deps.resolveWorkspacePath(target.workspaceId)
    const current = deps.store.getRecord(target.chatSessionId)
    return (
      resolve(root) === resolve(runPath) &&
      current !== null &&
      current.sessionId === target.chatSessionId &&
      current.location.executionHostId === target.hostId &&
      current.location.wslDistro === null &&
      current.location.workspaceId === target.workspaceId &&
      current.lease.runtimeFence === target.registrationGeneration &&
      chatVisible(deps.store, target.chatSessionId)
    )
  } catch {
    return false
  }
}

export async function appendStructuredAutomationReport(input: {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'resolveWorkspacePath'>
  runtimeId: string
  target: ReportTarget
  run: AutomationRun
  openJournal(): Promise<AgentSessionJournal>
}): Promise<AutomationReportDelivery> {
  const { deps, runtimeId, target, run } = input
  const runPath = run.runContext?.path
  const readRecord = () => {
    const record = deps.store.getRecord(target.chatSessionId)
    return record?.sessionId === target.chatSessionId &&
      record.location.executionHostId === target.hostId &&
      record.location.wslDistro === null &&
      record.location.workspaceId === target.workspaceId &&
      record.lease.runtimeFence === target.registrationGeneration &&
      chatVisible(deps.store, target.chatSessionId)
      ? record
      : null
  }
  if (
    runtimeId !== target.runtimeId ||
    target.hostId !== 'local' ||
    run.sessionKind !== 'command' ||
    run.workspaceId !== target.workspaceId ||
    run.runContext?.hostId !== target.hostId ||
    !runPath ||
    !deps.resolveWorkspacePath ||
    deps.store.readOnly ||
    !readRecord()
  ) {
    return 'undelivered'
  }
  let journal: AgentSessionJournal
  let root: string
  try {
    journal = await input.openJournal()
    root = await deps.resolveWorkspacePath(target.workspaceId)
  } catch {
    return 'unverifiable'
  }
  const record = readRecord()
  if (!record || !runPath || resolve(root) !== resolve(runPath)) {
    return 'undelivered'
  }
  const identity = {
    provider: 'orca' as const,
    clientMessageId: `automation-report:${run.automationId}:${run.id}`
  }
  const itemId = agentJournalItemKey(identity)
  if (journal.snapshot().items.some((item) => item.itemId === itemId)) {
    return 'delivered'
  }
  try {
    await journal.appendItem(
      identity,
      {
        kind: 'status',
        presentation: 'automation-report',
        automationReport: { automationId: run.automationId, runId: run.id },
        text: `Automation report: run ${run.id}. Open Automations to read it.`
      },
      { fence: record.lease.runtimeFence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    return 'delivered'
  } catch {
    try {
      return (await journal.readInOrder(() =>
        journal.snapshot().items.some((item) => item.itemId === itemId)
      ))
        ? 'delivered'
        : 'unverifiable'
    } catch {
      return 'unverifiable'
    }
  }
}
