import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { NativeClaudeRefreshSourceStatus } from '../../../src/shared/native-claude-refresh-source'
import {
  runNativeClaudeSignIn,
  submitNativeClaudeSignInCode,
  type NativeClaudeSignInView
} from '../../../src/shared/native-claude-sign-in-client'
import { mobileNativeClaudeSignInRequest } from './mobile-native-claude-sign-in-operations'
import { useMobileSignInActivity } from './use-mobile-sign-in-activity'
import { useClipboardWriter } from '../platform/clipboard'
import { openExternalLink } from '../platform/external-link'
import { poolStyles } from './mobile-account-pool-styles'
import { styles } from './mobile-accounts-screen-styles'

export function MobileNativeClaudeConnection({
  client,
  connected,
  accountId,
  status,
  shellSetupInstalled,
  onComplete
}: {
  client: RpcClient | null
  connected: boolean
  accountId: string
  status: NativeClaudeRefreshSourceStatus['state']
  shellSetupInstalled?: boolean
  onComplete: () => void
}) {
  const generation = client?.getGeneration?.() ?? 0
  const owner = useMemo(() => ({ client, generation, accountId }), [client, generation, accountId])
  const currentOwner = useRef(owner)
  currentOwner.current = owner
  const controller = useRef<AbortController | null>(null)
  const [view, setView] = useState<{ owner: typeof owner; state: NativeClaudeSignInView } | null>(
    null
  )
  const [busy, setBusy] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [renderOwner, setRenderOwner] = useState(owner)
  const ownBusy = renderOwner === owner && busy
  const shownError = renderOwner === owner ? error : ''
  const clipboard = useClipboardWriter()
  const waitUntilActive = useMobileSignInActivity(connected)
  const state = view?.owner === owner ? view.state : null
  useEffect(() => {
    setRenderOwner(owner)
    setView(null)
    setCode('')
    setError('')
    setBusy(false)
    setSubmitting(false)
    return () => {
      controller.current?.abort()
      controller.current = null
    }
  }, [owner])
  async function start() {
    if (!client || !connected || controller.current) {
      return
    }
    const active = new AbortController()
    controller.current = active
    setBusy(true)
    setError('')
    setCode('')
    setView(null)
    try {
      await runNativeClaudeSignIn({
        request: mobileNativeClaudeSignInRequest(client),
        accountId,
        signal: active.signal,
        waitUntilActive,
        onState: (next) => {
          if (active.signal.aborted || currentOwner.current !== owner) {
            return
          }
          setView({ owner, state: next })
          if (next.state === 'ready') {
            onComplete()
          } else if (next.state !== 'signing-in') {
            setError('Claude CLI connection was not completed. Start a new sign-in.')
          }
        }
      })
    } catch {
      if (!active.signal.aborted && currentOwner.current === owner) {
        setError('Claude CLI connection could not be completed. Try again.')
      }
    } finally {
      if (controller.current === active) {
        controller.current = null
        setBusy(false)
      }
    }
  }
  function cancel() {
    controller.current?.abort()
    setView(null)
    setCode('')
    setError('')
  }
  async function submit() {
    const submitted = code
    setCode('')
    const active = controller.current
    if (
      !client ||
      !state ||
      !active ||
      active.signal.aborted ||
      !connected ||
      submitting ||
      !submitted.trim()
    ) {
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await submitNativeClaudeSignInCode(
        mobileNativeClaudeSignInRequest(client),
        state.reference,
        submitted
      )
    } catch {
      if (
        currentOwner.current === owner &&
        controller.current === active &&
        !active.signal.aborted
      ) {
        setError('Could not confirm the code. Wait for sign-in status or start again.')
      }
    } finally {
      if (currentOwner.current === owner && controller.current === active) {
        setSubmitting(false)
      }
    }
  }
  async function copyLink() {
    if (!state?.link) {
      return
    }
    try {
      await clipboard.writeText(state.link)
    } catch {
      if (currentOwner.current === owner) {
        setError('Could not copy the link. Open the sign-in page instead.')
      }
    }
  }
  if (status === 'ready' && !state) {
    return (
      <Text style={styles.rowSubtitle}>
        {shellSetupInstalled === false ? 'Account connected' : 'CLI switching ready'}
      </Text>
    )
  }
  if (status === 'unsupported' || status === 'unverifiable') {
    return (
      <Text style={styles.rowSubtitle}>
        Claude CLI connection is unavailable on this host. Check its update and connection.
      </Text>
    )
  }
  return (
    <View style={poolStyles.memberSettings}>
      <Pressable
        accessibilityRole="button"
        style={poolStyles.action}
        disabled={!connected || ownBusy}
        accessibilityState={{ disabled: !connected || ownBusy }}
        onPress={() => void start()}
      >
        <Text style={poolStyles.actionText}>
          {ownBusy ? 'Waiting for Claude sign-in…' : 'Connect for CLI switching'}
        </Text>
      </Pressable>
      {ownBusy && state?.link ? (
        <>
          <Text style={styles.rowSubtitle}>
            Sign in with this same Claude account, then paste the returned code.
          </Text>
          <Pressable
            accessibilityRole="button"
            style={poolStyles.action}
            disabled={!connected}
            onPress={() => state.link && openExternalLink(state.link)}
          >
            <Text style={poolStyles.actionText}>Open sign-in page</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={poolStyles.action}
            disabled={!connected}
            onPress={() => void copyLink()}
          >
            <Text style={poolStyles.actionText}>Copy sign-in link</Text>
          </Pressable>
        </>
      ) : null}
      {ownBusy && state?.requiresCode ? (
        <>
          <TextInput
            accessibilityLabel="Claude sign-in code"
            placeholder="Paste sign-in code"
            style={poolStyles.input}
            value={code}
            onChangeText={setCode}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={connected && !submitting}
          />
          <Pressable
            accessibilityRole="button"
            style={poolStyles.action}
            disabled={!connected || submitting || !code.trim()}
            onPress={() => void submit()}
          >
            <Text style={poolStyles.actionText}>
              {submitting ? 'Confirming code…' : 'Confirm sign-in code'}
            </Text>
          </Pressable>
        </>
      ) : null}
      {ownBusy ? (
        <Pressable accessibilityRole="button" style={poolStyles.action} onPress={cancel}>
          <Text style={poolStyles.actionText}>Cancel sign-in</Text>
        </Pressable>
      ) : null}
      {state?.state === 'ready' ? (
        <Text accessibilityRole="alert" style={styles.rowSubtitle}>
          Account connected on this host.
        </Text>
      ) : null}
      {shownError ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error}
        </Text>
      ) : null}
    </View>
  )
}
