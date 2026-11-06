import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { selectCodexProviderAccount } from '@/runtime/runtime-provider-accounts-client'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { getCodexSystemDefaultSubtitle } from './accounts-pane-runtime'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

export function CodexSystemLoginRow({
  model,
  automatic = false
}: {
  model: AccountsPaneSectionModel
  automatic?: boolean
}): React.JSX.Element {
  const {
    systemCodexNeedsSignIn,
    systemCodexActive,
    systemCodexMissingSignIn,
    systemCodexIdentity,
    accountRuntimeSentenceLabel,
    runCodexAccountAction,
    accountOwner,
    accountRuntime,
    codexAction,
    accountRuntimeUnavailable
  } = model
  return (
    <div
      className={cn(
        'flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors',
        systemCodexNeedsSignIn
          ? 'border-destructive/50 bg-destructive/5'
          : systemCodexActive
            ? 'border-foreground/20 bg-accent/15'
            : 'border-border/70'
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">
            {translate('accounts.cliLoginOnHost', 'CLI login on this host')}
          </span>
          {systemCodexActive && !automatic ? (
            <Badge
              variant="outline"
              className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
            >
              {translate('accounts.defaultForNewChats', 'Default for new chats')}
            </Badge>
          ) : null}
          {systemCodexNeedsSignIn ? (
            <Badge
              variant="destructive"
              className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none"
            >
              {translate('auto.components.settings.AccountsPane.93c47b333a', 'Needs sign-in')}
            </Badge>
          ) : null}
        </div>
        <span
          className={cn(
            'truncate text-[11px]',
            systemCodexNeedsSignIn ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {systemCodexNeedsSignIn
            ? systemCodexMissingSignIn
              ? translate(
                  'auto.components.settings.AccountsPane.codexSystemDefaultNeedsSignIn',
                  'No Codex sign-in was found for {{value0}}.',
                  { value0: accountRuntimeSentenceLabel }
                )
              : translate(
                  'auto.components.settings.AccountsPane.fd62f37c24',
                  'Codex reported this {{value0}} login is out of date.',
                  { value0: accountRuntimeSentenceLabel }
                )
            : getCodexSystemDefaultSubtitle(systemCodexIdentity, accountRuntimeSentenceLabel)}
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          void runCodexAccountAction('select:system', () =>
            selectCodexProviderAccount(accountOwner, {
              accountId: null,
              runtime: accountRuntime.runtime,
              wslDistro: accountRuntime.wslDistro
            })
          )
        }
        disabled={
          automatic || codexAction !== 'idle' || accountRuntimeUnavailable || systemCodexActive
        }
      >
        {translate('accounts.useForNewChats', 'Use for new chats')}
      </Button>
    </div>
  )
}
