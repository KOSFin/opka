import React from 'react'
import { Button } from '@/components/ui/button'
import type { AutomationRun } from '../../../../shared/automations-types'
import {
  getAutomationHostTargetFromKey,
  getAutomationHostTargetKey,
  type AutomationHostTarget
} from './automation-host-client'
import { listCommandAutomationHistoryPageForTarget } from './automation-command-host-client'

type Props = { target: AutomationHostTarget; onClose(): void }

export function AutomationCommandArchive({ target, onClose }: Props): React.JSX.Element {
  const [runs, setRuns] = React.useState<AutomationRun[]>([])
  const [cursor, setCursor] = React.useState<string | null>(null)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const epoch = React.useRef(0)
  const targetKey = getAutomationHostTargetKey(target)
  const stableTarget = React.useMemo<AutomationHostTarget>(
    () => getAutomationHostTargetFromKey(targetKey) ?? { kind: 'local' },
    [targetKey]
  )
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0] ?? null
  const load = React.useCallback(
    async (nextCursor?: string): Promise<void> => {
      const request = ++epoch.current
      setLoading(true)
      try {
        const page = await listCommandAutomationHistoryPageForTarget(stableTarget, nextCursor)
        if (request !== epoch.current) {
          return
        }
        setRuns((current) =>
          nextCursor
            ? [
                ...current,
                ...page.runs.filter((run) => !current.some((entry) => entry.id === run.id))
              ]
            : page.runs
        )
        setCursor(page.nextCursor)
        setError(null)
      } catch (cause) {
        if (request !== epoch.current) {
          return
        }
        setError(cause instanceof Error ? cause.message : 'History is unavailable.')
      } finally {
        if (request === epoch.current) {
          setLoading(false)
        }
      }
    },
    [stableTarget]
  )
  React.useEffect(() => {
    setRuns([])
    setSelectedId(null)
    void load()
    return () => {
      epoch.current += 1
    }
  }, [load])

  return (
    <section
      aria-label="Retained command reports"
      className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto rounded-md border border-border p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Retained reports</h2>
        <Button variant="outline" onClick={onClose}>
          Back to definitions
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(10rem,16rem)_minmax(0,1fr)]">
        <div className="grid content-start gap-1">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              data-current={run.id === selected?.id}
              className="rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[current=true]:bg-accent"
              onClick={() => setSelectedId(run.id)}
            >
              {run.title} · {new Date(run.createdAt).toLocaleString()}
            </button>
          ))}
          {runs.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">No retained command reports.</p>
          )}
          {cursor && (
            <Button variant="outline" onClick={() => void load(cursor)} disabled={loading}>
              Load more
            </Button>
          )}
        </div>
        <div className="rounded-md border border-border p-3">
          {selected ? (
            <>
              <p className="text-sm font-medium">{selected.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {selected.status} ·{' '}
                {selected.commandExecution?.finalReason ?? 'No final reason yet'}
              </p>
              <pre className="scrollbar-sleek mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
                {selected.outputSnapshot?.content ?? 'Report not yet available.'}
              </pre>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Select a report.</p>
          )}
        </div>
      </div>
    </section>
  )
}
