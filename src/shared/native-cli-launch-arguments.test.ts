import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { nativeCliLaunchArguments } from './native-cli-launch-arguments'

it('adds owned Claude modules before the literal boundary and preserves native arguments', () => {
  const first = resolve('owned-module-one'),
    second = resolve('owned-module-two')
  const args = ['--model', 'native-model', '--plugin-dir', 'user-module', '--', 'literal prompt']
  expect(nativeCliLaunchArguments('claude', args, { claudePluginDirs: [first, second] })).toEqual([
    ...args.slice(0, 4),
    '--plugin-dir',
    first,
    '--plugin-dir',
    second,
    '--',
    'literal prompt'
  ])
  expect(args).toEqual([
    '--model',
    'native-model',
    '--plugin-dir',
    'user-module',
    '--',
    'literal prompt'
  ])
})

it('preserves print prompt and user plugin directories when adding an owning module', () => {
  const owned = resolve('owned-module')
  expect(
    nativeCliLaunchArguments('claude', ['-p', 'unique request', '--plugin-dir', 'user-module'], {
      claudePluginDirs: [owned]
    })
  ).toEqual(['-p', 'unique request', '--plugin-dir', 'user-module', '--plugin-dir', owned])
  const args = ['--version']
  expect(nativeCliLaunchArguments('claude', args, {})).toBe(args)
})

it('rejects cross-provider and non-absolute module plans', () => {
  expect(() =>
    nativeCliLaunchArguments('codex', [], { claudePluginDirs: [resolve('owned-module')] })
  ).toThrow()
  expect(() =>
    nativeCliLaunchArguments('claude', [], { claudePluginDirs: [join('relative', 'module')] })
  ).toThrow()
  expect(() =>
    nativeCliLaunchArguments('claude', [], {
      claudePluginDirs: [resolve('owned-module')],
      codexConfigOverrides: ['model="native"']
    })
  ).toThrow()
})
