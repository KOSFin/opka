import { describe, expect, it } from 'vitest'
import { harness, ID, OTHER, subscribeFrame } from './bridge-host-test-harness'
import { clientFrame, flushBridge, rpcSuccess } from './bridge-host-test-fakes'

describe('retained page bridge activity', () => {
  it('releases hidden streams and timers, refuses new remote work, and resumes once', () => {
    const timers = new Set<unknown>()
    const bridge = harness({
      ready: true,
      terminalTimers: {
        set: (callback) => {
          timers.add(callback)
          return callback
        },
        clear: (handle) => {
          timers.delete(handle)
        }
      }
    })
    bridge.host.receive(subscribeFrame(ID))
    for (let index = 0; index < 258; index += 1) {
      bridge.client.streams[0].emit({ type: 'data', streamId: 1, chunk: 'synthetic output' })
    }
    expect(timers.size).toBe(1)
    bridge.host.setActive(false)
    expect(bridge.client.streams[0].unsubscribes).toBe(1)
    expect(timers.size).toBe(0)
    expect(bridge.frames()).toContainEqual(
      expect.objectContaining({
        type: 'state',
        connection: expect.objectContaining({ state: 'disconnected' })
      })
    )
    bridge.host.receive(subscribeFrame(OTHER))
    bridge.host.receive(clientFrame({ type: 'request', id: OTHER, method: 'status.get' }))
    bridge.host.receive(clientFrame({ type: 'notify', name: 'foreground' }))
    bridge.host.receive(
      clientFrame({ type: 'notify', name: 'terminalViewport', terminal: 't', cols: 80, rows: 24 })
    )
    expect(bridge.client.streams).toHaveLength(1)
    expect(bridge.client.requests).toHaveLength(0)
    expect(bridge.client.foregroundCalls).toHaveLength(0)
    expect(bridge.client.viewports).toHaveLength(0)
    const before = bridge.frames().length
    bridge.host.setActive(true)
    bridge.host.setActive(true)
    expect(bridge.frames().slice(before)).toEqual([
      expect.objectContaining({
        type: 'state',
        connection: expect.objectContaining({ state: 'connected' })
      })
    ])
    bridge.host.receive(subscribeFrame(ID))
    expect(bridge.client.streams).toHaveLength(2)
    bridge.host.dispose()
    expect(bridge.client.streams[1].unsubscribes).toBe(1)
  })

  it('lets an accepted request finish while inactive without replaying it on resume', async () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    bridge.host.setActive(false)
    bridge.client.requests[0].resolve(rpcSuccess(ID, { retained: true }))
    await flushBridge()
    expect(bridge.frames()).toContainEqual(expect.objectContaining({ type: 'reply', id: ID }))
    bridge.host.setActive(true)
    expect(bridge.client.requests).toHaveLength(1)
    bridge.host.dispose()
    bridge.host.setActive(true)
    expect(bridge.client.stateListeners()).toBe(0)
  })
})
