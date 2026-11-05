import type { NativeClaudeCanonicalHook } from '../../../shared/native-claude-canonical-hook'
import type { HookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'

/** Only native handles become children; incomplete inventories cannot erase earlier work. */
export function nativeClaudeStructuredChildEvidence(
  state: HookListenerState,
  key: string,
  hook: NativeClaudeCanonicalHook,
  existing: ReadonlySet<string>,
  complete: boolean
): AgentChildWorkEvidence[] {
  const observedAt = Date.now()
  const evidence: AgentChildWorkEvidence[] = []
  const live = new Set<string>(),
    ended = new Set<string>()
  const finish = (id: string) => {
    if (!ended.has(id)) {
      ended.add(id)
      evidence.push({
        type: 'ended',
        observedAt,
        handle: { idKind: 'task_id', id },
        outcome: 'unknown'
      })
    }
  }
  for (const [id, child] of state.claudeSubagentRosterByPaneKey.get(key) ?? []) {
    if (child.restoredFromSnapshot) {
      continue
    }
    if (child.state === 'idle') {
      finish(id)
      continue
    }
    live.add(id)
    evidence.push({
      type: 'live',
      observedAt,
      child: {
        handle: { idKind: 'task_id', id },
        kind: 'agent',
        residency: 'background',
        state: 'working',
        stoppable: false
      }
    })
  }
  if (hook.agentId && (hook.event === 'SubagentStop' || hook.event === 'StopFailure')) {
    finish(hook.agentId)
  }
  for (const task of hook.backgroundTasks ?? []) {
    if (!task.id || task.type === 'agent' || task.type === 'teammate') {
      if (task.id && ['completed', 'failed', 'cancelled'].includes(task.status)) {
        finish(task.id)
      }
      continue
    }
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      finish(task.id)
      continue
    }
    live.add(task.id)
    evidence.push({
      type: 'live',
      observedAt,
      child: {
        handle: { idKind: 'task_id', id: task.id },
        kind: task.type === 'unknown' ? 'unknown' : task.type === 'cron' ? 'monitor' : 'command',
        residency: 'background',
        state: 'working',
        stoppable: false
      }
    })
  }
  for (const id of hook.sessionCrons ?? []) {
    live.add(id)
    evidence.push({
      type: 'live',
      observedAt,
      child: {
        handle: { idKind: 'task_id', id },
        kind: 'monitor',
        residency: 'background',
        state: 'monitoring',
        stoppable: false
      }
    })
  }
  if (complete) {
    for (const id of existing) {
      if (!live.has(id) && !ended.has(id)) {
        evidence.push({ type: 'removed', observedAt, handle: { idKind: 'task_id', id } })
      }
    }
  }
  return evidence
}
