import { expect, it, vi } from 'vitest'
import { eraseRpcMethods, isStreamingMethod } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { NATIVE_CLI_ACCOUNT_METHODS } from './native-cli-accounts'
const hooks = vi.hoisted(() => ({
  prepare: vi.fn(),
  release: vi.fn(),
  coverage: vi.fn(),
  observe: vi.fn()
}))
vi.mock('../../native-cli-account-launch', () => ({
  prepareNativeCliAccountLaunch: hooks.prepare,
  releaseNativeCliAccountLaunch: hooks.release
}))
vi.mock('../../native-claude-hook-sessions', () => ({
  dispatchNativeClaudeCoverage: hooks.coverage,
  dispatchNativeClaudeHook: hooks.observe
}))
const launchId = '12345678-1234-4234-8234-123456789012'
for (const method of eraseRpcMethods(NATIVE_CLI_ACCOUNT_METHODS)) {
  if (isStreamingMethod(method)) {
    continue
  }
  it.each(['runtime', 'mobile'] as const)(
    `${method.name} refuses a nonlocal %s caller`,
    async (clientKind) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Authorization must refuse before consulting the deliberately absent runtime.
      const runtime = {} as OrcaRuntimeService
      const params = method.params?.parse(
        method.name.endsWith('prepareNativeCliLaunch')
          ? { provider: 'claude', launchId }
          : method.name === 'accounts.nativeClaudeHook'
            ? {
                launchId,
                capability: 'synthetic-capability-'.repeat(3),
                sessionId: 'session',
                promptId: 'prompt',
                event: 'stop'
              }
            : method.name === 'accounts.nativeClaudeCoverage'
              ? {
                  launchId,
                  capability: 'synthetic-capability-'.repeat(3),
                  sessionId: 'session',
                  generation: launchId,
                  sequence: 1,
                  observation: { kind: 'draft', active: false }
                }
              : { launchId }
      )
      await expect(
        Promise.resolve().then(() => method.handler(params, { runtime, clientKind }))
      ).rejects.toThrow('owning host local CLI')
      expect(hooks.prepare).not.toHaveBeenCalled()
      expect(hooks.release).not.toHaveBeenCalled()
      expect(hooks.coverage).not.toHaveBeenCalled()
      expect(hooks.observe).not.toHaveBeenCalled()
    }
  )
}
