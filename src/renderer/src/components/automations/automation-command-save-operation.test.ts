import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import { emptyAutomationCommandDraft } from './automation-command-draft'
import { pendingCommandRequests } from './automation-command-pending-requests'
import { saveCommandAutomationDraft } from './automation-command-save-operation'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

const target = { kind: 'environment' as const, environmentId: 'create-lifecycle-host' }
const setup: ProjectHostSetup = {
  id: 'setup-1',
  projectId: 'repo-local',
  hostId: 'local',
  repoId: 'repo-local',
  path: '/synthetic/folder',
  displayName: 'Folder',
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1
}

function draft(name: string) {
  return {
    ...emptyAutomationCommandDraft(),
    name,
    setupId: setup.id,
    commandText: 'true',
    timezone: 'UTC'
  }
}

beforeEach(() => vi.mocked(callRuntimeRpc).mockReset())

describe('command automation create lifecycle', () => {
  it('releases a definitively refused stale project so the draft can be edited', async () => {
    const pending = pendingCommandRequests('fixture:stale-project-create')
    pending.create = null
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ capabilities: ['automation.command-pipeline.v1'] })
      .mockRejectedValueOnce(
        new RuntimeRpcCallError({
          id: 'req-1',
          ok: false,
          error: { code: 'runtime_error', message: 'Command automation project is unavailable.' }
        })
      )
    await expect(
      saveCommandAutomationDraft({
        target,
        setups: [setup],
        draft: draft('Before'),
        editingId: null,
        selected: null,
        pending
      })
    ).rejects.toThrow('Command automation project is unavailable.')
    expect(pending.create).toBeNull()

    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ capabilities: ['automation.command-pipeline.v1'] })
      .mockResolvedValueOnce({ automation: { id: 'created-1', name: 'After' } })
    await saveCommandAutomationDraft({
      target,
      setups: [setup],
      draft: draft('After'),
      editingId: null,
      selected: null,
      pending
    })
    expect(pendingCommandRequests('fixture:stale-project-create').create?.draft.name).toBe('After')
    expect(vi.mocked(callRuntimeRpc).mock.calls[3][2]).toMatchObject({
      definition: { name: 'After' }
    })
  })

  it('keeps the exact creation key and draft after a lost answer and remount', async () => {
    const hostKey = 'fixture:lost-create-answer'
    const pending = pendingCommandRequests(hostKey)
    pending.create = null
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ capabilities: ['automation.command-pipeline.v1'] })
      .mockRejectedValueOnce(new Error('response_lost'))
    await expect(
      saveCommandAutomationDraft({
        target,
        setups: [setup],
        draft: draft('Same'),
        editingId: null,
        selected: null,
        pending
      })
    ).rejects.toThrow('response_lost')
    const first = pendingCommandRequests(hostKey).create
    expect(first?.input.creationKey).toBeTruthy()
    expect(pendingCommandRequests(hostKey).create).toBe(first)

    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ capabilities: ['automation.command-pipeline.v1'] })
      .mockResolvedValueOnce({ automation: { id: 'created-1', name: 'Same' } })
    await saveCommandAutomationDraft({
      target,
      setups: [setup],
      draft: draft('Changed while pending'),
      editingId: null,
      selected: null,
      pending: pendingCommandRequests(hostKey)
    })
    expect(pendingCommandRequests(hostKey).create).toBe(first)
    expect(vi.mocked(callRuntimeRpc).mock.calls[3][2]).toMatchObject({
      definition: first?.input
    })
  })
})
