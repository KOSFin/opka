import { AccountPoolSection } from './AccountPoolSection'
import { ClaudeSystemLoginRow } from './ClaudeSystemLoginRow'
import { renderClaudeAccountRow } from './accounts-pane-claude-account-row'
import { Loader2, Plus, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { ButtonGroup } from '../ui/button-group'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { ClaudeRunningSessionSwitchSetting } from './claude-running-session-switch-setting'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import {
  canOfferClaudeSignInLink,
  ClaudeSignInLinkMenu,
  withCopiedClaudeLink
} from './claude-sign-in-link-menu'

export function renderClaudeAccountsSection(model: AccountsPaneSectionModel): React.JSX.Element {
  const {
    accountRuntime,
    accountRuntimeSentenceLabel,
    accountRuntimeUnavailable,
    claudeAction,
    isRemoteAccountScope,
    remoteAccountScopeNotice,
    runClaudeAccountAction,
    settings,
    accountOwner,
    updateSettings,
    visibleClaudeAccounts,
    wslCapabilitiesLoading
  } = model
  // Why: interactive `claude login` needs a desktop browser and
  // would authenticate against this device, not the server.
  const addDisabled =
    isRemoteAccountScope ||
    claudeAction !== 'idle' ||
    wslCapabilitiesLoading ||
    accountRuntimeUnavailable
  const addClaudeAccount = (copyLink: boolean): Promise<void> =>
    runClaudeAccountAction('adding', () =>
      withCopiedClaudeLink(
        copyLink,
        window.api.claudeAccounts.add({
          runtime: accountRuntime.runtime,
          wslDistro: accountRuntime.wslDistro,
          copyLink
        })
      )
    )
  return (
    <section key="claude-accounts" id="accounts-claude" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          {translate(
            'accounts.claude.defaultOutsidePools',
            'Choose the default login for new chats outside automatic pools. Saved accounts can also participate in account pools. Existing chats keep their assigned account.'
          )}
        </p>
      </div>

      <SearchableSetting
        title={translate('auto.components.settings.AccountsPane.8bbfd74556', 'Claude Accounts')}
        description={translate(
          'accounts.defaultSelectionScope',
          'Choose the manual default for new chats on this host. Automatic pools use their own selection policy.'
        )}
        keywords={['claude', 'account', 'rate limit', 'status bar', 'quota']}
        className="space-y-3 py-2"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label>
              {translate('auto.components.settings.AccountsPane.94d351af4a', 'Accounts')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {isRemoteAccountScope
                ? translate(
                    'auto.components.settings.AccountsPane.remoteScopeAccounts',
                    'Showing accounts managed by {{value0}}. Add or re-authenticate accounts on that server.',
                    { value0: accountRuntimeSentenceLabel }
                  )
                : translate(
                    'auto.components.settings.AccountsPane.c0a52abfc5',
                    'Showing accounts for {{value0}}. New accounts are added there.',
                    { value0: accountRuntimeSentenceLabel }
                  )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <ButtonGroup>
              <Button
                variant="outline"
                size="xs"
                onClick={() => void addClaudeAccount(false)}
                disabled={addDisabled}
                className="gap-1.5"
              >
                {claudeAction === 'adding' ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Plus className="size-3" />
                )}
                {translate('auto.components.settings.AccountsPane.b0e948a4f9', 'Add Account')}
              </Button>
              {canOfferClaudeSignInLink(accountRuntime.runtime) ? (
                <ClaudeSignInLinkMenu
                  variant="outline"
                  disabled={addDisabled}
                  onCopyLink={() => void addClaudeAccount(true)}
                />
              ) : null}
            </ButtonGroup>
            {claudeAction === 'adding' ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void window.api.claudeAccounts.cancelPendingLogin()}
                className="gap-1.5 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
                {translate('auto.components.settings.AccountsPane.dbb9626ed1', 'Cancel')}
              </Button>
            ) : null}
          </div>
        </div>
        {remoteAccountScopeNotice}

        {accountRuntime.runtime === 'host' ? (
          <AccountPoolSection
            target={accountOwner}
            hostLabel={accountRuntimeSentenceLabel}
            provider="claude"
            refreshKey={model.poolUsageRevision}
            accountIds={visibleClaudeAccounts.map((account) => account.id)}
            beforeAccounts={(automatic) => (
              <details className="space-y-2">
                <summary className="cursor-pointer text-xs font-medium">
                  {automatic
                    ? 'Existing CLI login (manual mode only)'
                    : model.systemClaudeActive
                      ? 'Manual default: existing CLI login'
                      : 'Existing CLI login'}
                </summary>
                <ClaudeSystemLoginRow model={model} automatic={automatic} />
              </details>
            )}
            renderAccount={(accountId, controls, automatic) => {
              const account = visibleClaudeAccounts.find((entry) => entry.id === accountId)
              return account
                ? renderClaudeAccountRow(account, model, { controls, automatic })
                : null
            }}
            fallbackAccounts={(manualBlocked) => (
              <div className="space-y-2">
                <ClaudeSystemLoginRow model={model} automatic={manualBlocked} />
                {visibleClaudeAccounts.map((account) =>
                  renderClaudeAccountRow(account, model, { automatic: manualBlocked })
                )}
              </div>
            )}
          />
        ) : (
          <div className="space-y-2">
            <ClaudeSystemLoginRow model={model} />
            {visibleClaudeAccounts.map((account) => renderClaudeAccountRow(account, model))}
          </div>
        )}
      </SearchableSetting>
      {isRemoteAccountScope ? null : (
        <ClaudeRunningSessionSwitchSetting settings={settings} updateSettings={updateSettings} />
      )}
    </section>
  )
}
