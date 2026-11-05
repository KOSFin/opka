import { userInfo } from 'node:os'
import { runDarwinRefreshSecurityCommand } from './claude-native-darwin-refresh-security-command.mjs'
/** Final cleanup failures must never hide the qualification's original failing guard. */
export async function finishDarwinRefreshCleanup({ primaryError, close, record }) {
  let failed = false
  try {
    await close()
  } catch {
    failed = true
  }
  try {
    await record({ failed })
  } catch {
    failed = true
  }
  if (failed) {
    if (primaryError) {
      primaryError.nativeCleanupUnverifiable = true
      return
    }
    const error = new Error('Synthetic refresh final cleanup is unverified')
    error.nativeCleanupUnverifiable = true
    throw error
  }
}

export function summarizeDarwinRefreshSecurityCommand({ result, terminationObserved }) {
  return {
    code:
      Number.isInteger(result.code) && result.code >= 0 && result.code <= 255 ? result.code : null,
    signal:
      typeof result.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(result.signal)
        ? result.signal
        : null,
    timedOut: result.timedOut === true,
    outputTruncated: result.outputTruncated === true,
    terminationObserved: terminationObserved === true
  }
}

export async function mutateDarwinRefreshKeychainSource(
  { kind, service, keychain, credentials, onObservation },
  run = runDarwinRefreshSecurityCommand
) {
  if (!['seed', 'delete'].includes(kind)) {
    throw new Error('Unknown synthetic Keychain source mutation')
  }
  const args = kind === 'seed' ? ['add-generic-password', '-U', '-A'] : ['delete-generic-password']
  args.push('-s', service, '-a', userInfo().username)
  if (kind === 'seed') {
    args.push('-w', credentials)
  }
  args.push(keychain)
  const value = await run(args)
  const observation = summarizeDarwinRefreshSecurityCommand(value)
  onObservation?.(observation)
  if (
    observation.code !== 0 ||
    observation.timedOut ||
    observation.outputTruncated ||
    !observation.terminationObserved
  ) {
    throw new Error('Synthetic Keychain source mutation is unverified')
  }
}
