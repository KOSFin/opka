import { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import { useRouteHandoff } from '../navigation/route-handoff'
import { PickerModal } from '../components/PickerModal'
import type { AccountSignInWorkspace } from '../../../src/shared/account-sign-in-workspaces'
import {
  accountSignInWorkspacesRead,
  openMobileAccountSignInTerminal
} from './mobile-account-enrollment-operations'
import { poolStyles } from './mobile-account-pool-styles'
import { styles } from './mobile-accounts-screen-styles'

export function MobileClaudeSignInSection({
  client,
  connected,
  hostId
}: {
  client: RpcClient | null
  connected: boolean
  hostId: string
}) {
  const router = useRouteHandoff()
  const mounted = useRef(true)
  const mutation = useRef<{ workspace: string; id: string } | null>(null)
  const [workspaces, setWorkspaces] = useState<AccountSignInWorkspace[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function chooseWorkspace() {
    if (!client || !connected || busy) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const inventory = accountSignInWorkspacesRead.interpret(
        await accountSignInWorkspacesRead.request(client, { limit: 100 })
      )
      if (!mounted.current) {
        return
      }
      setWorkspaces(inventory.worktrees)
      if (!inventory.worktrees.length) {
        setError('Open or create a workspace on this host first, then return here to sign in.')
      } else {
        setPickerOpen(true)
      }
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
  async function openTerminal(workspace: string) {
    if (!client || !connected || busy) {
      return
    }
    setPickerOpen(false)
    setBusy(true)
    setError('')
    const previous = mutation.current
    const clientMutationId =
      previous?.workspace === workspace
        ? previous.id
        : `account-login:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
    mutation.current = { workspace, id: clientMutationId }
    try {
      const { terminal } = await openMobileAccountSignInTerminal(client, {
        provider: 'claude',
        worktree: workspace.startsWith('folder:') ? workspace : `id:${workspace}`,
        clientMutationId
      })
      if (!mounted.current) {
        return
      }
      const query = new URLSearchParams({ paneKey: `${terminal.tabId}:${terminal.leafId}` })
      if (terminal.executionHostId?.startsWith('runtime:')) {
        query.set('executionHost', terminal.executionHostId)
      }
      router.push(
        `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(terminal.worktreeId)}?${query}`
      )
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
    <View>
      <Pressable
        accessibilityRole="button"
        disabled={busy || !connected}
        accessibilityState={{ disabled: busy || !connected }}
        style={poolStyles.action}
        onPress={() => void chooseWorkspace()}
      >
        <Text style={poolStyles.actionText}>
          {busy ? 'Opening sign-in…' : 'Add Claude account in terminal'}
        </Text>
      </Pressable>
      <Text style={styles.rowSubtitle}>
        Claude uses its own terminal login. Choose a workspace for the sign-in tab; the account is
        saved on this host.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error}
        </Text>
      ) : null}
      <PickerModal
        visible={pickerOpen}
        title="Open Claude sign-in in…"
        selected=""
        options={workspaces.map((workspace) => ({
          value: workspace.id,
          label: workspace.displayName || workspace.path
        }))}
        onClose={() => setPickerOpen(false)}
        onSelect={(workspace) => void openTerminal(workspace)}
      />
    </View>
  )
}
