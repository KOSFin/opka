import { providerAccountUsageRevision } from './provider-account-usage-revision'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type { CodexConfigSyncStatus } from '../../../../shared/codex-config-sync-types'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/lib/web-client-location'
import {
  emptyClaudeAccountsState,
  emptyCodexAccountsState,
  getProviderAccountsOwnerKey,
  watchProviderAccounts
} from '@/runtime/runtime-provider-accounts-client'
import { getAccountsLocationSearchEntries, getAccountsPaneSearchEntries } from './accounts-search'
import { getRemoteAccountsPaneScope } from './provider-account-scope'
import { ProviderHostScopeControl } from './ProviderHostScopeControl'
import { SettingsSectionStack } from './SettingsSectionStack'
import { matchesSettingsSearch } from './settings-search'
import { getCodexAccountAuthWarning } from './codex-account-auth-warning'
import { getCodexConfigSyncWarning } from './codex-config-sync-warning'
import {
  getProviderAccountActiveIdForView,
  providerAccountIsActiveInView,
  providerAccountMatchesView
} from './provider-account-visibility'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import type {
  AccountsPaneProps,
  AccountsPaneSectionModel,
  ClaudeAccountAction,
  CodexAccountAction,
  RemoveAccountTarget
} from './accounts-pane-types'
import {
  EMPTY_WSL_DISTROS,
  getRuntimeSentenceLabel,
  getSelectedAccountRuntime
} from './accounts-pane-runtime'
import { watchCodexConfigSyncStatus } from './accounts-pane-config-sync'
import {
  createClaudeAccountActionRunner,
  createCodexAccountActionRunner
} from './accounts-pane-account-actions'
import { renderAccountsLocationSection } from './accounts-pane-location-section'
import { useUsageHostSettings } from './use-usage-host-settings'
import { buildAccountsProviderSections } from './accounts-pane-provider-sections'
import { renderAccountsRemovalDialogs } from './accounts-pane-removal-dialogs'
import { ProviderAccountsDisclosure } from './ProviderAccountsDisclosure'
import { useAccountActionState } from './use-account-action-state'

export { getAccountsPaneSearchEntries }

export function AccountsPane({
  settings,
  updateSettings,
  hostScope,
  wslSupportedPlatform = false,
  wslAvailable = false,
  wslDistros = EMPTY_WSL_DISTROS,
  wslCapabilitiesLoading = false,
  accountOwnerPlatform = null,
  wslHostDistro = null
}: AccountsPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const [enrollmentRevision, setEnrollmentRevision] = useState(0)
  const [remotePoolUsage, setRemotePoolUsage] = useState<{
    owner: string
    state: RateLimitState | null
  } | null>(null)
  const localPoolUsage = useAppStore((state) => state.rateLimits)
  const codexRateLimits = useAppStore((s) => s.rateLimits.codex)
  const codexRateLimitTarget = useAppStore((s) => s.rateLimits.codexTarget)
  const miniMaxRateLimits = useAppStore((s) => s.rateLimits.minimax)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const recordedOpenCodeSettingEditsRef = useRef<Set<'cookie' | 'workspaceId' | 'apiKey'>>(
    new Set()
  )
  const localAccountRuntime = getSelectedAccountRuntime(
    settings,
    wslSupportedPlatform,
    wslAvailable,
    wslDistros,
    wslCapabilitiesLoading,
    wslHostDistro
  )
  // Why: a server owns its provider accounts (see #7973); every list/select/remove
  // below goes to the host chosen in the page, never to the focused one.
  const accountOwner = hostScope.target
  const isRemoteAccountScope = accountOwner.kind === 'environment'
  const scopeEnvironmentId = runtimeTargetEnvironmentId(hostScope.target)
  // Why: A → B → A must not make an earlier A action current again.
  const accountOwnerKey = getProviderAccountsOwnerKey(accountOwner)
  const accountOwnerView = useMemo(() => ({ key: accountOwnerKey }), [accountOwnerKey])
  const accountOwnerViewRef = useRef<{ key: string } | null>(accountOwnerView)
  useLayoutEffect(() => {
    accountOwnerViewRef.current = accountOwnerView
    return () => {
      accountOwnerViewRef.current = null
    }
  }, [accountOwnerView])
  const isCurrentAccountOwner = (): boolean => accountOwnerViewRef.current === accountOwnerView
  // Why: keep the real name separate from the prose fallback below; the scope
  // label must not interpolate the fallback.
  const remoteServerName = isRemoteAccountScope
    ? (runtimeEnvironments.find((environment) => environment.id === scopeEnvironmentId)?.name ??
      null)
    : null
  const remoteServerLabel = isRemoteAccountScope
    ? (remoteServerName ??
      translate('auto.components.settings.AccountsPane.remoteServerFallback', 'the remote server'))
    : null
  const accountRuntime = isRemoteAccountScope
    ? { runtime: 'host' as const, label: remoteServerLabel ?? '' }
    : localAccountRuntime
  const accountRuntimeSentenceLabel = isRemoteAccountScope
    ? accountRuntime.label
    : getRuntimeSentenceLabel(accountRuntime)
  const localAccountRuntimeSentenceLabel = getRuntimeSentenceLabel(localAccountRuntime)
  // Why: users read the remote-scoped list as their desktop accounts being
  // deleted (#8186); say they are intact and link the default-runtime control.
  // The web client has no desktop-owned accounts and cannot select Local
  // desktop, so promising a switch back would be a dead end there.
  const remoteAccountScopeNotice =
    isRemoteAccountScope && !isWebClientLocation() ? (
      <ProviderHostScopeControl
        labelPrefix={translate(
          'auto.components.settings.AccountsPane.accountScopePrefix',
          'Account scope'
        )}
        scope={getRemoteAccountsPaneScope(remoteServerName)}
        className="text-xs"
      />
    ) : null

  const [codexAccounts, setCodexAccounts] =
    useState<CodexRateLimitAccountsState>(emptyCodexAccountsState)
  const rosterRevisionRef = useRef({ codex: 0, claude: 0 })
  const [codexAccountsLoaded, setCodexAccountsLoaded] = useState(false)
  const [claudeAccounts, setClaudeAccounts] =
    useState<ClaudeRateLimitAccountsState>(emptyClaudeAccountsState)
  const {
    action: codexAction,
    start: startCodexAction,
    finish: finishCodexAction
  } = useAccountActionState<CodexAccountAction>(accountOwnerView, isCurrentAccountOwner)
  const {
    action: claudeAction,
    start: startClaudeAction,
    finish: finishClaudeAction
  } = useAccountActionState<ClaudeAccountAction>(accountOwnerView, isCurrentAccountOwner)
  // Why: capture the account's runtime slot when the dialog opens; the roster
  // can change underneath an open dialog and lose the slot to diff for restarts.
  const [removeCodexTarget, setRemoveCodexTarget] = useState<RemoveAccountTarget | null>(null)
  const [removeClaudeTarget, setRemoveClaudeTarget] = useState<RemoveAccountTarget | null>(null)
  const accountVisibilityOptions = {
    remoteOwner: isRemoteAccountScope,
    ownerPlatform: accountOwnerPlatform
  }
  const visibleClaudeAccounts = claudeAccounts.accounts.filter((account) =>
    providerAccountMatchesView(account, accountRuntime, accountVisibilityOptions)
  )
  const visibleCodexAccounts = codexAccounts.accounts.filter((account) =>
    providerAccountMatchesView(account, accountRuntime, accountVisibilityOptions)
  )
  const activeCodexAccountId = getProviderAccountActiveIdForView(codexAccounts, accountRuntime)
  // Why: System default lights only when no account row is active; while a remote
  // owner's platform is unknown WSL rows hide fail-closed, so check the full roster.
  const ownerPlatformUnknown = isRemoteAccountScope && accountOwnerPlatform === null
  const systemCodexActive = !(
    ownerPlatformUnknown ? codexAccounts.accounts : visibleCodexAccounts
  ).some((account) =>
    providerAccountIsActiveInView(account, codexAccounts, accountRuntime, accountVisibilityOptions)
  )
  const systemClaudeActive = !(
    ownerPlatformUnknown ? claudeAccounts.accounts : visibleClaudeAccounts
  ).some((account) =>
    providerAccountIsActiveInView(account, claudeAccounts, accountRuntime, accountVisibilityOptions)
  )
  // Why: the system default's real identity is host-scoped (it reflects the
  // runtime's own ~/.codex), so only surface it in the host view. Per-distro
  // WSL falls back to the generic label.
  const systemCodexIdentity =
    accountRuntime.runtime === 'host' ? codexAccounts.systemDefault : undefined
  // Why: remote snapshots own their system-default identity, but the desktop's
  // rate-limit poll must not be misattributed to a remote account owner.
  const activeCodexAuthWarning = codexAccountsLoaded
    ? getCodexAccountAuthWarning({
        limits: isRemoteAccountScope ? null : codexRateLimits,
        target: codexRateLimitTarget,
        runtime: accountRuntime,
        activeAccountId: activeCodexAccountId,
        accountId: activeCodexAccountId,
        authKind: activeCodexAccountId === null ? systemCodexIdentity?.authKind : undefined
      })
    : null
  // Why: the mirror keeps serving the last synced settings when ~/.codex is
  // unusable, so without this the user only sees their edits being ignored.
  const [codexConfigSync, setCodexConfigSync] = useState<CodexConfigSyncStatus | null>(null)
  useEffect(() => {
    // Why: the status resolves the host's own ~/.codex and shared runtime home.
    // A WSL or remote scope mirrors different homes entirely, so showing it there
    // would name a config file that has nothing to do with the selected runtime.
    if (isRemoteAccountScope || accountRuntime.runtime !== 'host') {
      setCodexConfigSync(null)
      return
    }
    // Why: a temporarily locked managed home clears on its own, but this effect
    // only reruns on scope/runtime/selection changes — none of which a lock
    // release triggers. Without a retry the warning would stick until remount.
    // Serialized (timeout, not interval) so a slow response can never be
    // overwritten by an older one.
    return watchCodexConfigSyncStatus(setCodexConfigSync)
    // Why: the status resolves whichever home the ACTIVE selection mirrors into
    // (per-account, shared, or none for the real-home lane), so switching
    // accounts must refetch or the banner describes the previous account.
  }, [isRemoteAccountScope, accountRuntime.runtime, activeCodexAccountId, codexAccountsLoaded])
  const codexConfigSyncWarning = getCodexConfigSyncWarning(codexConfigSync)
  const systemCodexMissingSignIn = activeCodexAuthWarning === 'missing-sign-in'
  const systemCodexNeedsSignIn = activeCodexAccountId === null && Boolean(activeCodexAuthWarning)
  const accountRuntimeUnavailable =
    accountRuntime.runtime === 'wsl' && !wslAvailable && !wslCapabilitiesLoading

  const recordOpenCodeSettingEdit = (field: 'cookie' | 'workspaceId' | 'apiKey'): void => {
    if (recordedOpenCodeSettingEditsRef.current.has(field)) {
      return
    }
    recordedOpenCodeSettingEditsRef.current.add(field)
    recordFeatureInteraction('usage-tracking')
  }
  // Why: MiniMax/GLM keys are read by the selected host's own usage poller, so they live there too.
  const usageCredentialHost = { owner: accountOwner, label: remoteServerLabel }
  const usageHostSettings = useUsageHostSettings(
    accountOwner,
    remoteServerLabel,
    settings,
    updateSettings
  )

  useEffect(() => {
    let active = true
    const owner: RuntimeClientTarget = scopeEnvironmentId
      ? { kind: 'environment', environmentId: scopeEnvironmentId }
      : { kind: 'local' }
    // Why: remote snapshots stream usage refreshes after the synchronous ready
    // message, so the watcher stays open for the pane's lifetime; the local
    // path resolves once and the close() is a no-op.
    const watcher = watchProviderAccounts(owner, {
      onSnapshot: (snapshot) => {
        if (!active || accountOwnerViewRef.current !== accountOwnerView) {
          return
        }
        setRemotePoolUsage({
          owner: getProviderAccountsOwnerKey(owner),
          state: snapshot.rateLimits
        })

        // Why: a failed provider's half is a substituted empty roster, not
        // authoritative data; keep prior state and leave the loaded gate shut.
        if (!snapshot.failedProviders?.includes('codex')) {
          rosterRevisionRef.current.codex++
          setCodexAccounts(snapshot.codex)
          setCodexAccountsLoaded(true)
        }
        if (!snapshot.failedProviders?.includes('claude')) {
          rosterRevisionRef.current.claude++
          setClaudeAccounts(snapshot.claude)
        }
      },
      onError: (error) => {
        if (!active || accountOwnerViewRef.current !== accountOwnerView) {
          return
        }
        toast.error(
          translate(
            'auto.components.settings.AccountsPane.loadAccountsFailed',
            'Could not load provider accounts.'
          ),
          { description: String((error as Error)?.message ?? error) }
        )
      }
    })
    return () => {
      active = false
      watcher.close()
    }
  }, [scopeEnvironmentId, enrollmentRevision, accountOwnerView])

  const runCodexAccountAction = createCodexAccountActionRunner({
    settings,
    accountOwner,
    isCurrentAccountOwner,
    accountRuntime,
    isRemoteAccountScope,
    codexAccounts,
    setCodexAccounts,
    setCodexAccountsLoaded,
    getRosterRevision: () => rosterRevisionRef.current.codex,
    startCodexAction,
    finishCodexAction,
    fetchSettings,
    recordFeatureInteraction
  })
  const runClaudeAccountAction = createClaudeAccountActionRunner({
    accountOwner,
    isCurrentAccountOwner,
    accountRuntime,
    isRemoteAccountScope,
    claudeAccounts,
    setClaudeAccounts,
    getRosterRevision: () => rosterRevisionRef.current.claude,
    startClaudeAction,
    finishClaudeAction,
    fetchSettings,
    recordFeatureInteraction
  })
  const model: AccountsPaneSectionModel = {
    settings,
    accountOwner,
    updateSettings,
    searchQuery,
    recordFeatureInteraction,
    wslSupportedPlatform,
    wslAvailable,
    wslDistros,
    wslCapabilitiesLoading,
    localAccountRuntime,
    localAccountRuntimeSentenceLabel,
    isRemoteAccountScope,
    remoteServerName,
    remoteAccountScopeNotice,
    accountRuntime,
    accountRuntimeSentenceLabel,
    accountRuntimeUnavailable,
    accountVisibilityOptions,
    claudeAccounts,
    claudeAction,
    visibleClaudeAccounts,
    systemClaudeActive,
    setRemoveClaudeTarget,
    runClaudeAccountAction,
    codexAccounts,
    codexAction,
    visibleCodexAccounts,
    systemCodexActive,
    systemCodexNeedsSignIn,
    systemCodexMissingSignIn,
    systemCodexIdentity,
    activeCodexAuthWarning,
    activeCodexAccountId,
    codexConfigSync,
    codexConfigSyncWarning,
    codexRateLimits,
    codexRateLimitTarget,
    poolUsageSnapshot: isRemoteAccountScope
      ? remotePoolUsage?.owner === accountOwnerKey
        ? remotePoolUsage.state
        : null
      : localPoolUsage,
    poolUsageRevision: providerAccountUsageRevision(
      isRemoteAccountScope
        ? remotePoolUsage?.owner === accountOwnerKey
          ? remotePoolUsage.state
          : null
        : localPoolUsage
    ),
    setRemoveCodexTarget,
    runCodexAccountAction,
    recordOpenCodeSettingEdit
  }
  const providerSections = buildAccountsProviderSections({
    model,
    accountOwnerKey,
    remoteServerLabel,
    setEnrollmentRevision,
    usageCredentialHost,
    usageHostSettings,
    miniMaxRateLimits
  })
  const visibleSections = [
    wslSupportedPlatform &&
    !isRemoteAccountScope &&
    !wslHostDistro &&
    matchesSettingsSearch(searchQuery, getAccountsLocationSearchEntries())
      ? renderAccountsLocationSection(model)
      : null,
    ...providerSections.map((section) =>
      section.matches ? (
        <ProviderAccountsDisclosure
          key={`${section.key}:${accountOwnerKey}`}
          title={section.title}
          icon={section.icon}
          description={section.description}
          searchQuery={searchQuery}
        >
          {section.content}
        </ProviderAccountsDisclosure>
      ) : null
    )
  ]

  return (
    <div id="account-pools" className="space-y-8">
      {renderAccountsRemovalDialogs(model, removeCodexTarget, removeClaudeTarget)}
      <SettingsSectionStack sections={visibleSections} spacing="group" />
    </div>
  )
}
