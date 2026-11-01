import { translate } from '@/i18n/i18n'

export function usageAccountOwnerLabel(
  environmentId: string | null,
  environments: readonly { id: string; name: string }[]
): string | undefined {
  return environmentId === null
    ? undefined
    : (environments.find((environment) => environment.id === environmentId)?.name ??
        translate('auto.components.status.bar.StatusBar.remoteServerLabel', 'Remote server'))
}
