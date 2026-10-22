import { useState } from 'react'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { Button } from '../ui/button'

export function ProfileCliRegistration({
  status,
  onStatusChange
}: {
  status: CliInstallStatus
  onStatusChange: (status: CliInstallStatus) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const installed = status.state === 'installed'
  const change = async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await (installed ? window.api.cli.remove() : window.api.cli.install())
      onStatusChange(next)
      if (next.state === 'conflict') {
        setError(next.detail ?? 'Existing launcher left unchanged.')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'CLI setup failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-3" data-settings-section="cli">
      <h2 className="text-sm font-semibold">Test profile CLI</h2>
      <p className="text-xs text-muted-foreground">
        {installed ? 'Profile launcher ready.' : 'Profile launcher not created.'} Use its full path
        from an external terminal. Your global Orca command and shell PATH are unchanged.
      </p>
      <code className="block break-all rounded bg-muted p-2 text-xs">{status.commandPath}</code>
      <p className="text-xs text-muted-foreground">
        This launcher uses the isolated test profile. Codex and Claude sign-in are separate; no
        accounts are copied from your working setup.
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !status.supported || status.state === 'conflict'}
          onClick={() => void change()}
        >
          {busy ? 'Updating…' : installed ? 'Remove profile launcher' : 'Create profile launcher'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!installed}
          onClick={() => {
            void navigator.clipboard
              .writeText(status.commandPath ?? '')
              .catch(() => setError('Could not copy command path.'))
          }}
        >
          Copy command path
        </Button>
      </div>
      {error || status.detail ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? status.detail}
        </p>
      ) : null}
    </section>
  )
}
