import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClaudeNativeCoverageModule } from './claude-native-coverage-module'

/** One disposable module per facade; no native global plugin installation or provider secrets. */
export function installClaudeNativeCoverageModule(options: {
  home: string
  launchId: string
  launch: { command: string; args: string[] }
  assertExclusive: () => void
}): string {
  const directory = join(options.home, '.opka-native-continuity')
  options.assertExclusive()
  mkdirSync(directory, { mode: 0o700 })
  for (const name of ['.claude-plugin', 'hooks']) {
    options.assertExclusive()
    mkdirSync(join(directory, name), { mode: 0o700 })
  }
  const files = [
    [
      join('.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'opka-native-continuity', version: '1.0.0' })
    ],
    [join('hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.js'] })],
    [
      join('hooks', 'register.js'),
      createClaudeNativeCoverageModule(options.launchId, options.launch)
    ]
  ]
  for (const [path, body] of files) {
    options.assertExclusive()
    writeFileSync(join(directory, path), body, { mode: 0o600, flag: 'wx' })
  }
  return directory
}
