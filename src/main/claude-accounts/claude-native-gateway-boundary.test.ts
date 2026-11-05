import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { NativeClaudeCoverageState } from '../../shared/native-claude-coverage'
import { readClaudeNativeRejectedRequestBoundary } from './claude-native-gateway-boundary'

function fixture(change: Partial<NativeClaudeCoverageState> = {}) {
  let coverage: NativeClaudeCoverageState | undefined = {
    launchId: randomUUID(),
    sessionId: randomUUID(),
    generation: randomUUID(),
    sequence: 1,
    lastEvent: '',
    unknown: false,
    requests: ['actual-opaque-intent'],
    tools: [],
    spawns: [],
    pendingTasks: [],
    liveAgents: [],
    settledTasks: [],
    draftActive: false,
    pendingPrompts: [],
    ...change
  }
  let owner: string | null = 'actual-owned-generation',
    active = 1,
    owed = false
  const read = () =>
    readClaudeNativeRejectedRequestBoundary({
      readCoverage: () => coverage,
      readOwner: () => owner,
      activeHttp: () => active,
      hasOwedBackgroundWork: () => owed
    })
  return {
    read,
    replace: () => {
      coverage = coverage && { ...coverage, sequence: 2 }
    },
    lose: () => {
      coverage = undefined
    },
    changeOwner: () => {
      owner = null
    },
    otherHttp: () => {
      active = 2
    },
    background: () => {
      owed = true
    }
  }
}

it('certifies only the held rejected request without claiming a native Stop or completed main turn', () => {
  expect(fixture().read()()).toBe(true)
})
it.each<Partial<NativeClaudeCoverageState>>([
  { requests: [] },
  { requests: ['first', 'queued'] },
  { tools: ['busy'] },
  { spawns: ['unknown-child'] },
  { pendingTasks: [{ id: 'owed', kind: 'shell', notificationOwed: true }] },
  { liveAgents: ['child'] },
  { pendingPrompts: ['queued-user'] },
  { draftActive: true },
  { draftUnverifiable: true },
  { unknown: true }
])('pins concurrent, queued, unknown or nonrequest work', (change) => {
  expect(fixture(change).read()()).toBe(false)
})
it.each(['replace', 'lose', 'changeOwner', 'otherHttp', 'background'] as const)(
  'rechecks %s after asynchronous evidence',
  (change) => {
    const f = fixture(),
      held = f.read()
    expect(held()).toBe(true)
    f[change]()
    expect(held()).toBe(false)
  }
)
