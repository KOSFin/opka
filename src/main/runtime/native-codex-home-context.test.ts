import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareCodexNativeHome } from '../codex-routing/codex-native-home'
import { readAgentCliVersion } from '../agent-cli-version-probe'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import {
  nativeCodexHomeContext,
  installNativeCodexHomeContext,
  requireNativeCodexHomeContext,
  assertNativeCodexPreferenceHomeUnused,
  qualifyNativeCodexExecutable
} from './native-codex-home-context'

vi.mock('../agent-cli-version-probe', () => ({
  readAgentCliVersion: vi.fn(async () => ({ version: '0.166.0' }))
}))
const roots: string[] = []
afterEach(async () => {
  for (const path of roots.splice(0)) {
    await rm(path, { recursive: true, force: true })
  }
  vi.mocked(readAgentCliVersion).mockResolvedValue({ version: '0.166.0' })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opka-home-context-'))
  roots.push(root)
  const sourceHome = join(root, 'source')
  await mkdir(sourceHome)
  const resolveSourceHome = vi.fn(() => sourceHome)
  const context = nativeCodexHomeContext({
    storageRoot: root,
    resolveSourceHome,
    assertExclusive: vi.fn()
  })
  return { root, sourceHome, context, resolveSourceHome }
}

it('installs only one lazy context without touching the preference origin', async () => {
  const f = await fixture()
  const runtime = {}
  installNativeCodexHomeContext(runtime, f.context)
  expect(requireNativeCodexHomeContext(runtime)).toBe(f.context)
  expect(f.resolveSourceHome).not.toHaveBeenCalled()
  expect(() => installNativeCodexHomeContext(runtime, f.context)).toThrow('already configured')
  expect(() => requireNativeCodexHomeContext({})).toThrow('not configured')
})

it('requires the actual qualified executable and rejects an unqualified observed version', async () => {
  const f = await fixture()
  expect(await qualifyNativeCodexExecutable(process.execPath, f.context)).toMatchObject({
    nativeVersion: '0.166.0'
  })
  vi.mocked(readAgentCliVersion).mockResolvedValueOnce({ version: '0.167.0' })
  await expect(qualifyNativeCodexExecutable(process.execPath, f.context)).rejects.toThrow(
    NativeCliControlError
  )
  await expect(qualifyNativeCodexExecutable(undefined, f.context)).rejects.toThrow('actual native')
})

it('protects the persisted preference origin after every CLI and engine has exited', async () => {
  const f = await fixture()
  await prepareCodexNativeHome({
    ...f.context,
    sourceHome: f.sourceHome,
    context: { nativeVersion: '0.166.0' }
  })
  await expect(assertNativeCodexPreferenceHomeUnused(f.context, f.sourceHome)).rejects.toThrow(
    'preference source'
  )
  await mkdir(join(f.root, 'other'))
  await expect(
    assertNativeCodexPreferenceHomeUnused(f.context, join(f.root, 'other'))
  ).resolves.toBeUndefined()
  await writeFile(join(f.context.homeDirectory, '.opka-native-home.json'), 'invalid')
  await expect(assertNativeCodexPreferenceHomeUnused(f.context, f.sourceHome)).rejects.toThrow(
    'ownership metadata'
  )
})

it('does not create a native HOME while checking removal before first installation', async () => {
  const f = await fixture()
  await expect(
    assertNativeCodexPreferenceHomeUnused(f.context, f.sourceHome)
  ).resolves.toBeUndefined()
})
