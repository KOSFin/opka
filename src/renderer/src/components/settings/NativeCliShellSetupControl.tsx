import { useEffect, useMemo, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  nativeCliShellSetupInstalled,
  type NativeCliShellSetup
} from '../../../../shared/native-cli-shell-setup'
import {
  runNativeCliShellSetupAction,
  createNativeCliShellSetupActionOwner,
  type NativeCliShellSetupAction
} from '../../../../shared/native-cli-shell-setup-action'
import { Button } from '../ui/button'
import { SecuritySurface } from '../ui/security-surface'

export function NativeCliShellSetupControl({
  setup,
  target,
  hostLabel,
  onComplete
}: {
  setup: NativeCliShellSetup
  target: RuntimeClientTarget
  hostLabel: string
  onComplete: () => void
}) {
  const identity = JSON.stringify([
    target.kind,
    target.kind === 'environment' ? target.environmentId : null
  ])
  const owner = useMemo(() => ({ identity, ...createNativeCliShellSetupActionOwner() }), [identity])
  const [view, setView] = useState<{
    owner: typeof owner
    setup?: NativeCliShellSetup
    base: NativeCliShellSetup
    notice: string
    busy: boolean
  } | null>(null)
  useEffect(() => {
    owner.active = true
    return () => {
      owner.active = false
      owner.controller?.abort()
    }
  }, [owner])
  const current =
    view?.owner === owner && (view.busy || !view.setup || view.base === setup) ? view : null
  const shown = current?.setup ?? setup
  const busy = current?.busy === true
  async function act(action: NativeCliShellSetupAction) {
    if (owner.busy || !owner.active) {
      return
    }
    owner.busy = true
    const controller = new AbortController()
    owner.controller = controller
    setView({
      owner,
      base: setup,
      notice:
        action === 'install'
          ? `Setting up CLI on ${hostLabel}…`
          : `Removing CLI setup from ${hostLabel}…`,
      busy: true
    })
    try {
      const result = await runNativeCliShellSetupAction({
        action,
        signal: controller.signal,
        request: (method, signal) => callRuntimeRpc<unknown>(target, method, undefined, { signal })
      })
      if (result) {
        setView({
          owner,
          base: setup,
          setup: result,
          busy: false,
          notice:
            action === 'uninstall' && result.state === 'not-installed'
              ? `CLI setup removed from ${hostLabel}.`
              : nativeCliShellSetupInstalled(result)
                ? `CLI setup is ready on ${hostLabel}. Open a new terminal.`
                : `CLI setup needs review on ${hostLabel}. User changes are preserved.`
        })
      }
    } catch {
      if (!controller.signal.aborted && owner.active) {
        setView({
          owner,
          base: setup,
          busy: false,
          notice: `CLI setup on ${hostLabel} could not be confirmed. Existing user changes are preserved; refresh its status.`
        })
      }
    } finally {
      owner.busy = false
      if (controller.signal.aborted && owner.active) {
        setView(null)
      }
      if (!controller.signal.aborted && owner.active) {
        onComplete()
      }
    }
  }
  const supported = shown.supported && shown.state !== 'unsupported'
  const installed = shown.state === 'installed'
  const canInstall = supported && shown.state === 'not-installed' && shown.missing.length === 0
  return (
    <SecuritySurface>
      <div className="space-y-2">
        <p className="break-words text-xs text-muted-foreground" role="status" aria-live="polite">
          {current?.notice ??
            (nativeCliShellSetupInstalled(shown)
              ? `Ordinary CLI commands are ready on ${hostLabel}.`
              : !supported
                ? `Ordinary CLI setup is unavailable on ${hostLabel}.`
                : shown.missing.length
                  ? `Install the missing commands on ${hostLabel}: ${shown.missing.map((name) => (name === 'orca' ? 'Opka CLI' : name)).join(', ')}.`
                  : shown.state === 'not-installed'
                    ? `Set up ordinary Claude and Codex commands on ${hostLabel}. This updates only this host user’s shell integration.`
                    : `Shell setup on ${hostLabel} needs review. Existing user changes are preserved.`)}
        </p>
        {canInstall ? (
          <Button size="sm" disabled={busy} onClick={() => void act('install')}>
            {busy ? 'Setting up…' : 'Set up ordinary CLI'}
          </Button>
        ) : installed && supported ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act('uninstall')}>
            {busy ? 'Removing…' : 'Remove CLI setup'}
          </Button>
        ) : null}
        {!canInstall && !installed && supported ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={onComplete}>
            Refresh setup status
          </Button>
        ) : null}
        {supported && (shown.state === 'modified' || shown.state === 'unverifiable') ? (
          <code className="block break-all text-xs text-muted-foreground">
            &quot;$ORCA_CLI_COMMAND&quot; agent native-shell status
          </code>
        ) : null}
      </div>
    </SecuritySurface>
  )
}
