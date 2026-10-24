import { X } from 'lucide-react'
import { Button } from '../../ui/button'
import { translate } from '@/i18n/i18n'

export function MacBetaUpdateContent({
  version,
  downloaded,
  onAction,
  onClose
}: {
  version: string
  downloaded: boolean
  onAction: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {translate('opka.updates.beta.version', 'Opka {{version}}', { version })}
        </h3>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={translate('auto.components.UpdateCard.318d3b4bc7', 'Dismiss update')}
        >
          <X />
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {downloaded
          ? translate(
              'opka.updates.beta.downloaded',
              'The installer passed its checksum check. Open it, quit Opka and confirm replacing Opka.app. Your profile stays on this Mac.'
            )
          : translate(
              'opka.updates.beta.available',
              'This beta is not notarized by Apple. Download the installer, then confirm replacing Opka.app. macOS may ask you to allow it to open.'
            )}
      </p>
      <Button size="sm" onClick={onAction}>
        {downloaded
          ? translate('opka.updates.beta.open', 'Open installer')
          : translate('opka.updates.beta.download', 'Download installer')}
      </Button>
    </div>
  )
}
