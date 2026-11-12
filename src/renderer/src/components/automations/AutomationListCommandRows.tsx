import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { LIST_TABLE_ROW_CLASS } from '@/lib/list-table-layout'
import { formatUiAutomationSchedule } from './automation-schedule-label'
import { formatAutomationDateTimeWithRelative } from './automation-page-parts'
import { AUTOMATIONS_TABLE_GRID_CLASS } from './automations-table-layout'
import type { AutomationCommandCatalogRow } from './use-automation-command-catalog'

export function AutomationListCommandRow({
  row,
  now,
  onSelect
}: {
  row: AutomationCommandCatalogRow
  now: number
  onSelect(row: AutomationCommandCatalogRow): void
}) {
  return (
    <div className={cn(AUTOMATIONS_TABLE_GRID_CLASS, LIST_TABLE_ROW_CLASS)}>
      <Button variant="ghost" className="justify-start" onClick={() => onSelect(row)}>
        {row.definition.name}
      </Button>
      <span className="truncate">{formatUiAutomationSchedule(row.definition.rrule)}</span>
      <span className="truncate">{row.definition.runContext?.path}</span>
      <span className="truncate">{row.host.label}</span>
      <span>{formatAutomationDateTimeWithRelative(row.definition.nextRunAt, now)}</span>
      <span>
        {row.definition.lastRunAt
          ? formatAutomationDateTimeWithRelative(row.definition.lastRunAt, now)
          : 'Never run'}
      </span>
      <span>{row.definition.enabled ? 'Enabled' : 'Paused'}</span>
      <span>{row.definition.execution.agent ? 'Codex' : 'Script'}</span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Open ${row.definition.name}`}
        onClick={() => onSelect(row)}
      >
        …
      </Button>
    </div>
  )
}
