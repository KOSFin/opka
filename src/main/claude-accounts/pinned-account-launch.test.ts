import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { preparePinnedClaudeAccountLaunch } from './pinned-account-launch'

vi.mock('./claude-profile-installed-router', () => ({ getClaudeProfileRouter: () => undefined }))
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'opka-pinned-account-'))
  roots.push(root)
  const home = join(root, 'account', 'home')
  mkdirSync(home, { recursive: true })
  const account: ClaudeManagedAccount = {
    id: 'account-a',
    email: 'a@example.test',
    organizationUuid: 'org-a',
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
  const accounts = [account]
  const router = {
    accountLogin: vi.fn(() => ({
      email: account.email,
      organizationUuid: 'org-a',
      organizationName: null
    })),
    accountHome: vi.fn(() => home),
    prepareAccount: vi.fn(async () => home)
  }
  return { home, account, accounts, router, getAccounts: () => accounts }
}
describe('pinned Claude launch', () => {
  it('pins an account-specific shell pointer without changing the selected account', async () => {
    const f = fixture()
    const result = await preparePinnedClaudeAccountLaunch({ ...f, accountId: f.account.id })
    expect(result.configDir).toBe(f.home)
    expect(result.provenance).toBe('profile:account-a')
    const pointer = result.envPatch.ORCA_CLAUDE_PROFILE_POINTER
    expect(pointer).toBe(join(f.home, '..', 'pinned-launch-home'))
    expect(readFileSync(pointer!, 'utf8')).toBe(f.home)
  })
  it('refuses a missing router rather than using system auth', async () => {
    await expect(
      preparePinnedClaudeAccountLaunch({ accountId: 'a', getAccounts: () => [] })
    ).rejects.toThrow('unavailable')
  })
  it('refuses a different login before preparing the profile', async () => {
    const f = fixture()
    f.account.email = 'other@example.test'
    f.router.accountLogin.mockReturnValue({
      email: 'original@example.test',
      organizationUuid: 'org-a',
      organizationName: null
    })
    await expect(
      preparePinnedClaudeAccountLaunch({ ...f, accountId: f.account.id })
    ).rejects.toThrow('no account was substituted')
    expect(f.router.prepareAccount).not.toHaveBeenCalled()
  })
  it('requires the registered organization instead of accepting an ambiguous login', async () => {
    const f = fixture()
    const router = {
      ...f.router,
      accountLogin: () => ({
        email: f.account.email,
        organizationUuid: null,
        organizationName: null
      })
    }
    await expect(
      preparePinnedClaudeAccountLaunch({ ...f, router, accountId: f.account.id })
    ).rejects.toThrow('no account was substituted')
    expect(f.router.prepareAccount).not.toHaveBeenCalled()
  })
  it('refuses account removal while asynchronous setup runs', async () => {
    const f = fixture()
    f.router.prepareAccount.mockImplementation(async () => {
      f.accounts.splice(0)
      return f.home
    })
    await expect(
      preparePinnedClaudeAccountLaunch({ ...f, accountId: f.account.id })
    ).rejects.toThrow('no account was substituted')
  })
  it('refuses a replaced profile home after setup', async () => {
    const f = fixture()
    f.router.prepareAccount.mockResolvedValue(join(f.home, 'other'))
    await expect(
      preparePinnedClaudeAccountLaunch({ ...f, accountId: f.account.id })
    ).rejects.toThrow('home changed')
  })
})
