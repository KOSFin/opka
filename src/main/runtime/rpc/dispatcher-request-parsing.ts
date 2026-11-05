import { getCompiledSchema } from '../../zod-schema-compilation'
import {
  formatZodError,
  type RpcAnyMethodDeclaration,
  type RpcEnvelopeMeta,
  type RpcRequest,
  type RpcResponse
} from './core'
import { invalidArgumentResponse } from './dispatcher-error-response'
import { isPrivateNativeCliRpc } from '../../../shared/native-cli-private-rpc'

export function parseRpcRequestParams(
  request: RpcRequest,
  method: RpcAnyMethodDeclaration,
  meta: RpcEnvelopeMeta
): { value: unknown; error?: undefined } | { value?: undefined; error: RpcResponse } {
  if (method.params === null) {
    return { value: undefined }
  }
  const result = getCompiledSchema(method.params).safeParse(request.params ?? {})
  if (!result.success) {
    return {
      error: invalidArgumentResponse(
        request,
        meta,
        isPrivateNativeCliRpc(request.method)
          ? 'Native account control input is unavailable.'
          : formatZodError(result.error)
      )
    }
  }
  return { value: result.data }
}
