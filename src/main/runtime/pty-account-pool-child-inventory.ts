import { agentHookServer } from '../agent-hooks/server'
import { projectAgentChildWorkViews } from '../../shared/agent-status-child-work-view'
import { agentStatusSubjectsEqual } from '../../shared/agent-status-subject'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'

export function readPtyAccountPoolChildren(row: AgentStatusIpcPayload) {
  const snapshot = agentHookServer.getCanonicalStatusSnapshot()
  const parent = snapshot.parents.find(
    (entry) =>
      entry.status?.executionId === row.executionId && entry.status?.paneKey === row.paneKey
  )
  if (!parent) {
    return undefined
  }
  return projectAgentChildWorkViews(
    snapshot.children.filter((child) => agentStatusSubjectsEqual(child.parent, parent.subject)),
    snapshot.aliases
  )
}
