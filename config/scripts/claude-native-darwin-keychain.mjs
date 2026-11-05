import { runProcess } from '@orca/process-host'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { userInfo } from 'node:os'
import { isDarwinNativeProbeCi } from './claude-native-probe-cli.mjs'

/** Called only by the sandboxed fixture with an isolated, fake-only CI keychain. */
export async function prepareDarwinProbeKeychain({ config, tokenA, accountA }) {
  const keychain = process.env.OPKA_DARWIN_KEYCHAIN_PATH
  const productionModule = process.env.OPKA_DARWIN_PRODUCTION_MODULE
  if (
    !isDarwinNativeProbeCi() ||
    !keychain ||
    !productionModule ||
    !isAbsolute(keychain) ||
    !isAbsolute(productionModule)
  ) {
    throw new Error('An isolated Darwin CI keychain is required')
  }
  const { claudeKeychainService, readNativeAccessSnapshot } = await import(
    pathToFileURL(productionModule).href
  )
  const service = claudeKeychainService(config)
  const username = userInfo().username
  const mode = process.env.OPKA_DARWIN_KEYCHAIN_MODE
  if (mode !== 'absent' && mode !== 'present') {
    throw new Error('Unknown fake keychain case')
  }
  const security = async (args) => {
    const result = await runProcess({
      program: '/usr/bin/security',
      args,
      timeoutMs: 3000
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error('Synthetic CI keychain operation failed')
    }
    return result
  }
  if (mode === 'present') {
    const fake = JSON.stringify({
      claudeAiOauth: {
        accessToken: tokenA,
        refreshToken: 'synthetic-keychain-refresh-only',
        expiresAt: Date.now() + 86400000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max'
      }
    })
    await security([
      'add-generic-password',
      '-U',
      '-A',
      '-s',
      service,
      '-a',
      username,
      '-w',
      fake,
      keychain
    ])
  }
  return {
    async observe(finalIdentity) {
      const snapshot = await readNativeAccessSnapshot(config, finalIdentity).catch(() => null)
      return {
        mode,
        sourceAccessReadable: Boolean(snapshot),
        sourcePrefersKeychain: snapshot?.access.accessToken === tokenA,
        sourceReadsFileB: snapshot?.access.accessToken === 'sk-ant-oat01-synthetic-probe-b',
        refreshTokenExposed: Boolean(
          snapshot && JSON.stringify(snapshot).includes('synthetic-keychain-refresh-only')
        ),
        identityMatches: snapshot?.identity.accountUuid === finalIdentity.accountUuid,
        initialIdentityKnown: Boolean(accountA.accountUuid)
      }
    },
    async dispose() {
      if (mode === 'present') {
        await security(['delete-generic-password', '-s', service, '-a', username, keychain])
      }
    }
  }
}
