import { expect, it, vi } from 'vitest'
import { withNativeClaudeLaunchPreparation } from './native-claude-launch-preparation'
import {
  registerNativeClaudeRoutingOwner,
  isNativeClaudeRoutingLaunch,
  releaseNativeClaudeRoutingOwner
} from './native-claude-routing-ownership'

it('fences concurrent preparations and releases only its own pending slot', async () => {
  const runtime = {},
    id = 'native-launch',
    second = vi.fn(async () => null)
  let finish = () => {}
  const held = new Promise<null>((resolve) => {
    finish = () => resolve(null)
  })
  const pending = withNativeClaudeLaunchPreparation(runtime, id, () => held)
  await expect(withNativeClaudeLaunchPreparation(runtime, id, second)).rejects.toThrow(
    'already active'
  )
  expect(second).not.toHaveBeenCalled()
  finish()
  await pending
  await expect(withNativeClaudeLaunchPreparation(runtime, id, second)).resolves.toBeNull()
  expect(second).toHaveBeenCalledOnce()
})
it('never invokes duplicate setup or disposal for a registered live native launch', async () => {
  const runtime = { subscribeToPtyExit: () => () => {}, getPtyExecutionHostMetadata: () => ({}) }
  const release = vi.fn(async () => {})
  registerNativeClaudeRoutingOwner(runtime, 'native-launch', { readOwner: () => null, release })
  const prepare = vi.fn(async () => null)
  await expect(
    withNativeClaudeLaunchPreparation(runtime, 'native-launch', prepare)
  ).rejects.toThrow('already active')
  expect(prepare).not.toHaveBeenCalled()
  expect(release).not.toHaveBeenCalled()
  await releaseNativeClaudeRoutingOwner(runtime, 'native-launch')
  expect(release).toHaveBeenCalledOnce()
})

it('revokes admission synchronously and retains unknown ownership until an actual internal absence proof arrives', async () => {
  const runtime = { subscribeToPtyExit: () => () => {}, getPtyExecutionHostMetadata: () => ({}) }
  let revoked = false
  const release = vi.fn(async (proof?: { ownerAbsent: 'not-started' | 'exited' }) => {
    revoked = true
    return proof?.ownerAbsent === 'exited'
  })
  registerNativeClaudeRoutingOwner(runtime, 'retained-native', { readOwner: () => null, release })
  const pending = releaseNativeClaudeRoutingOwner(runtime, 'retained-native')
  expect(revoked).toBe(true)
  expect(await pending).toBe(true)
  expect(isNativeClaudeRoutingLaunch(runtime, 'retained-native')).toBe(true)
  await releaseNativeClaudeRoutingOwner(runtime, 'retained-native', { ownerAbsent: 'exited' })
  expect(release).toHaveBeenCalledTimes(2)
  expect(isNativeClaudeRoutingLaunch(runtime, 'retained-native')).toBe(false)
})
