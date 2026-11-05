import {
  claudeOwedTaskNotificationKinds,
  recordClaudeBackgroundTaskLaunch,
  settleClaudeTaskNotification
} from '../../../shared/claude-owed-task-notifications'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import {
  foldNativeClaudeCoverage,
  isNativeClaudeCoverageQuiet,
  isNativeClaudeCoverageSettled,
  type NativeClaudeCoverageRequest
} from '../../../shared/native-claude-coverage'
import {
  AgentHookServerNativeClaudeCoverageScope,
  type NativeClaudeCoverageScope
} from './server-native-claude-coverage-scope'
export type { NativeClaudeCoverageScope } from './server-native-claude-coverage-scope'

/** Only the authenticated live-launch adapter supplies this scope; callers never choose a pane. */
export abstract class AgentHookServerNativeClaudeCoverage extends AgentHookServerNativeClaudeCoverageScope {
  abstract readNativeClaudePromptId(row: AgentStatusIpcPayload): string | null
  abstract readNativeClaudeChildInventory(row: AgentStatusIpcPayload): {
    status: 'settled' | 'live' | 'unverifiable'
  }

  observeNativeClaudeCoverage(
    scope: NativeClaudeCoverageScope,
    request: NativeClaudeCoverageRequest
  ) {
    if (request.launchId !== scope.launchId || request.sessionId !== scope.sessionId) {
      throw new Error('Native Claude continuity ownership is unverifiable.')
    }
    const before = this.readClaudeCoverageLead(scope)?.nativeCoverage
    if (
      before?.generation === request.generation &&
      before.sequence === request.sequence &&
      before.lastEvent === JSON.stringify(request.observation)
    ) {
      return {
        sequence: request.sequence,
        healthy: !before.unknown,
        replayed: true,
        sealedStop: false
      }
    }
    const applied =
      request.observation.kind === 'canonical-hook'
        ? this.ingestClaudeCoverageHook(scope, request.observation.hook)
        : true
    const lead = this.readClaudeCoverageLead(scope)
    if (!lead) {
      return { sequence: request.sequence, healthy: false, replayed: false, sealedStop: false }
    }
    const key = this.nativeClaudeCoverageKey(scope)
    const observation = request.observation
    const launch =
      observation.kind === 'tool-end' && !observation.agentId
        ? observation.task
        : observation.kind === 'spawn-end' && !observation.parentAgentId && observation.agentId
          ? { id: observation.agentId, kind: 'agent' as const }
          : undefined
    if (launch) {
      let tasks = this.state.claudeLaunchedBackgroundTasksByPaneKey.get(key)
      if (!tasks) {
        tasks = new Map()
        this.state.claudeLaunchedBackgroundTasksByPaneKey.set(key, tasks)
      }
      recordClaudeBackgroundTaskLaunch(tasks, launch)
    }
    if (
      observation.kind === 'prompt' &&
      observation.origin === 'task-notification' &&
      observation.taskId &&
      ['completed', 'failed', 'killed'].includes(observation.taskStatus ?? '') &&
      this.isKnownNativeClaudeCoverageTask(scope, observation.taskId)
    ) {
      const tasks = this.state.claudeLaunchedBackgroundTasksByPaneKey.get(key)
      if (tasks) {
        settleClaudeTaskNotification(tasks, observation.taskId)
      }
    }
    const current = this.readClaudeCoverageRow(scope)
    const previous = lead.nativeCoverage
    const blockedWithoutRequest =
      request.observation.kind === 'complete-stop' &&
      previous?.currentMainPromptId === undefined &&
      previous?.currentMainTurnId === undefined
    const recovery =
      request.observation.kind === 'complete-stop' &&
      current &&
      this.isNativeClaudeCompleteStop(scope, request.observation.promptId) &&
      lead.nativeCoverage?.currentMainPromptId === request.observation.promptId &&
      current.receivedAt > (lead.nativeCoverage?.unknownSince ?? 0) &&
      current.receivedAt > (lead.nativeCoverage?.sealedStop?.observedAt ?? 0) &&
      !lead.nativeCoverage?.requests.length
    if (blockedWithoutRequest && previous) {
      if (
        request.generation === previous.generation &&
        request.sequence === previous.sequence + 1
      ) {
        previous.sequence = request.sequence
        previous.lastEvent = JSON.stringify(request.observation)
        return {
          sequence: request.sequence,
          healthy: !previous.unknown,
          replayed: true,
          sealedStop: false
        }
      }
    }
    lead.nativeCoverage = foldNativeClaudeCoverage(
      lead.nativeCoverage,
      applied ||
        (request.observation.kind === 'canonical-hook' &&
          request.observation.hook.event === 'SessionStart' &&
          request.observation.hook.source === 'compact')
        ? request
        : { ...request, observation: { kind: 'lost' } },
      lead.nativeStart?.source === 'startup',
      recovery
    )
    const replayed = lead.nativeCoverage === previous
    if (!replayed) {
      lead.nativeCoverage.lastEvent = JSON.stringify(request.observation)
    }
    if (
      request.observation.kind === 'request-start' &&
      request.observation.mainTurnId &&
      !replayed
    ) {
      if (previous?.currentMainTurnId !== request.observation.mainTurnId) {
        lead.nativeCoverage.currentMainPromptId = undefined
      }
      if (!lead.nativeCoverage.currentMainPromptId) {
        lead.nativeCoverage.currentMainPromptId =
          lead.nativeHook?.event === 'UserPromptSubmit'
            ? lead.nativeHook.promptId
            : current?.mainAgent?.state === 'working'
              ? (this.readNativeClaudePromptId(current) ?? undefined)
              : undefined
      }
    }
    if (recovery && !replayed && !lead.nativeCoverage.unknown && current) {
      lead.nativeCoverage.currentMainPromptId = undefined
      lead.nativeCoverage.sealedStop = {
        promptId: request.observation.kind === 'complete-stop' ? request.observation.promptId : '',
        observedAt: current.receivedAt,
        turnId: previous?.currentMainTurnId,
        reason:
          previous?.mainTurn?.id === previous?.currentMainTurnId
            ? previous?.mainTurn?.reason
            : undefined
      }
    }
    if (lead.nativeCoverage.unknown) {
      lead.nativeCoverage.unknownSince ??= Date.now()
    } else {
      lead.nativeCoverage.unknownSince = undefined
    }
    return {
      sequence: request.sequence,
      healthy: !lead.nativeCoverage.unknown,
      replayed,
      sealedStop: !!recovery && !replayed && !lead.nativeCoverage.unknown
    }
  }

  private isNativeClaudeCompleteStop(scope: NativeClaudeCoverageScope, promptId: string): boolean {
    const row = this.readClaudeCoverageRow(scope)
    if (!row || row.sessionBoundary || row.mainAgent?.state !== 'done') {
      return false
    }
    if (scope.kind !== 'stdio') {
      return (
        this.state.lastStatusByPaneKey.get(scope.paneKey)?.hookEventName === 'Stop' &&
        this.readNativeClaudePromptId(row) === promptId &&
        this.readNativeClaudeChildInventory(row).status === 'settled'
      )
    }
    const lead = this.readClaudeCoverageLead(scope),
      receipt = lead?.nativeHook,
      key = this.nativeClaudeCoverageKey(scope)
    return (
      receipt?.event === 'Stop' &&
      receipt.promptId === promptId &&
      receipt.sessionId === scope.sessionId &&
      receipt.backgroundTasksComplete &&
      receipt.sessionCronsComplete &&
      row.state === 'done' &&
      !row.interrupted &&
      !this.state.claudeRunningNonAgentTaskPaneKeys.has(key) &&
      !this.state.claudeActiveSessionCronPaneKeys.has(key) &&
      this.getStructuredChildWork(scope.owner.subject).every(
        (child) => child.membership === 'settled'
      )
    )
  }

  revokeNativeClaudeCoverage(scope: NativeClaudeCoverageScope): void {
    const lead = this.readClaudeCoverageLead(scope)
    if (lead?.nativeCoverage?.launchId === scope.launchId) {
      lead.nativeCoverage.unknown = true
      lead.nativeHook = undefined
    }
  }

  isKnownNativeClaudeCoverageTask(scope: NativeClaudeCoverageScope, id: string): boolean {
    const coverage = this.readClaudeCoverageLead(scope)?.nativeCoverage
    return (
      !!coverage &&
      coverage.launchId === scope.launchId &&
      !coverage.unknown &&
      (coverage.pendingTasks.some((task) => task.id === id) || coverage.settledTasks.includes(id))
    )
  }

  readNativeClaudeSealedStop(scope: NativeClaudeCoverageScope): boolean {
    const coverage = this.readClaudeCoverageLead(scope)?.nativeCoverage,
      current = this.readClaudeCoverageRow(scope),
      seal = coverage?.sealedStop
    return (
      !!coverage &&
      !!current &&
      coverage.launchId === scope.launchId &&
      !!seal &&
      this.isNativeClaudeCompleteStop(scope, seal.promptId) &&
      seal.observedAt === current.receivedAt &&
      isNativeClaudeCoverageQuiet(coverage)
    )
  }

  readNativeClaudeAnswerComplete(scope: NativeClaudeCoverageScope): boolean {
    return (
      this.readNativeClaudeSealedStop(scope) &&
      this.readClaudeCoverageLead(scope)?.nativeCoverage?.sealedStop?.reason === 'answer'
    )
  }

  readNativeClaudeCoverageAvailable(scope: NativeClaudeCoverageScope): boolean {
    const coverage = this.readClaudeCoverageLead(scope)?.nativeCoverage
    return (
      !!coverage && coverage.launchId === scope.launchId && coverage.sessionId === scope.sessionId
    )
  }

  readNativeClaudeCoverageQuiescent(scope: NativeClaudeCoverageScope): boolean {
    const coverage = this.readClaudeCoverageLead(scope)?.nativeCoverage
    return coverage?.launchId === scope.launchId && isNativeClaudeCoverageQuiet(coverage)
  }

  readNativeClaudeCoverageHealthy(scope: NativeClaudeCoverageScope): boolean {
    const coverage = this.readClaudeCoverageLead(scope)?.nativeCoverage
    return (
      !!coverage &&
      coverage.launchId === scope.launchId &&
      coverage.sessionId === scope.sessionId &&
      !coverage.unknown
    )
  }

  readNativeClaudeFailureBoundary(scope: NativeClaudeCoverageScope) {
    const lead = this.readClaudeCoverageLead(scope),
      receipt = lead?.nativeFailure
    const canSwitch = (allowedSubmissionId?: string) => {
      const latest = this.readClaudeCoverageLead(scope),
        coverage = latest?.nativeCoverage
      return (
        !!receipt &&
        latest?.nativeFailure === receipt &&
        receipt.sessionId === scope.sessionId &&
        ((latest.state === 'done' && latest.outcome === 'failure') || !!allowedSubmissionId) &&
        !!receipt.turnId &&
        coverage?.mainTurn?.id === receipt.turnId &&
        coverage.mainTurn.reason === 'error' &&
        !Object.values(
          claudeOwedTaskNotificationKinds(
            this.state.claudeLaunchedBackgroundTasksByPaneKey.get(
              this.nativeClaudeCoverageKey(scope)
            )
          )
        ).some(Boolean) &&
        isNativeClaudeCoverageSettled(coverage, allowedSubmissionId)
      )
    }
    return {
      promptId: receipt?.promptId,
      canSwitch,
      onBoundaryAccepted: () => {
        const latest = this.readClaudeCoverageLead(scope)
        if (latest && latest.nativeFailure === receipt) {
          latest.nativeFailure = undefined
        }
      }
    }
  }
}
