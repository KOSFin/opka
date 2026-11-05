import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  nativeCodexAuthEnvToDelete,
  readNativeCodexModelProvider
} from './native-cli-auth-environment'
let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'opka-native-auth-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})
it('removes ambient OpenAI auth for a native managed account with default config', async () => {
  expect(await nativeCodexAuthEnvToDelete(home)).toEqual(['OPENAI_API_KEY', 'CODEX_API_KEY'])
})
it('preserves native custom provider credentials and selected profiles', async () => {
  await writeFile(
    join(home, 'config.toml'),
    'profile="custom"\n[profiles.custom]\nmodel_provider="custom"\n'
  )
  expect(await nativeCodexAuthEnvToDelete(home)).toEqual([])
  expect(await nativeCodexAuthEnvToDelete(home, undefined, 'openai')).toContain('OPENAI_API_KEY')
})
it('honors an explicit native CLI profile without rewriting config', async () => {
  const config = '[profiles.custom]\nmodel_provider="custom"\n'
  await writeFile(join(home, 'config.toml'), config)
  expect(await nativeCodexAuthEnvToDelete(home, 'custom')).toEqual([])
})

it('reads the qualified native separate profile file without changing legacy profile behavior', async () => {
  await writeFile(join(home, 'native.config.toml'), 'model_provider="custom"\n')
  expect(await readNativeCodexModelProvider(home, 'native', undefined, '0.166.0')).toBe('custom')
  expect(await readNativeCodexModelProvider(home, 'native', 'openai', '0.166.0')).toBe('openai')
})
it('refuses unsupported legacy selectors under the qualified new native loader', async () => {
  await writeFile(join(home, 'config.toml'), 'profile="native"\n')
  await expect(readNativeCodexModelProvider(home, undefined, undefined, '0.166.0')).rejects.toThrow(
    'separate named profile'
  )
})
