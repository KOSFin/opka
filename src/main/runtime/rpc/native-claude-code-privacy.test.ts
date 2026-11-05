import { expect, it } from 'vitest'
import { defineMethod } from './core'
import { parseRpcRequestParams } from './dispatcher-request-parsing'
import { mapDispatcherError } from './dispatcher-error-response'
import { NativeClaudeRefreshSignInCodeParams } from '../../../shared/native-claude-refresh-source'
import { isDurableMutation } from '../../../shared/orchestration-rpc-contract'
import { getRuntimeFeatureInteractionId } from './runtime-feature-interaction'

const method = defineMethod({
  name: 'accounts.submitNativeClaudeRefreshSignInCode',
  permission: 'workspace',
  params: NativeClaudeRefreshSignInCodeParams,
  handler: () => null
})
const meta = { runtimeId: 'runtime' }
const request = (params: unknown) => ({
  id: 'request',
  authToken: 'synthetic',
  method: method.name,
  params
})
it('never includes malformed secret input or a native error cause in an RPC error', () => {
  const input = {
    accountId: 'account',
    signInId: 'invalid',
    code: 'synthetic-private-code#state',
    'synthetic-private-code#state': 'extra'
  }
  const answer = parseRpcRequestParams(request(input), method, meta)
  expect(JSON.stringify(answer)).not.toContain('synthetic-private-code')
  const error = mapDispatcherError(request(input), meta, new Error('synthetic-private-code#state'))
  expect(JSON.stringify(error)).not.toContain('synthetic-private-code')
  expect(error.ok).toBe(false)
})
it('does not persist the code as a durable mutation receipt or feature interaction', () => {
  const params = {
    accountId: 'account',
    signInId: '12345678-1234-4234-8234-123456789012',
    code: 'synthetic-private-code#state'
  }
  expect(isDurableMutation(method.name, params)).toBe(false)
  expect(getRuntimeFeatureInteractionId(method.name, null, params)).toBeNull()
})
