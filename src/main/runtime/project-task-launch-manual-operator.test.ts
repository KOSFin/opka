import { describe, expect, it } from 'vitest'
import { PROJECT_TASK_DELEGATION_CAPABILITY } from '../../shared/project-task-delegation'
import { isManualProjectTaskOperatorStart } from './project-task-launch'

describe('manual project task operator start', () => {
  it('recognizes the authenticated desktop action without delegated intent', () => {
    expect(isManualProjectTaskOperatorStart({ caller: { kind: 'desktop' } }, {})).toBe(true)
  })

  it('retains the agent identity path for declared delegation and scoped requests', () => {
    expect(
      isManualProjectTaskOperatorStart(
        { caller: { kind: 'desktop' } },
        { delegationCapability: PROJECT_TASK_DELEGATION_CAPABILITY }
      )
    ).toBe(false)
    expect(
      isManualProjectTaskOperatorStart({ caller: { kind: 'desktop' } }, { requestId: 'request-1' })
    ).toBe(false)
    expect(
      isManualProjectTaskOperatorStart(
        { caller: { kind: 'desktop' }, orchestrationCompatibilityEvidence: {} },
        {}
      )
    ).toBe(false)
  })

  it('never treats a local CLI, unknown transport or paired client as the desktop operator', () => {
    expect(isManualProjectTaskOperatorStart({ caller: { kind: 'local-cli' } }, {})).toBe(false)
    expect(isManualProjectTaskOperatorStart({}, {})).toBe(false)
    expect(
      isManualProjectTaskOperatorStart({ caller: { kind: 'desktop' }, pairedDeviceId: 'phone' }, {})
    ).toBe(false)
    expect(
      isManualProjectTaskOperatorStart(
        { caller: { kind: 'paired-device', deviceId: 'phone' }, pairedDeviceId: 'phone' },
        {}
      )
    ).toBe(false)
  })
})
