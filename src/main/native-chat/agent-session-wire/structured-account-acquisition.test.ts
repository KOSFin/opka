import { describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { AgentSessionPreSpawnError } from './structured-agent-session-adapter'
import { acquireOwner } from './structured-agent-session-acquisition'
import type { AttachFlowInput } from './structured-agent-session-attach-flow'
const mint = vi.hoisted(() => vi.fn((args: unknown) => args))
vi.mock('./structured-agent-session-startup-attempt', () => ({
  mintStructuredAgentSessionStartupAttempt: mint
}))
vi.mock('./structured-agent-session-attach', () => ({ journalIdentityFor: () => ({}) }))
function fixture() {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      claimStatus: 'reserved',
      ownerProcess: null,
      provenHandleLinkId: null
    })
  )
  record.providerHandleChain = []
  const selected = {
    ...record,
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/synthetic/pinned' }
  }
  const release = vi.fn()
  const acquire = vi.fn(async () => {
    throw new AgentSessionPreSpawnError(new Error('not spawned'))
  })
  const prepare = vi.fn(async () => ({ record: selected, preSpawnFailed: release }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture always fails before spawn, so no post-spawn store method is read.
  const input = {
    params: {},
    now: () => 3000,
    store: { getRecord: () => selected },
    adapter: { acquire },
    prepareAccountAcquisition: prepare
  } as unknown as AttachFlowInput
  return { record, selected, release, acquire, prepare, input }
}
describe('native account acquisition lifecycle', () => {
  it('pins before minting the startup and releases a proven pre-spawn failure', async () => {
    const f = fixture()
    await expect(acquireOwner(f.input, f.record)).rejects.toThrow()
    expect(mint).toHaveBeenLastCalledWith(expect.objectContaining({ record: f.selected }))
    expect(f.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      f.acquire.mock.invocationCallOrder[0]
    )
    expect(f.release).toHaveBeenCalledOnce()
  })
  it('does not acquire a provider after account preparation fails', async () => {
    const f = fixture()
    f.prepare.mockRejectedValue(new Error('account unavailable'))
    await expect(acquireOwner(f.input, f.record)).rejects.toThrow()
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.release).not.toHaveBeenCalled()
  })
  it('returns capacity when the permission wait rejects before invoking the adapter', async () => {
    const f = fixture()
    f.input.launchPermissionMode = async () => {
      throw new Error('permission wait closed')
    }
    await expect(acquireOwner(f.input, f.record)).rejects.toBeInstanceOf(AgentSessionPreSpawnError)
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.acquire).not.toHaveBeenCalled()
  })
  it('returns capacity when Stop aborts a pending permission wait', async () => {
    const f = fixture()
    const abort = new AbortController()
    f.input.acquireSignal = abort.signal
    const permissionEntered = vi.fn()
    f.input.launchPermissionMode = () =>
      new Promise((_resolve, reject) => {
        permissionEntered()
        abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
      })
    const running = acquireOwner(f.input, f.record)
    const rejected = expect(running).rejects.toBeInstanceOf(AgentSessionPreSpawnError)
    await vi.waitFor(() => expect(permissionEntered).toHaveBeenCalledOnce())
    abort.abort(new Error('operator stop'))
    await rejected
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.acquire).not.toHaveBeenCalled()
  })
  it('retains capacity for an ambiguous failure after adapter invocation', async () => {
    const f = fixture()
    f.acquire.mockRejectedValue(new Error('spawn reply lost'))
    await expect(acquireOwner(f.input, f.record)).rejects.toThrow()
    expect(f.acquire).toHaveBeenCalledOnce()
    expect(f.release).not.toHaveBeenCalled()
  })
})
