import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ configured: undefined as boolean | undefined, os: 'android' }))
vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      android: { package: 'com.kosfin.opka.mobile' },
      extra: {
        get opkaAndroidPushConfigured() {
          return state.configured
        }
      }
    }
  }
}))
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return state.os
    }
  }
}))
import { pushBuildConfigurationIssue } from './push-build-support'
beforeEach(() => {
  state.configured = undefined
  state.os = 'android'
})
it('explains explicitly unconfigured Android builds', () => {
  state.configured = false
  expect(pushBuildConfigurationIssue()).toContain('Reconnecting cannot fix it')
})
it('does not invent failure for older manifests or configured builds', () => {
  expect(pushBuildConfigurationIssue()).toBeNull()
  state.configured = true
  expect(pushBuildConfigurationIssue()).toBeNull()
})
it('does not apply the Android requirement to iOS', () => {
  state.configured = false
  state.os = 'ios'
  expect(pushBuildConfigurationIssue()).toBeNull()
})
