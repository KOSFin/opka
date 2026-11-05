import { Buffer } from 'node:buffer'
import { runProcess } from '@orca/process-host'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { isDarwinNativeProbeCi } from './claude-native-probe-cli.mjs'
import {
  securityDiagnosticElapsedBucket,
  securityDiagnosticSignal
} from './claude-native-darwin-security-shim-runner.mjs'

export function summarizeDarwinSecurityControl(result) {
  return {
    code:
      Number.isInteger(result.code) && result.code >= 0 && result.code <= 255 ? result.code : null,
    signal: securityDiagnosticSignal(result.signal),
    elapsed:
      Number.isFinite(result.durationMs) && result.durationMs >= 0
        ? securityDiagnosticElapsedBucket(result.durationMs)
        : 'pending',
    timedOut: result.timedOut === true,
    terminationObserved: result.terminationObserved === true
  }
}
const clean = (value) =>
  value.terminationObserved === true &&
  !value.timedOut &&
  !value.outputTruncated &&
  !value.signal &&
  typeof value.stdout === 'string'
const pathKnown = (value) =>
  typeof value === 'string' && isAbsolute(value) && value.length <= 1024 && !/[\0\r\n]/.test(value)

export async function inspectSecurityWriteDefault(result, keychain, canonicalize = realpath) {
  let pathJSONKnown = false,
    canonicalExists = false,
    ownedMatch = false
  try {
    if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 16384) {
      throw new Error('bound')
    }
    const path = JSON.parse(result.stdout.trim())
    pathJSONKnown = pathKnown(path)
    if (pathJSONKnown) {
      const actual = await canonicalize(path),
        expected = await canonicalize(keychain)
      canonicalExists = true
      ownedMatch = actual === expected
    }
  } catch {}
  return {
    invokeRejected: false,
    control: summarizeDarwinSecurityControl(result),
    outputTruncated: result.outputTruncated === true,
    pathJSONKnown,
    canonicalExists,
    ownedMatch
  }
}

/** Only known empty or canonical fake-only search domains permit native fixture access. */
export async function inspectDarwinRefreshKeychainDomain({
  defaultResult,
  searchResult,
  keychain,
  canonicalize = realpath
}) {
  const control = await inspectSecurityWriteDefault(defaultResult, keychain, canonicalize)
  let searchParsed = false,
    searchCount = null,
    allOwned = false
  if (
    clean(searchResult) &&
    searchResult.code === 0 &&
    Buffer.byteLength(searchResult.stdout) <= 16384
  ) {
    try {
      const lines = searchResult.stdout.trim() ? searchResult.stdout.trim().split(/\r?\n/) : []
      if (lines.length > 32) {
        throw new Error('bound')
      }
      const expected = await canonicalize(keychain)
      if (!pathKnown(expected)) {
        throw new Error('unknown')
      }
      const paths = lines.map((line) => JSON.parse(line.trim()))
      if (!paths.every(pathKnown)) {
        throw new Error('unknown')
      }
      searchCount = paths.length
      searchParsed = true
      allOwned = true
      for (const path of paths) {
        if ((await canonicalize(path)) !== expected) {
          allOwned = false
        }
      }
    } catch {
      searchParsed = false
      allOwned = false
    }
  }
  let mode = 'unverifiable'
  if (clean(defaultResult) && searchParsed && allOwned) {
    if (defaultResult.code === 0 && control.ownedMatch) {
      mode = 'owned-default'
    } else if (
      defaultResult.code === 1 &&
      defaultResult.stdout.trim() === '' &&
      searchCount === 0
    ) {
      mode = 'isolated-no-keychain'
    }
  }
  return {
    mode,
    default: control,
    search: {
      control: summarizeDarwinSecurityControl(searchResult),
      outputTruncated: searchResult.outputTruncated === true,
      parsed: searchParsed,
      count: searchCount,
      allOwned,
      verifiedEmpty: searchParsed && searchCount === 0 && allOwned
    }
  }
}

export async function probeDarwinRefreshKeychainDomain({ sandbox, keychain, env, onObservation }) {
  if (!isDarwinNativeProbeCi()) {
    throw new Error('Keychain domain proof requires isolated Darwin CI')
  }
  const observations = []
  for (const sandboxed of [false, true]) {
    const query = async (args) => {
      let terminationObserved = false
      const start = performance.now()
      const result = await runProcess({
        program: sandboxed ? '/usr/bin/sandbox-exec' : '/usr/bin/security',
        args: sandboxed ? ['-f', sandbox, '/usr/bin/security', ...args] : args,
        env,
        timeoutMs: 2000,
        maxOutputBytes: 16384,
        terminationBarrier: true,
        onChildTerminated: () => {
          terminationObserved = true
        }
      })
      return { ...result, durationMs: performance.now() - start, terminationObserved }
    }
    let classified
    try {
      classified = await inspectDarwinRefreshKeychainDomain({
        defaultResult: await query(['default-keychain', '-d', 'user']),
        searchResult: await query(['list-keychains', '-d', 'user']),
        keychain
      })
    } catch {
      const error = new Error('Synthetic Keychain domain helper ownership is unverifiable')
      error.nativeCleanupUnverifiable = true
      throw error
    }
    const observation = { sandboxed, ...classified }
    observations.push(observation)
    onObservation?.(observation)
    if (classified.mode === 'unverifiable') {
      const error = new Error('Synthetic Keychain domain is unverified')
      error.nativeCleanupUnverifiable = true
      throw error
    }
  }
  if (observations[0].mode !== observations[1].mode) {
    throw new Error('Synthetic Keychain domains disagree across the network fence')
  }
  return { mode: observations[0].mode, observations }
}
