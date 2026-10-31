import { useEffect, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { AccountSignInTerminalSchema } from '../../../../shared/account-sign-in-terminal'
import {
  AccountSignInWorkspacesSchema,
  type AccountSignInWorkspace
} from '../../../../shared/account-sign-in-workspaces'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

export function RemoteClaudeSignInSection({
  target
}: {
  target: RuntimeClientTarget
}): React.JSX.Element {
  const mounted = useRef(true)
  const [workspaces, setWorkspaces] = useState<AccountSignInWorkspace[] | null>(null)
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mutation = useRef<string | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function chooseWorkspace(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const inventory = AccountSignInWorkspacesSchema.parse(
        await callRuntimeRpc(target, 'worktree.list', { limit: 100 })
      )
      if (!mounted.current) {
        return
      }
      setWorkspaces(inventory.worktrees)
      setSelected(inventory.worktrees[0]?.id ?? '')
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (mounted.current) {
        setBusy(false)
      }
    }
  }
  async function openTerminal(): Promise<void> {
    if (!selected || busy) {
      return
    }
    setBusy(true)
    setError('')
    const clientMutationId = mutation.current ?? createBrowserUuid()
    mutation.current = clientMutationId
    try {
      const { terminal } = AccountSignInTerminalSchema.parse(
        await callRuntimeRpc(target, 'accounts.openSignInTerminal', {
          provider: 'claude',
          worktree: selected.startsWith('folder:') ? selected : `id:${selected}`,
          clientMutationId
        })
      )
      if (!mounted.current) {
        return
      }
      await callRuntimeRpc({ kind: 'local' }, 'terminal.reveal', {
        worktreeId: terminal.worktreeId,
        tabId: terminal.tabId,
        leafId: terminal.leafId,
        executionHostId:
          target.kind === 'environment' ? toRuntimeExecutionHostId(target.environmentId) : 'local'
      })
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (mounted.current) {
        setBusy(false)
      }
    }
  }
  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void chooseWorkspace()}>
        Add Claude account in terminal
      </Button>
      {workspaces ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Choose where to show the sign-in terminal. Claude opens its own login screen; the
            account is saved on this server.
          </p>
          {workspaces.length ? (
            <>
              <Select
                value={selected}
                disabled={busy}
                onValueChange={(value) => {
                  setSelected(value)
                  mutation.current = null
                }}
              >
                <SelectTrigger aria-label="Claude sign-in workspace">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>
                      {workspace.displayName || workspace.path}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" disabled={busy || !selected} onClick={() => void openTerminal()}>
                {busy ? 'Opening…' : 'Open Claude sign-in'}
              </Button>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Open or create a workspace on this server first, then return here to sign in.
            </p>
          )}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
