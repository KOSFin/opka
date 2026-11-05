import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import type * as Os from 'node:os'
import type * as HookLookup from '../codex/codex-hook-hash-lookup'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  CODEX_EVENTS,
  computeOrcaCodexHookHashes,
  getCodexManagedHookInstallMaterial
} from '../codex/codex-hook-definition'
import type { CodexHookAnswer } from '../codex/codex-hook-trust-derivation'
import { setupCodexHookHomes } from '../codex/hook-service-test-harness'
import { prepareNativeCodexGatewayAuth } from './native-codex-gateway-credential'
import { prepareNativeCodexStatusHooks } from './native-codex-status-hooks'

const mocks = vi.hoisted(() => ({
  home: vi.fn<() => string>(),
  appPath: vi.fn<(name: string) => string>(),
  answer: vi.fn<() => Promise<CodexHookAnswer>>()
}))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: mocks.home
}))
vi.mock('electron', () => ({ app: { getPath: mocks.appPath } }))
vi.mock('../codex/codex-hook-hash-lookup', async (original) => ({
  ...(await original<typeof HookLookup>()),
  lookupCodexHookAnswer: mocks.answer
}))

const homes = setupCodexHookHomes(mocks.home, mocks.appPath)
let home = ''
let executable = ''
const enabled = () => true
const assertExclusive = () => {}
const userHook = { hooks: [{ type: 'command', command: 'echo synthetic-user-hook', timeout: 5 }] }

beforeEach(() => {
  home = join(homes.userDataDir, 'owned-native-home')
  executable = join(homes.userDataDir, 'synthetic-codex')
  mkdirSync(home, { mode: 0o700 })
  writeFileSync(executable, 'synthetic executable metadata', { mode: 0o700 })
  prepareNativeCodexGatewayAuth(home, 'a'.repeat(64), assertExclusive)
  writeFileSync(join(home, 'config.toml'), 'model="preserved-model"\n', { mode: 0o600 })
  const material = getCodexManagedHookInstallMaterial()
  if (!material.scriptPath.startsWith(`${homes.tmpHome}${sep}`)) {
    throw new Error('Refusing test outside private canonical-script root')
  }
  mocks.answer.mockReset().mockResolvedValue({
    kind: 'hashes',
    codexVersion: 'synthetic-qualified-native',
    hashes: computeOrcaCodexHookHashes(material.command)
  })
})

function prepare(isEnabled = enabled) {
  return prepareNativeCodexStatusHooks({ home, executable, assertExclusive, isEnabled })
}

it('installs one-way canonical hooks, preserves users and leaves original HOME files untouched', async () => {
  const original = join(homes.tmpHome, '.codex')
  mkdirSync(original)
  writeFileSync(join(original, 'config.toml'), 'model="original-do-not-touch"\n')
  writeFileSync(join(original, 'hooks.json'), JSON.stringify({ hooks: { Stop: [userHook] } }))
  const beforeOriginal = readdirSync(original).map((name) =>
    readFileSync(join(original, name), 'utf8')
  )
  writeFileSync(
    join(home, 'hooks.json'),
    JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: '/old/agent-hooks/codex-hook.sh', timeout: 10 }] },
          userHook
        ]
      }
    }),
    { mode: 0o600 }
  )
  await prepare()
  const material = getCodexManagedHookInstallMaterial()
  const hooks = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8')).hooks
  for (const event of CODEX_EVENTS) {
    expect(
      hooks[event].some((group: { hooks: { command: string }[] }) =>
        group.hooks.some((hook) => hook.command === material.command)
      )
    ).toBe(true)
  }
  expect(hooks.Stop).toContainEqual(userHook)
  expect(JSON.stringify(hooks)).not.toContain('/old/')
  const hookBytes = readFileSync(join(home, 'hooks.json'), 'utf8')
  const configBytes = readFileSync(join(home, 'config.toml'), 'utf8')
  const scriptInode = statSync(material.scriptPath).ino
  for (let index = 0; index < 5; index++) {
    await prepare()
  }
  expect(readFileSync(join(home, 'hooks.json'), 'utf8')).toBe(hookBytes)
  expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(configBytes)
  expect(statSync(material.scriptPath).ino).toBe(scriptInode)
  expect(readdirSync(original).map((name) => readFileSync(join(original, name), 'utf8'))).toEqual(
    beforeOriginal
  )
  expect(mocks.answer).toHaveBeenCalledWith(executable, material.command)
})

it('refuses hooks Off before lookup or any canonical script/config write', async () => {
  const before = readFileSync(join(home, 'config.toml'), 'utf8')
  await expect(prepare(() => false)).rejects.toThrow('enabled status hooks')
  expect(mocks.answer).not.toHaveBeenCalled()
  expect(existsSync(getCodexManagedHookInstallMaterial().scriptPath)).toBe(false)
  expect(existsSync(join(home, 'hooks.json'))).toBe(false)
  expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(before)
})

it('refuses missing native-derived hashes instead of computing a fallback', async () => {
  mocks.answer.mockResolvedValue({ kind: 'pending', failure: 'synthetic unavailable' })
  await expect(prepare()).rejects.toThrow('not ready or supported')
  expect(existsSync(getCodexManagedHookInstallMaterial().scriptPath)).toBe(false)
  expect(existsSync(join(home, 'hooks.json'))).toBe(false)
})

it('rechecks user Off after the asynchronous exact-binary lookup', async () => {
  let on = true
  mocks.answer.mockImplementation(async () => {
    on = false
    return { kind: 'hashes', codexVersion: 'synthetic', hashes: computeOrcaCodexHookHashes() }
  })
  await expect(prepare(() => on)).rejects.toThrow('enabled status hooks')
  expect(existsSync(join(home, 'hooks.json'))).toBe(false)
})

it('refuses a replaced executable after lookup before writing hooks', async () => {
  mocks.answer.mockImplementation(async () => {
    writeFileSync(executable, 'different longer synthetic executable', { mode: 0o700 })
    return { kind: 'hashes', codexVersion: 'synthetic', hashes: computeOrcaCodexHookHashes() }
  })
  await expect(prepare()).rejects.toThrow('executable changed')
  expect(existsSync(join(home, 'hooks.json'))).toBe(false)
})

it('does not report success when the existing reconciler refuses malformed hooks JSON', async () => {
  writeFileSync(join(home, 'hooks.json'), '{malformed', { mode: 0o600 })
  await expect(prepare()).rejects.toThrow('could not be verified')
  expect(readFileSync(join(home, 'hooks.json'), 'utf8')).toBe('{malformed')
})

it('removes only obsolete managed metadata in the owned copy and preserves supported user description', async () => {
  writeFileSync(
    join(home, 'hooks.json'),
    JSON.stringify({
      _managed: { old: 'bookkeeping' },
      description: 'user description',
      hooks: { Stop: [userHook] }
    }),
    { mode: 0o600 }
  )
  await prepare()
  const config = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8'))
  expect(config).not.toHaveProperty('_managed')
  expect(config.description).toBe('user description')
  expect(config.hooks.Stop).toContainEqual(userHook)
})

it('refuses unsupported user fields without removing even obsolete metadata', async () => {
  const raw = JSON.stringify({
    _managed: true,
    unknownUserField: 'preserve',
    hooks: { Stop: [userHook] }
  })
  writeFileSync(join(home, 'hooks.json'), raw, { mode: 0o600 })
  await expect(prepare()).rejects.toThrow('unsupported top-level')
  expect(readFileSync(join(home, 'hooks.json'), 'utf8')).toBe(raw)
})
