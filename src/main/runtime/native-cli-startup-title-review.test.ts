import { afterEach, expect, it, vi } from 'vitest'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import { nativeCliStartupFixture } from './native-cli-startup-fixture'
import { prepareNativeCliStartup } from './native-cli-startup-prepare'

const prepare = vi.hoisted(() => vi.fn())
vi.mock('./native-cli-account-launch', () => ({ prepareNativeCliAccountLaunch: prepare }))

afterEach(() => prepare.mockReset())

it('keeps a typed initial refusal eligible after an unrelated live title with no agent status', async () => {
  const fixture = nativeCliStartupFixture()
  try {
    // The title observer sets observedLive for an unclassified title too.
    fixture.pty.lastAgentStatus = null
    fixture.pty.lastAgentStatusObservedLive = true
    prepare.mockRejectedValue(new NativeCliControlError('config_conflict'))

    await expect(prepareNativeCliStartup(fixture.runtime, fixture.request)).rejects.toThrow(
      NativeCliControlError
    )
    expect(prepare).toHaveBeenCalledOnce()
    expect(fixture.startup.refusal?.code).toBe('native_cli_config_conflict')
    await expect(fixture.startup.settled).resolves.toMatchObject({
      kind: 'not-started',
      code: 'native_cli_config_conflict'
    })
  } finally {
    fixture.dispose()
  }
})
