/**
 * The AutomationService a runtime host executes schedules with. Shared by Electron startup and
 * orcad so both hosts dispatch through the same headless path.
 */
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { AutomationService } from './service'
import { createHeadlessRunTerminalRetention } from './headless-run-terminal-retention'
import {
  getTuiAgentDetectCommands,
  isTuiAgent,
  TUI_AGENT_CONFIG
} from '../../shared/tui-agent-config'
import { launchHeadlessAutomationAgent, runOwnHandle } from './headless-automation-agent-launch'
import { createRuntimeAutomationRunTerminalObserver } from './runtime-terminal-run-observer'
import {
  createLinuxCommandAutomationAdapter,
  type CommandAdapterInputs
} from './automation-linux-command-adapter'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { supportsStructuredAutomationReportTarget } from '../native-chat/agent-session-wire/structured-agent-session-automation-report'
import { createLinuxOneShotAutomationAgent } from './automation-linux-one-shot-agent'

const MAX_REMEMBERED_LAUNCHES = 256

export function createRuntimeAutomationService(input: {
  store: Store
  runtime: OrcaRuntimeService
  claudeUsage?: ClaudeUsageStore
  codexUsage?: CodexUsageStore
  /** A server process: it executes remote_host_service-owned schedules and dispatches headlessly. */
  headless: boolean
  /** Supplied only after this owning runtime has independently verified its command scope. */
  verifiedCommandHost?: {
    generation: number
    oneShotAgent?: CommandAdapterInputs['oneShotAgent']
  }
}): AutomationService {
  const { store, runtime, claudeUsage, codexUsage } = input
  // The handle each headless launch returned, so its watcher never depends on a pane-key lookup.
  const launchedHandles = new Map<string, string>()
  const observer = createRuntimeAutomationRunTerminalObserver(runtime, {
    getAgentStatusRowsForPane: (paneKey) => runtime.getAgentStatusRowsForPane(paneKey),
    agentCommandsForRun: (run) =>
      automationAgentCommands(
        store.listAutomations().find((entry) => entry.id === run.automationId)?.agentId
      )
  })
  const service = new AutomationService(store, {
    claudeUsage,
    codexUsage,
    ...(input.verifiedCommandHost
      ? {
          commandHostGeneration: input.verifiedCommandHost.generation,
          commandHostAdapterFactory: (runs) => {
            const ownerRuntimeId = runtime.getRuntimeId()
            const hostGeneration = input.verifiedCommandHost?.generation ?? 0
            const isCurrentOwner = () =>
              runtime.getRuntimeId() === ownerRuntimeId &&
              store.getCommandHostEpoch() === hostGeneration
            const resolveExistingWorkspaceCwd: CommandAdapterInputs['resolveExistingWorkspaceCwd'] =
              async (definition) => {
                const context = definition.runContext
                const setup = store
                  .getProjectHostSetups()
                  .find((entry) => entry.id === context?.projectHostSetupId)
                const repo = store.getRepo(context?.repoId ?? '')
                if (
                  !context ||
                  !setup ||
                  !repo ||
                  context.hostId !== 'local' ||
                  setup.setupState !== 'ready' ||
                  setup.hostId !== 'local' ||
                  getRepoExecutionHostId(repo) !== 'local' ||
                  setup.repoId !== context.repoId ||
                  repo.path !== setup.path ||
                  setup.path !== context.path ||
                  resolve(setup.path) !== resolve(context.path)
                ) {
                  return null
                }
                try {
                  return (await stat(setup.path)).isDirectory() ? setup.path : null
                } catch {
                  return null
                }
              }
            return createLinuxCommandAutomationAdapter({
              store,
              runs,
              hostGeneration,
              isCurrentOwner,
              resolveExistingWorkspaceCwd,
              oneShotAgent:
                input.verifiedCommandHost?.oneShotAgent ??
                createLinuxOneShotAutomationAgent({
                  store,
                  runs,
                  hostGeneration,
                  isCurrentOwner,
                  resolveExistingWorkspaceCwd
                }),
              reportDelivery: {
                supportsTarget: async (definition) => {
                  const target = definition.execution.reportTarget
                  const host = getStructuredAgentSessionHost()
                  return target && host
                    ? supportsStructuredAutomationReportTarget({
                        deps: host.deps,
                        runtimeId: runtime.getRuntimeId(),
                        target,
                        workspaceId: definition.workspaceId,
                        runPath: definition.runContext?.path ?? null
                      })
                    : false
                },
                deliver: async (target, run) => {
                  const host = getStructuredAgentSessionHost()
                  if (!host) {
                    return false
                  }
                  const status = await host.appendAutomationReport(
                    runtime.getRuntimeId(),
                    target,
                    run
                  )
                  return status === 'unverifiable' ? status : status === 'delivered'
                }
              }
            })
          }
        }
      : {}),
    terminalObserver: {
      ...observer,
      // This host's own launch handle first: it names the run's terminal without a lookup.
      resolveRunTerminal: (run) =>
        (run.terminalPaneKey ? launchedHandles.get(run.terminalPaneKey) : undefined) ??
        observer.resolveRunTerminal(run)
    },
    onAutomationsChanged: (payload) => runtime.notifyAutomationsChanged(payload),
    allowRemoteHostScheduling: input.headless,
    headlessDispatcher: input.headless
      ? async (request) => {
          const { terminalHandle, ...launch } = await launchHeadlessAutomationAgent(runtime, {
            ...request,
            runs: store.listAutomationRuns(request.automation.id)
          })
          if (launch.terminalPaneKey) {
            launchedHandles.set(launch.terminalPaneKey, terminalHandle)
            if (launchedHandles.size > MAX_REMEMBERED_LAUNCHES) {
              launchedHandles.delete(launchedHandles.keys().next().value ?? '')
            }
          }
          // No completion: the run's watcher observes it, retrying wait timeouts until it settles.
          return launch
        }
      : undefined
  })
  runtime.setAutomationService(service)
  if (input.headless) {
    bindHeadlessRunTerminalRetention(service, store, runtime)
  }
  return service
}

/** A headless host has no renderer to close finished run terminals; its service does it. */
function bindHeadlessRunTerminalRetention(
  service: AutomationService,
  store: Store,
  runtime: OrcaRuntimeService
): void {
  const retention = createHeadlessRunTerminalRetention({
    listRuns: () => store.listAutomationRuns(),
    terminalClientUse: (run) =>
      run.terminalPtyId ? runtime.readTerminalClientUse(run.terminalPtyId) : 'unknown',
    runTerminalAlive: (run) => runOwnHandle(runtime, run) !== null,
    shellAloneAtPrompt: (run) =>
      run.terminalPtyId
        ? runtime.confirmTerminalShellAlone(run.terminalPtyId)
        : Promise.resolve(false),
    closeRunTerminal: async (run) => {
      // Only the run's own process: a restarted pane holds a new PTY a user may be working in.
      const handle = runOwnHandle(runtime, run)
      if (!handle) {
        return false
      }
      // The run's pane only: a pane a user split into the same tab is theirs.
      await runtime.closeTerminal(handle)
      return true
    },
    // Why: only a workspace made for this run sleeps; a shared one would gather a tab per run.
    runOwnsWorkspace: (run) =>
      run.workspaceId !== null &&
      store.getWorktreeMeta(run.workspaceId)?.automationProvenance?.automationRunId === run.id,
    sleepRunWorkspace: async (run) => {
      const ptyId = run.terminalPtyId
      if (!run.workspaceId || !ptyId) {
        return false
      }
      try {
        // Records the agent's resume for reopening; sole, since any other live terminal is a user's.
        const sleep = await runtime.sleepTerminalsForWorktree(`id:${run.workspaceId}`, {
          soleLivePtyId: ptyId
        })
        // Why "nothing live" too: retrying a sleep that stopped the PTY and then threw finds none;
        // a decline always reports the other live terminal.
        const slept =
          sleep.livePtyIds.length === 0 ||
          (sleep.stoppedPtyIds.includes(ptyId) && !sleep.remainingLivePtyIds?.includes(ptyId))
        if (!slept) {
          return false
        }
      } catch (error) {
        console.error('[automations] could not sleep a run workspace:', error)
        return false
      }
      // The slept pane keeps its tab and pane key, which reopen and resume it.
      await service.markDispatchResult({ runId: run.id, status: run.status, terminalPtyId: null })
      return true
    },
    inAutomationLane: (automationId, operation) =>
      service.runInAutomationLane(automationId, operation),
    forgetRunTerminal: async (run) => {
      // A run still dispatched had its agent exit without a result, proven by its idle shell.
      const unfinished = run.status === 'dispatched'
      await service.markDispatchResult({
        runId: run.id,
        status: unfinished ? 'dispatch_failed' : run.status,
        error: unfinished
          ? (run.error ?? 'The agent exited without reporting completion.')
          : run.error,
        terminalSessionId: null,
        terminalPaneKey: null,
        terminalPtyId: null
      })
    }
  })
  service.releaseFinishedRunTerminals = () => retention.drain()
  const start = service.start.bind(service)
  const stop = service.stop.bind(service)
  service.start = () => {
    start()
    retention.start()
  }
  service.stop = () => {
    retention.stop()
    stop()
  }
}

function automationAgentCommands(agentId: string | undefined): string[] {
  if (!isTuiAgent(agentId)) {
    return []
  }
  const config = TUI_AGENT_CONFIG[agentId]
  return [...getTuiAgentDetectCommands(config), config.launchCmd]
}
