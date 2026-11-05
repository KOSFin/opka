import { beforeEach, expect, it, vi } from 'vitest'
import { beginNativeAccountRoutingShutdown } from './native-account-routing-shutdown'

const state = vi.hoisted(() => ({
  shell: false,
  claude: false,
  codex: false,
  closeShell: vi.fn(async () => {}),
  closeClaude: vi.fn(async () => {}),
  beginCodex: vi.fn(),
  closeCodex: vi.fn(async () => {})
}))
vi.mock('./configure-native-cli-user-integration', () => ({
  getRuntimeNativeCliUserIntegration: () => (state.shell ? {} : null),
  shutdownRuntimeNativeCliUserIntegration: state.closeShell
}))
vi.mock('./runtime-claude-native-sources', () => ({
  getRuntimeClaudeNativeSources: () => (state.claude ? {} : null),
  shutdownRuntimeClaudeNativeSources: state.closeClaude
}))
vi.mock('./runtime-codex-engine-host', () => ({
  peekRuntimeCodexEngineHost: () => (state.codex ? {} : null),
  beginRuntimeCodexEngineShutdown: state.beginCodex,
  stopRuntimeCodexEngineHost: state.closeCodex
}))
beforeEach(() => {
  vi.clearAllMocks()
  state.shell = state.claude = state.codex = false
  state.closeShell.mockImplementation(async () => {})
})
it('does nothing when no local runtime exists', () => {
  expect(beginNativeAccountRoutingShutdown(null)).toBeNull()
  expect(state.closeShell).not.toHaveBeenCalled()
})
it('retains the final mutation barrier until a shell-profile transaction has settled', async () => {
  state.shell = state.claude = state.codex = true
  let finish = () => {}
  state.closeShell.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const signIns = vi.fn(async () => {})
  const operation = beginNativeAccountRoutingShutdown({ stopAccountDeviceSignIns: signIns })
  let closed = false
  void operation?.then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  expect(state.beginCodex).toHaveBeenCalledOnce()
  expect(state.closeClaude).toHaveBeenCalledOnce()
  expect(state.closeCodex).toHaveBeenCalledOnce()
  finish()
  await operation
  expect(closed).toBe(true)
})
it('propagates an unsettled mutation failure instead of declaring profile teardown complete', async () => {
  state.shell = true
  state.closeShell.mockRejectedValueOnce(new Error('synthetic pending transaction'))
  await expect(
    beginNativeAccountRoutingShutdown({ stopAccountDeviceSignIns: async () => {} })
  ).rejects.toThrow('pending transaction')
})
