import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { selectClaudeProviderAccount } from '@/runtime/runtime-provider-accounts-client'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

export function ClaudeSystemLoginRow({
  model,
  automatic = false
}: {
  model: AccountsPaneSectionModel
  automatic?: boolean
}): React.JSX.Element {
  const {
    accountRuntime,
    claudeAccounts,
    settings,
    systemClaudeActive,
    accountRuntimeSentenceLabel,
    runClaudeAccountAction,
    accountOwner,
    claudeAction,
    accountRuntimeUnavailable,
    updateSettings
  } = model
  // Why host only: the host reads its own System default, never a WSL distro's.
  const systemDefaultEmail =
    accountRuntime.runtime === 'host' ? claudeAccounts.systemDefaultEmail : undefined
  // Why the copy evidence: saving your own login as an account too is normal and needs no warning.
  const systemDefaultIsSaved =
    !!systemDefaultEmail &&
    claudeAccounts.systemDefaultMayBeCopied === true &&
    !settings.claudeCopiedSystemDefaultNoticeDismissed &&
    claudeAccounts.accounts.some(
      (account) => account.email.toLowerCase() === systemDefaultEmail.toLowerCase()
    )
  return (
    <>
      <div
        className={cn(
          'flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors',
          systemClaudeActive ? 'border-foreground/20 bg-accent/15' : 'border-border/70'
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">
              {systemDefaultEmail
                ? translate('accounts.cliLoginOnHostNamed', 'CLI login on this host: {{value0}}', {
                    value0: systemDefaultEmail
                  })
                : translate('accounts.cliLoginOnHost', 'CLI login on this host')}
            </span>
            {systemClaudeActive && !automatic ? (
              <Badge
                variant="outline"
                className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
              >
                {translate('accounts.defaultForNewChats', 'Default for new chats')}
              </Badge>
            ) : null}
          </div>
          <span className="truncate text-[11px] text-muted-foreground">
            {translate(
              'auto.components.settings.AccountsPane.e05d0ff737',
              'Use your current {{value0}} Claude login.',
              { value0: accountRuntimeSentenceLabel }
            )}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void runClaudeAccountAction('select:system', () =>
              selectClaudeProviderAccount(accountOwner, {
                accountId: null,
                runtime: accountRuntime.runtime,
                wslDistro: accountRuntime.wslDistro
              })
            )
          }
          disabled={
            automatic || claudeAction !== 'idle' || accountRuntimeUnavailable || systemClaudeActive
          }
        >
          {translate('accounts.useForNewChats', 'Use for new chats')}
        </Button>
      </div>
      {systemDefaultIsSaved ? (
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {translate(
              'accounts.claude.systemDefaultIsSaved',
              'System default is signed in as {{value0}}, which is also a saved account. An earlier Orca version may have copied that login there. If it is not your own login, select System default and run claude /login.',
              { value0: systemDefaultEmail }
            )}
          </p>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => updateSettings({ claudeCopiedSystemDefaultNoticeDismissed: true })}
          >
            {translate('accounts.claude.systemDefaultIsSavedDismiss', 'Dismiss')}
          </Button>
        </div>
      ) : null}
    </>
  )
}
