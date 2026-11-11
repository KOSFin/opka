import { ArrowLeft, ArrowRight, ArrowUp, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { FILE_EXPLORER_FULL_ROOT } from './file-explorer-display-root'

type ExplorerLocationAction = {
  label: string
  disabled: boolean
  onClick: () => void
  icon: React.JSX.Element
}

function LocationAction({ label, disabled, onClick, icon }: ExplorerLocationAction) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label={label}
          onClick={onClick}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function FileExplorerLocationBar({
  rootChoice,
  rootName,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onUp,
  onSelectRoot,
  disabled
}: {
  rootChoice: string
  rootName: string
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  onUp: () => void
  onSelectRoot: (choice: string) => void
  disabled: boolean
}): React.JSX.Element {
  const parts = rootChoice === FILE_EXPLORER_FULL_ROOT ? [] : rootChoice.split('/')
  const rootLabel = rootName || translate('fileExplorer.location.workspaceRoot', 'Workspace root')
  return (
    <nav
      aria-label={translate('fileExplorer.location.label', 'Explorer location')}
      className="min-w-0 border-b border-border px-2 py-1"
    >
      <div className="flex min-w-0 items-center gap-0.5">
        <LocationAction
          label={translate('fileExplorer.location.back', 'Back')}
          disabled={disabled || !canGoBack}
          onClick={onBack}
          icon={<ArrowLeft />}
        />
        <LocationAction
          label={translate('fileExplorer.location.forward', 'Forward')}
          disabled={disabled || !canGoForward}
          onClick={onForward}
          icon={<ArrowRight />}
        />
        <LocationAction
          label={translate('fileExplorer.location.up', 'Up one folder')}
          disabled={disabled || parts.length === 0}
          onClick={onUp}
          icon={<ArrowUp />}
        />
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto scrollbar-sleek">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="min-w-0 shrink-0"
            disabled={disabled}
            aria-current={parts.length === 0 ? 'page' : undefined}
            title={rootLabel}
            onClick={() => onSelectRoot(FILE_EXPLORER_FULL_ROOT)}
          >
            <span className="block max-w-24 truncate">{rootLabel}</span>
          </Button>
          {parts.map((part, index) => {
            const choice = parts.slice(0, index + 1).join('/')
            return (
              <span key={choice} className="inline-flex min-w-0 shrink-0 items-center">
                <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="min-w-0"
                  disabled={disabled}
                  aria-current={index === parts.length - 1 ? 'page' : undefined}
                  title={choice}
                  onClick={() => onSelectRoot(choice)}
                >
                  <span className="block max-w-24 truncate">{part}</span>
                </Button>
              </span>
            )
          })}
        </div>
      </div>
      {parts.length > 0 && (
        <p className="truncate px-1 text-2xs text-muted-foreground">
          {translate(
            'fileExplorer.location.viewOnly',
            'Explorer view only · terminal cwd unchanged'
          )}
        </p>
      )}
    </nav>
  )
}
