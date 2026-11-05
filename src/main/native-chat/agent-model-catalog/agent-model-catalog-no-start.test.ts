import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { runAgentModelCatalogListing } from './agent-model-catalog-probe-runner'

it('reports a genuine missing executable as no child instead of an unknown writer', async () => {
  const notStarted = vi.fn(),
    closed = vi.fn()
  await expect(
    runAgentModelCatalogListing(
      {
        command: join(tmpdir(), 'opka-no-provider-executable'),
        args: []
      },
      { site: 'missing-provider-start-proof', onNotStarted: notStarted, onClosed: closed }
    )
  ).rejects.toMatchObject({ reason: 'spawn', executableMissing: true })
  expect(notStarted).toHaveBeenCalledTimes(1)
  expect(closed).not.toHaveBeenCalled()
})

it('does not turn an actually started failing executable into no-child proof', async () => {
  const notStarted = vi.fn(),
    closed = vi.fn()
  await expect(
    runAgentModelCatalogListing(
      {
        command: process.execPath,
        args: ['-e', 'process.exit(127)'],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      },
      { site: 'started-provider-exit-proof', onNotStarted: notStarted, onClosed: closed }
    )
  ).rejects.toMatchObject({ reason: 'exit' })
  expect(notStarted).not.toHaveBeenCalled()
  expect(closed).toHaveBeenCalledTimes(1)
})
