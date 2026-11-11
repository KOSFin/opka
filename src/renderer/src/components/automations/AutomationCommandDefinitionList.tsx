import React from 'react'
import type { AutomationCommandDefinitionV1 } from '../../../../shared/automation-command-domain'

type Props = {
  definitions: readonly AutomationCommandDefinitionV1[]
  selectedId: string | null
  busy: boolean
  onSelect(id: string): void
}

export function AutomationCommandDefinitionList({
  definitions,
  selectedId,
  busy,
  onSelect
}: Props): React.JSX.Element {
  return (
    <section
      aria-label="Command automation list"
      className="scrollbar-sleek min-h-0 overflow-y-auto rounded-md border border-border p-2"
    >
      {definitions.length === 0 && (
        <p className="p-3 text-sm text-muted-foreground">No command automations on this host.</p>
      )}
      {definitions.map((entry) => (
        <button
          key={entry.id}
          type="button"
          disabled={busy}
          data-current={entry.id === selectedId}
          className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[current=true]:bg-accent"
          onClick={() => onSelect(entry.id)}
        >
          <span className="block font-medium">{entry.name}</span>
          <span className="block text-xs text-muted-foreground">
            {entry.timezone} · revision {entry.revision}
          </span>
        </button>
      ))}
    </section>
  )
}
