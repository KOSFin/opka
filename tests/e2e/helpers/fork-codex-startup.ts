import { openCodexAppServerConnection } from '../../../src/main/codex/codex-app-server-connection'

export async function probeForkCodexStartup(wrapper: string, cwd: string, env: NodeJS.ProcessEnv) {
  const launchEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      launchEnv[key] = value
    }
  }
  const connection = await openCodexAppServerConnection({
    command: wrapper,
    args: ['app-server'],
    cwd,
    env: { ...launchEnv, RUST_LOG: 'warn' }
  })
  // No turn/start: prove SQLite and thread initialization without sending a model prompt.
  const startup = await connection
    .request(
      'thread/start',
      { cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request' },
      { timeoutMs: 15000 }
    )
    .then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    )
  if (!(await connection.close())) {
    throw new AggregateError(
      startup.ok ? [] : [startup.error],
      'The synthetic startup probe did not confirm its process exit'
    )
  }
  if (!startup.ok) {
    throw startup.error
  }
}
