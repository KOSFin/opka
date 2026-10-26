import { randomUUID } from 'node:crypto'
import { readInjectedAgentSessionId } from '../../shared/agent-session-caller-env'
import { readOrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import { readInjectedTerminalTaskCaller } from '../../shared/terminal-task-caller-file'

export function orchestrationCompatibilityForMethod(
  method: string,
  envelope: RuntimeOrchestrationEnvelope,
  requestId?: string
): RuntimeOrchestrationEnvelope {
  if (
    !method.startsWith('orchestration.') &&
    !['projectTask.claim', 'projectTask.progress', 'projectTask.complete'].includes(method)
  ) {
    return {}
  }
  return {
    ...envelope,
    compatibilityInvocationId: requestId ?? envelope.compatibilityInvocationId
  }
}

export function createOrchestrationCompatibilityEnvelope(
  env: NodeJS.ProcessEnv
): RuntimeOrchestrationEnvelope {
  const evidence = readOrchestrationCompatibilityEvidence(env)
  // Read here, from this CLI's own environment only: the SSH paths build evidence from a remote
  // shell's environment, where a session id could never name a session on this host.
  const agentSessionId = readInjectedAgentSessionId(env)
  const terminal = !agentSessionId && !evidence?.host ? readInjectedTerminalTaskCaller(env) : null
  const callerEvidence = terminal?.identity
    ? {
        ...evidence,
        terminalHandle: terminal.identity.terminalHandle,
        paneKey: terminal.identity.paneKey,
        terminalTaskProof: terminal.proof
      }
    : evidence
  return {
    compatibilityInvocationId: randomUUID(),
    orchestrationCompatibilityEvidence: agentSessionId
      ? { ...evidence, agentSessionId }
      : callerEvidence
  }
}
