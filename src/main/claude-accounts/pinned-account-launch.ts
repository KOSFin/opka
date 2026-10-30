import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV
} from '../../shared/claude-profile-routing'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { isSameClaudeLogin } from './claude-account-folder'
import { getClaudeProfileRouter } from './claude-profile-installed-router'
import type { ClaudeProfileRouter } from './claude-profile-router'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export async function preparePinnedClaudeAccountLaunch(args: {
  accountId: string
  getAccounts: () => readonly ClaudeManagedAccount[]
  router?: Pick<ClaudeProfileRouter, 'accountLogin' | 'prepareAccount' | 'accountHome'>
}): Promise<ClaudeRuntimeAuthPreparation> {
  const router = args.router ?? getClaudeProfileRouter()
  if (!router) {
    throw new Error('Claude account routing is unavailable on this execution host')
  }
  const assertAccount = (): void => {
    const account = args.getAccounts().find((entry) => entry.id === args.accountId)
    const login = router.accountLogin(args.accountId)
    if (
      !account ||
      account.managedAuthRuntime === 'wsl' ||
      !login ||
      !isSameClaudeLogin(account, login) ||
      (Boolean(account.organizationUuid) && account.organizationUuid !== login.organizationUuid)
    ) {
      throw new Error(
        'The requested Claude account needs its own host sign-in; no account was substituted'
      )
    }
  }
  assertAccount()
  const expectedHome = router.accountHome(args.accountId)
  const home = await router.prepareAccount(args.accountId)
  assertAccount()
  if (home !== expectedHome || router.accountHome(args.accountId) !== expectedHome) {
    throw new Error('Claude account home changed during launch preparation')
  }
  // A pinned shell must never reread the user's mutable selected-account pointer.
  const pointer = join(dirname(home), 'pinned-launch-home')
  if (!existsSync(pointer) || readFileSync(pointer, 'utf8') !== home) {
    writeFileAtomically(pointer, home, { mode: 0o600 })
  }
  return {
    configDir: home,
    runtime: 'host',
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch: {
      CLAUDE_CONFIG_DIR: home,
      [CLAUDE_INJECTED_CONFIG_DIR_ENV]: home,
      [CLAUDE_PROFILE_POINTER_ENV]: pointer
    },
    provenance: `profile:${args.accountId}`
  }
}
