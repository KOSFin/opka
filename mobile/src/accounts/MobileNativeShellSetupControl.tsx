import { useEffect, useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import {
  nativeCliShellSetupInstalled,
  type NativeCliShellSetup
} from '../../../src/shared/native-cli-shell-setup'
import {
  runNativeCliShellSetupAction,
  createNativeCliShellSetupActionOwner,
  type NativeCliShellSetupAction
} from '../../../src/shared/native-cli-shell-setup-action'
import { requestMobileNativeCliShellSetup } from './mobile-native-cli-shell-setup-operations'
import { poolStyles } from './mobile-account-pool-styles'
import { styles } from './mobile-accounts-screen-styles'

export function MobileNativeShellSetupControl({
  setup,
  client,
  connected,
  hostName,
  onComplete
}: {
  setup: NativeCliShellSetup
  client: RpcClient | null
  connected: boolean
  hostName: string
  onComplete: () => void
}) {
  const generation = client?.getGeneration?.() ?? 0
  const owner = useMemo(
    () => ({ client, generation, ...createNativeCliShellSetupActionOwner() }),
    [client, generation]
  )
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
  const shown = current?.setup ?? setup,
    busy = current?.busy === true
  async function act(action: NativeCliShellSetupAction) {
    if (!client || !connected || owner.busy || !owner.active) {
      return
    }
    owner.busy = true
    const controller = new AbortController()
    owner.controller = controller
    setView({
      owner,
      base: setup,
      busy: true,
      notice:
        action === 'install'
          ? `Setting up CLI on ${hostName}…`
          : `Removing CLI setup from ${hostName}…`
    })
    try {
      const result = await runNativeCliShellSetupAction({
        action,
        signal: controller.signal,
        request: (method) => requestMobileNativeCliShellSetup(client, method)
      })
      if (result) {
        setView({
          owner,
          base: setup,
          setup: result,
          busy: false,
          notice:
            action === 'uninstall' && result.state === 'not-installed'
              ? `CLI setup removed from ${hostName}.`
              : nativeCliShellSetupInstalled(result)
                ? `CLI setup is ready on ${hostName}. Open a new terminal.`
                : `CLI setup needs review on ${hostName}. User changes are preserved.`
        })
      }
    } catch {
      if (!controller.signal.aborted && owner.active) {
        setView({
          owner,
          base: setup,
          busy: false,
          notice: `CLI setup on ${hostName} could not be confirmed. Existing user changes are preserved; refresh its status.`
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
  const supported = shown.supported && shown.state !== 'unsupported',
    installed = shown.state === 'installed'
  const canInstall = supported && shown.state === 'not-installed' && shown.missing.length === 0
  const action = canInstall ? 'install' : installed && supported ? 'uninstall' : null
  return (
    <View style={poolStyles.memberSettings}>
      <Text accessibilityLiveRegion="polite" style={styles.rowSubtitle}>
        {current?.notice ??
          (nativeCliShellSetupInstalled(shown)
            ? `Ordinary CLI commands are ready on ${hostName}.`
            : !supported
              ? `Ordinary CLI setup is unavailable on ${hostName}.`
              : shown.missing.length
                ? `Install the missing commands on ${hostName}: ${shown.missing.map((name) => (name === 'orca' ? 'Opka CLI' : name)).join(', ')}.`
                : shown.state === 'not-installed'
                  ? `Set up ordinary Claude and Codex commands on ${hostName}. This updates only this host user’s shell integration.`
                  : `Shell setup on ${hostName} needs review. Existing user changes are preserved.`)}
      </Text>
      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || !connected || !client }}
          disabled={busy || !connected || !client}
          style={poolStyles.action}
          onPress={() => void act(action)}
        >
          <Text style={poolStyles.actionText}>
            {busy
              ? action === 'install'
                ? 'Setting up…'
                : 'Removing…'
              : action === 'install'
                ? 'Set up ordinary CLI'
                : 'Remove CLI setup'}
          </Text>
        </Pressable>
      ) : null}
      {!canInstall && !installed && supported ? (
        <Pressable
          accessibilityRole="button"
          disabled={busy || !connected || !client}
          style={poolStyles.action}
          onPress={onComplete}
        >
          <Text style={poolStyles.actionText}>Refresh setup status</Text>
        </Pressable>
      ) : null}
      {supported && (shown.state === 'modified' || shown.state === 'unverifiable') ? (
        <Text selectable style={styles.rowSubtitle}>
          "$ORCA_CLI_COMMAND" agent native-shell status
        </Text>
      ) : null}
    </View>
  )
}
