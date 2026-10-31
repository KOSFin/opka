import { defineMethod, type RpcContext } from '../core'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import {
  AccountDeviceSignInParams,
  BeginAccountDeviceSignInParams
} from '../../../../shared/account-device-sign-in'

function deviceOwner({ caller }: Pick<RpcContext, 'caller'>): string {
  if (!caller) {
    throw new Error('Sign-in requires an authenticated caller.')
  }
  return rpcCallerOperationKey(caller)
}

export const ACCOUNT_DEVICE_SIGN_IN_METHODS = [
  defineMethod({
    name: 'accounts.beginDeviceSignIn',
    permission: 'accounts-admin',
    params: BeginAccountDeviceSignInParams,
    handler: (_, context) => context.runtime.beginDeviceSignIn(deviceOwner(context))
  }),
  defineMethod({
    name: 'accounts.deviceSignIn',
    permission: 'accounts-admin',
    params: AccountDeviceSignInParams,
    handler: ({ id }, context) => context.runtime.deviceSignIn(deviceOwner(context), id)
  }),
  defineMethod({
    name: 'accounts.cancelDeviceSignIn',
    permission: 'accounts-admin',
    params: AccountDeviceSignInParams,
    handler: ({ id }, context) => context.runtime.cancelDeviceSignIn(deviceOwner(context), id)
  })
]
