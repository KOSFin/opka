import React from 'react'
import { Button } from '@/components/ui/button'
import type { AutomationHostTarget } from './automation-host-client'
import {
  listCommandAutomationsForTarget,
  reconcileCommandManualRequestForTarget
} from './automation-command-host-client'
import type { PendingCommandRun } from './automation-command-pending-requests'
import {
  reconcilePendingCommandRun,
  type CommandRequestReconciliation
} from './automation-command-request-reconciliation'

type Props = {
  target: AutomationHostTarget
  request: PendingCommandRun
  busy: boolean
  canStartNew: boolean
  onAdmitted(runId: string, overlap: boolean): void
  onStartNew(): void
}

export function AutomationCommandRunRecovery({
  target,
  request,
  busy,
  canStartNew,
  onAdmitted,
  onStartNew
}: Props): React.JSX.Element {
  const [resolution, setResolution] = React.useState<CommandRequestReconciliation | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const epoch = React.useRef(0)
  React.useEffect(
    () => () => {
      epoch.current += 1
    },
    [request.key, target]
  )
  const reconcile = async (): Promise<void> => {
    const current = ++epoch.current
    setLoading(true)
    setError(null)
    try {
      const definitions = await listCommandAutomationsForTarget(target)
      const definition = definitions.find((entry) => entry.id === request.id)
      if (!definition) {
        throw new Error('The automation is no longer on this host.')
      }
      const history = await reconcileCommandManualRequestForTarget(target, request.id, request.key)
      if (current !== epoch.current) {
        return
      }
      const result = reconcilePendingCommandRun(
        request,
        history.receipt,
        history.runs,
        Date.now(),
        definition.revision
      )
      setResolution(result)
      if (result.kind === 'admitted') {
        onAdmitted(result.runId, result.overlap)
      }
    } catch (cause) {
      if (current !== epoch.current) {
        return
      }
      setError(cause instanceof Error ? cause.message : 'The host could not reconcile the request.')
    } finally {
      if (current === epoch.current) {
        setLoading(false)
      }
    }
  }
  return (
    <div className="mt-4 rounded-md border border-border p-3 text-sm">
      <p className="font-medium">Previous run request</p>
      <p className="mt-1 text-muted-foreground">
        Check the host receipt and retained history before starting another run.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
      {resolution?.kind === 'unverifiable' && (
        <p role="status" className="mt-2">
          The host cannot prove whether this request ran. Keep its key; do not start a new request.
        </p>
      )}
      {resolution?.kind === 'safe_no_effect' && (
        <p role="status" className="mt-2">
          The host has no receipt or later run, and the old request can no longer be admitted. You
          may start a new request.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void reconcile()}
          disabled={busy || loading}
        >
          Reconcile request
        </Button>
        {resolution?.kind === 'safe_no_effect' && (
          <Button size="sm" onClick={onStartNew} disabled={busy || loading || !canStartNew}>
            Start new request
          </Button>
        )}
      </div>
    </div>
  )
}
