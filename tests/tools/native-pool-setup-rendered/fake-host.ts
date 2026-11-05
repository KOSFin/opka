import { AccountPoolPolicySchema } from '../../../src/shared/account-pool-policy'
import type { NativeCliShellSetup } from '../../../src/shared/native-cli-shell-setup'
import type { RpcClient } from '../../../mobile/src/transport/rpc-client'
export const accountId = '10000000-0000-4000-8000-000000000001'
const mode = new URLSearchParams(location.search).get('mode') ?? 'not-installed'
const calls: { host: string; method: string }[] = []
const listeners = new Set<() => void>()
const setup = new Map<string, NativeCliShellSetup>()
const policies = new Map<string, unknown[]>()
export const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
export const snapshot = () => JSON.stringify(calls)
function state(host: string): NativeCliShellSetup {
  return (
    setup.get(host) ?? {
      supported: true,
      state: mode === 'modified' ? 'modified' : 'not-installed',
      missing: []
    }
  )
}
export async function request(host: string, method: string, params?: unknown): Promise<unknown> {
  calls.push({ host, method })
  listeners.forEach((fn) => fn())
  if (
    method === 'accounts.installNativeCliIntegration' ||
    method === 'accounts.uninstallNativeCliIntegration'
  ) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (mode === 'error') {throw new Error('Synthetic private host error')}
    const next: NativeCliShellSetup = {
      supported: true,
      state: method.includes('uninstall') ? 'not-installed' : 'installed',
      missing: []
    }
    setup.set(host, next)
    return next
  }
  if (method === 'accounts.codexRoutingState')
    {return {
      capability: 'accounts.native-codex-routing.v1',
      supported: true,
      accounts: [{ accountId, rosterRevision: 'fixture-r1', status: 'ready' }],
      shellSetup: state(host)
    }}
  if (method === 'accounts.nativeClaudeRefreshSources')
    {return {
      accounts: [{ accountId, state: 'ready', nativeVersion: '2.1.318' }],
      shellSetup: state(host)
    }}
  if (method === 'accountPool.update') {
    const policy = AccountPoolPolicySchema.parse(
      params && typeof params === 'object' && 'policy' in params ? params.policy : null
    )
    policies.set(host, [policy])
  } else if (method !== 'accountPool.list')
    {throw new Error(`Unexpected synthetic request: ${method}`)}
  return {
    capability: 'orchestration.account-pools.v1',
    policies: policies.get(host) ?? [],
    accounts: {
      claude: {
        accounts: [{ id: accountId, email: 'claude@example.test' }],
        activeAccountId: accountId
      },
      codex: {
        accounts: [{ id: accountId, email: 'codex@example.test' }],
        activeAccountId: accountId
      }
    },
    candidates: ['claude', 'codex'].map((provider) => ({
      provider,
      accountId,
      auth: 'ready',
      quota: 'available',
      usedPercent: 1
    })),
    assignments: []
  }
}
export const callRuntimeRpc = (
  target: { kind: string; environmentId?: string },
  method: string,
  params?: unknown
) => request(target.environmentId ?? 'local', method, params)
export function mobileClient(host: string): RpcClient {
  return {
    sendRequest: async (method, params) => ({
      id: 'synthetic',
      ok: true,
      result: await request(host, method, params),
      _meta: { runtimeId: host }
    }),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getGeneration: () => 1,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}
export function translate(_key: string, fallback: string, values?: Record<string, string>) {
  return fallback.replace(/{{(\w+)}}/g, (_match, key) => values?.[key] ?? '')
}
