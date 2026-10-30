import { afterEach, describe, expect, it } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'
import { accountPoolRotationBoundary } from '../runtime/account-pool-rotation-boundary'
import type { AccountPoolPolicy } from '../../shared/account-pool-policy'
let server: AgentHookServer | undefined
afterEach(() => {
  server?.stop()
  _internals.resetCachesForTests()
})
describe('ordinary CLI hooks admit idle account rotation without inventing success', () => {
  it.each(['claude', 'codex'] as const)(
    '%s prompt and plain Stop preserve a usable owned turn clock',
    async (provider) => {
      server = new AgentHookServer()
      await server.start({ env: 'production' })
      const route = `/hook/${provider}`
      const session = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
      await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'UserPromptSubmit',
          session_id: session,
          prompt: 'Synthetic task'
        }),
        route
      )
      const started = server.getStatusSnapshot()[0]?.turnStartedAt
      expect(started).toEqual(expect.any(Number))
      if (started === undefined) {
        throw new Error('Missing owning-host turn clock')
      }
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'Stop', session_id: session }),
        route
      )
      const normal = server.getStatusSnapshot()[0]
      expect(normal).toMatchObject({
        state: 'done',
        turnStartedAt: started,
        mainAgent: { state: 'done' }
      })
      expect(normal?.mainAgent?.outcome).toBeUndefined()
      expect(normal?.turnCompletedAt).toBeUndefined()
      if (!normal) {
        throw new Error('Missing hook row')
      }
      const policy: AccountPoolPolicy = {
        id: 'pool',
        provider,
        revision: 1,
        strategy: 'balanced',
        applyToNewWork: true,
        rotation: 'after-turn',
        unknownQuota: 'allow',
        allowReserve: false,
        members: []
      }
      // Host execution identity and settled inventory are separate admission proofs, not hook claims.
      const args = {
        policy,
        accountId: 'a',
        candidate: undefined,
        row: { ...normal, executionId: 'owned-generation' },
        executionId: 'owned-generation',
        children: [],
        launchStartedAt: started - 1,
        now: Date.now()
      }
      expect(accountPoolRotationBoundary(args)).toBe(normal.mainAgent?.stateStartedAt)
      expect(accountPoolRotationBoundary({ ...args, executionId: 'other' })).toBeNull()
      expect(accountPoolRotationBoundary({ ...args, children: undefined })).toBeNull()
      expect(
        accountPoolRotationBoundary({
          ...args,
          row: {
            ...args.row,
            mainAgent: {
              state: 'done',
              stateStartedAt: normal.mainAgent!.stateStartedAt,
              outcome: 'cancellation'
            }
          }
        })
      ).toBeNull()
      expect(
        accountPoolRotationBoundary({ ...args, row: { ...args.row, sessionBoundary: true } })
      ).toBeNull()
    }
  )
})
