import { readInjectedTerminalTaskCaller } from './terminal-task-caller-file'

export function nativeCliParentTerminalContext(env: NodeJS.ProcessEnv) {
  const record = readInjectedTerminalTaskCaller(env)
  return {
    parentContextExpected: Boolean(
      env.ORCA_PANE_KEY || env.ORCA_WORKTREE_ID || env.ORCA_AGENT_SESSION_ID
    ),
    ...(record?.identity
      ? {
          parentTerminal: {
            terminalHandle: record.identity.terminalHandle,
            paneKey: record.identity.paneKey,
            terminalTaskProof: record.proof
          }
        }
      : {})
  }
}
