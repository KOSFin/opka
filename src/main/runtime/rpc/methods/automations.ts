import { AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY } from '../../../../shared/automation-runtime-capabilities'
import type { AutomationOwnerPrecondition } from '../../../../shared/automation-owner-precondition'
import { defineMethod, type RpcContext } from '../core'
import {
  AutomationCreate,
  AutomationId,
  AutomationList,
  AutomationRuns,
  AutomationUpdate
} from '../../../../shared/rpc-contract/automation-params'
import {
  AutomationCreateV2,
  AutomationUpdateV2,
  AutomationDeleteV2,
  AutomationRunNowV2,
  AutomationCancelRunV1
} from '../../../../shared/rpc-contract/automation-command-params'

function assertCommandHost(context: RpcContext): void {
  if (!context.runtime.commandAutomationAvailable()) {
    throw new Error('automation_command_unsupported')
  }
}

function canReadCommands(context: RpcContext): boolean {
  return (
    context.clientCapabilities?.includes(AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY) === true
  )
}

function mutationOwner(
  id: string,
  expectedOwner: AutomationOwnerPrecondition | undefined,
  context: RpcContext
): AutomationOwnerPrecondition | undefined {
  if (
    expectedOwner ||
    context.clientCapabilities === undefined ||
    context.clientCapabilities.includes(AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY)
  ) {
    return expectedOwner
  }
  // Legacy clients cannot echo owner metadata, so snapshot it at the RPC boundary.
  return context.runtime.automationOwnerPrecondition(id) ?? undefined
}

export const AUTOMATION_METHODS = [
  defineMethod({
    name: 'automation.createV2',
    permission: 'workspace',
    params: AutomationCreateV2,
    handler: async (params, context) => {
      assertCommandHost(context)
      return { automation: await context.runtime.createCommandAutomation(params.definition) }
    }
  }),
  defineMethod({
    name: 'automation.updateV2',
    permission: 'workspace',
    params: AutomationUpdateV2,
    handler: async (params, context) => {
      assertCommandHost(context)
      return {
        automation: await context.runtime.updateCommandAutomation(
          params.id,
          params.expectedRevision,
          params.expectedOwner,
          params.updates
        )
      }
    }
  }),
  defineMethod({
    name: 'automation.deleteV2',
    permission: 'workspace',
    params: AutomationDeleteV2,
    handler: async (params, context) => {
      assertCommandHost(context)
      return context.runtime.deleteCommandAutomation(
        params.id,
        params.expectedRevision,
        params.expectedOwner
      )
    }
  }),
  defineMethod({
    name: 'automation.runNowV2',
    permission: 'workspace',
    params: AutomationRunNowV2,
    handler: async (params, context) => {
      assertCommandHost(context)
      return {
        admission: await context.runtime.runCommandAutomationNow(
          params.id,
          params.expectedRevision,
          params.expectedOwner,
          {
            key: params.requestKey,
            createdAt: params.requestCreatedAt,
            payloadHash: params.payloadHash
          }
        )
      }
    }
  }),
  defineMethod({
    name: 'automation.cancelRunV1',
    permission: 'workspace',
    params: AutomationCancelRunV1,
    handler: (params, context) =>
      context.runtime.cancelCommandAutomationRun(
        params.id,
        params.runId,
        params.expectedOwner,
        params.requestKey
      )
  }),
  defineMethod({
    name: 'automation.list',
    permission: 'workspace',
    params: AutomationList,
    // The projection retains `automations`, so old clients ignore the added owner metadata.
    handler: (params, context) => {
      const result = context.runtime.listAutomationsForScope(params)
      return canReadCommands(context)
        ? { ...result, commandAutomations: context.runtime.listCommandAutomations() }
        : result
    }
  }),
  defineMethod({
    name: 'automation.show',
    permission: 'workspace',
    params: AutomationId,
    // Why: the owner rides along so a client that cannot project one itself — the
    // CLI — can echo it back on the mutation that follows. Optional: an older
    // host omits it, and an older client ignores it.
    handler: (params, context) => {
      const { runtime } = context
      if (canReadCommands(context)) {
        const command = runtime.listCommandAutomations().find((entry) => entry.id === params.id)
        if (command) {
          if (params.expectedOwner && params.expectedOwner.selector.kind !== 'self') {
            throw new Error('Command automation execution host changed or is unsupported.')
          }
          return { automation: command, owner: { selector: { kind: 'self' as const } } }
        }
      }
      const automation = runtime.showAutomation(params.id, params.expectedOwner)
      const owner = runtime.automationOwnerPrecondition(params.id)
      return owner ? { automation, owner } : { automation }
    }
  }),
  defineMethod({
    name: 'automation.create',
    permission: 'workspace',
    params: AutomationCreate,
    handler: async (params, { runtime }) => ({
      automation: await runtime.createAutomation(params)
    })
  }),
  defineMethod({
    name: 'automation.update',
    permission: 'workspace',
    params: AutomationUpdate,
    handler: async (params, context) => ({
      automation: await context.runtime.updateAutomation(params.id, params.updates, {
        expectedOwner: mutationOwner(params.id, params.expectedOwner, context),
        destination: params.destination
      })
    })
  }),
  defineMethod({
    name: 'automation.delete',
    permission: 'workspace',
    params: AutomationId,
    handler: (params, context) =>
      context.runtime.deleteAutomation(
        params.id,
        mutationOwner(params.id, params.expectedOwner, context)
      )
  }),
  defineMethod({
    name: 'automation.runNow',
    permission: 'workspace',
    params: AutomationId,
    handler: async (params, context) => ({
      run: await context.runtime.runAutomationNow(
        params.id,
        mutationOwner(params.id, params.expectedOwner, context)
      )
    })
  }),
  defineMethod({
    name: 'automation.runs',
    permission: 'workspace',
    params: AutomationRuns,
    handler: (params, context) => {
      const { runtime } = context
      const visible = (run: { sessionKind: string }) =>
        canReadCommands(context) || run.sessionKind !== 'command'
      let manualReceipt
      if (params.manualRequestKey) {
        assertCommandHost(context)
        if (
          !canReadCommands(context) ||
          !params.automationId ||
          (params.expectedOwner && params.expectedOwner.selector.kind !== 'self')
        ) {
          throw new Error('Command run receipt host changed or is unsupported.')
        }
        manualReceipt = runtime.commandAutomationManualReceipt(
          params.automationId,
          params.manualRequestKey
        )
      }
      const receiptResult = params.manualRequestKey ? { manualReceipt } : {}
      if (params.limit !== undefined || params.cursor !== undefined) {
        const page = runtime.listAutomationRunsPage(
          params.automationId,
          params.expectedOwner,
          params.limit,
          params.cursor
        )
        return { ...page, runs: page.runs.filter(visible), ...receiptResult }
      }
      return {
        runs: runtime.listAutomationRuns(params.automationId, params.expectedOwner).filter(visible),
        ...receiptResult
      }
    }
  })
]
