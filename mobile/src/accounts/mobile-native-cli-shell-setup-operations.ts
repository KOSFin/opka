import type { RpcClient } from '../transport/rpc-client'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { NativeCliShellSetupSchema } from '../../../src/shared/native-cli-shell-setup'
import type { nativeCliShellSetupActionMethod } from '../../../src/shared/native-cli-shell-setup-action'
const install = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.install-native-cli-setup',
    method: 'accounts.installNativeCliIntegration',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('setup', NativeCliShellSetupSchema)
  })
)
const uninstall = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.remove-native-cli-setup',
    method: 'accounts.uninstallNativeCliIntegration',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('setup', NativeCliShellSetupSchema)
  })
)
export async function requestMobileNativeCliShellSetup(
  client: RpcClient,
  method: ReturnType<typeof nativeCliShellSetupActionMethod>
) {
  return method === 'accounts.installNativeCliIntegration'
    ? install.interpret(await install.request(client))
    : uninstall.interpret(await uninstall.request(client))
}
