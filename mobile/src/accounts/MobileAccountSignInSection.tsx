import { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { AccountDeviceSignIn } from '../../../src/shared/account-device-sign-in'
import { runAccountDeviceSignIn } from '../../../src/shared/account-device-sign-in-client'
import { useClipboardWriter } from '../platform/clipboard'
import { openExternalLink } from '../platform/external-link'
import { poolStyles } from './mobile-account-pool-styles'
import { styles } from './mobile-accounts-screen-styles'
import { MobileClaudeSignInSection } from './MobileClaudeSignInSection'
import { mobileAccountDeviceSignInRequest } from './mobile-account-enrollment-operations'

export function MobileAccountSignInSection({
  client,
  connected,
  hostName,
  hostId,
  onComplete
}: {
  client: RpcClient | null
  connected: boolean
  hostName: string
  hostId: string
  onComplete: () => void
}) {
  const controller = useRef<AbortController | null>(null)
  const clipboard = useClipboardWriter()
  const [state, setState] = useState<AccountDeviceSignIn | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(
    () => () => {
      controller.current?.abort()
      controller.current = null
    },
    []
  )
  function cancel() {
    controller.current?.abort()
    setState(null)
  }

  async function start() {
    if (!client || !connected || controller.current) {
      return
    }
    const active = new AbortController()
    controller.current = active
    setBusy(true)
    setState(null)
    setError('')
    setCopied(false)
    try {
      await runAccountDeviceSignIn({
        signal: active.signal,
        request: mobileAccountDeviceSignInRequest(client),
        onState: (next) => {
          if (active.signal.aborted) {
            return
          }
          setState(next)
          if (next.status === 'complete') {
            onComplete()
          }
        }
      })
    } catch (cause) {
      if (!active.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (controller.current === active) {
        controller.current = null
        setBusy(false)
      }
    }
  }

  async function copyCode() {
    if (!state?.userCode) {
      return
    }
    try {
      await clipboard.writeText(state.userCode)
      setCopied(true)
    } catch {
      setError('Could not copy the code. You can enter it manually.')
    }
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>Add an account</Text>
      <View style={[styles.card, poolStyles.content]}>
        <Text style={styles.rowSubtitle}>
          Sign in for {hostName || 'this host'}. The account stays on this host and can be used in
          its pools.
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={busy || !connected}
          accessibilityState={{ disabled: busy || !connected }}
          style={poolStyles.action}
          onPress={() => void start()}
        >
          <Text style={poolStyles.actionText}>
            {busy ? 'Waiting for sign-in…' : 'Add Codex account'}
          </Text>
        </Pressable>
        {state?.status === 'waiting' && state.userCode && state.verificationUrl ? (
          <>
            <Text style={styles.rowTitle} selectable>
              {state.userCode}
            </Text>
            <Pressable
              accessibilityRole="button"
              style={poolStyles.action}
              onPress={() => void copyCode()}
            >
              <Text style={poolStyles.actionText}>{copied ? 'Code copied' : 'Copy code'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={poolStyles.action}
              onPress={() => state.verificationUrl && openExternalLink(state.verificationUrl)}
            >
              <Text style={poolStyles.actionText}>Open sign-in page</Text>
            </Pressable>
          </>
        ) : null}
        {busy ? (
          <Pressable accessibilityRole="button" style={poolStyles.action} onPress={cancel}>
            <Text style={poolStyles.actionText}>Cancel sign-in</Text>
          </Pressable>
        ) : null}
        {state?.status === 'complete' ? (
          <Text accessibilityRole="alert" style={styles.rowSubtitle}>
            Account added. Select it below, then include it in a pool if needed.
          </Text>
        ) : null}
        {error || state?.error ? (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {error || state?.error}
          </Text>
        ) : null}
        <MobileClaudeSignInSection client={client} connected={connected} hostId={hostId} />
      </View>
    </View>
  )
}
