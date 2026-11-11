import { describe, expect, it } from 'vitest'
import {
  EXECUTION_HOST_METHODS,
  MOBILE_RPC_METHOD_ROUTES
} from './runtime-rpc-mobile-method-routing'
import { PAIRED_DESKTOP_METHODS } from './runtime-rpc-mobile-paired-desktop-methods'

describe('mobile RPC method routing census', () => {
  it('tags every routed method exactly once', () => {
    expect(PAIRED_DESKTOP_METHODS.length + EXECUTION_HOST_METHODS.length).toBe(
      MOBILE_RPC_METHOD_ROUTES.size
    )
  })

  it.each([
    'jira.status',
    'jira.listIssues',
    'jira.searchIssues',
    'jira.getIssue',
    'jira.issueComments'
  ])('keeps %s on the paired desktop that owns its Jira connection', (method) => {
    expect(MOBILE_RPC_METHOD_ROUTES.get(method)).toBe('paired-desktop')
  })

  it('routes no per-section collapse write while the sidebar-inputs switch is off', () => {
    expect(MOBILE_RPC_METHOD_ROUTES.has('ui.setCollapsed')).toBe(false)
  })

  it('sends a targeted status to the server, whose features a server workspace gates on', () => {
    expect(MOBILE_RPC_METHOD_ROUTES.get('status.get')).toBe('execution-host')
  })
  it('admits only the reviewed group edits on the execution host', () => {
    expect(MOBILE_RPC_METHOD_ROUTES.get('projectGroup.list')).toBe('execution-host')
    expect(MOBILE_RPC_METHOD_ROUTES.get('projectGroup.update')).toBe('execution-host')
    expect(MOBILE_RPC_METHOD_ROUTES.get('projectGroup.moveProject')).toBe('execution-host')
    expect(MOBILE_RPC_METHOD_ROUTES.has('projectGroup.create')).toBe(false)
    expect(MOBILE_RPC_METHOD_ROUTES.has('projectGroup.delete')).toBe(false)
    expect(MOBILE_RPC_METHOD_ROUTES.has('projectGroup.merge')).toBe(false)
  })
})

it.each([
  'accounts.codexRoutingState',
  'accounts.beginCodexRoutingSignIn',
  'accounts.codexRoutingSignIn',
  'accounts.cancelCodexRoutingSignIn',
  'accounts.nativeClaudeRefreshSources',
  'accounts.beginNativeClaudeRefreshSignIn',
  'accounts.getNativeClaudeRefreshSignInLink',
  'accounts.submitNativeClaudeRefreshSignInCode',
  'accounts.cancelNativeClaudeRefreshSignIn',
  'accounts.installNativeCliIntegration',
  'accounts.uninstallNativeCliIntegration'
])('routes %s to its execution host', (method) => {
  expect(MOBILE_RPC_METHOD_ROUTES.get(method)).toBe('execution-host')
})
it('does not expose full local installer paths to mobile', () => {
  expect(MOBILE_RPC_METHOD_ROUTES.has('accounts.nativeCliIntegrationStatus')).toBe(false)
})
