import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'

const fakes = vi.hoisted(() => ({
  host: {
    prepareLaunch: async () => ({ runtime: 'host' }),
    publish: () => {},
    systemDefaultHome: () => '/host/.claude',
    preparation: async () => ({ runtime: 'host' }),
    accountUsagePreparation: async (id: string) => ({
      configDir: `/legacy/${id}`,
      envPatch: {},
      provenance: `profile:${id}`
    })
  },
  wsl: {
    prepareLaunch: async (distro: string) => ({ runtime: 'wsl', wslDistro: distro }),
    preparation: async (distro: string) => ({ runtime: 'wsl', wslDistro: distro }),
    publish: async (_distro: string): Promise<void> => {},
    runningDistros: async (): Promise<string[]> => []
  }
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/data/orca' })
}))
vi.mock('../wsl', () => ({
  getDefaultWslDistro: () => 'Ubuntu',
  getWslHome: (distro: string) => `/wsl/${distro}/home`
}))
vi.mock('./claude-profile-router', () => ({
  ClaudeProfileRouter: function ClaudeProfileRouter() {
    return fakes.host
  }
}))
vi.mock('./claude-profile-wsl-router', () => ({
  ClaudeWslProfileRouter: function ClaudeWslProfileRouter() {
    return fakes.wsl
  }
}))
vi.mock('./claude-profile-installed-router', () => ({
  installClaudeProfileRouter: () => {},
  installClaudeWslProfileRouter: () => {}
}))

import { ClaudeRuntimeAuthService } from './runtime-auth-service'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
function service(
  platformName: NodeJS.Platform,
  overrides: Partial<GlobalSettings> = {},
  isDistroRunning: (distro: string) => Promise<boolean> = async () => true
) {
  Object.defineProperty(process, 'platform', { configurable: true, value: platformName })
  const settings = { ...getDefaultSettings('/home/user'), ...overrides }
  return new ClaudeRuntimeAuthService({ getSettings: () => settings }, isDistroRunning)
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
})

describe('ClaudeRuntimeAuthService', () => {
  it('skips a quota preparation for a stopped distro instead of booting it', async () => {
    const preparation = vi.spyOn(fakes.wsl, 'preparation')
    const auth = service('win32', {}, async () => false)
    await expect(
      auth.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).resolves.toMatchObject({ usageError: 'WSL distro Ubuntu is not running.' })
    expect(preparation).not.toHaveBeenCalled()

    const running = service('win32')
    await expect(
      running.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).resolves.toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('keeps a stale WSL account setting on the host off Windows', async () => {
    const auth = service('darwin', { localAccountRuntime: 'wsl', localAccountWslDistro: 'Ubuntu' })
    expect(auth.getRuntimeConfigDir()).toBe('/host/.claude')
    await expect(auth.prepareForClaudeLaunch()).resolves.toEqual({ runtime: 'host' })
  })

  it('routes a WSL target that names no distro to the default distro', async () => {
    const auth = service('win32')
    await expect(auth.prepareForClaudeLaunch({ runtime: 'wsl', wslDistro: null })).resolves.toEqual(
      { runtime: 'wsl', wslDistro: 'Ubuntu' }
    )
    expect(auth.getRuntimeConfigDir({ runtime: 'wsl', wslDistro: null })).toBe(
      '/wsl/Ubuntu/home/.claude'
    )
  })

  it('never fails a select over a failed guest publish, and publishes one pass at a time', async () => {
    const auth = service('win32')
    vi.spyOn(fakes.wsl, 'publish').mockRejectedValue(new Error('distro is gone'))
    await expect(
      auth.syncForCurrentSelection({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).resolves.toBeUndefined()

    const order: string[] = []
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(fakes.host, 'publish').mockImplementation(() => order.push('host'))
    vi.spyOn(fakes.wsl, 'runningDistros')
      .mockImplementationOnce(async () => {
        await gate
        order.push('first guests')
        return []
      })
      .mockResolvedValue([])
    const first = auth.publishAll()
    const second = auth.publishAll()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(order).toEqual(['host'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['host', 'first guests', 'host'])
  })
})

it('uses the sole native source for selected and inactive usage, without preparing legacy auth', async () => {
  const auth = service('linux', { activeClaudeManagedAccountId: 'source-A' })
  const legacy = vi.spyOn(fakes.host, 'accountUsagePreparation')
  const prepared = { configDir: '/owned/source', envPatch: {}, provenance: 'profile:source-A' }
  const resolver = vi.fn(async () => prepared)
  auth.setNativeUsagePreparationResolver(resolver)
  const signal = new AbortController().signal
  expect(await auth.prepareForAccountUsage('source-A', signal)).toBe(prepared)
  expect(resolver).toHaveBeenCalledWith('source-A', signal)
  expect(await auth.prepareForRateLimitFetch({ runtime: 'host' })).toBe(prepared)
  expect(legacy).not.toHaveBeenCalled()
})

it('falls back only for unconnected sources and does not detach a newer resolver', async () => {
  const auth = service('linux')
  const detachOld = auth.setNativeUsagePreparationResolver(async () => undefined)
  expect(await auth.prepareForAccountUsage('legacy')).toMatchObject({ configDir: '/legacy/legacy' })
  const unavailable = {
    configDir: '',
    envPatch: {},
    provenance: 'profile:A',
    usageError: 'Reconnect source.'
  }
  const detachCurrent = auth.setNativeUsagePreparationResolver(async () => unavailable)
  detachOld()
  expect(await auth.prepareForAccountUsage('A')).toBe(unavailable)
  detachCurrent()
  expect(await auth.prepareForAccountUsage('legacy')).toMatchObject({ configDir: '/legacy/legacy' })
})

it('does not run host native refresh for a WSL quota target', async () => {
  const auth = service('win32')
  const resolver = vi.fn(async () => undefined)
  auth.setNativeUsagePreparationResolver(resolver)
  await auth.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  expect(resolver).not.toHaveBeenCalled()
})
