import type { CodexTranscriptReadBudget } from '../../../shared/codex-rollout-jsonl-cursor'
import {
  createNativeCodexInventorySource,
  type NativeCodexInventorySourceOptions
} from '../native-codex-inventory-source'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import {
  readCodexNativeChildInventory,
  type NativeCodexChildInventory
} from '../../../shared/codex-native-child-inventory'
import { reconcileCodexSubagentTranscript } from '../../../shared/codex-subagent-transcript'
import { AgentHookServerStatusHookLifecycle } from './server-status-hook-lifecycle'

export abstract class AgentHookServerNativeCodexInventory extends AgentHookServerStatusHookLifecycle {
  private readonly nativeInventorySourceOwners = new Set<string>()
  registerNativeCodexInventorySource(options: NativeCodexInventorySourceOptions) {
    if (
      this.nativeInventorySourceOwners.size >= 64 ||
      this.nativeInventorySourceOwners.has(options.launchId)
    ) {
      throw new Error('Native inventory source ownership is unavailable')
    }
    const source = createNativeCodexInventorySource(this.state, options, () =>
      this.nativeInventorySourceOwners.delete(options.launchId)
    )
    this.nativeInventorySourceOwners.add(options.launchId)
    return source
  }

  readNativeCodexChildInventory(
    row: AgentStatusIpcPayload,
    budget: CodexTranscriptReadBudget = { remainingBytes: 1024 * 1024 }
  ): NativeCodexChildInventory {
    const current = this.state.lastStatusByPaneKey.get(row.paneKey)
    if (
      !current ||
      current.connectionId !== null ||
      row.connectionId !== null ||
      current.payload.agentType !== 'codex' ||
      row.agentType !== 'codex' ||
      !row.providerSession ||
      current.providerSession?.id !== row.providerSession.id ||
      !('receivedAt' in current) ||
      current.receivedAt !== row.receivedAt ||
      row.observation?.origin !== 'hook' ||
      row.observation.kind !== 'transition' ||
      current.isReplay ||
      row.isReplay ||
      row.restoredUnconfirmed ||
      row.sessionBoundary
    ) {
      return { status: 'unverifiable', reason: 'row-changed' }
    }
    const transcript = this.state.codexSubagentTranscriptByPaneKey.get(row.paneKey)
    const roster = this.state.codexSubagentRosterByPaneKey.get(row.paneKey)
    if (transcript?.parent.filePath && roster) {
      reconcileCodexSubagentTranscript(transcript, roster, transcript.parent.filePath, budget)
    }
    return readCodexNativeChildInventory(transcript, roster, row.providerSession.id)
  }
}
