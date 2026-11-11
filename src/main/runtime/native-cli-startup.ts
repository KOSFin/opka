import type { AgentLaunchPaneVerdict } from '../../shared/agent-launch-pane-verdict'
import type { NativeCliControlError } from '../../shared/native-cli-control-error'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { holdAgentLaunchPaneStartup } from '../agent-launch/agent-launch-pane-attachment'

/** Evidence for one initial native prepare, owned by the PTY generation, never agent status. */
export class NativeCliStartup {
  state: 'pending' | 'preparing' | 'prepared' | 'refused' | 'unconfirmed' = 'pending'
  launchId: string | null = null
  refusal: NativeCliControlError | null = null
  readonly settled: Promise<AgentLaunchPaneVerdict>
  private settle!: (verdict: AgentLaunchPaneVerdict) => void
  private readonly listeners = new Set<(error: NativeCliControlError) => void>()
  private readonly timer: ReturnType<typeof setTimeout>

  constructor(
    readonly incarnationId: string,
    readonly launchToken: string,
    readonly agent: 'claude' | 'codex'
  ) {
    this.settled = new Promise((resolve) => {
      this.settle = resolve
    })
    this.timer = setTimeout(() => this.finish('unconfirmed'), 30_000)
    this.timer.unref?.()
  }

  begin(launchId: string): boolean {
    if (this.state !== 'pending') {
      return false
    }
    this.state = 'preparing'
    this.launchId = launchId
    return true
  }

  finish(state: 'prepared' | 'unconfirmed', launchId?: string): void {
    if (
      (this.state !== 'pending' && this.state !== 'preparing') ||
      (launchId !== undefined && this.launchId !== launchId)
    ) {
      return
    }
    this.state = state
    clearTimeout(this.timer)
    this.listeners.clear()
    this.settle(state === 'prepared' ? { kind: 'proceed' } : { kind: 'unconfirmed' })
  }

  refuse(launchId: string, error: NativeCliControlError): boolean {
    if (this.state !== 'preparing' || this.launchId !== launchId) {
      return false
    }
    this.state = 'refused'
    this.refusal = error
    clearTimeout(this.timer)
    this.settle({ kind: 'not-started', code: error.code })
    for (const listener of this.listeners) {
      listener(error)
    }
    this.listeners.clear()
    return true
  }

  onRefusal(listener: (error: NativeCliControlError) => void): () => void {
    if (this.refusal) {
      listener(this.refusal)
    } else {
      this.listeners.add(listener)
    }
    return () => this.listeners.delete(listener)
  }
}

export function armNativeCliStartup(pty: RuntimePtyWorktreeRecord): void {
  if (
    currentNativeCliStartup(pty) ||
    pty.connectionId ||
    pty.isWsl ||
    !pty.connected ||
    !pty.incarnationId ||
    pty.launchIncarnationId !== pty.incarnationId ||
    !pty.launchToken ||
    !pty.paneKey ||
    (pty.launchAgent !== 'codex' && pty.launchAgent !== 'claude')
  ) {
    return
  }
  pty.nativeCliStartup?.finish('unconfirmed')
  const startup = new NativeCliStartup(pty.incarnationId, pty.launchToken, pty.launchAgent)
  pty.nativeCliStartup = startup
  holdAgentLaunchPaneStartup({ worktreeId: pty.worktreeId, paneKey: pty.paneKey }, startup.settled)
}

export function currentNativeCliStartup(pty: RuntimePtyWorktreeRecord | undefined) {
  const startup = pty?.nativeCliStartup
  return pty &&
    startup &&
    startup.incarnationId === pty.incarnationId &&
    startup.incarnationId === pty.launchIncarnationId &&
    startup.launchToken === pty.launchToken &&
    startup.agent === pty.launchAgent
    ? startup
    : null
}

export function recordNativeCliStartup(
  pty: RuntimePtyWorktreeRecord,
  launchToken: string | undefined,
  agent: RuntimePtyWorktreeRecord['launchAgent']
): void {
  pty.launchToken = launchToken ?? null
  pty.launchIncarnationId = launchToken ? pty.incarnationId : null
  pty.launchAgent = agent
  armNativeCliStartup(pty)
}
