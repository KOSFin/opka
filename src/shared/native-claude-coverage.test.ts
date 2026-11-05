import { expect, it } from 'vitest'
import {
  foldNativeClaudeCoverage,
  isNativeClaudeCoverageSettled,
  type NativeClaudeCoverageState,
  type NativeClaudeCoverageObservation
} from './native-claude-coverage'

function fixture(fresh = true) {
  let state: NativeClaudeCoverageState | undefined
  let sequence = 0
  const envelope = (observation: NativeClaudeCoverageObservation) => ({
    launchId: '11111111-1111-4111-8111-111111111111',
    capability: 'x'.repeat(64),
    sessionId: 'actual-root',
    generation: '22222222-2222-4222-8222-222222222222',
    sequence: ++sequence,
    observation
  })
  return {
    event(observation: NativeClaudeCoverageObservation) {
      state = foldNativeClaudeCoverage(state, envelope(observation), fresh)
      return state
    },
    read: () => state,
    envelope,
    replace: (next: NativeClaudeCoverageState) => {
      state = next
    }
  }
}
const end: Extract<NativeClaudeCoverageObservation, { kind: 'turn-end' }> = {
  kind: 'turn-end',
  id: 'turn-A',
  reason: 'error',
  agents: []
}

it('requires a fresh startup and an actual completed main turn', () => {
  const f = fixture()
  expect(isNativeClaudeCoverageSettled(f.event({ kind: 'prompt', origin: 'composer' }))).toBe(false)
  f.event({ kind: 'request-start', id: 'request', mainTurnId: 'turn-A' })
  f.event({ kind: 'request-end', id: 'request' })
  expect(isNativeClaudeCoverageSettled(f.event(end))).toBe(true)
  const resumed = fixture(false)
  resumed.event({ kind: 'request-start', id: 'request', mainTurnId: 'turn-A' })
  resumed.event({ kind: 'request-end', id: 'request' })
  expect(isNativeClaudeCoverageSettled(resumed.event(end))).toBe(false)
})

it('keeps Bash and Agent work pinned until genuine native completion', () => {
  const f = fixture()
  f.event({ kind: 'tool-start', id: 'bash', tool: 'Bash' })
  f.event({ kind: 'tool-end', id: 'bash', task: { id: 'shell-task', kind: 'shell' } })
  f.event({ kind: 'tool-start', id: 'agent', tool: 'Agent' })
  f.event({ kind: 'tool-end', id: 'agent', task: { id: 'agent-task', kind: 'agent' } })
  f.event({ kind: 'request-start', id: 'main', mainTurnId: 'turn-A' })
  f.event({ kind: 'request-end', id: 'main' })
  f.event({ ...end, agents: [{ id: 'agent-task', status: 'running' }] })
  expect(isNativeClaudeCoverageSettled(f.read())).toBe(false)
  f.event({ kind: 'prompt', origin: 'composer', taskId: 'shell-task', taskStatus: 'completed' })
  expect(f.read()?.pendingTasks).toHaveLength(2)
  f.event({
    kind: 'prompt',
    origin: 'task-notification',
    taskId: 'shell-task',
    taskStatus: 'completed'
  })
  f.event({
    ...end,
    agentId: 'agent-task',
    id: 'child-turn',
    reason: 'answer',
    agents: [{ id: 'agent-task', status: 'completed' }]
  })
  expect(isNativeClaudeCoverageSettled(f.read())).toBe(false)
  f.event({
    kind: 'prompt',
    origin: 'task-notification',
    taskId: 'agent-task',
    taskStatus: 'completed'
  })
  expect(isNativeClaudeCoverageSettled(f.read())).toBe(true)
})

it('does not borrow the previous main completion after a new main request', () => {
  const f = fixture()
  f.event({ kind: 'request-start', id: 'first', mainTurnId: 'turn-A' })
  f.event({ kind: 'request-end', id: 'first' })
  f.event(end)
  f.event({ kind: 'request-start', id: 'second', mainTurnId: 'turn-B' })
  f.event({ kind: 'request-end', id: 'second' })
  expect(isNativeClaudeCoverageSettled(f.read())).toBe(false)
})

it('pins unknown or missing request/tool/spawn intents', () => {
  for (const event of [
    { kind: 'tool-end', id: 'unknown' },
    { kind: 'request-end', id: 'unknown' },
    { kind: 'spawn-end', id: 'unknown' }
  ] as const) {
    const f = fixture()
    expect(f.event(event).unknown).toBe(true)
  }
  const f = fixture()
  expect(
    f.event({
      kind: 'prompt',
      origin: 'task-notification',
      taskId: 'unobserved',
      taskStatus: 'completed'
    }).unknown
  ).toBe(true)
})

it('pins a producer sequence gap, generation reload or changed session', () => {
  const f = fixture()
  const first = f.event({ kind: 'prompt', origin: 'composer' })
  const next = f.envelope({ kind: 'prompt', origin: 'composer' })
  expect(
    foldNativeClaudeCoverage(first, { ...next, sequence: next.sequence + 1 }, true).unknown
  ).toBe(true)
  expect(
    foldNativeClaudeCoverage(
      first,
      { ...next, generation: '33333333-3333-4333-8333-333333333333' },
      true
    ).unknown
  ).toBe(true)
  expect(foldNativeClaudeCoverage(first, { ...next, sessionId: 'other-root' }, true).unknown).toBe(
    true
  )
})

it('acknowledges an exact retry without reopening or replaying work', () => {
  const f = fixture()
  const request = f.envelope({ kind: 'tool-start', id: 'native-tool', tool: 'Bash' })
  const state = foldNativeClaudeCoverage(undefined, request, true)
  expect(foldNativeClaudeCoverage(state, request, true)).toBe(state)
  expect(state.tools).toEqual(['native-tool'])
})

it('bounds unknown active intents without displacing live evidence', () => {
  const f = fixture()
  for (let index = 0; index < 257; index++) {
    f.event({ kind: 'tool-start', id: `tool-${index}`, tool: 'Bash' })
  }
  expect(f.read()?.unknown).toBe(true)
  expect(f.read()?.tools).toHaveLength(256)
  expect(f.read()?.tools[0]).toBe('tool-0')
})

it('requires a separately certified fresh complete Stop to recover unknown continuity', () => {
  const f = fixture()
  const lost = f.event({ kind: 'lost' })
  const request = f.envelope({ kind: 'complete-stop', promptId: 'actual-stop-prompt' })
  expect(foldNativeClaudeCoverage(lost, request, true).unknown).toBe(true)
  const recovered = foldNativeClaudeCoverage(lost, request, false, true)
  expect(recovered.unknown).toBe(false)
  expect(isNativeClaudeCoverageSettled(recovered)).toBe(false)
})

it('pins a draft or accepted queued prompt while permitting only its exact owned internal wake', () => {
  const f = fixture()
  f.event({ kind: 'request-start', id: 'main-request', mainTurnId: 'turn-A' })
  f.event({ kind: 'request-end', id: 'main-request' })
  f.event(end)
  f.event({ kind: 'draft', active: true })
  expect(isNativeClaudeCoverageSettled(f.read())).toBe(false)
  f.event({ kind: 'draft', active: false })
  f.event({ kind: 'prompt', origin: 'unclassified', submissionId: 'own-wake' })
  expect(isNativeClaudeCoverageSettled(f.read())).toBe(false)
  expect(isNativeClaudeCoverageSettled(f.read(), 'own-wake')).toBe(true)
  f.event({ kind: 'prompt', origin: 'composer', submissionId: 'queued-human' })
  expect(isNativeClaudeCoverageSettled(f.read(), 'own-wake')).toBe(false)
  f.event({ kind: 'prompt-end', id: 'own-wake', dropped: true })
  expect(f.read()?.pendingPrompts).toEqual(['queued-human'])
})

it('does not let an old Stop replay clear newer tool activity', () => {
  const f = fixture()
  const initial = f.event({ kind: 'lost' })
  const stopped = f.envelope({ kind: 'complete-stop', promptId: 'actual-stop' })
  f.replace(foldNativeClaudeCoverage(initial, stopped, false, true))
  f.event({ kind: 'tool-start', id: 'new-tool', tool: 'Bash' })
  const replay = foldNativeClaudeCoverage(f.read(), stopped, true, true)
  expect(replay.unknown).toBe(true)
  expect(replay.tools).toEqual(['new-tool'])
})

it('requires a fresh actual draft observation after an editor gap without clearing other continuity gaps', () => {
  const f = fixture()
  f.event({ kind: 'request-start', id: 'main', mainTurnId: 'turn-A' })
  f.event({ kind: 'request-end', id: 'main' })
  f.event(end)
  expect(isNativeClaudeCoverageSettled(f.read())).toBe(true)
  f.event({ kind: 'lost', stage: 'draft-read' })
  expect(isNativeClaudeCoverageSettled(f.read())).toBe(false)
  expect(f.read()?.unknown).toBe(false)
  f.event({ kind: 'draft', active: false })
  expect(isNativeClaudeCoverageSettled(f.read())).toBe(true)
  f.event({ kind: 'lost', stage: 'tool' })
  f.event({ kind: 'draft', active: false })
  expect(isNativeClaudeCoverageSettled(f.read())).toBe(false)
})

it('never treats full lead Stop as delivery of an owed background-task notification', () => {
  const f = fixture()
  f.event({ kind: 'tool-start', id: 'launch', tool: 'Agent' })
  f.event({ kind: 'tool-end', id: 'launch', task: { id: 'actual-background', kind: 'agent' } })
  f.event({ ...end, agents: [{ id: 'actual-background', status: 'completed' }] })
  const previous = f.read()
  const request = f.envelope({ kind: 'complete-stop', promptId: 'actual-complete-stop' })
  const recovered = foldNativeClaudeCoverage(previous, request, true, true)
  expect(recovered.unknown).toBe(false)
  expect(recovered.pendingTasks).toEqual([
    { id: 'actual-background', kind: 'agent', notificationOwed: true }
  ])
  expect(isNativeClaudeCoverageSettled(recovered)).toBe(false)
})

it('keeps a required model-entry control failure pinned through later draft observations', () => {
  const f = fixture()
  f.event({ kind: 'control-failed' })
  f.event({ kind: 'draft', active: false })
  expect(f.read()?.unknown).toBe(true)
  expect(isNativeClaudeCoverageSettled(f.read())).toBe(false)
})
