import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BuildPtyHostEnvOptions } from './types'

const fixture = vi.hoisted(() => ({
  userData: '',
  scheduleCodexHookReconcile: vi.fn(),
  prependCli: vi.fn<() => string | null>()
}))
vi.mock('../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => fixture.userData, onWillQuit: vi.fn() })
}))
vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: { buildPtyEnv: () => ({ ORCA_AGENT_HOOK_PORT: '12345' }) }
}))
vi.mock('../../../agent-hooks/wsl-hook-relay-manager', () => ({
  wslHookRelayManager: {
    ensureForDistro: vi.fn(),
    getGuestEndpointFilePath: () => '/guest/endpoint.json',
    getOpenCodeOverlayDir: () => join(fixture.userData, 'guest-overlay'),
    getGuestAgentPath: () => null
  }
}))
vi.mock('../../../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), buildFreshOmpEnv: () => ({}) }
}))
vi.mock('../../../cli/orca-cli-child-path', () => ({
  prependOrcaCliDirToChildPath: fixture.prependCli
}))
vi.mock('../../../cli/wsl-managed-cli', () => ({
  getManagedWslCliDir: () => undefined,
  getWslCliCommandName: () => 'orca-ide'
}))
vi.mock('../../../codex/codex-hook-reconcile', () => ({
  scheduleCodexHookReconcile: fixture.scheduleCodexHookReconcile
}))

import { buildPtyHostEnv } from './assembly'

// Why this file: a codex typed in a native pane reads ~/.codex, so each native
// spawn rechecks Orca's entry there; a WSL pane's Codex never reads it.

let root: string
let options: BuildPtyHostEnvOptions

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-reconcile-spawn-'))
  fixture.userData = join(root, 'user-data')
  vi.stubEnv('HOME', join(root, 'home'))
  vi.stubEnv('USERPROFILE', join(root, 'home'))
  options = {
    isPackaged: true,
    userDataPath: fixture.userData,
    selectedCodexHomePath: null,
    agentStatusHooksEnabled: true
  }
  fixture.scheduleCodexHookReconcile.mockClear()
  fixture.prependCli.mockReset().mockReturnValue(join(fixture.userData, 'cli', 'bin', 'orca'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe("a pane spawn rechecks Orca's entry in ~/.codex", () => {
  it.each([true, false])(
    'pins its own CLI and profile for packaged=%s native children',
    (isPackaged) => {
      const env = buildPtyHostEnv(
        'native-pane',
        { ORCA_CLI_COMMAND: '/another-app/orca', ORCA_USER_DATA_PATH: '/another-profile' },
        { ...options, isPackaged }
      )
      expect(env.ORCA_CLI_COMMAND).toBe(join(fixture.userData, 'cli', 'bin', 'orca'))
      expect(env.ORCA_USER_DATA_PATH).toBe(fixture.userData)
    }
  )

  it('keeps a WSL command and profile rather than naming a native launcher', () => {
    const env = buildPtyHostEnv('wsl-pane', {}, { ...options, isWsl: true, wslDistro: 'Ubuntu' })
    expect(env.ORCA_CLI_COMMAND).toBe('orca-ide')
    expect(env.ORCA_USER_DATA_PATH).toBe(fixture.userData)
  })

  it('does not preserve another app launcher when this host has no launcher', () => {
    fixture.prependCli.mockReturnValue(null)
    const env = buildPtyHostEnv('native-pane', { ORCA_CLI_COMMAND: '/another-app/orca' }, options)
    expect(env.ORCA_CLI_COMMAND).toBeUndefined()
  })

  it('on a native spawn', () => {
    buildPtyHostEnv('native-pane', {}, options)

    expect(fixture.scheduleCodexHookReconcile).toHaveBeenCalledTimes(1)
  })

  it('never on a WSL spawn', () => {
    buildPtyHostEnv('wsl-pane', {}, { ...options, isWsl: true, wslDistro: 'Ubuntu' })

    expect(fixture.scheduleCodexHookReconcile).not.toHaveBeenCalled()
  })
})
