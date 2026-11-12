import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { AutomationCommandArchive } from './AutomationCommandArchive'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationHostTarget } from './automation-host-client'

export function AutomationCommandReports({
  hosts,
  environmentId
}: {
  hosts: readonly AutomationHostCatalogEntry[]
  environmentId?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [hostKey, setHostKey] = useState<string | null>(null)
  const choices = hosts.filter((host) => host.kind === 'self')
  const selected =
    hostKey === null
      ? choices.find((host) => {
          const authority = host.stableRef.authority
          return environmentId
            ? authority.kind === 'runtime' && authority.environmentId === environmentId
            : authority.kind === 'desktop'
        })
      : choices.find((host) => host.stableKey === hostKey)
  const authority = selected?.stableRef.authority
  const target: AutomationHostTarget | null = authority
    ? authority.kind === 'runtime'
      ? { kind: 'environment', environmentId: authority.environmentId }
      : { kind: 'local' }
    : null
  return (
    <section className="flex min-h-0 shrink-0 flex-col gap-3 px-5 pb-4">
      <div>
        <Button variant="outline" onClick={() => setOpen(!open)}>
          {open ? 'Hide script reports' : 'Script run reports'}
        </Button>
      </div>
      {open && (
        <>
          <Select value={selected?.stableKey ?? ''} onValueChange={setHostKey}>
            <SelectTrigger aria-label="Report execution host" className="w-full">
              <SelectValue placeholder="Select host" />
            </SelectTrigger>
            <SelectContent>
              {choices.map((host) => (
                <SelectItem key={host.stableKey} value={host.stableKey}>
                  {host.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {target && (
            <div className="scrollbar-sleek flex max-h-80 min-h-0 flex-col overflow-auto">
              <AutomationCommandArchive target={target} onClose={() => setOpen(false)} />
            </div>
          )}
        </>
      )}
    </section>
  )
}
