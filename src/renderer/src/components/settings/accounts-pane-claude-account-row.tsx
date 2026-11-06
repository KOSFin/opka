import { ProviderAccountQuota } from './ProviderAccountQuota'
import type { ReactNode } from 'react'
import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { selectClaudeProviderAccount } from '@/runtime/runtime-provider-accounts-client'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/managed-account-types'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { ButtonGroup } from '../ui/button-group'
import {
  getProviderAccountRuntime,
  providerAccountIsActiveInView
} from './provider-account-visibility'
import { formatAccountTimestamp, getClaudeAccountRuntimeLabel } from './accounts-pane-runtime'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import {
  canOfferClaudeSignInLink,
  ClaudeSignInLinkMenu,
  withCopiedClaudeLink
} from './claude-sign-in-link-menu'

export function renderClaudeAccountRow(
  account: ClaudeRateLimitAccountsState['accounts'][number],
  model: AccountsPaneSectionModel,
  presentation: { controls?: ReactNode; automatic?: boolean } = {}
): React.JSX.Element {
  const {
    claudeAccounts,
    accountRuntime,
    accountVisibilityOptions,
    claudeAction,
    accountRuntimeUnavailable,
    runClaudeAccountAction,
    accountOwner,
    isRemoteAccountScope,
    setRemoveClaudeTarget
  } = model
  const isActive = providerAccountIsActiveInView(
    account,
    claudeAccounts,
    accountRuntime,
    accountVisibilityOptions
  )
  const isReauthing = claudeAction === `reauth:${account.id}`
  const isBusy = claudeAction !== 'idle' || accountRuntimeUnavailable
  const accountRuntimeView = getProviderAccountRuntime(account)
  const reauthenticate = (copyLink: boolean): Promise<void> =>
    runClaudeAccountAction(
      `reauth:${account.id}`,
      () =>
        withCopiedClaudeLink(
          copyLink,
          window.api.claudeAccounts.reauthenticate({ accountId: account.id, copyLink })
        ),
      accountRuntimeView
    )

  return (
    <div
      key={account.id}
      role="group"
      aria-label={account.email}
      className={cn(
        'w-full space-y-3 rounded-md border px-3 py-2.5 text-left transition-colors',
        isActive ? 'border-foreground/20 bg-accent/15' : 'border-border/70'
      )}
    >
      <div className="flex w-full items-center justify-between gap-3 max-md:flex-col max-md:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{account.email}</span>
            <Badge
              variant="outline"
              className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/70"
            >
              {getClaudeAccountRuntimeLabel(account, accountRuntime.label)}
            </Badge>
            {isActive && !presentation.automatic ? (
              <Badge
                variant="outline"
                className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
              >
                {translate('accounts.defaultForNewChats', 'Default for new chats')}
              </Badge>
            ) : null}
          </div>
          <span className="truncate text-[11px] text-muted-foreground">
            {account.needsSignIn
              ? translate('accounts.claude.signInRequired', 'Sign in again to use this account')
              : account.organizationName
                ? `${account.organizationName} · ${formatAccountTimestamp(account.lastAuthenticatedAt)}`
                : formatAccountTimestamp(account.lastAuthenticatedAt)}
          </span>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-1 max-md:w-full max-md:flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void runClaudeAccountAction(
                `select:${account.id}`,
                () =>
                  selectClaudeProviderAccount(accountOwner, {
                    accountId: account.id,
                    ...accountRuntimeView
                  }),
                accountRuntimeView
              )
            }}
            disabled={isBusy || account.needsSignIn || isActive || presentation.automatic}
          >
            {translate('accounts.useForNewChats', 'Use for new chats')}
          </Button>
          <ButtonGroup>
            <Button
              variant="ghost"
              size="xs"
              onClick={(event) => {
                event.stopPropagation()
                void reauthenticate(false)
              }}
              disabled={isRemoteAccountScope || isBusy}
              className="h-6 px-2 text-muted-foreground hover:text-foreground"
            >
              {isReauthing ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              {translate('accounts.claude.signInAgain', 'Sign in again')}
            </Button>
            {canOfferClaudeSignInLink(accountRuntimeView.runtime) ? (
              <ClaudeSignInLinkMenu
                variant="ghost"
                disabled={isRemoteAccountScope || isBusy}
                onCopyLink={() => void reauthenticate(true)}
              />
            ) : null}
          </ButtonGroup>
          <Button
            variant="ghost"
            size="xs"
            onClick={(event) => {
              event.stopPropagation()
              setRemoveClaudeTarget({
                id: account.id,
                runtime: getProviderAccountRuntime(account)
              })
            }}
            disabled={isBusy}
            className="h-6 px-2 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-3" />
            {translate('auto.components.settings.AccountsPane.db209ee572', 'Remove')}
          </Button>
        </div>
      </div>
      <ProviderAccountQuota provider="claude" accountId={account.id} model={model} />
      {presentation.controls}
    </div>
  )
}
