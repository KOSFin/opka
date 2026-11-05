import { expect, it } from 'vitest'
import { parse } from 'smol-toml'
import { codexNativeRoutingLaunch, CODEX_ROUTING_KEY_ENV } from './codex-native-launch-config'
import { nativeCliLaunchArguments } from '../../shared/native-cli-launch-arguments'

const transport = {
  baseUrl: `http://127.0.0.1:19876/native/${'b'.repeat(64)}/v1`,
  apiKey: 'a'.repeat(64)
}

it('passes only a loopback capability through env, preserving model, permission and plugin options', () => {
  const plan = codexNativeRoutingLaunch(transport)
  expect(plan.env).toEqual({ [CODEX_ROUTING_KEY_ENV]: 'b'.repeat(64) })
  expect(Object.values(plan.env ?? {})).not.toContain(transport.apiKey)
  expect(plan.codexConfigOverrides?.join('\n')).not.toContain(transport.apiKey)
  expect(parse(plan.codexConfigOverrides?.join('\n') ?? '')).toMatchObject({
    model_provider: 'openai',
    openai_base_url: transport.baseUrl,
    cli_auth_credentials_store: 'file',
    features: {
      responses_websockets: false,
      responses_websockets_v2: false,
      api_key_model_discovery: false
    }
  })
  const args = ['exec', '-m', 'native-model', '-c', 'model_reasoning_effort="high"', '--full-auto']
  const routed = nativeCliLaunchArguments('codex', args, plan)
  expect(routed[0]).toBe('--no-daemon')
  expect(routed.slice(1, args.length + 1)).toEqual(args)
  expect(routed.slice(args.length + 1)).toEqual(
    plan.codexConfigOverrides?.flatMap((value) => ['-c', value])
  )
})

it('keeps literal prompt arguments after the separator unchanged', () => {
  const args = ['exec', '--', '-c literal $input']
  const plan = codexNativeRoutingLaunch(transport)
  const routed = nativeCliLaunchArguments('codex', args, plan)
  expect(routed.slice(-2)).toEqual(['--', '-c literal $input'])
  expect(args).toEqual(['exec', '--', '-c literal $input'])
})

it('leaves ordinary unconfigured launches unchanged and rejects cross-provider configuration', () => {
  const args = ['--model', 'native-model']
  expect(nativeCliLaunchArguments('claude', args, {})).toBe(args)
  expect(() =>
    nativeCliLaunchArguments('claude', args, codexNativeRoutingLaunch(transport))
  ).toThrow('cannot be applied to Claude')
})

it.each([
  'https://127.0.0.1:19876/v1',
  'http://localhost:19876/v1',
  'http://0.0.0.0:19876/v1',
  'http://127.0.0.1/v1',
  'http://127.0.0.1:19876/v1?token=forbidden',
  'http://user@127.0.0.1:19876/v1',
  'http://127.0.0.1:19876/v1#fragment',
  'http://127.0.0.1:19876/other'
])('refuses a non-local or ambiguous transport (%s)', (baseUrl) => {
  expect(() => codexNativeRoutingLaunch({ ...transport, baseUrl })).toThrow()
})

it('rejects malformed capabilities before spawning a native CLI', () => {
  expect(() => codexNativeRoutingLaunch({ ...transport, apiKey: 'short' })).toThrow()
})

it('keeps the native provider identity stable while the per-launch route changes', () => {
  const first = codexNativeRoutingLaunch(transport)
  const next = codexNativeRoutingLaunch({
    ...transport,
    baseUrl: transport.baseUrl.replace('b'.repeat(64), 'c'.repeat(64))
  })
  for (const plan of [first, next]) {
    const config = parse(plan.codexConfigOverrides?.join('\n') ?? '')
    expect(config.model_provider).toBe('openai')
    expect(plan.env?.[CODEX_ROUTING_KEY_ENV]).toBe(plan === first ? 'b'.repeat(64) : 'c'.repeat(64))
    expect(config).not.toHaveProperty('model_providers')
    expect(plan.codexConfigOverrides?.join('\n')).not.toContain(transport.apiKey)
  }
  expect(next.codexConfigOverrides).not.toEqual(first.codexConfigOverrides)
})

it('rejects using the durable gateway credential as a route nonce', () => {
  expect(() =>
    codexNativeRoutingLaunch({
      ...transport,
      baseUrl: transport.baseUrl.replace('b'.repeat(64), transport.apiKey)
    })
  ).toThrow()
})

it('keeps an existing no-daemon flag single and does not cross a native remote-host boundary', () => {
  const plan = codexNativeRoutingLaunch(transport)
  expect(
    nativeCliLaunchArguments('codex', ['--no-daemon'], plan).filter((x) => x === '--no-daemon')
  ).toHaveLength(1)
  expect(() =>
    nativeCliLaunchArguments('codex', ['--remote', 'http://example.invalid'], plan)
  ).toThrow('execution host')
  const args = ['--remote', 'http://example.invalid']
  expect(nativeCliLaunchArguments('codex', args, {})).toBe(args)
})
