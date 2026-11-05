import { expect, it, vi, type Mock } from 'vitest'
import type { NativeCodexInventorySourceOptions } from '../agent-hooks/native-codex-inventory-source'
import { NativeCodexRootInventory } from './native-codex-root-inventory'
function fixture() {
  const state = { live: true }
  const sources: {
    options: NativeCodexInventorySourceOptions
    id: string | null
    done: Set<string>
    settled: boolean
    latest?: string
    dispose: Mock<() => void>
  }[] = []
  const inventory = new NativeCodexRootInventory({
    home: '/synthetic-owned-home',
    launchId: 'owned-launch',
    isCurrent: () => state.live,
    register: (options) => {
      const source: (typeof sources)[number] = {
        options,
        id: null,
        done: new Set<string>(),
        settled: true,
        dispose: vi.fn()
      }
      sources.push(source)
      return {
        bindRoot: (id) => {
          source.id = id
        },
        read: () => ({ status: source.settled && options.isCurrent() ? 'settled' : 'live' }),
        readTurn: (turn) => source.settled && options.isCurrent() && source.done.has(turn),
        readBoundaryTurn: (turn, _budget, allowed) =>
          source.settled &&
          options.isCurrent() &&
          source.done.has(turn) &&
          (!source.latest || source.done.has(source.latest) || allowed === source.latest),
        prepare: async () => {},
        dispose: source.dispose
      }
    }
  })
  return { inventory, sources, state }
}
it('retains immutable old ROOT sources through unsafe /new and unpins only after old main and children settle', () => {
  const f = fixture()
  f.inventory.bindRoot('root-A')
  f.inventory.acceptTurn('root-A', 'turn-A')
  f.inventory.bindRoot('root-B', {
    settledPrevious: false,
    previousTurn: { threadId: 'root-A', turnId: 'turn-A' }
  })
  f.inventory.acceptTurn('root-B', 'turn-B')
  f.sources[1].done.add('turn-B')
  expect(f.sources.map((source) => source.id)).toEqual(['root-A', 'root-B'])
  expect(f.inventory.completedBoundary().canSwitch()).toBe(false)
  f.sources[0].done.add('turn-A')
  f.sources[0].settled = false
  expect(f.inventory.completedBoundary().canSwitch()).toBe(false)
  f.sources[0].settled = true
  expect(f.inventory.completedBoundary().canSwitch()).toBe(true)
  f.inventory.bindRoot('root-B', { settledPrevious: true })
  expect(f.sources[0].dispose).toHaveBeenCalledOnce()
  expect(f.sources[1].dispose).not.toHaveBeenCalled()
})
it('evaluates the old accepted turn before a new accepted ROOT turn updates its boundary', () => {
  const f = fixture()
  f.inventory.bindRoot('root')
  f.inventory.acceptTurn('root', 'turn-one')
  f.sources[0].done.add('turn-one')
  const old = f.inventory.completedBoundary()
  expect(old.canSwitch()).toBe(true)
  f.inventory.acceptTurn('root', 'turn-two')
  expect(old.canSwitch()).toBe(false)
  expect(f.inventory.completedBoundary().canSwitch()).toBe(false)
  f.sources[0].done.add('turn-two')
  expect(f.inventory.completedBoundary().canSwitch()).toBe(true)
})
it('does not let a late old source or revoked capability prove the new ROOT boundary', () => {
  const f = fixture()
  f.inventory.bindRoot('A')
  f.inventory.acceptTurn('A', 'one')
  f.sources[0].done.add('one')
  f.inventory.bindRoot('B', { settledPrevious: true })
  f.inventory.acceptTurn('B', 'two')
  expect(f.inventory.completedBoundary().canSwitch()).toBe(false)
  expect(f.sources[0].options.isCurrent()).toBe(false)
  f.sources[1].done.add('two')
  f.state.live = false
  expect(f.inventory.completedBoundary().canSwitch()).toBe(false)
  f.inventory.dispose()
  f.inventory.dispose()
  expect(f.sources[1].dispose).toHaveBeenCalledOnce()
})
it('keeps missing metadata pinned and refuses more than64 unresolved ROOT sources', () => {
  const f = fixture()
  f.inventory.bindRoot(null)
  expect(f.inventory.retainedSettled([])).toBe(false)
  const bounded = fixture()
  for (let i = 0; i < 64; i++) {
    bounded.inventory.bindRoot(`root-${i}`)
  }
  expect(() => bounded.inventory.bindRoot('overflow')).toThrow(/capacity/)
  expect(bounded.sources).toHaveLength(64)
})

it('shares one cumulative catch-up byte budget across all retained ROOT readers', async () => {
  const budgets: { remainingBytes: number }[] = []
  const inventory = new NativeCodexRootInventory({
    home: '/synthetic-home',
    launchId: 'owned',
    isCurrent: () => true,
    register: () => ({
      bindRoot: () => {},
      read: () => ({ status: 'settled' }),
      readTurn: () => false,
      readBoundaryTurn: () => false,
      dispose: () => {},
      prepare: async (_signal, budget) => {
        if (budget) {
          budgets.push(budget)
          budget.remainingBytes -= 4 * 1024 * 1024
        }
      }
    })
  })
  inventory.bindRoot('A')
  inventory.bindRoot('B')
  inventory.bindRoot('C')
  await inventory.prepare(new AbortController().signal)
  expect(budgets).toHaveLength(2)
  expect(budgets[0]).toBe(budgets[1])
  expect(budgets[0].remainingBytes).toBe(0)
  inventory.dispose()
})

it('cancels the entire preparation after one2s deadline rather than waiting2s per ROOT', async () => {
  vi.useFakeTimers()
  try {
    const inventory = new NativeCodexRootInventory({
      home: '/synthetic-home',
      launchId: 'owned',
      isCurrent: () => true,
      register: () => ({
        bindRoot: () => {},
        read: () => ({ status: 'settled' }),
        readTurn: () => false,
        readBoundaryTurn: () => false,
        dispose: () => {},
        prepare: (signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('bounded wait aborted')), {
              once: true
            })
          )
      })
    })
    inventory.bindRoot('A')
    inventory.bindRoot('B')
    const result = inventory.prepare(new AbortController().signal).catch((error) => error)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await result).toBeInstanceOf(Error)
    inventory.dispose()
  } finally {
    vi.useRealTimers()
  }
})

it('does not mistake an old completed turn for a safe boundary while newer same-ROOT work is active', () => {
  const f = fixture()
  f.inventory.bindRoot('A')
  f.inventory.acceptTurn('A', 'old')
  f.sources[0].done.add('old')
  f.sources[0].latest = 'incoming'
  expect(f.inventory.completedBoundary().canSwitch()).toBe(false)
  expect(f.inventory.completedBoundary({ threadId: 'A', turnId: 'incoming' }).canSwitch()).toBe(
    true
  )
  expect(f.inventory.completedBoundary({ threadId: 'B', turnId: 'incoming' }).canSwitch()).toBe(
    false
  )
  expect(f.inventory.currentMainSettled()).toBe(false)
})

it('retains unverified owned ROOT state and retries registration after global reader capacity becomes available', () => {
  const register = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('capacity')
    })
    .mockImplementation(() => ({
      bindRoot: () => {},
      read: () => ({ status: 'settled' }),
      readTurn: () => true,
      readBoundaryTurn: () => true,
      prepare: async () => {},
      dispose: () => {}
    }))
  const inventory = new NativeCodexRootInventory({
    home: '/synthetic-home',
    launchId: 'owned',
    isCurrent: () => true,
    register
  })
  inventory.bindRoot('root')
  inventory.acceptTurn('root', 'turn')
  expect(register).toHaveBeenCalledTimes(1)
  expect(inventory.completedBoundary().canSwitch()).toBe(true)
  expect(register).toHaveBeenCalledTimes(2)
  inventory.dispose()
})
