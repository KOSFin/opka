import { describe, expect, it, vi } from 'vitest'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import {
  createCommandAutomationDefinition,
  deleteCommandAutomationDefinition,
  replaceCommandAutomationDefinition
} from './automation-command-definition-operations'

const NOW = Date.UTC(2026, 10, 9, 12)

function fixture() {
  const state = buildProfileStateCutoverFixture('/fixture')
  const markDomainDirty = vi.fn()
  const flush = vi.fn()
  const operations = { state, markDomainDirty, flush }
  const input = {
    creationKey: 'create-1',
    name: 'Check folder',
    runContext: {
      kind: 'workspace-run',
      projectId: 'project-fixture',
      hostId: 'local',
      projectHostSetupId: 'setup-local',
      repoId: 'repo-local',
      path: '/fixture/local'
    },
    sourceContext: null,
    projectId: 'repo-local',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: 'repo-local::/fixture/local',
    baseBranch: null,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=12;BYMINUTE=0',
    dtstart: NOW,
    enabled: true,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    execution: {
      version: 1,
      command: { kind: 'program', executable: 'check', argv: [] },
      condition: 'never_agent',
      agent: null,
      policy: {
        timeoutSeconds: 900,
        commandTimeoutSeconds: 60,
        idempotent: false,
        maxAttempts: 1
      },
      reportTarget: null
    }
  }
  return { state, operations, input, flush }
}

describe('command automation definitions', () => {
  it('deduplicates a matching create key and rejects changed content', () => {
    const { operations, input, flush } = fixture()
    const created = createCommandAutomationDefinition(operations, input, NOW)
    expect(created).toMatchObject({ revision: 1, name: 'Check folder' })
    expect(createCommandAutomationDefinition(operations, input, NOW)).toEqual(created)
    expect(flush).toHaveBeenCalledOnce()
    expect(() =>
      createCommandAutomationDefinition(operations, { ...input, name: 'Changed' }, NOW)
    ).toThrow('different content')
  })

  it('fences replacement and deletion while a claim is active', () => {
    const { state, operations, input } = fixture()
    const created = createCommandAutomationDefinition(operations, input, NOW)
    state.automationCommandsV1 = {
      version: 1,
      definitions: [created],
      activeClaims: [
        {
          automationId: created.id,
          runId: 'run-1',
          definitionRevision: 1,
          hostId: 'local',
          hostGeneration: 1,
          acquisitionId: 'acquisition-1',
          attempt: 1,
          phase: 'acquiring',
          createdAt: NOW
        }
      ],
      manualReceipts: []
    }
    expect(() =>
      replaceCommandAutomationDefinition(operations, created.id, 1, input, NOW + 1)
    ).toThrow('active run')
    expect(() => deleteCommandAutomationDefinition(operations, created.id, 1)).toThrow('active run')
  })

  it('rejects an unproven target before persistence', () => {
    const { operations, input, flush } = fixture()
    expect(() =>
      createCommandAutomationDefinition(
        operations,
        { ...input, executionTargetType: 'ssh', executionTargetId: 'ssh-1' },
        NOW
      )
    ).toThrow('capable local execution host')
    expect(flush).not.toHaveBeenCalled()
  })

  it('drops replay receipts when a settled definition is deleted', () => {
    const { state, operations, input } = fixture()
    const created = createCommandAutomationDefinition(operations, input, NOW)
    state.automationCommandsV1 = {
      version: 1,
      definitions: [created],
      activeClaims: [],
      manualReceipts: [
        {
          automationId: created.id,
          requestKey: 'run-1',
          payloadHash: 'a'.repeat(64),
          createdAt: NOW,
          runId: 'run-1'
        }
      ]
    }
    deleteCommandAutomationDefinition(operations, created.id, created.revision)
    expect(state.automationCommandsV1).toMatchObject({ definitions: [], manualReceipts: [] })
  })
})
