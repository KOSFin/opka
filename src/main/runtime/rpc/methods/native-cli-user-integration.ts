import { projectNativeCliShellSetup } from '../../native-cli-shell-setup'
import { defineMethod, type RpcContext } from '../core'
import { assertNativeCliLocalCaller } from './native-cli-accounts'
import { getRuntimeNativeCliUserIntegration } from '../../configure-native-cli-user-integration'

function service(context: RpcContext) {
  const integration = getRuntimeNativeCliUserIntegration(context.runtime)
  if (!integration) {
    throw new Error(
      'Native command setup is unavailable on this host. Update and restart its runtime.'
    )
  }
  return integration
}
async function changeSetup(context: RpcContext, action: 'install' | 'uninstall') {
  const integration = service(context)
  try {
    return projectNativeCliShellSetup(await integration[action](context.signal))
  } catch {
    throw new Error(
      'Native CLI setup needs review on this host. Existing user changes were preserved; inspect local CLI setup status for details.'
    )
  }
}
export const NATIVE_CLI_USER_INTEGRATION_METHODS = [
  defineMethod({
    name: 'accounts.nativeCliIntegrationStatus',
    permission: 'accounts-admin',
    params: null,
    handler: async (_params, context) => {
      assertNativeCliLocalCaller(context)
      return service(context).status()
    }
  }),
  defineMethod({
    name: 'accounts.installNativeCliIntegration',
    permission: 'accounts-admin',
    params: null,
    handler: async (_params, context) => changeSetup(context, 'install')
  }),
  defineMethod({
    name: 'accounts.uninstallNativeCliIntegration',
    permission: 'accounts-admin',
    params: null,
    handler: async (_params, context) => changeSetup(context, 'uninstall')
  })
]
