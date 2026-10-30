import { useState } from 'react'
import { Pressable, Text, View, StyleSheet } from 'react-native'
import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { RpcClient } from '../transport/rpc-client'
import { useRouteHandoff } from '../navigation/route-handoff'
import { parseOrcaSessionAddress } from '../../../src/shared/orca-session-address'
import { sessionTabActivate } from '../session/mobile-session-write-operations'
import { colors, spacing, typography } from '../theme/mobile-theme'

const terminalRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.terminal',
    method: 'terminal.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'terminals',
      z.object({
        terminals: z.array(
          z.object({
            handle: z.string(),
            worktreeId: z.string(),
            tabId: z.string(),
            leafId: z.string(),
            executionHostId: z.string().optional()
          })
        )
      })
    )
  })
)
const tabsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.session-tabs',
    method: 'session.tabs.listAll',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'tabs',
      z.object({
        snapshots: z.array(
          z.object({
            worktree: z.string(),
            tabs: z.array(
              z.object({ id: z.string(), type: z.string(), sessionId: z.string().optional() })
            )
          })
        )
      })
    )
  })
)
export function ProjectTaskSessionLink({
  client,
  connected,
  hostId,
  terminal
}: {
  client: RpcClient | null
  connected: boolean
  hostId: string
  terminal: string
}) {
  const router = useRouteHandoff()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function open() {
    if (!client || !connected || busy) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const sessionId = parseOrcaSessionAddress(terminal)
      if (sessionId) {
        const inventory = tabsRead.interpret(await tabsRead.request(client))
        const matches = inventory.snapshots.flatMap((snapshot) =>
          snapshot.tabs
            .filter((item) => item.type === 'agent-session' && item.sessionId === sessionId)
            .map((tab) => ({ snapshot, tab }))
        )
        const target = matches.length === 1 ? matches[0] : undefined
        if (!target) {
          throw new Error(
            'This chat cannot be uniquely located in the current host inventory. Its saved reports remain available.'
          )
        }
        const { snapshot, tab } = target
        const activated = sessionTabActivate.interpret(
          await sessionTabActivate.request(client, {
            worktree:
              snapshot.worktree.startsWith('folder:') || snapshot.worktree.startsWith('id:')
                ? snapshot.worktree
                : `id:${snapshot.worktree}`,
            tabId: tab.id,
            navigation: 'caller',
            notifyClients: false
          })
        )
        if (!activated.accepted) {
          throw new Error('The host could not open this chat. Refresh before retrying.')
        }
        const workspaceId = snapshot.worktree.startsWith('id:')
          ? snapshot.worktree.slice(3)
          : snapshot.worktree
        router.push(`/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(workspaceId)}`)
        return
      }
      const result = terminalRead.interpret(await terminalRead.request(client, {}))
      const target = result.terminals.find((item) => item.handle === terminal)
      if (!target) {
        throw new Error(
          'This session is not in the current host inventory. Its saved reports remain available.'
        )
      }
      const query = new URLSearchParams({ paneKey: `${target.tabId}:${target.leafId}` })
      if (target.executionHostId?.startsWith('runtime:')) {
        query.set('executionHost', target.executionHostId)
      }
      router.push(
        `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(target.worktreeId)}?${query}`
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not open session.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        disabled={busy || !connected}
        onPress={() => void open()}
        style={styles.button}
      >
        <Text style={styles.text}>{busy ? 'Finding session…' : 'Open agent session'}</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  )
}
const styles = StyleSheet.create({
  button: { minHeight: 48, justifyContent: 'center', paddingVertical: spacing.sm },
  text: { color: colors.textPrimary, fontSize: typography.bodySize },
  error: { color: colors.statusAmber, fontSize: typography.metaSize }
})
