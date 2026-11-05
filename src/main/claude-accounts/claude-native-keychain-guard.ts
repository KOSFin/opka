import { readActiveClaudeKeychainCredentialsStrict } from './keychain'

export function createClaudeNativeKeychainGuard(args: {
  home: string
  assertExclusive: () => void
  platform?: NodeJS.Platform
  readScopedKeychain?: typeof readActiveClaudeKeychainCredentialsStrict
}): () => Promise<void> {
  let manualKeychainLogin = false
  return async () => {
    if (
      manualKeychainLogin ||
      ((args.platform ?? process.platform) === 'darwin' &&
        (await (args.readScopedKeychain ?? readActiveClaudeKeychainCredentialsStrict)(args.home)))
    ) {
      manualKeychainLogin = true
      throw new Error(
        'Claude native profile has a manual Keychain login; automatic switching is suspended.'
      )
    }
    args.assertExclusive()
  }
}
