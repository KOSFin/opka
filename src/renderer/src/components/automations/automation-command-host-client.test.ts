import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  commandAutomationEditorSetupsForTarget,
  updateCommandAutomationForTarget,
  createCommandAutomationForTarget,
  listCommandAutomationsForTarget,
  reconcileCommandManualRequestForTarget,
  runCommandAutomationForTarget
} from './automation-command-host-client'
import { commandDefinitionFromDraft, emptyAutomationCommandDraft } from './automation-command-draft'
import type { ProjectHostSetup } from '../../../../shared/project-types'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

const target = { kind: 'environment' as const, environmentId: 'execution-host' }

describe('command automation host client', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refuses a host without command capability before any command RPC', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ capabilities: [] })

    await expect(listCommandAutomationsForTarget(target)).rejects.toMatchObject({
      code: 'unsupported_host_scope'
    })
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(callRuntimeRpc).toHaveBeenCalledWith(target, 'status.get', undefined, {
      timeoutMs: 15_000
    })
  })

  it('uses the selected execution host and stable request hash for V2 admission', async () => {
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ capabilities: ['automation.command-pipeline.v1'] })
      .mockResolvedValueOnce({ admission: { kind: 'overlap', activeRunId: 'run-1' } })

    await expect(
      runCommandAutomationForTarget(target, 'command-1', 3, 'same-request', 1_000)
    ).resolves.toEqual({ admission: { kind: 'overlap', activeRunId: 'run-1' } })

    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ id: 'command-1', expectedRevision: 3 }))
      .digest('hex')
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      target,
      'automation.runNowV2',
      {
        version: 2,
        id: 'command-1',
        expectedRevision: 3,
        expectedOwner: { selector: { kind: 'self' } },
        requestKey: 'same-request',
        requestCreatedAt: 1_000,
        payloadHash
      },
      { timeoutMs: 15_000 }
    )
  })

  it('does not retry a missing V2 method through legacy Run Now', async () => {
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ capabilities: ['automation.command-pipeline.v1'] })
      .mockRejectedValueOnce(new Error('method_not_found'))

    await expect(
      runCommandAutomationForTarget(target, 'command-1', 3, 'same-request', 1_000)
    ).rejects.toThrow('method_not_found')
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(vi.mocked(callRuntimeRpc).mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'automation.runNowV2'
    ])
  })

  it('freezes a manual request only after its host preflight succeeds', async () => {
    const preflightAccepted = vi.fn()
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ capabilities: [] })
    await expect(
      runCommandAutomationForTarget(
        target,
        'command-1',
        3,
        'same-request',
        1_000,
        preflightAccepted
      )
    ).rejects.toMatchObject({ code: 'unsupported_host_scope' })
    expect(preflightAccepted).not.toHaveBeenCalled()

    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ capabilities: ['automation.command-pipeline.v1'] })
      .mockRejectedValueOnce(new Error('response_lost'))
    await expect(
      runCommandAutomationForTarget(
        target,
        'command-1',
        3,
        'same-request',
        1_000,
        preflightAccepted
      )
    ).rejects.toThrow('response_lost')
    expect(preflightAccepted).toHaveBeenCalledOnce()
  })

  it('leaves a refused create editable and freezes only after a successful preflight', async () => {
    const setup: ProjectHostSetup = {
      id: 'setup-1',
      projectId: 'project-1',
      hostId: 'local',
      repoId: 'project-1',
      path: '/synthetic/folder',
      displayName: 'Folder',
      setupState: 'ready',
      setupMethod: 'imported-existing-folder',
      createdAt: 1,
      updatedAt: 1
    }
    const definition = commandDefinitionFromDraft(
      {
        ...emptyAutomationCommandDraft(),
        name: 'Check',
        setupId: setup.id,
        commandText: 'true',
        timezone: 'UTC'
      },
      setup,
      1000,
      'create-key'
    )
    const preflightAccepted = vi.fn()
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ capabilities: [] })
    await expect(
      createCommandAutomationForTarget(target, definition, preflightAccepted)
    ).rejects.toMatchObject({ code: 'unsupported_host_scope' })
    expect(preflightAccepted).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)

    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ capabilities: ['automation.command-pipeline.v1'] })
      .mockRejectedValueOnce(new Error('response_lost'))
    await expect(
      createCommandAutomationForTarget(target, definition, preflightAccepted)
    ).rejects.toThrow('response_lost')
    expect(preflightAccepted).toHaveBeenCalledOnce()
  })

  it('refuses to infer a missing receipt field from an older host', async () => {
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ capabilities: ['automation.command-pipeline.v1'] })
      .mockResolvedValueOnce({ runs: [] })
    await expect(
      reconcileCommandManualRequestForTarget(target, 'command-1', 'same-request')
    ).rejects.toMatchObject({ code: 'unsupported_host_scope' })
  })
  it('keeps project choices, list, create, edit and run on the selected remote host', async () => {
    const setup: ProjectHostSetup = {
      id: 'remote-setup',
      projectId: 'project',
      hostId: 'local',
      repoId: 'repo',
      path: '/remote/folder',
      displayName: 'Remote folder',
      setupState: 'ready',
      setupMethod: 'imported-existing-folder',
      createdAt: 1,
      updatedAt: 1
    }
    const definition = commandDefinitionFromDraft(
      {
        ...emptyAutomationCommandDraft(),
        name: 'Remote check',
        setupId: setup.id,
        commandText: 'true',
        timezone: 'UTC'
      },
      setup,
      1000,
      'remote-create'
    )
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ capabilities: ['automation.command-pipeline.v1'] })
      .mockResolvedValueOnce({ setups: [setup] })
      .mockResolvedValueOnce({ capabilities: ['automation.command-pipeline.v1'] })
      .mockResolvedValueOnce({ commandAutomations: [] })
      .mockResolvedValueOnce({ capabilities: ['automation.command-pipeline.v1'] })
      .mockResolvedValueOnce({ automation: { ...definition, id: 'remote-command', revision: 1 } })
      .mockResolvedValueOnce({ capabilities: ['automation.command-pipeline.v1'] })
      .mockResolvedValueOnce({ automation: { ...definition, id: 'remote-command', revision: 2 } })
      .mockResolvedValueOnce({ capabilities: ['automation.command-pipeline.v1'] })
      .mockResolvedValueOnce({ admission: { kind: 'overlap', activeRunId: 'active' } })
    expect(await commandAutomationEditorSetupsForTarget(target)).toEqual([setup])
    await listCommandAutomationsForTarget(target)
    await createCommandAutomationForTarget(target, definition)
    await updateCommandAutomationForTarget(target, 'remote-command', 1, { name: 'Changed' })
    await runCommandAutomationForTarget(target, 'remote-command', 1, 'remote-run', 1000)
    expect(
      vi.mocked(callRuntimeRpc).mock.calls.every(([destination]) => destination === target)
    ).toBe(true)
    expect(vi.mocked(callRuntimeRpc).mock.calls.map(([, method]) => method)).toEqual([
      'status.get',
      'projectHostSetup.list',
      'status.get',
      'automation.list',
      'status.get',
      'automation.createV2',
      'status.get',
      'automation.updateV2',
      'status.get',
      'automation.runNowV2'
    ])
  })

  it('never loads desktop projects after a remote project read fails', async () => {
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ capabilities: ['automation.command-pipeline.v1'] })
      .mockRejectedValueOnce(new Error('remote offline'))
    await expect(commandAutomationEditorSetupsForTarget(target)).rejects.toThrow('remote offline')
    expect(
      vi.mocked(callRuntimeRpc).mock.calls.every(([destination]) => destination === target)
    ).toBe(true)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  })
})
