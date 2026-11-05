import { expect, it } from 'vitest'
import { supportsCodexEngineGateway } from './codex-engine-capability'

it('exposes only platforms with supported persistent engine writer ownership', () => {
  expect(supportsCodexEngineGateway('darwin')).toBe(true)
  expect(supportsCodexEngineGateway('linux')).toBe(true)
  expect(supportsCodexEngineGateway('win32')).toBe(false)
  expect(supportsCodexEngineGateway('freebsd')).toBe(false)
})
