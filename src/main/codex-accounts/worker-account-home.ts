import { join } from 'node:path'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { getAppEnvironment } from '../../shared/app-environment'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { resolveHostCodexManagedHomeVerdict } from './host-codex-managed-home-ownership'
import { readStoredCodexCredentialState } from './managed-codex-auth-readiness'

export const WORKER_CODEX_ACCOUNT_ENV = 'ORCA_WORKER_CODEX_ACCOUNT_ID'

export function resolveWorkerCodexAccountHome(
  accounts: readonly CodexManagedAccount[] | undefined,
  accountId: string
): string {
  const account = accounts?.find((candidate) => candidate.id === accountId)
  if (!account || account.managedHomeRuntime === 'wsl') {
    throw new Error('The requested Codex account is not registered on this execution host')
  }
  const verdict = resolveHostCodexManagedHomeVerdict({
    candidatePath: account.managedHomePath,
    managedAccountsRoot: join(getAppEnvironment().getPath('userData'), 'codex-accounts'),
    systemCodexHomePath: getSystemCodexHomePath(),
    expectedAccountId: account.id
  })
  if (verdict.kind !== 'owned') {
    throw new Error(
      'The requested Codex account home is unavailable or untrusted; no account was substituted'
    )
  }
  if (readStoredCodexCredentialState(join(account.managedHomePath, 'auth.json')) !== 'present') {
    throw new Error('The requested Codex account needs sign-in; no account was substituted')
  }
  return account.managedHomePath
}

export function resolveWorkerCodexLaunchHome(args: {
  env: Record<string, string> | undefined
  agent: string | undefined
  runtime: string
  accounts: readonly CodexManagedAccount[] | undefined
}): string | undefined {
  const id = args.env?.[WORKER_CODEX_ACCOUNT_ENV]
  if (id === undefined) {
    return undefined
  }
  if (args.agent !== 'codex' || args.runtime !== 'host') {
    throw new Error('Explicit worker account routing is only supported for local Codex terminals')
  }
  const home = resolveWorkerCodexAccountHome(args.accounts, id)
  if (args.env?.CODEX_HOME !== home) {
    throw new Error('The worker account home changed during launch; no account was substituted')
  }
  return home
}
