import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationCommandDefinitionV1 } from '../../shared/automation-command-domain'
import type { Automation } from '../../shared/automations-types'
import { getDefaultPersistedState } from '../../shared/constants'
import { closeTestStores, createStore, testState } from '../persistence-test-harness'
import { RuntimeAutomationController } from './runtime-automation-controller'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const self = { selector: { kind: 'self' } } as const
const foreign = { selector: { kind: 'ssh', targetId: 'foreign', targetGeneration: 1 } } as const
const command = AutomationCommandDefinitionV1.parse({
  id: 'command-owned',
  name: 'Owned command',
  revision: 1,
  runContext: {
    kind: 'workspace-run',
    projectId: 'repo',
    hostId: 'local',
    projectHostSetupId: 'setup',
    repoId: 'repo',
    path: '/fixture/project'
  },
  sourceContext: null,
  projectId: 'repo',
  executionTargetType: 'local',
  executionTargetId: 'local',
  schedulerOwner: 'local_host_service',
  workspaceMode: 'existing',
  workspaceId: 'workspace',
  baseBranch: null,
  timezone: 'UTC',
  rrule: 'FREQ=DAILY',
  dtstart: 0,
  enabled: false,
  nextRunAt: 0,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 1,
  createdAt: 0,
  updatedAt: 0,
  execution: {
    version: 1,
    command: { kind: 'program', executable: '/usr/bin/true', argv: [] },
    condition: 'never_agent',
    agent: null,
    reportTarget: null,
    policy: { timeoutSeconds: 10, commandTimeoutSeconds: 5, idempotent: true, maxAttempts: 1 }
  }
})

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'command-owner-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

function fixture() {
  const legacy: Automation = {
    ...command,
    id: 'legacy-owned',
    prompt: 'Review',
    precheck: null,
    agentId: 'codex',
    reuseSession: false
  }
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({
      ...getDefaultPersistedState(testState.dir),
      repos: [
        { id: 'repo', path: testState.dir, displayName: 'Fixture', badgeColor: '', addedAt: 0 }
      ],
      automations: [legacy],
      automationCommandsV1: {
        version: 1,
        hostEpoch: 1,
        definitions: [command],
        activeClaims: [],
        manualReceipts: []
      }
    })
  )
  const store = createStore()
  const controller = new RuntimeAutomationController(store, {
    showRepo: async () => {
      throw new Error('Not used by owner reads')
    },
    showManagedWorktree: async () => {
      throw new Error('Not used by owner reads')
    }
  })
  return { store, controller }
}

describe('command and legacy automation ownership', () => {
  it('reads only verified self commands and retains the legacy ownership guard', () => {
    const { store, controller } = fixture()
    const legacyGuard = vi.spyOn(store, 'assertAutomationOwnerFence')
    expect(controller.commands.available()).toBe(false)
    expect(() => controller.assertOwner(command.id, self, 'read')).not.toThrow()
    expect(() => controller.assertOwner(command.id, undefined, 'read')).not.toThrow()
    expect(legacyGuard).not.toHaveBeenCalled()
    expect(() => controller.assertOwner(command.id, foreign, 'read')).toThrow(/host|context/)
    expect(() => controller.assertOwner('legacy-owned', self, 'read')).not.toThrow()
    expect(legacyGuard).toHaveBeenCalledOnce()
    expect(() => controller.assertOwner('legacy-owned', foreign, 'read')).toThrow()
    expect(() => controller.assertOwner('missing', self, 'read')).toThrow('not found')
  })

  it.each([
    { executionTargetType: 'ssh', executionTargetId: 'foreign' },
    { executionTargetGeneration: 2 },
    { runContext: { ...command.runContext, hostId: 'ssh:foreign' } },
    { runContext: { ...command.runContext, projectId: 'different-project' } }
  ])(
    'refuses an inconsistent imported definition before bypassing any legacy fence: %j',
    (changes) => {
      const { store, controller } = fixture()
      const changed = AutomationCommandDefinitionV1.parse({ ...command, ...changes })
      vi.spyOn(store, 'listCommandAutomations').mockReturnValue([changed])
      expect(() => controller.assertOwner(command.id, self, 'read')).toThrow(/host|context/)
    }
  )

  it('refuses foreign-owner mutations and still updates/deletes an owned command', async () => {
    const { controller } = fixture()
    const commands = controller.commands
    await expect(commands.update(command.id, 1, foreign, { name: 'Wrong' })).rejects.toThrow(
      /host|context/
    )
    await expect(commands.delete(command.id, 1, foreign)).rejects.toThrow(/host|context/)
    await expect(
      commands.runNow(command.id, 1, foreign, {
        key: 'request',
        createdAt: 1,
        payloadHash: '0'.repeat(64)
      })
    ).rejects.toThrow(/host|context/)
    await expect(commands.cancel(command.id, 'run', foreign, 'request')).rejects.toThrow(
      /host|context/
    )
    expect(commands.manualReceipt(command.id, 'unknown')).toBeNull()
    expect(() => commands.manualReceipt('missing', 'request')).toThrow('unavailable')
    const updated = await commands.update(command.id, 1, self, { name: 'Renamed' })
    expect(updated.name).toBe('Renamed')
    await commands.delete(command.id, updated.revision, self)
    expect(commands.list()).toEqual([])
  })
})
