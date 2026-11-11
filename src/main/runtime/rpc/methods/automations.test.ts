import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { AUTOMATION_METHODS } from './automations'
import { AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY } from '../../../../shared/automation-runtime-capabilities'
import { readAutomationCommandsV1Domain } from '../../../../shared/automation-command-domain'
import { buildProfileStateCutoverFixture } from '../../../persistence/profile-state-cutover-fixture'
import { createCommandAutomationDefinition } from '../../../persistence/scheduling-automations/automation-command-definition-operations'
import {
  commandDefinitionFromDraft,
  emptyAutomationCommandDraft
} from '../../../../renderer/src/components/automations/automation-command-draft'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('automation RPC methods', () => {
  it('routes automation CRUD and run operations to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAutomations: vi.fn().mockReturnValue([{ id: 'auto-1', name: 'Daily review' }]),
      listAutomationsForScope: vi.fn().mockReturnValue({
        automations: [{ id: 'auto-1', name: 'Daily review' }],
        items: [{ automationId: 'auto-1', selector: { kind: 'self' } }]
      }),
      showAutomation: vi.fn().mockReturnValue({ id: 'auto-1', name: 'Daily review' }),
      createAutomation: vi.fn().mockResolvedValue({ id: 'auto-2', name: 'New review' }),
      updateAutomation: vi.fn().mockResolvedValue({ id: 'auto-1', name: 'Paused' }),
      deleteAutomation: vi.fn().mockReturnValue({ removed: true, id: 'auto-1' }),
      runAutomationNow: vi.fn().mockResolvedValue({ id: 'run-1', automationId: 'auto-1' }),
      listAutomationRuns: vi.fn().mockReturnValue([{ id: 'run-1', automationId: 'auto-1' }])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    await dispatcher.dispatch(makeRequest('automation.list'))
    await dispatcher.dispatch(makeRequest('automation.show', { id: 'auto-1' }))
    await dispatcher.dispatch(
      makeRequest('automation.create', {
        name: 'New review',
        prompt: 'Review changes',
        precheck: { command: 'test -f ready', timeoutSeconds: 30 },
        agentId: 'codex',
        runContext: {
          kind: 'workspace-run',
          projectId: 'github:stablyai/orca',
          hostId: 'runtime:gpu',
          projectHostSetupId: 'setup-gpu',
          repoId: 'repo-gpu',
          path: '/srv/orca'
        },
        sourceContext: {
          kind: 'task-source',
          provider: 'github',
          projectId: 'github:stablyai/orca',
          hostId: 'local',
          projectHostSetupId: 'setup-local',
          repoId: 'repo-local',
          providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
        },
        repo: 'repo-1',
        setupDecision: 'skip',
        reuseSession: true,
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: 1
      })
    )
    await dispatcher.dispatch(
      makeRequest('automation.update', {
        id: 'auto-1',
        updates: {
          enabled: false,
          setupDecision: 'run',
          reuseSession: false,
          rrule: '0 9 * * 1-5',
          dtstart: 2
        }
      })
    )
    await dispatcher.dispatch(makeRequest('automation.delete', { id: 'auto-1' }))
    await dispatcher.dispatch(makeRequest('automation.runNow', { id: 'auto-1' }))
    await dispatcher.dispatch(makeRequest('automation.runs', { automationId: 'auto-1' }))

    expect(runtime.listAutomationsForScope).toHaveBeenCalledWith({})
    // A legacy client sends no precondition, so each call forwards an absent expected owner.
    expect(runtime.showAutomation).toHaveBeenCalledWith('auto-1', undefined)
    expect(runtime.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'New review',
        prompt: 'Review changes',
        precheck: { command: 'test -f ready', timeoutSeconds: 30 },
        agentId: 'codex',
        runContext: expect.objectContaining({ hostId: 'runtime:gpu' }),
        sourceContext: expect.objectContaining({ hostId: 'local' }),
        repo: 'repo-1',
        setupDecision: 'skip',
        reuseSession: true
      })
    )
    expect(runtime.updateAutomation).toHaveBeenCalledWith(
      'auto-1',
      expect.objectContaining({
        enabled: false,
        setupDecision: 'run',
        reuseSession: false,
        rrule: '0 9 * * 1-5'
      }),
      { expectedOwner: undefined, destination: undefined }
    )
    expect(runtime.deleteAutomation).toHaveBeenCalledWith('auto-1', undefined)
    expect(runtime.runAutomationNow).toHaveBeenCalledWith('auto-1', undefined)
    expect(runtime.listAutomationRuns).toHaveBeenCalledWith('auto-1', undefined)
  })

  it('returns a cursor page when the caller requests a bounded run history', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAutomationRunsPage: vi.fn().mockReturnValue({
        runs: [{ id: 'run-100', automationId: 'auto-1' }],
        nextCursor: '100'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    await expect(
      dispatcher.dispatch(makeRequest('automation.runs', { automationId: 'auto-1', limit: 100 }))
    ).resolves.toMatchObject({
      ok: true,
      result: { nextCursor: '100' }
    })
    expect(runtime.listAutomationRunsPage).toHaveBeenCalledWith('auto-1', undefined, 100, undefined)
  })

  it('hides command runs from legacy history reads, including cursor pages', async () => {
    const commandRun = { id: 'command-run', automationId: 'command-1', sessionKind: 'command' }
    const legacyRun = { id: 'legacy-run', automationId: 'legacy-1', sessionKind: 'terminal' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This dispatcher fixture supplies every runtime method exercised by its requests.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAutomationRuns: vi.fn().mockReturnValue([commandRun, legacyRun]),
      listAutomationRunsPage: vi.fn().mockReturnValue({
        runs: [commandRun, legacyRun],
        nextCursor: null
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    await expect(dispatcher.dispatch(makeRequest('automation.runs', {}))).resolves.toMatchObject({
      ok: true,
      result: { runs: [legacyRun] }
    })
    await expect(
      dispatcher.dispatch(makeRequest('automation.runs', { limit: 100 }))
    ).resolves.toMatchObject({ ok: true, result: { runs: [legacyRun] } })
  })

  it('exposes command definitions and runs only to a capable reader', async () => {
    const command = { id: 'command-1', name: 'Command' }
    const commandRun = { id: 'command-run', automationId: 'command-1', sessionKind: 'command' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This dispatcher fixture supplies every runtime method exercised by its requests.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAutomationsForScope: vi.fn().mockReturnValue({ automations: [], items: [] }),
      listCommandAutomations: vi.fn().mockReturnValue([command]),
      listAutomationRuns: vi.fn().mockReturnValue([commandRun])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })
    const clientCapabilities = [AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY]

    await expect(dispatcher.dispatch(makeRequest('automation.list'))).resolves.toMatchObject({
      ok: true,
      result: { automations: [] }
    })
    expect(runtime.listCommandAutomations).not.toHaveBeenCalled()
    await expect(
      dispatcher.dispatch(makeRequest('automation.list'), { clientCapabilities })
    ).resolves.toMatchObject({ ok: true, result: { commandAutomations: [command] } })
    await expect(
      dispatcher.dispatch(makeRequest('automation.runs', { automationId: command.id }), {
        clientCapabilities
      })
    ).resolves.toMatchObject({ ok: true, result: { runs: [commandRun] } })
  })

  it('reads one command manual receipt only for a capable local owner', async () => {
    const receipt = {
      automationId: 'command-1',
      requestKey: 'request-1',
      payloadHash: 'a'.repeat(64),
      createdAt: 1,
      runId: 'run-1'
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This dispatcher fixture supplies every runtime method exercised by its requests.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      commandAutomationAvailable: () => true,
      commandAutomationManualReceipt: vi.fn().mockReturnValue(receipt),
      listAutomationRuns: vi.fn().mockReturnValue([])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })
    const params = {
      automationId: 'command-1',
      manualRequestKey: 'request-1',
      expectedOwner: { selector: { kind: 'self' } }
    }
    await expect(
      dispatcher.dispatch(makeRequest('automation.runs', params))
    ).resolves.toMatchObject({ ok: false })
    expect(runtime.commandAutomationManualReceipt).not.toHaveBeenCalled()
    await expect(
      dispatcher.dispatch(makeRequest('automation.runs', params), {
        clientCapabilities: [AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY]
      })
    ).resolves.toMatchObject({ ok: true, result: { manualReceipt: receipt, runs: [] } })
    expect(runtime.commandAutomationManualReceipt).toHaveBeenCalledWith('command-1', 'request-1')
  })

  it('refuses a stale local project in the actual V2 create handler before any definition write', async () => {
    const state = buildProfileStateCutoverFixture('/fixture')
    const localSetup = state.projectHostSetups.find((entry) => entry.id === 'setup-local')
    const localRepo = state.repos.find((entry) => entry.id === 'repo-local')
    if (!localSetup || !localRepo) {
      throw new Error('Fixture local project missing.')
    }
    const setup = { ...localSetup, projectId: 'repo-local' }
    const definition = commandDefinitionFromDraft(
      {
        ...emptyAutomationCommandDraft(),
        name: 'Check',
        setupId: setup.id,
        commandText: 'true',
        timezone: 'UTC'
      },
      setup,
      Date.UTC(2026, 10, 11, 8),
      'same-create-key'
    )
    localRepo.executionHostId = 'ssh:build-host'
    const flush = vi.fn()
    const operations = { state, flush, markDomainDirty: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This dispatcher fixture supplies every runtime method exercised by its request.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      commandAutomationAvailable: () => true,
      createCommandAutomation: vi.fn((input: typeof definition) =>
        Promise.resolve(createCommandAutomationDefinition(operations, input))
      )
    } as unknown as OrcaRuntimeService
    const response = await new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS }).dispatch(
      makeRequest('automation.createV2', { version: 2, definition })
    )
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'runtime_error', message: 'Command automation project is unavailable.' }
    })
    expect(runtime.createCommandAutomation).toHaveBeenCalledOnce()
    expect(readAutomationCommandsV1Domain(state.automationCommandsV1).definitions).toEqual([])
    expect(flush).not.toHaveBeenCalled()
  })

  it('refuses versioned execution before any legacy fallback or effect', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This dispatcher fixture supplies every runtime method exercised by its requests.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      commandAutomationAvailable: vi.fn().mockReturnValue(false),
      runAutomationNow: vi.fn(),
      createCommandAutomation: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    await expect(
      dispatcher.dispatch(
        makeRequest('automation.runNowV2', {
          version: 2,
          id: 'command-1',
          expectedRevision: 1,
          expectedOwner: { selector: { kind: 'self' } },
          requestKey: 'request-1',
          requestCreatedAt: 1,
          payloadHash: 'a'.repeat(64)
        })
      )
    ).resolves.toMatchObject({ ok: false })
    expect(runtime.commandAutomationAvailable).toHaveBeenCalledOnce()
    expect(runtime.runAutomationNow).not.toHaveBeenCalled()
    expect(runtime.createCommandAutomation).not.toHaveBeenCalled()
  })

  it('rejects unknown providers and invalid schedules', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createAutomation: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    await expect(
      dispatcher.dispatch(
        makeRequest('automation.create', {
          name: 'Bad provider',
          prompt: 'Run',
          agentId: 'not-real',
          repo: 'repo-1',
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
          dtstart: 1
        })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })

    await expect(
      dispatcher.dispatch(
        makeRequest('automation.create', {
          name: 'Bad schedule',
          prompt: 'Run',
          agentId: 'codex',
          repo: 'repo-1',
          rrule: 'not a schedule',
          dtstart: 1
        })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })

  it('preserves null baseBranch update values through the RPC boundary', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateAutomation: vi.fn().mockResolvedValue({ id: 'auto-1', baseBranch: null })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    await dispatcher.dispatch(
      makeRequest('automation.update', {
        id: 'auto-1',
        updates: { baseBranch: null }
      })
    )

    expect(runtime.updateAutomation).toHaveBeenCalledWith(
      'auto-1',
      { baseBranch: null },
      { expectedOwner: undefined, destination: undefined }
    )
  })
})
