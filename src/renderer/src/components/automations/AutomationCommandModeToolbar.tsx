import React from 'react'
import { Button } from '@/components/ui/button'

type Props = {
  busy: boolean
  canCreate: boolean
  onBack(): void
  onRefresh(): void
  onOpenReports(): void
  onCreate(): void
}

export function AutomationCommandModeToolbar({
  busy,
  canCreate,
  onBack,
  onRefresh,
  onOpenReports,
  onCreate
}: Props): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <div>
        <h1 className="text-lg font-semibold">Command automations</h1>
        <p className="text-sm text-muted-foreground">
          Script → condition → history report on one execution host.
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack}>
          Back to automations
        </Button>
        <Button variant="outline" onClick={onRefresh} disabled={busy}>
          Refresh
        </Button>
        <Button variant="outline" onClick={onOpenReports} disabled={busy}>
          Retained reports
        </Button>
        <Button onClick={onCreate} disabled={busy || !canCreate}>
          New command automation
        </Button>
      </div>
    </div>
  )
}
