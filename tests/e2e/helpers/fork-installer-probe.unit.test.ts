import { expect, it } from 'vitest'
import { forkInstallerProbes } from './fork-installer-probe'

it('pins immutable default probes and requires a complete explicit release pair', () => {
  expect(forkInstallerProbes({})[0].version).toBe('1.4.236-rc.3')
  expect(
    forkInstallerProbes({
      ORCA_FORK_UPDATE_TARGET_VERSION: '1.4.236-rc.4',
      ORCA_FORK_UPDATE_TARGET_SHA256: 'a'.repeat(64)
    })
  ).toEqual([{ version: '1.4.236-rc.4', sha256: 'a'.repeat(64) }])
  for (const env of [
    { ORCA_FORK_UPDATE_TARGET_VERSION: '1.4.236-rc.4' },
    { ORCA_FORK_UPDATE_TARGET_SHA256: 'a'.repeat(64) },
    {
      ORCA_FORK_UPDATE_TARGET_VERSION: '../foreign',
      ORCA_FORK_UPDATE_TARGET_SHA256: 'a'.repeat(64)
    },
    { ORCA_FORK_UPDATE_TARGET_VERSION: '1.4.236-rc.4', ORCA_FORK_UPDATE_TARGET_SHA256: 'unchecked' }
  ]) {
    expect(() => forkInstallerProbes(env)).toThrow(/explicit beta/)
  }
})
