import {
  appUpdateInstallBusy,
  getAppUpdateInstallSnapshot,
  publishAppUpdateInstall
} from './app-update-install-state'
import Constants from 'expo-constants'
import { requireOptionalNativeModule } from 'expo-modules-core'
import { opkaReleaseUpdateSource } from './opka-release-update-source'
import * as Linking from 'expo-linking'
import { useSyncExternalStore } from 'react'
import { AppState, Platform, Alert } from 'react-native'
import {
  loadAppUpdatePreferences,
  saveAppUpdateCheck,
  saveDismissedAppUpdateVersion
} from '../storage/app-update-preferences'
import { appStoreUpdateSource } from './app-store-update-source'
import { createAppUpdateChecker, type AppUpdateState } from './app-update-checker'
import type { AppUpdateSource } from './app-update-source'
import { githubReleaseUpdateSource } from './github-release-update-source'

/**
 * Invariant: this app does not use expo-updates, so `expoConfig` is the manifest embedded in the
 * binary and its version is the binary's (app.json `version`, Android `versionName`). SDK 55
 * removed `Constants.nativeAppVersion`; adopting expo-updates would make this the update's version.
 */
export const installedAppVersion: string | null = Constants.expoConfig?.version ?? null

/** The channel that installed this binary. */
function resolveAppUpdateSource(): AppUpdateSource | null {
  if (
    Platform.OS === 'android' &&
    Constants.expoConfig?.android?.package === 'com.kosfin.opka.mobile'
  ) {
    return opkaReleaseUpdateSource
  }
  if (Platform.OS === 'android') {
    return githubReleaseUpdateSource
  }
  if (Platform.OS === 'ios') {
    return appStoreUpdateSource
  }
  return null
}

export const appUpdateChecker = createAppUpdateChecker({
  source: resolveAppUpdateSource(),
  installedVersion: installedAppVersion,
  now: () => Date.now(),
  setTimer: (run, delayMs) => setTimeout(run, delayMs),
  clearTimer: (handle) => clearTimeout(handle),
  subscribeForeground: (onForeground) => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        onForeground()
      }
    })
    return () => subscription.remove()
  },
  loadPreferences: loadAppUpdatePreferences,
  saveCheck: saveAppUpdateCheck,
  saveDismissedVersion: saveDismissedAppUpdateVersion
})

export function useAppUpdateState(): AppUpdateState {
  return useSyncExternalStore(appUpdateChecker.subscribe, appUpdateChecker.getSnapshot)
}

/** Opens the channel's page for the update: the GitHub release (Android) or App Store (iOS). */
export function openAppUpdate(url: string): void {
  if (appUpdateInstallBusy()) {
    return
  }
  publishAppUpdateInstall('preparing', 'Preparing update…')
  void installAppUpdate(url)
}

type NativeInstaller = {
  install(url: string): Promise<void>
  installTracked?(url: string, operationId: string): Promise<void>
  cancel?(operationId: string): Promise<boolean>
  addListener?(
    name: string,
    listener: (event: { phase?: string; downloadedBytes?: number; totalBytes?: number }) => void
  ): { remove(): void }
}

type ActiveInstall = {
  cancel: () => Promise<boolean>
  cancelPromise: Promise<boolean> | null
  settled: boolean
}

let activeInstall: ActiveInstall | null = null
let installSequence = 0

export function cancelAppUpdate(): void {
  const operation = activeInstall
  const previous = getAppUpdateInstallSnapshot()
  if (!operation || !previous.canCancel) {
    return
  }
  publishAppUpdateInstall('cancelling', 'Cancelling update…')
  operation.cancelPromise = Promise.resolve()
    .then(() => operation.cancel())
    .catch(() => false)
    .then((cancelled) => {
      if (!cancelled && !operation.settled && activeInstall === operation) {
        publishAppUpdateInstall(previous.phase, previous.label, previous.canCancel)
      }
      return cancelled
    })
}

async function installAppUpdate(url: string): Promise<void> {
  let progress: { remove(): void } | undefined
  let operation: ActiveInstall | null = null
  try {
    const opka =
      Platform.OS === 'android' &&
      Constants.expoConfig?.android?.package === 'com.kosfin.opka.mobile'
    if (!opka) {
      await Linking.openURL(url)
      publishAppUpdateInstall('idle', null)
      return
    }
    const installer = requireOptionalNativeModule<NativeInstaller>('OpkaAppUpdate')
    if (!installer) {
      throw new Error('This build has no Android installer. Download the current Opka release.')
    }
    const trackedInstall = installer.installTracked
    const cancelTracked = installer.cancel
    const canCancel = typeof trackedInstall === 'function' && typeof cancelTracked === 'function'
    const operationId = `${Date.now()}-${++installSequence}-${Math.random()}`
    const currentOperation: ActiveInstall = {
      cancel: () =>
        trackedInstall && cancelTracked ? cancelTracked(operationId) : Promise.resolve(false),
      cancelPromise: null,
      settled: false
    }
    operation = currentOperation
    activeInstall = currentOperation
    progress = installer.addListener?.('onInstallProgress', (event) => {
      if (activeInstall !== currentOperation || currentOperation.cancelPromise) {
        return
      }
      if (event.phase === 'downloading') {
        const total = event.totalBytes ?? 0
        const downloaded = event.downloadedBytes ?? 0
        const percent = total > 0 ? Math.min(100, Math.floor((downloaded * 100) / total)) : null
        const label = percent === null ? 'Downloading update…' : `Downloading update… ${percent}%`
        publishAppUpdateInstall(
          'downloading',
          canCancel ? label : `${label} Cancel is unavailable in this build.`,
          canCancel
        )
      } else if (event.phase === 'verifying') {
        publishAppUpdateInstall('verifying', 'Verifying update…', canCancel)
      }
    })
    await (trackedInstall && cancelTracked
      ? trackedInstall(url, operationId)
      : installer.install(url))
    const cancelled = currentOperation.cancelPromise ? await currentOperation.cancelPromise : false
    currentOperation.settled = true
    publishAppUpdateInstall(
      cancelled ? 'cancelled' : 'installer',
      cancelled ? 'Download cancelled' : 'Confirm installation in Android'
    )
  } catch (error: unknown) {
    const cancelled = operation?.cancelPromise ? await operation.cancelPromise : false
    if (operation) {
      operation.settled = true
    }
    const message =
      error instanceof Error ? error.message : 'Please check your connection and retry.'
    if (cancelled && message.includes('Update download cancelled.')) {
      publishAppUpdateInstall('cancelled', 'Download cancelled')
      return
    }
    publishAppUpdateInstall('failed', 'Update failed — tap to retry')
    Alert.alert('Update could not be opened', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Retry', onPress: () => openAppUpdate(url) }
    ])
  } finally {
    if (activeInstall === operation) {
      activeInstall = null
    }
    progress?.remove()
  }
}
