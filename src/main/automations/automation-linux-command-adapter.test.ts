import { describe, expect, it, vi } from 'vitest'
import { AutomationCommandDefinitionV1 } from '../../shared/automation-command-domain'
import { createLinuxCommandAutomationAdapter } from './automation-linux-command-adapter'

vi.mock('../daemon/daemon-cgroup-scope', () => ({ isDurableDaemonScopeSupported: () => true }))
vi.mock('../ipc/command-path-resolver', () => ({
  resolveCommandOnLocalPath: vi.fn(async () => '/synthetic/check')
}))

const NOW = Date.UTC(2026, 10, 11, 8)

function definition() {
  return AutomationCommandDefinitionV1.parse({
    id: 'command-1',
    name: 'Check',
    revision: 1,
    runContext: {
      kind: 'workspace-run',
      projectId: 'repo-local',
      hostId: 'local',
      projectHostSetupId: 'setup-local',
      repoId: 'repo-local',
      path: '/synthetic/folder'
    },
    sourceContext: null,
    projectId: 'repo-local',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: 'workspace-1',
    baseBranch: null,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
    dtstart: NOW,
    enabled: true,
    nextRunAt: NOW,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: NOW,
    updatedAt: NOW,
    execution: {
      version: 1,
      command: { kind: 'program', executable: 'check', argv: [] },
      condition: 'exit_zero',
      agent: { agentId: 'codex', prompt: 'Review', sessionPolicy: 'ephemeral' },
      policy: {
        timeoutSeconds: 900,
        commandTimeoutSeconds: 60,
        idempotent: false,
        maxAttempts: 1
      },
      reportTarget: {
        runtimeId: 'runtime-1',
        hostId: 'local',
        workspaceId: 'workspace-1',
        chatSessionId: 'chat-1',
        registrationGeneration: 1
      }
    }
  })
}

function adapter(options: {
  agent?: boolean
  report?: boolean
  agentSupported?: boolean
  reportSupported?: boolean
}) {
  const agentSupports = vi.fn(async () => options.agentSupported ?? true)
  const reportSupports = vi.fn(async () => options.reportSupported ?? true)
  const runAgent = vi.fn(async () => ({ verdict: 'exited' as const, success: true }))
  const deliver = vi.fn(async () => true)
  const result = createLinuxCommandAutomationAdapter({
    store: { getCommandAutomationClaim: vi.fn(), listAutomationRuns: vi.fn(() => []) },
    hostGeneration: 1,
    isCurrentOwner: () => true,
    runs: {
      bindCommandProcessIntent: vi.fn(),
      recordCommandExitProof: vi.fn(),
      bindAgentProcessIntent: vi.fn(),
      recordAgentExitProof: vi.fn()
    },
    resolveExistingWorkspaceCwd: vi.fn(async () => '/synthetic/folder'),
    ...(options.agent
      ? { oneShotAgent: { supportsDefinition: agentSupports, run: runAgent } }
      : {}),
    ...(options.report ? { reportDelivery: { supportsTarget: reportSupports, deliver } } : {})
  })
  return { result, agentSupports, reportSupports, runAgent, deliver }
}

describe.skipIf(process.platform !== 'linux')('Linux command adapter composition', () => {
  it('refuses optional effects without proven adapters before command acquisition', async () => {
    const candidate = definition()
    expect(await adapter({}).result.supportsDefinition(candidate)).toBe(false)
    expect(await adapter({ agent: true }).result.supportsDefinition(candidate)).toBe(false)
    expect(await adapter({ report: true }).result.supportsDefinition(candidate)).toBe(false)
    expect(
      await adapter({ agent: true, report: true, agentSupported: false }).result.supportsDefinition(
        candidate
      )
    ).toBe(false)
    expect(
      await adapter({
        agent: true,
        report: true,
        reportSupported: false
      }).result.supportsDefinition(candidate)
    ).toBe(false)
  })

  it('routes optional stages only through both explicitly supported injected effects', async () => {
    const candidate = definition()
    const wired = adapter({ agent: true, report: true })
    expect(await wired.result.supportsDefinition(candidate)).toBe(true)
    expect(wired.agentSupports).toHaveBeenCalledWith(candidate)
    expect(wired.reportSupports).toHaveBeenCalledWith(candidate)
    expect(wired.runAgent).not.toHaveBeenCalled()
    expect(wired.deliver).not.toHaveBeenCalled()
  })
})
