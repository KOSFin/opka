/** These local control requests may contain capabilities, native argv, stdin or authorization codes. */
const PRIVATE_NATIVE_CLI_METHODS = new Set([
  'accounts.submitNativeClaudeRefreshSignInCode',
  'accounts.nativeClaudeHook',
  'accounts.nativeClaudeCoverage',
  'accounts.prepareNativeCliLaunch',
  'accounts.createNativeCliTerminal',
  'accounts.attachNativeCliTerminal',
  'accounts.writeNativeCliTerminal',
  'accounts.resizeNativeCliTerminal',
  'accounts.stopNativeCliTerminal',
  'accounts.startNativeCliStdio',
  'accounts.attachNativeCliStdio',
  'accounts.controlNativeCliStdio'
])

export function isPrivateNativeCliRpc(method: string): boolean {
  return PRIVATE_NATIVE_CLI_METHODS.has(method)
}
