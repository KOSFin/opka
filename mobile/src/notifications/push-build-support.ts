import Constants from 'expo-constants'
import { Platform } from 'react-native'

export function pushBuildConfigurationIssue(): string | null {
  return Platform.OS === 'android' &&
    Constants.expoConfig?.android?.package === 'com.kosfin.opka.mobile' &&
    Constants.expoConfig.extra?.opkaAndroidPushConfigured === false
    ? 'Remote push is not configured in this Opka build. Reconnecting cannot fix it; install a build with Opka Firebase configuration.'
    : null
}
