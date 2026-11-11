import { describe, expect, it, vi } from 'vitest'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import {
  bindAutomationCommandProcessIntent,
  recordAutomationCommandExitProof
} from './automation-command-process-operations'

const acquisitionId = '11111111-1111-4111-8111-111111111111'
const unitName = `orca-automation-${acquisitionId}.scope`
const childCgroupPath = `/sys/fs/cgroup/user.slice/${unitName}/command`

function fixture() {
  const state = buildProfileStateCutoverFixture('/fixture')
  state.automationRuns = [
    {
      ...state.automationRuns[0],
      id: 'run-1',
      automationId: 'automation-1',
      sessionKind: 'command'
    }
  ]
  state.automationCommandsV1 = {
    version: 1,
    definitions: [],
    activeClaims: [
      {
        automationId: 'automation-1',
        runId: 'run-1',
        definitionRevision: 1,
        hostId: 'local',
        hostGeneration: 2,
        acquisitionId,
        attempt: 1,
        phase: 'command',
        createdAt: 10,
        processIntent: {
          backend: 'linux_cgroup_v1',
          unitName,
          childName: 'command',
          receiptDirectory: '/tmp/claim'
        }
      }
    ],
    manualReceipts: []
  }
  const flush = vi.fn()
  const operations = { state, flush, markDomainsDirty: vi.fn() }
  const fence = {
    automationId: 'automation-1',
    runId: 'run-1',
    acquisitionId,
    hostGeneration: 2,
    expectedPhase: 'command' as const
  }
  return { state, operations, fence, flush }
}

describe('command child identity persistence', () => {
  it('refuses a different cgroup or acquisition before authorizing the effect gate', () => {
    const { operations, fence, flush } = fixture()
    for (const path of [
      `/sys/fs/cgroup/user.slice/other.scope/command`,
      `/sys/fs/cgroup/user.slice/${unitName}/other`,
      `/tmp/${unitName}/command`
    ]) {
      expect(() =>
        bindAutomationCommandProcessIntent(operations, fence, {
          childCgroupPath: path,
          blockedChildPid: 42,
          blockedChildStartTime: '500'
        })
      ).toThrow('receipt does not match')
    }
    expect(() =>
      bindAutomationCommandProcessIntent(
        operations,
        { ...fence, acquisitionId: 'stale' },
        { childCgroupPath, blockedChildPid: 42, blockedChildStartTime: '500' }
      )
    ).toThrow('acquisition changed')
    expect(flush).not.toHaveBeenCalled()
  })

  it('persists the verified exit result behind the same acquisition and refuses replacement', () => {
    const { state, operations, fence, flush } = fixture()
    const receipt = { childCgroupPath, blockedChildPid: 42, blockedChildStartTime: '500' }
    const bound = bindAutomationCommandProcessIntent(operations, fence, receipt)
    expect(bound.processIntent).toMatchObject({ ...receipt, execMayHappen: true })
    const observation = {
      exitCode: 0,
      timedOut: false,
      error: null,
      stdout: '{"version":1,"changed":false}\n',
      stdoutTruncated: false,
      stderr: '',
      stderrTruncated: false
    }
    const proved = recordAutomationCommandExitProof(operations, fence, observation, 11)
    expect(proved.processIntent?.exitProof).toMatchObject(observation)
    expect(state.automationCommandsV1).toMatchObject({
      activeClaims: [{ processIntent: { exitProof: { verifiedAt: 11 } } }]
    })
    expect(() => recordAutomationCommandExitProof(operations, fence, observation, 12)).toThrow(
      'exit proof does not match'
    )
    expect(flush).toHaveBeenCalledTimes(2)
  })
})
