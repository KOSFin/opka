import { describe, expect, it, vi } from 'vitest'
import { createPageBackConsumers } from './page-back-consumers'

function consumers() {
  const claims: boolean[] = []
  const unclaimed = vi.fn()
  return {
    claims,
    unclaimed,
    stack: createPageBackConsumers({
      publishClaim: (claimed) => claims.push(claimed),
      onUnclaimed: unclaimed
    })
  }
}

describe('who in the page is holding the device Back key', () => {
  it('handles project and drawer Back claims without copied-array builtins on older WebViews', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toReversed')
    const { stack, unclaimed } = consumers()
    const steps: string[] = []
    let project = true
    stack.claim(() => {
      if (!project) {
        return false
      }
      project = false
      steps.push('project cleared')
      return true
    })
    const releaseDrawer = stack.claim(() => {
      steps.push('drawer closed')
      releaseDrawer()
      return true
    })
    try {
      Object.defineProperty(Array.prototype, 'toReversed', { configurable: true, value: undefined })
      stack.press()
      stack.press()
      stack.press()
    } finally {
      if (descriptor) {
        Object.defineProperty(Array.prototype, 'toReversed', descriptor)
      } else {
        Reflect.deleteProperty(Array.prototype, 'toReversed')
      }
    }
    expect(steps).toEqual(['drawer closed', 'project cleared'])
    expect(unclaimed).toHaveBeenCalledTimes(1)
  })

  it('tells the shell on the edges only, so one sheet over another does not flicker the key', () => {
    const { claims, stack } = consumers()
    const first = stack.claim(() => true)
    const second = stack.claim(() => true)
    expect(claims).toEqual([true])
    second()
    expect(claims).toEqual([true])
    first()
    expect(claims).toEqual([true, false])
  })

  it('offers a press newest first, and stops at the one that takes it', () => {
    const { stack } = consumers()
    const order: string[] = []
    stack.claim(() => {
      order.push('bottom')
      return true
    })
    stack.claim(() => {
      order.push('top')
      return true
    })
    stack.press()
    expect(order).toEqual(['top'])
  })

  it('falls through a consumer that says the press was not its own', () => {
    const { stack, unclaimed } = consumers()
    const order: string[] = []
    stack.claim(() => {
      order.push('bottom')
      return true
    })
    stack.claim(() => {
      order.push('top')
      return false
    })
    stack.press()
    expect(order).toEqual(['top', 'bottom'])
    expect(unclaimed).not.toHaveBeenCalled()
  })

  /**
   * The claim and the press cross on separate frames, so a sheet that closed between the two leaves
   * the shell holding a claim this page cannot spend. Dropping the press there is the failure this
   * whole lane exists to remove: the key would do nothing at all.
   */
  it('hands a press nothing took back to the shell rather than dropping it', () => {
    const { stack, unclaimed } = consumers()
    stack.press()
    expect(unclaimed).toHaveBeenCalledTimes(1)
    const release = stack.claim(() => false)
    stack.press()
    expect(unclaimed).toHaveBeenCalledTimes(2)
    release()
  })

  it('survives a consumer that disposes itself from inside its own answer', () => {
    const { stack } = consumers()
    const order: string[] = []
    stack.claim(() => {
      order.push('bottom')
      return true
    })
    const release = stack.claim(() => {
      order.push('top')
      release()
      return false
    })
    stack.press()
    // The one beneath it still hears the press: the walk is over a copy, so the splice inside the
    // top consumer cannot skip it.
    expect(order).toEqual(['top', 'bottom'])
  })

  it('ignores a release called twice, so a remounting claim cannot free another one', () => {
    const { claims, stack } = consumers()
    const release = stack.claim(() => true)
    release()
    const other = stack.claim(() => true)
    release()
    expect(claims).toEqual([true, false, true])
    other()
    expect(claims).toEqual([true, false, true, false])
  })

  /**
   * The shell drops the claim on every `ready` and when its host is torn down, so an edge this
   * document posted before that shell arrived is one it never heard. `init` is the shell saying it
   * is here now, and this is the page answering with the state rather than with a transition.
   */
  it('says again what it is holding when the shell asks, without a second edge', () => {
    const { claims, stack } = consumers()
    stack.claim(() => true)
    stack.reassert()
    expect(claims).toEqual([true, true])
  })

  /**
   * Nothing to say. Every `init` that answers a `ready` is sent by a host that dropped the claim
   * first, so it already holds false; the only other one carries a rewritten route, where a stale
   * true needs a `false` the page posted to have never left — and a port that refused that one
   * refuses this too. A `false` here would be a frame per document boot asserting what the shell
   * already holds.
   */
  it('says nothing when it is holding nothing, because the shell already holds that', () => {
    const { claims, stack } = consumers()
    stack.reassert()
    const release = stack.claim(() => true)
    release()
    stack.reassert()
    expect(claims).toEqual([true, false])
  })

  it('gives the key back when the client closes, whoever was still holding it', () => {
    const { claims, stack } = consumers()
    stack.claim(() => true)
    stack.claim(() => true)
    stack.clear()
    expect(claims).toEqual([true, false])
    // And says nothing a second time: there is nothing left to give back.
    stack.clear()
    expect(claims).toEqual([true, false])
  })
})
