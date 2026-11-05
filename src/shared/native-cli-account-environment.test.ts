import { expect, it } from 'vitest'
import { applyNativeCliAccountEnvironment } from './native-cli-account-environment'
import { NATIVE_CLAUDE_ROUTING_KEY_ENV } from './native-claude-hook'

it('bypasses inherited external proxies for a fresh Claude gateway while preserving external rules', () => {
  const inherited = {
    HTTP_PROXY: 'http://proxy.example:8080',
    NO_PROXY: '.corp',
    no_proxy: 'internal.example'
  }
  const result = applyNativeCliAccountEnvironment(inherited, {
    env: {
      [NATIVE_CLAUDE_ROUTING_KEY_ENV]: `sk-ant-oat01-${'a'.repeat(64)}`,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:43210'
    },
    envToDelete: []
  })
  expect(result.HTTP_PROXY).toBe(inherited.HTTP_PROXY)
  expect(result.NO_PROXY).toBe('127.0.0.1,localhost,::1,.corp,internal.example')
  expect(result.no_proxy).toBe(result.NO_PROXY)
  expect(
    applyNativeCliAccountEnvironment(inherited, {
      env: { [NATIVE_CLAUDE_ROUTING_KEY_ENV]: 'direct-mode-capability' },
      envToDelete: []
    }).NO_PROXY
  ).toBe('.corp')
})
import { NATIVE_CODEX_ROUTING_KEY_ENV } from './native-cli-account-launch'

const routed = { env: { [NATIVE_CODEX_ROUTING_KEY_ENV]: 'synthetic-capability' }, envToDelete: [] }

it('keeps the private gateway off external proxies without disabling tool network proxies', () => {
  const inherited = { HTTP_PROXY: 'http://proxy.example:8080', NO_PROXY: '' }
  const result = applyNativeCliAccountEnvironment(inherited, routed)
  expect(result).toMatchObject({
    HTTP_PROXY: inherited.HTTP_PROXY,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1'
  })
  expect(inherited.NO_PROXY).toBe('')
})

it('preserves exclusions from both spellings while giving loopback a bounded prefix', () => {
  const result = applyNativeCliAccountEnvironment(
    { NO_PROXY: '.corp;*.private', no_proxy: 'internal.example' },
    routed
  )
  expect(result.NO_PROXY).toBe('127.0.0.1,localhost,::1,.corp,*.private,internal.example')
  expect(result.no_proxy).toBe(result.NO_PROXY)
  const long = applyNativeCliAccountEnvironment({ NO_PROXY: 'a'.repeat(10_000) }, routed)
  expect(long.NO_PROXY?.startsWith('127.0.0.1,localhost,::1')).toBe(true)
  expect(long.NO_PROXY?.length).toBeLessThanOrEqual(4096)
})

it('leaves custom provider and manual native proxy settings unchanged', () => {
  const inherited = { HTTP_PROXY: 'http://proxy.example:8080', no_proxy: '.corp' }
  expect(applyNativeCliAccountEnvironment(inherited, { env: {}, envToDelete: [] })).toEqual(
    inherited
  )
})
