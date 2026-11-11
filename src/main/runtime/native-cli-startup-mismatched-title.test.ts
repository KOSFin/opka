import { afterEach, expect, it, vi } from 'vitest'
import { detectAgentStatusFromTitle } from '../../shared/agent-detection'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import { nativeCliStartupFixture } from './native-cli-startup-fixture'
import { prepareNativeCliStartup } from './native-cli-startup-prepare'

const prepare = vi.hoisted(() => vi.fn())
vi.mock('./native-cli-account-launch', () => ({ prepareNativeCliAccountLaunch: prepare }))

afterEach(() => prepare.mockReset())

it('keeps an initial Codex refusal after a classified title from another agent', async () => {
  const fixture = nativeCliStartupFixture()
  try {
    const unrelatedStatus = detectAgentStatusFromTitle('MiMo Code')
    expect(unrelatedStatus).toBe('idle')
    fixture.pty.lastOscTitle = 'MiMo Code'
    fixture.pty.lastAgentStatus = unrelatedStatus
    fixture.pty.lastAgentStatusObservedLive = true
    prepare.mockRejectedValue(new NativeCliControlError('config_conflict'))

    await expect(prepareNativeCliStartup(fixture.runtime, fixture.request)).rejects.toThrow(
      NativeCliControlError
    )
    expect(fixture.startup.refusal?.code).toBe('native_cli_config_conflict')
    await expect(fixture.startup.settled).resolves.toMatchObject({
      kind: 'not-started',
      code: 'native_cli_config_conflict'
    })
  } finally {
    fixture.dispose()
  }
})
