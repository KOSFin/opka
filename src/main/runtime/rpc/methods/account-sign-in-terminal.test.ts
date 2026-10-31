import type * as FsPromises from 'node:fs/promises'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/vitest-host-ports-setup'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { ACCOUNT_SIGN_IN_TERMINAL_METHODS } from './account-sign-in-terminal'
import {
  AccountSignInTerminalSchema,
  OpenAccountSignInTerminalParams
} from '../../../../shared/account-sign-in-terminal'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  access: vi.fn(async () => {})
}))
vi.mock('../../../cli/orca-cli-child-path', () => ({
  prependOrcaCliDirToChildPath: (env: Record<string, string>) => {
    env.ORCA_USER_DATA_PATH = '/own/profile'
    return '/own app/cli/orca'
  }
}))
const leafId = '8b5b9855-6a24-4eb8-9aab-63ca8376b8c7'
const request = {
  provider: 'claude',
  worktree: 'id:workspace',
  clientMutationId: 'click-1'
} as const
const method = ACCOUNT_SIGN_IN_TERMINAL_METHODS[0]
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => Object.defineProperty(process, 'platform', platform))
function setup(host = 'local', path = '/workspace', worktreeId = 'workspace') {
  installFakeAppEnvironment({ getPath: () => '/own/profile', isPackaged: () => true })
  const resolveRuntimeFileTarget = vi.fn(async () => ({
    executionHostId: host,
    worktree: { id: worktreeId, path }
  }))
  const createTerminal = vi.fn(async () => ({
    handle: 'term_signin',
    worktreeId,
    paneKey: `tab-login:${leafId}`,
    title: 'Sign in to Claude'
  }))
  const dedupeTerminalCreate = vi.fn<OrcaRuntimeService['dedupeTerminalCreate']>(
    async (_owner, canonical, _id, _reconcile, run) => run(canonical, 'term_reserved')
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this handler only uses these three host methods and all are supplied.
  const runtime = {
    resolveRuntimeFileTarget,
    createTerminal,
    dedupeTerminalCreate
  } as unknown as OrcaRuntimeService
  return { runtime, createTerminal, dedupeTerminalCreate }
}
describe('account sign-in terminal', () => {
  it('creates a fixed CLI sign-in in the chosen local workspace with caller-scoped deduplication', async () => {
    const h = setup()
    const reply = await method.handler(request, {
      runtime: h.runtime,
      caller: { kind: 'paired-device', deviceId: 'phone-a' }
    })
    expect(method.permission).toBe('accounts-admin')
    expect(h.dedupeTerminalCreate).toHaveBeenCalledWith(
      'phone-a',
      'id:workspace',
      'account-sign-in:click-1',
      false,
      expect.any(Function)
    )
    expect(h.createTerminal).toHaveBeenCalledWith(
      'id:workspace',
      expect.objectContaining({
        command: "'/own app/cli/orca' 'account' 'add' '--agent' 'claude' '--interactive-login'",
        preAllocatedHandle: 'term_reserved',
        presentation: 'background',
        focus: false
      })
    )
    expect(AccountSignInTerminalSchema.parse(reply).terminal).toMatchObject({
      tabId: 'tab-login',
      leafId,
      handle: 'term_signin'
    })
  })
  it('preserves an existing folder workspace through the canonical id selector', async () => {
    const h = setup('local', '/existing-folder', 'folder:folder-1')
    await method.handler(
      { ...request, worktree: 'folder:folder-1' },
      { runtime: h.runtime, caller: { kind: 'local-cli' } }
    )
    expect(h.dedupeTerminalCreate).toHaveBeenCalledWith(
      'trusted-local:runtime',
      'id:folder:folder-1',
      'account-sign-in:click-1',
      false,
      expect.any(Function)
    )
    expect(h.createTerminal).toHaveBeenCalledWith('id:folder:folder-1', expect.any(Object))
  })
  it.each(['ssh:server', 'runtime:other'])(
    'refuses a %s workspace before launching',
    async (host) => {
      const h = setup(host)
      await expect(
        method.handler(request, { runtime: h.runtime, caller: { kind: 'local-cli' } })
      ).rejects.toThrow()
      expect(h.createTerminal).not.toHaveBeenCalled()
      expect(h.dedupeTerminalCreate).not.toHaveBeenCalled()
    }
  )
  it('refuses a WSL workspace instead of running the native host CLI there', async () => {
    const h = setup('local', '\\\\wsl.localhost\\Ubuntu\\home\\test')
    await expect(
      method.handler(request, { runtime: h.runtime, caller: { kind: 'local-cli' } })
    ).rejects.toThrow('native workspace')
    expect(h.createTerminal).not.toHaveBeenCalled()
  })
  it('chooses the actual Windows PowerShell shell for its PowerShell-quoted command', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const h = setup()
    await method.handler(request, { runtime: h.runtime, caller: { kind: 'local-cli' } })
    expect(h.createTerminal).toHaveBeenCalledWith(
      'id:workspace',
      expect.objectContaining({
        shellOverride: 'powershell.exe',
        command: expect.stringMatching(/^& '/)
      })
    )
  })
  it('accepts no arbitrary command, provider or launcher path', () => {
    expect(() =>
      OpenAccountSignInTerminalParams.parse({ ...request, command: 'anything' })
    ).toThrow()
    expect(() => OpenAccountSignInTerminalParams.parse({ ...request, provider: 'codex' })).toThrow()
    expect(() => OpenAccountSignInTerminalParams.parse({ ...request, cli: '/other/cli' })).toThrow()
  })
})
