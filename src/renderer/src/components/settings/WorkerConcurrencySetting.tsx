import { translate } from '@/i18n/i18n'
import { NumberField, SettingsSwitchRow } from './SettingsFormControls'

export function WorkerConcurrencySetting({
  value,
  onChange
}: {
  value: number | null | undefined
  onChange: (value: number | null) => void
}): React.JSX.Element {
  const enabled = value != null
  return (
    <div className="space-y-3">
      <SettingsSwitchRow
        label={translate('settings.orchestration.limitWorkers', 'Limit parallel workers')}
        description={translate(
          'settings.orchestration.limitWorkersDescription',
          'Limit new worker launches on this computer. Existing work keeps running. Workers with an unconfirmed status still occupy a slot.'
        )}
        checked={enabled}
        onChange={() => onChange(enabled ? null : 5)}
      />
      {enabled ? (
        <NumberField
          label={translate('settings.orchestration.maxWorkers', 'Maximum parallel workers')}
          description={translate(
            'settings.orchestration.maxWorkersDescription',
            'When all slots are occupied, new launches report that capacity is full. Retry after a worker finishes.'
          )}
          value={value}
          min={1}
          integer
          onChange={onChange}
        />
      ) : null}
    </div>
  )
}
