import { isDarwinNativeProbeCi } from './claude-native-probe-cli.mjs'
import { probeDarwinRefreshKeychainDomain } from './claude-native-darwin-keychain-domain.mjs'
import { probeDarwinRefreshSecurity } from './claude-native-darwin-security-probe.mjs'
import { probeDarwinSecurityWrites } from './claude-native-darwin-security-write-probe.mjs'

/** Pure ordering seam: no implicit lookup or write precedes a known fake-only namespace. */
export async function runDarwinRefreshPreflight(options, probes) {
  const domain = await probes.domain({ ...options, onObservation: options.onDefaultObservation })
  if (!['owned-default', 'isolated-no-keychain'].includes(domain.mode)) {
    throw new Error('Synthetic Keychain namespace is unverified')
  }
  const lookups = await probes.lookups(options)
  if (
    lookups.length !== 4 ||
    lookups.some((value) => value.code !== 44 || value.timedOut || value.outputTruncated)
  ) {
    throw new Error('Synthetic OS Security absence proof failed')
  }
  const writes = []
  const writtenDomain = await probes.writes({
    ...options,
    onObservation: (value) => writes.push(value)
  })
  if (
    writtenDomain.mode !== domain.mode ||
    writes.length !== (domain.mode === 'owned-default' ? 4 : 2) ||
    writes.some(
      (value) =>
        value.write.code !== 0 ||
        value.write.timedOut ||
        !value.readMatched ||
        !value.cleanupVerified ||
        !value.readTerminationObserved ||
        !value.write.terminationObserved
    ) ||
    (domain.mode === 'isolated-no-keychain' && writes.some((value) => !value.explicit))
  ) {
    const error = new Error('Synthetic Security write control or namespace changed')
    if (
      writtenDomain.mode !== domain.mode ||
      writes.some(
        (value) =>
          !value.cleanupVerified ||
          !value.readTerminationObserved ||
          !value.write.terminationObserved
      )
    ) {
      error.nativeCleanupUnverifiable = true
    }
    throw error
  }
  return { domain, lookups, writes, ownedDefault: domain.mode === 'owned-default' }
}
export async function probeDarwinRefreshPreflight(options) {
  if (!isDarwinNativeProbeCi()) {
    throw new Error('Security preflight requires isolated Darwin CI')
  }
  return runDarwinRefreshPreflight(options, {
    domain: probeDarwinRefreshKeychainDomain,
    lookups: probeDarwinRefreshSecurity,
    writes: probeDarwinSecurityWrites
  })
}
