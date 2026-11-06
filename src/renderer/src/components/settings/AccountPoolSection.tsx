import { useAccountPoolSettings } from './use-account-pool-settings'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { Button } from '../ui/button'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '../ui/accordion'
import { AccountPoolProviderSummary } from './AccountPoolProviderSummary'
import { AccountPoolPolicyEditor, type AccountPoolPresentation } from './AccountPoolPolicyEditor'

export function AccountPoolSection({
  target,
  hostLabel,
  provider,
  fallbackAccounts,
  refreshKey,
  ...presentation
}: AccountPoolPresentation & {
  target: RuntimeClientTarget
  hostLabel: string
  provider?: 'claude' | 'codex'
  fallbackAccounts?: React.ReactNode | ((manualBlocked: boolean) => React.ReactNode)
  refreshKey?: string
}): React.JSX.Element {
  const { view, drafts, busy, error, unsupported, saved, saveError, change, refresh, save } =
    useAccountPoolSettings(target, refreshKey)
  return (
    <section
      id={provider ? `accounts-${provider}-switching` : 'account-pools'}
      className="space-y-4 scroll-mt-6"
    >
      {!provider ? (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">
            {translate('settings.accountPools.title', 'Account pools')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.accountPools.scope',
              'Execution host: {{host}}. Pools choose accounts for chats, workers and connected CLI commands on this host.',
              { host: hostLabel }
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.accountPools.modes',
              'With the pool off, new launches use the manual default. Sequential prefers the lowest priority number. Balanced distributes eligible launches within a priority level.'
            )}
          </p>
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="space-y-2 text-xs text-destructive">
          <p>
            {view
              ? 'Could not save or refresh pools.'
              : 'Account pools unavailable on this host. An older host may require an update.'}{' '}
            {error}
          </p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
            {provider ? 'Refresh accounts and limits' : 'Refresh pools'}
          </Button>
        </div>
      ) : null}
      {!view && !error ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading account pools…
        </p>
      ) : null}
      {view ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
          {provider ? 'Refresh accounts and limits' : 'Refresh pools'}
        </Button>
      ) : null}
      {provider && view ? (
        drafts
          .filter((policy) => policy.provider === provider)
          .map((policy) => (
            <AccountPoolPolicyEditor
              key={policy.id}
              {...presentation}
              view={view}
              policy={policy}
              target={target}
              hostLabel={hostLabel}
              busy={busy}
              saved={saved}
              saveError={saveError}
              change={change}
              save={save}
            />
          ))
      ) : !provider ? (
        <Accordion type="multiple">
          {view
            ? drafts.map((policy) => (
                <AccordionItem key={policy.id} value={policy.id}>
                  <AccordionTrigger>
                    <AccountPoolProviderSummary
                      policy={policy}
                      savedAccountCount={view.accounts[policy.provider].accounts.length}
                    />
                  </AccordionTrigger>
                  <AccordionContent>
                    <AccountPoolPolicyEditor
                      {...presentation}
                      view={view}
                      policy={policy}
                      target={target}
                      hostLabel={hostLabel}
                      busy={busy}
                      saved={saved}
                      saveError={saveError}
                      change={change}
                      save={save}
                    />
                  </AccordionContent>
                </AccordionItem>
              ))
            : null}
        </Accordion>
      ) : null}
      {provider && !view
        ? typeof fallbackAccounts === 'function'
          ? fallbackAccounts(!unsupported)
          : fallbackAccounts
        : null}
    </section>
  )
}
