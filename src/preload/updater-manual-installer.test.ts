import { beforeEach, expect, it, vi } from 'vitest'
const spies = vi.hoisted(() => ({ invoke: vi.fn(), prepare: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: { invoke: spies.invoke } }))
vi.mock('./renderer-restart-wiring', () => ({ prepareAndInvokeUpdaterInstall: spies.prepare }))
vi.mock('./preload-runtime-support', () => ({
  awaitBeforeUnloadCheckpoint: vi.fn(),
  updaterQuitAbortRelay: {}
}))
import { updaterApi } from './api/updater-bridge'
beforeEach(() => {
  spies.invoke.mockReset()
  spies.prepare.mockReset()
})
it('opens the manual installer without preparing a renderer shutdown', async () => {
  spies.invoke.mockResolvedValueOnce({
    state: 'downloaded',
    version: '0.1.0-rc.1',
    manualInstaller: true
  })
  await updaterApi.quitAndInstall()
  expect(spies.invoke.mock.calls.map(([channel]) => channel)).toEqual([
    'updater:getStatus',
    'updater:quitAndInstall'
  ])
  expect(spies.prepare).not.toHaveBeenCalled()
})
