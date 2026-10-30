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
  const opka =
    Platform.OS === 'android' && Constants.expoConfig?.android?.package === 'com.kosfin.opka.mobile'
  const installer = opka
    ? requireOptionalNativeModule<{ install(url: string): Promise<void> }>('OpkaAppUpdate')
    : null
  const action = opka
    ? (installer?.install(url) ??
      Promise.reject(
        new Error('This build has no Android installer. Download the current Opka release.')
      ))
    : Linking.openURL(url)
  void action.catch((error: unknown) => {
    Alert.alert(
      'Update could not be opened',
      error instanceof Error ? error.message : 'Please check your connection and retry.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Retry', onPress: () => openAppUpdate(url) }
      ]
    )
  })
}
