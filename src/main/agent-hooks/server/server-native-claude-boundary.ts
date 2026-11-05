import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import { AgentHookServerNativeClaudeCoverage } from './server-native-claude-coverage'

/** Use the existing canonical hook receipt to reject stale or child-origin private callbacks. */
export abstract class AgentHookServerNativeClaudeBoundary extends AgentHookServerNativeClaudeCoverage {
  readNativeClaudeChildInventory(row: AgentStatusIpcPayload): {
    status: 'settled' | 'live' | 'unverifiable'
  } {
    const current = this.state.lastStatusByPaneKey.get(row.paneKey)
    if (
      !current ||
      !this.readNativeClaudePromptId(row) ||
      current.hookEventName !== 'Stop' ||
      current.payload.claudeNativeBoundaryInventory !== 'complete' ||
      current.toolAgentId ||
      current.payload.mainAgent?.state !== 'done' ||
      row.mainAgent?.state !== 'done' ||
      current.payload.sessionBoundary ||
      row.sessionBoundary ||
      current.payload.interrupted ||
      row.interrupted
    ) {
      return { status: 'unverifiable' }
    }
    const roster = this.state.claudeSubagentRosterByPaneKey.get(row.paneKey)
    if ([...(roster?.values() ?? [])].some((child) => child.restoredFromSnapshot)) {
      return { status: 'unverifiable' }
    }
    const live =
      current.payload.state !== 'done' ||
      row.state !== 'done' ||
      [...(roster?.values() ?? [])].some((child) => child.state !== 'idle') ||
      this.state.claudeRunningNonAgentTaskPaneKeys.has(row.paneKey) ||
      this.state.claudeActiveSessionCronPaneKeys.has(row.paneKey) ||
      current.claudeRunningNonAgentTask ||
      current.payload.claudeTaskWakeupPending
    return { status: live ? 'live' : 'settled' }
  }

  readNativeClaudePromptId(row: AgentStatusIpcPayload): string | null {
    const current = this.state.lastStatusByPaneKey.get(row.paneKey)
    return current &&
      current.connectionId === null &&
      row.connectionId === null &&
      current.payload.agentType === 'claude' &&
      row.agentType === 'claude' &&
      row.providerSession &&
      current.providerSession?.id === row.providerSession.id &&
      'receivedAt' in current &&
      current.receivedAt === row.receivedAt &&
      !current.isReplay &&
      !row.isReplay &&
      !row.restoredUnconfirmed &&
      !current.restoredUnconfirmed &&
      !current.toolAgentId &&
      row.observation?.origin === 'hook' &&
      row.observation.kind === 'transition' &&
      current.providerPromptId
      ? current.providerPromptId
      : null
  }
}
