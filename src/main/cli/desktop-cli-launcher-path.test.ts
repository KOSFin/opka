import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { desktopCliLauncherPath, prepareDesktopLinuxCliLauncher } from './desktop-cli-launcher-path'
import { ensureLinuxTerminalOrcaCliShimDir } from './linux-terminal-orca-cli-shim'
vi.mock('./linux-terminal-orca-cli-shim', () => ({ ensureLinuxTerminalOrcaCliShimDir: vi.fn() }))

const options = {
  platform: 'darwin' as const,
  packaged: true,
  resourcesPath: '/own/Resources',
  userDataPath: '/own/profile'
}
it('uses the own packaged launcher rather than a global or isolated-home forwarder', () => {
  const exists = vi.fn(() => true),
    linuxShim = vi.fn(() => null)
  expect(desktopCliLauncherPath(options, { exists, linuxShim })).toBe(
    join('/own/Resources', 'bin', 'orca')
  )
  expect(linuxShim).not.toHaveBeenCalled()
})
it('keeps Linux bare-orca handling in the existing shim implementation', () => {
  const linuxShim = vi.fn(() => '/own/profile/linux-shim')
  expect(
    desktopCliLauncherPath({ ...options, platform: 'linux' }, { exists: () => false, linuxShim })
  ).toBe(join('/own/profile/linux-shim', 'orca'))
  expect(linuxShim).toHaveBeenCalledWith({
    userDataPath: options.userDataPath,
    resourcesPath: options.resourcesPath
  })
})
it('refuses missing resources and missing development launchers', () => {
  const dependencies = { exists: () => false, linuxShim: vi.fn(() => null) }
  expect(desktopCliLauncherPath({ ...options, resourcesPath: undefined }, dependencies)).toBeNull()
  expect(desktopCliLauncherPath({ ...options, packaged: false }, dependencies)).toBeNull()
})
it('keeps Linux status reads free of launcher writes and only consumes boot preparation for that app', () => {
  const linux = { ...options, platform: 'linux' as const, userDataPath: '/readonly/own-profile' }
  expect(desktopCliLauncherPath(linux)).toBeNull()
  expect(ensureLinuxTerminalOrcaCliShimDir).not.toHaveBeenCalled()
  vi.mocked(ensureLinuxTerminalOrcaCliShimDir).mockReturnValue('/prepared/private-shim')
  prepareDesktopLinuxCliLauncher({
    userDataPath: linux.userDataPath,
    resourcesPath: linux.resourcesPath
  })
  expect(ensureLinuxTerminalOrcaCliShimDir).toHaveBeenCalledWith({
    userDataPath: linux.userDataPath,
    resourcesPath: linux.resourcesPath,
    appImageCacheRootPath: join(linux.userDataPath, 'cli', 'appimage')
  })
  expect(desktopCliLauncherPath(linux)).toBe(join('/prepared/private-shim', 'orca'))
  expect(desktopCliLauncherPath({ ...linux, userDataPath: '/different/profile' })).toBeNull()
  expect(ensureLinuxTerminalOrcaCliShimDir).toHaveBeenCalledOnce()
})
