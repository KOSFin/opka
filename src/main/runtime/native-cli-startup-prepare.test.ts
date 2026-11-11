import { registerNativeClaudeRoutingOwner } from './native-claude-routing-ownership'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import { nativeCliStartupFixture } from './native-cli-startup-fixture'
import { captureNativeCliStartup, prepareNativeCliStartup } from './native-cli-startup-prepare'
import { armNativeCliStartup, currentNativeCliStartup } from './native-cli-startup'
import { verifyProjectTaskTerminalProof } from './project-task-terminal-proof'
const prepare = vi.hoisted(() => vi.fn())
vi.mock('./native-cli-account-launch', () => ({ prepareNativeCliAccountLaunch: prepare }))
const fixtures: ReturnType<typeof nativeCliStartupFixture>[] = []
afterEach(() => {
  fixtures.splice(0).forEach((f) => f.dispose())
  prepare.mockReset()
})
function fixture() {
  const f = nativeCliStartupFixture()
  fixtures.push(f)
  return f
}

it('separates proof hash, token hash and raw/compound process identity', () => {
  const f = fixture()
  expect(
    verifyProjectTaskTerminalProof(f.runtime, f.request.parentTerminal)?.launchTokenHash
  ).not.toBe(f.authority.launchTokenHash)
  expect(captureNativeCliStartup(f.runtime, f.request).current()).toBe(true)
  f.authority.processIncarnation = f.pty.incarnationId ?? ''
  expect(() => captureNativeCliStartup(f.runtime, f.request)).toThrow(NativeCliControlError)
})
it.each(['token', 'proof', 'handle', 'pty', 'generation', 'host'] as const)(
  'refuses copied or rotated %s without targeting a launch',
  async (change) => {
    const f = fixture()
    if (change === 'token') {
      f.request.startup.launchToken = 'copied-token'
    }
    if (change === 'proof') {
      f.request.parentTerminal.terminalTaskProof = 'f'.repeat(64)
    }
    if (change === 'handle') {
      f.request.parentTerminal.terminalHandle = 'term_other'
    }
    if (change === 'pty') {
      f.authority.ptyId = 'pty_other'
    }
    if (change === 'generation') {
      f.pty.launchIncarnationId = null
    }
    if (change === 'host') {
      vi.spyOn(f.runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
        ...f.authority,
        hostScope: { kind: 'ssh', targetId: 'synthetic' }
      })
    }
    await expect(prepareNativeCliStartup(f.runtime, f.request)).rejects.toThrow(
      NativeCliControlError
    )
    expect(f.startup.state).toBe('pending')
    expect(prepare).not.toHaveBeenCalled()
  }
)
it('records only a host-typed refusal, with idempotent cleanup and replay fencing', async () => {
  const f = fixture()
  const cleanup = vi.fn()
  vi.spyOn(f.runtime, 'getOrchestrationDb').mockReturnValue(
    Object.assign(f.runtime.getOrchestrationDb(), { releaseUnconsumedNativeCliStartup: cleanup })
  )
  const report = vi.spyOn(f.runtime, 'reportAgentLaunchPaneVerdict')
  prepare.mockRejectedValue(new NativeCliControlError('config_conflict'))
  await expect(prepareNativeCliStartup(f.runtime, f.request)).rejects.toThrow(NativeCliControlError)
  expect(f.startup.refusal?.code).toBe('native_cli_config_conflict')
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(cleanup.mock.calls[0][0]).not.toHaveProperty('ownerKey')
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: f.pty.worktreeId }), {
    kind: 'not-started',
    code: 'native_cli_config_conflict'
  })
  await expect(prepareNativeCliStartup(f.runtime, f.request)).rejects.toThrow('owner changed')
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(prepare).toHaveBeenCalledTimes(1)
})
it('disarms after successful prepare; nested inherited failure never overwrites it', async () => {
  const f = fixture()
  prepare.mockResolvedValue({ executionMode: 'inherit' })
  await prepareNativeCliStartup(f.runtime, f.request)
  prepare.mockRejectedValue(new NativeCliControlError('config_conflict'))
  await expect(
    prepareNativeCliStartup(f.runtime, {
      ...f.request,
      launchId: '22345678-1234-4234-8234-123456789012'
    })
  ).rejects.toThrow('Native preferences changed')
  expect(f.startup.state).toBe('prepared')
  expect(f.startup.refusal).toBeNull()
})
it('does not settle a replacement after preparation awaits', async () => {
  const f = fixture()
  prepare.mockImplementation(async () => {
    f.authority.launchTokenHash = '0'.repeat(64)
    throw new NativeCliControlError('config_conflict')
  })
  await expect(prepareNativeCliStartup(f.runtime, f.request)).rejects.toThrow(NativeCliControlError)
  expect(f.startup.refusal).toBeNull()
})
it('ordinary errors remain ordinary and yield honest unconfirmed startup', async () => {
  const f = fixture()
  prepare.mockRejectedValue(new Error('synthetic ordinary error'))
  await expect(prepareNativeCliStartup(f.runtime, f.request)).rejects.toThrow(
    'synthetic ordinary error'
  )
  expect(f.startup.refusal).toBeNull()
  expect(f.startup.state).toBe('unconfirmed')
})

it('keeps a registered live owner and its reservation through later typed errors', async () => {
  const f = fixture()
  registerNativeClaudeRoutingOwner(f.runtime, 'consumed', {
    readOwner: () => ({
      paneKey: f.request.parentTerminal.paneKey,
      ptyId: f.pty.ptyId,
      incarnationId: f.startup.incarnationId
    }),
    release: async () => false
  })
  const cleanup = vi.spyOn(f.db, 'releaseUnconsumedNativeCliStartup')
  prepare.mockRejectedValue(new NativeCliControlError('config_conflict'))
  await expect(prepareNativeCliStartup(f.runtime, f.request)).rejects.toThrow(
    'Native preferences changed'
  )
  expect(f.startup.state).toBe('prepared')
  expect(f.startup.refusal).toBeNull()
  expect(cleanup).not.toHaveBeenCalled()
})

it('does not treat a classified title as proof that native startup prepared', async () => {
  const f = fixture()
  f.pty.lastAgentStatus = 'working'
  f.pty.lastAgentStatusObservedLive = true
  expect(f.runtime.getNativeCliStartupForHandle(f.request.parentTerminal.terminalHandle)).toBe(
    f.startup
  )
  expect(f.startup.state).toBe('pending')
  const cleanup = vi.spyOn(f.db, 'releaseUnconsumedNativeCliStartup')
  prepare.mockRejectedValue(new NativeCliControlError('config_conflict'))

  await expect(prepareNativeCliStartup(f.runtime, f.request)).rejects.toThrow(
    'Native preferences changed'
  )
  expect(f.startup.state).toBe('refused')
  expect(f.startup.refusal?.code).toBe('native_cli_config_conflict')
  expect(cleanup).toHaveBeenCalledOnce()
})

it('arms an already classified initial PTY without claiming preparation', () => {
  const f = fixture()
  f.startup.finish('unconfirmed')
  f.pty.nativeCliStartup = undefined
  f.pty.lastAgentStatus = 'working'
  f.pty.lastAgentStatusObservedLive = true

  armNativeCliStartup(f.pty)

  expect(currentNativeCliStartup(f.pty)?.state).toBe('pending')
})
