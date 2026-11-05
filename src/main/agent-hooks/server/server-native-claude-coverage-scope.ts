import type { NativeClaudeCanonicalHook } from '../../../shared/native-claude-canonical-hook'
import type { NativeCliStdioOwner } from '../../runtime/native-cli-stdio-owner'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import { foldNativeClaudeCanonicalHook } from './native-claude-canonical-fold'
import { claudeOwedTaskNotificationKinds } from '../../../shared/claude-owed-task-notifications'
import {
  AgentHookServerNativeClaudeTerminal,
  type NativeClaudeTerminalContext
} from './server-native-claude-terminal'

type Scope = { launchId: string; sessionId: string; startedAt: number; statusEnabled?: boolean }
export type NativeClaudeCoverageScope = Scope &
  (
    | { kind?: 'terminal'; paneKey: string; terminal?: NativeClaudeTerminalContext }
    | { kind: 'stdio'; owner: NativeCliStdioOwner }
  )

/** Capabilities authorize observation; only later completed canonical evidence authorizes switching. */
export abstract class AgentHookServerNativeClaudeCoverageScope extends AgentHookServerNativeClaudeTerminal {
  protected nativeClaudeCoverageKey(scope: NativeClaudeCoverageScope): string {
    return scope.kind === 'stdio'
      ? structuredAgentSessionPaneKey(
          structuredAgentSessionTabId(scope.owner.sessionId),
          scope.owner.sessionId
        )
      : scope.paneKey
  }
  protected readClaudeCoverageRow(scope: NativeClaudeCoverageScope) {
    return scope.kind === 'stdio'
      ? this.readNativeClaudeStructuredLead(scope.owner.subject)?.row
      : this.getStatusSnapshotForPane(scope.paneKey).find(
          (row) =>
            row.agentType === 'claude' &&
            row.providerSession?.id === scope.sessionId &&
            row.connectionId === null
        )
  }
  protected readClaudeCoverageLead(scope: NativeClaudeCoverageScope) {
    const lead = this.state.claudeLeadStateByPaneKey.get(this.nativeClaudeCoverageKey(scope))
    if (!lead) {
      return undefined
    }
    if (
      lead.nativeHook?.sessionId === scope.sessionId &&
      lead.nativeHook.observedAt >= scope.startedAt
    ) {
      return lead
    }
    const row = this.readClaudeCoverageRow(scope)
    return row &&
      row.connectionId === null &&
      !row.isReplay &&
      !row.restoredUnconfirmed &&
      row.receivedAt >= scope.startedAt &&
      row.observation?.origin === 'hook' &&
      row.observation.kind === 'transition' &&
      lead.nativeStart?.sessionId === scope.sessionId &&
      lead.nativeStart.observedAt >= scope.startedAt
      ? lead
      : undefined
  }
  protected ingestClaudeCoverageHook(
    scope: NativeClaudeCoverageScope,
    hook: NativeClaudeCanonicalHook
  ): boolean {
    if (hook.sessionId !== scope.sessionId) {
      return false
    }
    if (scope.statusEnabled === false) {
      return !!foldNativeClaudeCanonicalHook(this.state, this.nativeClaudeCoverageKey(scope), hook)
    }
    return scope.kind === 'stdio'
      ? this.ingestNativeClaudeStructuredHook(scope.owner, hook)
      : scope.terminal
        ? this.ingestNativeClaudeTerminalHook(scope.terminal, hook)
        : !!foldNativeClaudeCanonicalHook(this.state, scope.paneKey, hook)
  }

  /** Fresh background evidence only; an intercepted request has not produced a Stop. */
  hasNativeClaudeNonRequestBackgroundWork(scope: NativeClaudeCoverageScope): boolean {
    const key = this.nativeClaudeCoverageKey(scope)
    return (
      this.state.claudeRunningNonAgentTaskPaneKeys.has(key) ||
      this.state.claudeActiveSessionCronPaneKeys.has(key) ||
      [...(this.state.claudeSubagentRosterByPaneKey.get(key)?.values() ?? [])].some(
        (child) => child.state !== 'idle' || child.restoredFromSnapshot
      ) ||
      Object.values(
        claudeOwedTaskNotificationKinds(this.state.claudeLaunchedBackgroundTasksByPaneKey.get(key))
      ).some(Boolean)
    )
  }

  isKnownNativeClaudeChildSession(scope: NativeClaudeCoverageScope, id: string): boolean {
    const lead = this.readClaudeCoverageLead(scope)
    return (
      lead?.nativeCoverage?.sessionId === scope.sessionId &&
      (lead.nativeCoverage.liveAgents.includes(id) ||
        this.state.claudeSubagentRosterByPaneKey
          .get(this.nativeClaudeCoverageKey(scope))
          ?.has(id) === true)
    )
  }
}
