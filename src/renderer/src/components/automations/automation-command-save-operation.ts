import type {
  AutomationCommandDefinitionV1,
  AutomationCommandReportTargetOption
} from '../../../../shared/automation-command-domain'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { AutomationHostTarget } from './automation-host-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import {
  createCommandAutomationForTarget,
  updateCommandAutomationForTarget
} from './automation-command-host-client'
import { commandDefinitionFromDraft, type AutomationCommandDraft } from './automation-command-draft'
import {
  commandRequestNow,
  type PendingCommandCreate,
  type PendingRequests
} from './automation-command-pending-requests'

type Input = {
  target: AutomationHostTarget
  setups: readonly ProjectHostSetup[]
  reportTargets?: readonly AutomationCommandReportTargetOption[]
  draft: AutomationCommandDraft
  editingId: string | null
  selected: AutomationCommandDefinitionV1 | null
  pending: PendingRequests
}

const DEFINITIVE_CREATE_REFUSALS = new Set([
  'Command automation project is unavailable.',
  'Command automation definition limit reached.'
])

export async function saveCommandAutomationDraft(input: Input): Promise<{
  saved: AutomationCommandDefinitionV1
  createRequest: PendingCommandCreate | null
}> {
  const { target, setups, draft, editingId, selected, pending } = input
  if (editingId && selected?.id !== editingId) {
    throw new Error('The selected automation changed. Reopen it before saving.')
  }
  const setup = setups.find((entry) => entry.id === draft.setupId)
  if (editingId && selected) {
    if (!setup) {
      throw new Error('Choose a ready project folder on this host.')
    }
    const parsed = commandDefinitionFromDraft(
      draft,
      setup,
      commandRequestNow(),
      undefined,
      input.reportTargets
    )
    const saved = await updateCommandAutomationForTarget(target, editingId, selected.revision, {
      name: parsed.name,
      runContext: parsed.runContext,
      projectId: parsed.projectId,
      workspaceId: parsed.workspaceId,
      execution: parsed.execution,
      timezone: parsed.timezone,
      rrule: parsed.rrule,
      dtstart: parsed.dtstart
    })
    return { saved, createRequest: null }
  }
  let createRequest = pending.create
  let onPreflightAccepted: (() => void) | undefined
  if (!createRequest) {
    if (!setup) {
      throw new Error('Choose a ready project folder on this host.')
    }
    const parsed = commandDefinitionFromDraft(
      draft,
      setup,
      commandRequestNow(),
      undefined,
      input.reportTargets
    )
    createRequest = { input: parsed, draft: { ...draft } }
    const candidate = createRequest
    onPreflightAccepted = () => {
      pending.create = candidate
    }
  }
  try {
    const saved = await createCommandAutomationForTarget(
      target,
      createRequest.input,
      onPreflightAccepted
    )
    return { saved, createRequest }
  } catch (cause) {
    if (
      cause instanceof RuntimeRpcCallError &&
      cause.code === 'runtime_error' &&
      DEFINITIVE_CREATE_REFUSALS.has(cause.message) &&
      pending.create === createRequest
    ) {
      pending.create = null
    }
    throw cause
  }
}
