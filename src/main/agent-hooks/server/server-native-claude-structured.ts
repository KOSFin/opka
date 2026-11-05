import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { NativeCliStdioOwner } from '../../runtime/native-cli-stdio-owner'
import type { AgentStatusStructuredSessionSubject } from '../../../shared/agent-status-subject'
import { parseAgentStatusSubject } from '../../../shared/agent-status-subject'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import { clearPaneTurnCacheState } from '../../../shared/agent-hook-listener/listener-state'
import { foldNativeClaudeCanonicalHook } from './native-claude-canonical-fold'
import { nativeClaudeStructuredChildEvidence } from './native-claude-structured-child-evidence'
import { AgentHookServerNativeCodexInventory } from './server-native-codex-inventory'

const projectionKey = (subject: AgentStatusStructuredSessionSubject) =>
  structuredAgentSessionPaneKey(structuredAgentSessionTabId(subject.sessionId), subject.sessionId)

/** Metadata ingress for an actual native stdio lease, without a terminal or legacy status row. */
export abstract class AgentHookServerNativeClaudeStructured extends AgentHookServerNativeCodexInventory {
  ingestNativeClaudeStructuredHook(owner: NativeCliStdioOwner, raw: unknown): boolean {
    const subject = parseAgentStatusSubject(owner.subject)
    if (
      !subject ||
      subject.kind !== 'structured-session' ||
      subject.sessionId !== owner.sessionId
    ) {
      throw new Error('Native Claude hook does not match its trusted structured owner')
    }
    const key = projectionKey(subject)
    const prior = this.canonicalStatusStore.getParent(subject)?.status
    // The provider id is checked before the fold can replace existing ownership facts.
    if (
      prior?.providerSession &&
      raw &&
      typeof raw === 'object' &&
      'sessionId' in raw &&
      prior.providerSession.id !== raw.sessionId
    ) {
      return false
    }
    const folded = foldNativeClaudeCanonicalHook(this.state, key, raw)
    const mainAgent = folded?.normalized.mainAgent
    if (!folded || !mainAgent) {
      return false
    }
    const { hook, normalized, lead } = folded
    const status =
      mainAgent.state === 'working'
        ? 'working'
        : mainAgent.state === 'blocked' || mainAgent.state === 'waiting'
          ? 'attention'
          : 'idle'
    const summary: AgentSessionStatusSummary = {
      sessionId: subject.sessionId,
      workspaceId: subject.workspaceId,
      agent: 'claude' as const,
      hostExecutionOwned: true as const,
      hostExecutionPhase: 'ready' as const,
      status,
      latestPrompt: '',
      updatedAt: Date.now(),
      statusStartedAt: mainAgent.stateStartedAt,
      providerSession: { key: 'session_id' as const, id: hook.sessionId },
      ...(mainAgent.outcome ? { turnOutcome: mainAgent.outcome } : {}),
      ...(normalized.toolName ? { toolName: normalized.toolName } : {})
    }
    const projection = {
      state: normalized.state,
      mainAgent,
      workingMode: normalized.workingMode,
      sessionBoundary: normalized.sessionBoundary
    }
    const receipt = lead?.nativeHook
    const complete =
      !hook.agentId &&
      (hook.event === 'Stop' || hook.event === 'StopFailure') &&
      receipt?.backgroundTasksComplete === true &&
      receipt.sessionCronsComplete
    const children = nativeClaudeStructuredChildEvidence(
      this.state,
      key,
      hook,
      this.getStructuredChildWorkHandles(subject),
      complete
    )
    if (!prior && children.length) {
      this.ingestStructuredStatus(summary, subject, projection)
    }
    if (children.length) {
      this.ingestStructuredChildWork(subject, children, 'claude')
    }
    this.ingestStructuredStatus(summary, subject, projection)
    return true
  }

  readNativeClaudeStructuredLead(subject: AgentStatusStructuredSessionSubject) {
    const parsed = parseAgentStatusSubject(subject)
    if (!parsed || parsed.kind !== 'structured-session') {
      return null
    }
    const key = projectionKey(parsed),
      row = this.canonicalStatusStore.getParent(parsed)?.status
    const lead = this.state.claudeLeadStateByPaneKey.get(key)
    return row?.agentType === 'claude' && lead ? { key, row, lead } : null
  }

  /** Only the execution host calls this after its own process/lease retirement proof. */
  retireNativeClaudeStructuredHook(subject: AgentStatusStructuredSessionSubject): void {
    const parsed = parseAgentStatusSubject(subject)
    if (!parsed || parsed.kind !== 'structured-session') {
      return
    }
    const key = projectionKey(parsed)
    this.dropStructuredStatus(parsed)
    clearPaneTurnCacheState(this.state, key)
    this.state.claudeLeadStateByPaneKey.delete(key)
    this.state.claudeSubagentRosterByPaneKey.delete(key)
    this.state.claudeSessionOwnerByPaneKey.delete(key)
    this.state.claudeRunningNonAgentTaskPaneKeys.delete(key)
    this.state.claudeActiveSessionCronPaneKeys.delete(key)
    this.state.claudeLaunchedBackgroundTasksByPaneKey.delete(key)
    this.state.claudeUnconfirmedRestoredStatusPaneKeys.delete(key)
    this.state.claudeConsumedCompactPromptIdByPaneKey.delete(key)
  }
}
