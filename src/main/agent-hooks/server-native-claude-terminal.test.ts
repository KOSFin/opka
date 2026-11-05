import { afterEach, expect, it } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'

afterEach(() => _internals.resetCachesForTests())
it('ingests the first private native startup through the existing terminal canonical authority', async () => {
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  const sessionId = '66666666-6666-4666-8666-666666666666'
  try {
    expect(
      server.observeNativeClaudeCoverage(
        {
          launchId: '11111111-1111-4111-8111-111111111111',
          sessionId,
          startedAt: Date.now() - 1,
          paneKey: PANE,
          terminal: {
            paneKey: PANE,
            tabId: 'tab-1',
            worktreeId: 'synthetic-folder',
            ptyId: 'actual-owner-fixture',
            incarnationId: 'fixture-incarnation',
            executionHostId: 'local',
            terminalHandle: 'fixture-terminal-handle'
          }
        },
        {
          launchId: '11111111-1111-4111-8111-111111111111',
          sessionId,
          capability: 'x'.repeat(64),
          generation: '22222222-2222-4222-8222-222222222222',
          sequence: 1,
          observation: {
            kind: 'canonical-hook',
            hook: {
              nativeOrigin: 'engine',
              event: 'SessionStart',
              sessionId,
              source: 'startup'
            }
          }
        }
      )
    ).toMatchObject({ healthy: true, sequence: 1 })
    expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(sessionId)
  } finally {
    server.stop()
  }
})
