import { Buffer } from 'node:buffer'
import { runProcess } from '@orca/process-host'
import { realpath } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { isAbsolute } from 'node:path'
import { isDarwinNativeProbeCi } from './claude-native-probe-cli.mjs'
import {
  securityDiagnosticElapsedBucket,
  securityDiagnosticSignal
} from './claude-native-darwin-security-shim-runner.mjs'

const SERVICE = 'opka-native-security-write-preflight'
const PLACEHOLDER = 'opka-noncredential-write-check'
const ACCOUNT = 'runner'
function unverified() {
  const error = new Error('Synthetic Security control cleanup is unverifiable')
  error.nativeCleanupUnverifiable = true
  return error
}
function summary(result) {
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

/** Pure orchestration seam; only the guarded wrapper below executes OS Security. */
export async function runFixedSecurityWriteControls({ keychain, invoke, onObservation }) {
  if (!isAbsolute(keychain) || keychain.length > 1024 || /["\\\0\r\n]/.test(keychain)) {
    throw new Error('Synthetic keychain path is not supported')
  }
  const run = async (...args) => {
    try {
      return await invoke(...args)
    } catch {
      throw unverified()
    }
  }
  const find = ['find-generic-password', '-a', ACCOUNT, '-w', '-s', SERVICE, keychain]
  const cleanup = ['delete-generic-password', '-a', ACCOUNT, '-s', SERVICE, keychain]
  for (const sandboxed of [false, true]) {
    for (const explicit of [false, true]) {
      const absent = await run(false, find)
      if (absent.code !== 44 || absent.timedOut || !absent.terminationObserved) {
        throw unverified()
      }
      const input = `add-generic-password -U -a "${ACCOUNT}" -s "${SERVICE}" -X "${Buffer.from(PLACEHOLDER).toString('hex')}"${explicit ? ` "${keychain}"` : ''}\n`
      const written = await run(sandboxed, ['-i'], input)
      if (!written.terminationObserved) {
        onObservation({ sandboxed, explicit, write: summary(written), cleanupVerified: false })
        throw unverified()
      }
      let matched = false
      let readTerminated = false
      let cleanupVerified = false
      try {
        const found = await run(false, find)
        readTerminated = found.terminationObserved
        matched = found.code === 0 && !found.timedOut && found.stdout.trim() === PLACEHOLDER
      } finally {
        try {
          const removed = await run(false, cleanup)
          if (removed.terminationObserved && !removed.timedOut && [0, 44].includes(removed.code)) {
            const after = await run(false, find)
            cleanupVerified = after.terminationObserved && !after.timedOut && after.code === 44
          }
        } finally {
          onObservation({
            sandboxed,
            explicit,
            write: summary(written),
            readMatched: matched,
            readTerminationObserved: readTerminated,
            cleanupVerified
          })
        }
      }
      if (!cleanupVerified || !readTerminated) {
        throw unverified()
      }
    }
  }
}

export async function probeDarwinSecurityWrites({
  sandbox,
  keychain,
  env,
  onObservation,
  onDefaultVerified,
  onDefaultObservation
}) {
  if (!isDarwinNativeProbeCi()) {
    throw new Error('Security write controls require isolated Darwin CI')
  }
  const invoke = async (sandboxed, args, input) => {
    let terminationObserved = false
    const startedAt = performance.now()
    const result = await runProcess({
      program: sandboxed ? '/usr/bin/sandbox-exec' : '/usr/bin/security',
      args: sandboxed ? ['-f', sandbox, '/usr/bin/security', ...args] : args,
      env,
      input,
      timeoutMs: 2000,
      maxOutputBytes: 1024,
      terminationBarrier: true,
      onChildTerminated: () => {
        terminationObserved = true
      }
    }).catch(() => {
      throw unverified()
    })
    return {
      ...result,
      durationMs: performance.now() - startedAt,
      terminationObserved
    }
  }
  let defaultKeychain
  try {
    defaultKeychain = await invoke(false, ['default-keychain', '-d', 'user'])
  } catch {
    onDefaultObservation?.({ invokeRejected: true })
    throw unverified()
  }
  let pathJSONKnown = false
  let canonicalExists = false
  let ownedMatch = false
  try {
    const path = JSON.parse(defaultKeychain.stdout.trim())
    pathJSONKnown = typeof path === 'string' && isAbsolute(path)
    if (pathJSONKnown) {
      const actual = await realpath(path)
      const expected = await realpath(keychain)
      canonicalExists = true
      ownedMatch = actual === expected
    }
  } catch {}
  onDefaultObservation?.({
    invokeRejected: false,
    control: summary(defaultKeychain),
    outputTruncated: defaultKeychain.outputTruncated === true,
    pathJSONKnown,
    canonicalExists,
    ownedMatch
  })
  if (
    defaultKeychain.code !== 0 ||
    defaultKeychain.timedOut ||
    !defaultKeychain.terminationObserved ||
    defaultKeychain.outputTruncated ||
    !pathJSONKnown ||
    !canonicalExists ||
    !ownedMatch
  ) {
    throw unverified()
  }
  onDefaultVerified?.()
  await runFixedSecurityWriteControls({ keychain, invoke, onObservation })
}
