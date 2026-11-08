import { bindAccountPoolPtyExecution } from './account-pool-pty-ownership'
import { selectAccountPoolRotationMember } from './account-pool-rotation-policy'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { readPtyAccountPoolChildren } from './pty-account-pool-child-inventory'
import { randomUUID } from 'node:crypto'
import { resolveWorkerCodexHistoryHome } from '../codex-accounts/worker-account-home'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import { AGENT_DONE_QUIET_MS } from '../../shared/agent-transitions'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { buildAgentResumeStartupPlan } from '../../shared/tui-agent-resume-startup'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { OrcaRuntimeService } from './orca-runtime'
import {
  accountPoolRotationBoundary,
  rememberAccountPoolRotationTurn
} from './account-pool-rotation-boundary'
import {
  noteNativeCliTerminalRotation,
  nativeCliTerminalEnvironment,
  nativeCliTerminalCommand
} from './native-cli-terminal-bindings'
import { accountPoolCandidates } from './account-pool-candidates'
import { getAccountPoolPolicy } from './runtime-account-pool-policy'
import { prepareAccountPoolResume } from './account-pool-resume'
import { preparePinnedClaudeAccountLaunch } from '../claude-accounts/pinned-account-launch'
import { WORKER_CLAUDE_ACCOUNT_ENV } from '../claude-accounts/worker-account-launch'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { isNativeCliRoutingPty } from './native-cli-routing-pty'

type PoolRotationPty = Pick<RuntimePtyWorktreeRecord, 'isWsl' | 'wslDistro' | 'launchConfig'>
export class PtyAccountPoolRotation {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly running = new Set<string>()
  private readonly completed = new Map<string, number>()
  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly readPty: (id: string) => PoolRotationPty | undefined
  ) {}
  observe(change: AgentPaneChange): void {
    const prior = this.pending.get(change.paneKey)
    if (
      change.kind === 'seeded' ||
      (change.kind === 'observed' && change.phase === 'working') ||
      (change.kind === 'moved' && change.to === 'working')
    ) {
      if (prior) {
        clearTimeout(prior)
      }
      this.pending.delete(change.paneKey)
      return
    }
    if (
      change.kind !== 'moved' ||
      !['turn-finished', 'errored'].includes(change.transition ?? '')
    ) {
      return
    }
    if (prior) {
      clearTimeout(prior)
    }
    const timer = setTimeout(() => {
      this.pending.delete(change.paneKey)
      if (this.running.has(change.paneKey)) {
        return
      }
      this.running.add(change.paneKey)
      void this.rotate(change.paneKey)
        .catch(() => {
          console.warn(
            '[account-pool] Automatic terminal switch stopped; no user request was replayed'
          )
        })
        .finally(() => this.running.delete(change.paneKey))
    }, AGENT_DONE_QUIET_MS)
    timer.unref?.()
    this.pending.set(change.paneKey, timer)
  }
  private async rotate(paneKey: string): Promise<void> {
    const runtime = this.runtime
    if (
      !runtime
        .requireStore()
        .getSettings()
        .accountPools?.some((pool) => pool.rotation !== 'off' || pool.strategy === 'quota-equalize')
    ) {
      return
    }
    const row = runtime.agentTransitions.latestRow(paneKey)
    const pane = parsePaneKey(paneKey)
    if (!row?.executionId || !row.worktreeId || !pane) {
      return
    }
    const terminal = runtime.resolveTerminalPane(paneKey, row.worktreeId)
    if (!terminal.ptyId || !terminal.incarnationId || terminal.executionHostId !== 'local') {
      return
    }
    if (isNativeCliRoutingPty(runtime, terminal.ptyId, terminal.incarnationId)) {
      return
    }
    const pty = this.readPty(terminal.ptyId)
    if (!pty || pty.isWsl !== false || pty.wslDistro || !pty.launchConfig) {
      return
    }
    const db = runtime.getOrchestrationDb()
    const previous = db
      .listAccountPoolAssignments()
      .find(
        (entry) => entry.ptyId === terminal.ptyId && entry.incarnationId === terminal.incarnationId
      )
    if (!previous) {
      return
    }
    const policy = getAccountPoolPolicy(runtime, previous.poolId)
    const candidates = accountPoolCandidates(runtime.getAccountsSnapshot()).filter(
      (entry) => entry.provider === policy.provider
    )
    const children = readPtyAccountPoolChildren(row)
    const started = runtime.terminalRunFacts?.read(
      terminal.ptyId,
      terminal.incarnationId
    ).firstUserInputAt
    if (started === null || started === undefined) {
      return
    }
    const ptyId = terminal.ptyId
    const inputAt = runtime.terminalRunFacts?.readLastInputAt(ptyId)
    const token = accountPoolRotationBoundary({
      policy,
      row,
      children,
      accountId: previous.accountId,
      candidate: candidates.find((entry) => entry.accountId === previous.accountId),
      executionId: row.executionId,
      launchStartedAt: started,
      lastInputAt: inputAt,
      now: Date.now(),
      lastRotatedTurn: this.completed.get(previous.ownerKey)
    })
    if (token === null || !row.providerSession) {
      return
    }
    let inputChanged = false
    const assertCurrent = (): void => {
      const current = runtime.agentTransitions.latestRow(paneKey)
      if (!current) {
        throw new Error('The conversation is no longer present')
      }
      const inventory = readPtyAccountPoolChildren(current)
      if (!inventory || inventory.some((child) => child.membership !== 'settled')) {
        throw new Error('Child work changed while preparing the account switch')
      }
      const owner = runtime.resolveTerminalPane(paneKey, row.worktreeId)
      if (
        inputChanged ||
        owner.ptyId !== terminal.ptyId ||
        owner.incarnationId !== terminal.incarnationId ||
        current.executionId !== row.executionId ||
        accountPoolRotationBoundary({
          policy,
          row: current,
          children: inventory,
          accountId: previous.accountId,
          candidate: candidates.find((entry) => entry.accountId === previous.accountId),
          executionId: row.executionId ?? '',
          launchStartedAt: started,
          now: Date.now()
        }) !== token ||
        current.providerSession?.id !== row.providerSession?.id ||
        runtime.terminalRunFacts?.readLastInputAt(ptyId) !== inputAt ||
        getAccountPoolPolicy(runtime, policy.id).revision !== policy.revision
      ) {
        throw new Error('The conversation changed while preparing the account switch')
      }
    }
    const selected = selectAccountPoolRotationMember(
      db.db,
      { policy, candidates, replacesOwnerKey: previous.ownerKey },
      previous.accountId
    )
    if (selected.id === previous.accountId) {
      return
    }
    const next = db.acquireAccountPoolAssignment({
      ownerKey: `pty-rotation:${randomUUID()}`,
      policy: {
        ...policy,
        members: policy.members.filter((member) => member.accountId === selected.id)
      },
      candidates
    })
    const unwatchInput = runtime.terminalRunFacts?.onInput?.((id) => {
      if (id === ptyId) {
        inputChanged = true
      }
    })
    let stopping = false
    let dispatched = false
    try {
      if (next.accountId === previous.accountId) {
        return
      }
      const settings = runtime.requireStore().getSettings()
      const sourceHome =
        policy.provider === 'codex'
          ? resolveWorkerCodexHistoryHome(settings.codexManagedAccounts, previous.accountId)
          : getClaudeProfileRouter()?.accountHome(previous.accountId)
      const targetEnv: Record<string, string> =
        policy.provider === 'codex'
          ? runtime.getWorkerCodexAccountEnv(next.accountId)
          : {
              ...applyClaudeEnvPatch(
                {},
                (
                  await preparePinnedClaudeAccountLaunch({
                    accountId: next.accountId,
                    getAccounts: () =>
                      runtime.requireStore().getSettings().claudeManagedAccounts ?? []
                  })
                ).envPatch
              ),
              [WORKER_CLAUDE_ACCOUNT_ENV]: next.accountId
            }
      const targetHome =
        policy.provider === 'codex' ? targetEnv.CODEX_HOME : targetEnv.CLAUDE_CONFIG_DIR
      if (!sourceHome || !targetHome) {
        throw new Error('Account history routing is unavailable')
      }
      const session = await prepareAccountPoolResume({
        provider: policy.provider,
        sourceHome,
        targetHome,
        providerSession: row.providerSession
      })
      const startup = buildAgentResumeStartupPlan({
        agent: policy.provider,
        providerSession: session,
        platform: process.platform,
        cmdOverrides: settings.agentCmdOverrides ?? {},
        agentCommand: pty.launchConfig.agentCommand,
        agentArgs: pty.launchConfig.agentArgs,
        agentEnv: pty.launchConfig.agentEnv,
        resumeInLaunchCwd: true
      })
      if (!startup) {
        throw new Error('The provider cannot resume this conversation')
      }
      assertCurrent()
      const stop = await runtime.stopExactTerminalsForWorktree(
        `id:${row.worktreeId}`,
        [terminal.ptyId],
        {
          keepHistory: true,
          targetOnly: true,
          expectedIncarnationId: terminal.incarnationId,
          beforeStop: () => {
            assertCurrent()
            noteNativeCliTerminalRotation(runtime, paneKey, true)
            stopping = true
          }
        }
      )
      if (!stop.postStopVerified) {
        throw new Error('The previous execution exit is unverifiable')
      }
      db.releaseAccountPoolAssignment(previous.ownerKey)
      rememberAccountPoolRotationTurn(this.completed, previous.ownerKey, token)
      const result = await runtime.createTerminal(`id:${row.worktreeId}`, {
        command: nativeCliTerminalCommand(runtime, paneKey, startup.launchCommand),
        launchAgent: policy.provider,
        startupCommandDelivery: 'shell-ready',
        env: { ...nativeCliTerminalEnvironment(runtime, paneKey), ...startup.env, ...targetEnv },
        launchConfig: startup.launchConfig,
        resumeProviderSession: session,
        tabId: pane.tabId,
        leafId: pane.leafId,
        requireFreshPane: true,
        activate: false,
        presentation: 'background',
        surfaceOwner: false,
        onPtySpawnDispatched: () => {
          dispatched = true
        }
      })
      if (!result.ptyId || !result.incarnationId || result.isReattach) {
        throw new Error('The replacement execution is unverifiable')
      }
      bindAccountPoolPtyExecution(runtime, next.ownerKey, result.ptyId, result.incarnationId)
    } finally {
      unwatchInput?.()
      // No physical start was attempted: a failed preparation has no active target execution.
      if (!dispatched) {
        db.releaseAccountPoolAssignment(next.ownerKey)
      }
      if (stopping) {
        this.completed.set(previous.ownerKey, token)
        noteNativeCliTerminalRotation(runtime, paneKey, false)
      }
    }
  }
}
