import type { AutomationService } from '../automations/service'
import {
  AutomationCommandDefinitionCreateV1,
  type AutomationCommandDefinitionV1
} from '../../shared/automation-command-domain'
import type { AutomationOwnerPrecondition } from '../../shared/automation-owner-precondition'
import type { CommandRunClaimResult } from '../persistence/scheduling-automations/automation-command-claim-operations'
import type { RuntimeStore } from './runtime-store-contract'
import { assertCommandAutomationOwner } from '../../shared/automation-command-owner'

/** Versioned command definitions use the same Store and service as legacy automations. */
export class RuntimeCommandAutomationController {
  private service: AutomationService | null = null

  constructor(private readonly store: RuntimeStore | null) {}

  setService(service: AutomationService): void {
    this.service = service
  }

  available(): boolean {
    return this.service?.commandPipelineAvailable() ?? false
  }

  list(): AutomationCommandDefinitionV1[] {
    if (!this.store?.listCommandAutomations) {
      throw new Error('runtime_unavailable')
    }
    return this.store.listCommandAutomations()
  }

  ownedDefinition(id: string, expectedOwner?: AutomationOwnerPrecondition) {
    const definition = this.store?.listCommandAutomations?.()?.find((entry) => entry.id === id)
    if (!definition) {
      return null
    }
    assertCommandAutomationOwner(definition, expectedOwner)
    if (this.store?.listAutomations?.()?.some((entry) => entry.id === id)) {
      throw new Error('Automation identity is ambiguous.')
    }
    return definition
  }

  private requireOwnedDefinition(id: string, expectedOwner?: AutomationOwnerPrecondition) {
    const definition = this.ownedDefinition(id, expectedOwner)
    if (!definition) {
      throw new Error('Command automation changed or is unavailable.')
    }
    return definition
  }

  manualReceipt(automationId: string, requestKey: string) {
    this.requireOwnedDefinition(automationId)
    if (!this.store?.getCommandAutomationManualReceipt) {
      throw new Error('runtime_unavailable')
    }
    return this.store.getCommandAutomationManualReceipt(automationId, requestKey)
  }

  async create(input: AutomationCommandDefinitionCreateV1): Promise<AutomationCommandDefinitionV1> {
    if (!this.store?.createCommandAutomation || !this.store.flushPendingOrThrowAsync) {
      throw new Error('runtime_unavailable')
    }
    assertCommandAutomationOwner(input)
    const definition = this.store.createCommandAutomation(input)
    await this.store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    return definition
  }

  async update(
    id: string,
    expectedRevision: number,
    expectedOwner: AutomationOwnerPrecondition,
    updates: Partial<AutomationCommandDefinitionCreateV1>
  ): Promise<AutomationCommandDefinitionV1> {
    if (!this.store?.replaceCommandAutomation || !this.store.flushPendingOrThrowAsync) {
      throw new Error('runtime_unavailable')
    }
    const current = this.requireOwnedDefinition(id, expectedOwner)
    if (!current || current.revision !== expectedRevision) {
      throw new Error('Command automation changed or is unavailable.')
    }
    const {
      id: _id,
      revision: _revision,
      creationPayloadHash: _creationPayloadHash,
      nextRunAt: _nextRunAt,
      lastAdmittedOccurrenceAt: _lastAdmittedOccurrenceAt,
      lastRunAt: _lastRunAt,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...base
    } = current
    const input = AutomationCommandDefinitionCreateV1.parse({ ...base, ...updates })
    assertCommandAutomationOwner(input, expectedOwner)
    const definition = this.store.replaceCommandAutomation(id, expectedRevision, input)
    await this.store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    return definition
  }

  async delete(
    id: string,
    expectedRevision: number,
    expectedOwner: AutomationOwnerPrecondition
  ): Promise<void> {
    this.requireOwnedDefinition(id, expectedOwner)
    if (!this.store?.deleteCommandAutomation || !this.store.flushPendingOrThrowAsync) {
      throw new Error('runtime_unavailable')
    }
    this.store.deleteCommandAutomation(id, expectedRevision)
    await this.store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
  }

  async runNow(
    id: string,
    expectedRevision: number,
    expectedOwner: AutomationOwnerPrecondition,
    manualRequest: { key: string; createdAt: number; payloadHash: string }
  ): Promise<CommandRunClaimResult> {
    this.requireOwnedDefinition(id, expectedOwner)
    if (!this.service?.commandPipelineAvailable()) {
      throw new Error('automation_command_unsupported')
    }
    return this.service.runCommandNow({
      automationId: id,
      definitionRevision: expectedRevision,
      manualRequest
    })
  }

  async cancel(
    id: string,
    runId: string,
    expectedOwner: AutomationOwnerPrecondition,
    requestKey: string
  ) {
    this.requireOwnedDefinition(id, expectedOwner)
    if (!this.service) {
      throw new Error('runtime_unavailable')
    }
    return this.service.requestCommandCancel(id, runId, requestKey)
  }
}
