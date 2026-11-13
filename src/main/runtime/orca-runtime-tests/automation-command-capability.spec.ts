import { describe, expect, it, vi } from 'vitest'
import { createRuntime } from '../orca-runtime-test-fixtures.spec'
import {
  AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY,
  AUTOMATION_RUNTIME_CAPABILITIES
} from '../../../shared/automation-runtime-capabilities'

describe('command automation capability', () => {
  it('is absent until this execution host has a ready command pipeline', () => {
    const runtime = createRuntime()
    const available = vi.spyOn(runtime, 'commandAutomationAvailable').mockReturnValue(false)
    expect(runtime.getStatus().capabilities).not.toContain(
      AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY
    )
    available.mockReturnValue(true)
    expect(runtime.getStatus().capabilities).toContain(
      AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY
    )
    available.mockReturnValue(false)
    expect(runtime.getStatus().capabilities).not.toContain(
      AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY
    )
    expect(available).toHaveBeenCalledTimes(3)
  })

  it('does not advertise command execution through the unconditional runtime capability list', () => {
    expect([...AUTOMATION_RUNTIME_CAPABILITIES]).not.toContain(
      AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY
    )
    expect(createRuntime().commandAutomationAvailable()).toBe(false)
  })
})
