import { expect, it } from 'vitest'
import { z } from 'zod'
import { defineMethod } from './core'
import { parseRpcRequestParams } from './dispatcher-request-parsing'
import { mapDispatcherError } from './dispatcher-error-response'
import { isPrivateNativeCliRpc } from '../../../shared/native-cli-private-rpc'
import { isDurableMutation } from '../../../shared/orchestration-rpc-contract'
import { getRuntimeFeatureInteractionId } from './runtime-feature-interaction'
import { NativeCliControlError } from '../../../shared/native-cli-control-error'

it.each([
  'accounts.nativeClaudeHook',
  'accounts.nativeClaudeCoverage',
  'accounts.prepareNativeCliLaunch',
  'accounts.createNativeCliTerminal',
  'accounts.writeNativeCliTerminal',
  'accounts.startNativeCliStdio',
  'accounts.controlNativeCliStdio',
  'accounts.attachNativeCliStdio',
  'accounts.submitNativeClaudeRefreshSignInCode'
])('never echoes private native request keys/values or errors for %s', (name) => {
  const declaration = defineMethod({
    name,
    permission: 'workspace',
    params: z.object({ launchId: z.uuid() }).strict(),
    handler: () => null
  })
  const request = {
    id: 'request',
    method: name,
    authToken: 'synthetic',
    params: { launchId: 'invalid', 'synthetic-private-unknown-key': 'synthetic-private-input' }
  }
  const meta = { runtimeId: 'runtime' }
  expect(isPrivateNativeCliRpc(name)).toBe(true)
  expect(JSON.stringify(parseRpcRequestParams(request, declaration, meta))).not.toContain(
    'synthetic-private'
  )
  expect(
    JSON.stringify(mapDispatcherError(request, meta, new Error('synthetic-private-input')))
  ).not.toContain('synthetic-private')
  expect(isDurableMutation(name, request.params)).toBe(false)
  expect(getRuntimeFeatureInteractionId(name, null, request.params)).toBeNull()
})

it('returns only fixed recovery guidance for recognized private native failures', () => {
  const error = new NativeCliControlError('retention_full')
  Object.assign(error, { message: 'synthetic-private-message', code: 'synthetic-private-code', cause: 'synthetic-private-cause' })
  const reply = mapDispatcherError(
    { id: 'request', method: 'accounts.startNativeCliStdio', authToken: 'synthetic' },
    { runtimeId: 'runtime' }, error
  )
  expect(reply).toMatchObject({ ok: false, error: { code: 'native_cli_retention_full' } })
  expect(JSON.stringify(reply)).toContain('Review unfinished')
  expect(JSON.stringify(reply)).not.toContain('synthetic-private')
})

it('keeps ordinary validation failures and UI result objects intact', () => {
  expect(isPrivateNativeCliRpc('accounts.nativeClaudeRefreshSources')).toBe(false)
  const error = mapDispatcherError(
    { id: 'request', method: 'other.read', authToken: 'synthetic' },
    { runtimeId: 'runtime' },
    new Error('ordinary failure')
  )
  expect(JSON.stringify(error)).toContain('ordinary failure')
})
