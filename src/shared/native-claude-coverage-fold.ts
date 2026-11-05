import type {
  NativeClaudeCoverageRequest,
  NativeClaudeCoverageState
} from './native-claude-coverage'

const terminal = (status: string) => ['completed', 'failed', 'killed'].includes(status)
const limit = 256

/** An unacknowledged gap cannot become an empty inventory; a later native complete Stop may reset it. */
export function foldNativeClaudeCoverage(
  previous: NativeClaudeCoverageState | undefined,
  request: NativeClaudeCoverageRequest,
  freshStartup: boolean,
  completeStop = false
): NativeClaudeCoverageState {
  const serialized = JSON.stringify(request.observation)
  if (
    previous &&
    previous.launchId === request.launchId &&
    previous.sessionId === request.sessionId &&
    request.generation === previous.generation &&
    request.sequence === previous.sequence &&
    serialized === previous.lastEvent
  ) {
    return previous
  }
  if (
    completeStop &&
    request.observation.kind === 'complete-stop' &&
    previous?.launchId === request.launchId &&
    previous.sessionId === request.sessionId &&
    (request.generation !== previous.generation || request.sequence > previous.sequence)
  ) {
    return {
      ...previous,
      generation: request.generation,
      sequence: request.sequence,
      lastEvent: serialized,
      unknown: false,
      tools: [],
      spawns: [],
      requests: [],
      pendingTasks: previous.pendingTasks.filter((task) => task.notificationOwed),
      liveAgents: [],
      settledTasks: [],
      mainTurn: undefined,
      currentMainTurnId: undefined
    }
  }
  const next: NativeClaudeCoverageState = previous
    ? {
        ...previous,
        tools: [...previous.tools],
        spawns: [...previous.spawns],
        requests: [...previous.requests],
        pendingTasks: previous.pendingTasks.map((task) => ({ ...task })),
        liveAgents: [...previous.liveAgents],
        settledTasks: [...previous.settledTasks],
        pendingPrompts: [...previous.pendingPrompts]
      }
    : {
        launchId: request.launchId,
        sessionId: request.sessionId,
        generation: request.generation,
        sequence: 0,
        lastEvent: '',
        unknown: !freshStartup,
        tools: [],
        spawns: [],
        requests: [],
        pendingTasks: [],
        liveAgents: [],
        settledTasks: [],
        draftActive: false,
        pendingPrompts: []
      }
  if (
    next.launchId !== request.launchId ||
    next.sessionId !== request.sessionId ||
    next.generation !== request.generation ||
    request.sequence !== next.sequence + 1
  ) {
    next.unknown = true
    return next
  }
  next.sequence = request.sequence
  next.lastEvent = serialized
  const insert = (rows: string[], value: string) => {
    if (rows.includes(value) || rows.length >= limit) {
      next.unknown = true
    } else {
      rows.push(value)
    }
  }
  const remove = (rows: string[], value: string) => {
    const index = rows.indexOf(value)
    if (index === -1) {
      next.unknown = true
    } else {
      rows.splice(index, 1)
    }
  }
  const settled = (id: string) => {
    if (!next.settledTasks.includes(id)) {
      if (next.settledTasks.length >= limit) {
        next.settledTasks.shift()
      }
      next.settledTasks.push(id)
    }
  }
  const pending = (id: string, kind: 'agent' | 'shell', notificationOwed = false) => {
    next.settledTasks = next.settledTasks.filter((value) => value !== id)
    const found = next.pendingTasks.find((task) => task.id === id)
    if (found) {
      if (notificationOwed) {
        found.notificationOwed = true
      }
      if (found.kind !== kind) {
        next.unknown = true
      }
    } else if (next.pendingTasks.length >= limit) {
      next.unknown = true
    } else {
      next.pendingTasks.push({
        id,
        kind,
        ...(notificationOwed ? { notificationOwed: true as const } : {})
      })
    }
  }
  const event = request.observation
  switch (event.kind) {
    case 'canonical-hook':
      if (event.hook.agentId && event.hook.event === 'SubagentStart') {
        pending(event.hook.agentId, 'agent')
      }
      if (event.hook.agentId && ['SubagentStop', 'StopFailure'].includes(event.hook.event)) {
        const id = event.hook.agentId
        if (!next.pendingTasks.some((task) => task.id === id) && !next.settledTasks.includes(id)) {
          next.unknown = true
        }
        next.pendingTasks = next.pendingTasks.filter(
          (task) => task.id !== id || task.notificationOwed
        )
        settled(id)
      }
      break
    case 'draft':
      next.draftUnverifiable = undefined
      next.draftActive = event.active
      break
    case 'prompt-end':
      if (event.dropped) {
        remove(next.pendingPrompts, event.id)
      }
      break
    case 'turn-start':
      if (!event.agentId) {
        next.pendingPrompts.shift()
        next.currentMainTurnId = event.id
        next.currentMainPromptId = undefined
        next.mainTurn = undefined
      }
      break
    case 'lost':
      if (event.stage === 'draft' || event.stage === 'draft-read') {
        next.draftUnverifiable = true
      } else {
        next.unknown = true
      }
      break
    case 'control-failed':
    case 'complete-stop':
      next.unknown = true
      break
    case 'tool-start':
      insert(next.tools, event.id)
      break
    case 'tool-end':
      remove(next.tools, event.id)
      if (event.task) {
        pending(event.task.id, event.task.kind, !event.agentId)
      }
      break
    case 'spawn-start':
      insert(next.spawns, event.id)
      break
    case 'spawn-end':
      remove(next.spawns, event.id)
      if (event.agentId) {
        pending(event.agentId, 'agent')
      }
      break
    case 'request-start':
      insert(next.requests, event.id)
      if (event.mainTurnId) {
        next.currentMainTurnId = event.mainTurnId
        next.mainTurn = undefined
      }
      break
    case 'request-end':
      remove(next.requests, event.id)
      break
    case 'prompt':
      if (event.submissionId) {
        insert(next.pendingPrompts, event.submissionId)
      }
      if (
        event.origin === 'task-notification' &&
        event.taskId &&
        terminal(event.taskStatus ?? '')
      ) {
        if (
          !next.pendingTasks.some((task) => task.id === event.taskId) &&
          !next.settledTasks.includes(event.taskId)
        ) {
          next.unknown = true
        } else {
          next.pendingTasks = next.pendingTasks.filter((task) => task.id !== event.taskId)
          settled(event.taskId)
        }
      }
      break
    case 'turn-end':
      if (!event.agentId) {
        if (next.sealedStop?.turnId === event.id) {
          if (next.sealedStop.reason && next.sealedStop.reason !== event.reason) {
            next.unknown = true
          } else {
            next.sealedStop = { ...next.sealedStop, reason: event.reason }
          }
        }
        if (next.currentMainTurnId && next.currentMainTurnId !== event.id) {
          next.unknown = true
        }
        if (next.currentMainTurnId === event.id) {
          next.mainTurn = { id: event.id, reason: event.reason }
        }
      }
      if (new Set(event.agents.map((agent) => agent.id)).size !== event.agents.length) {
        next.unknown = true
      }
      next.liveAgents = event.agents
        .filter((agent) => !terminal(agent.status))
        .map((agent) => agent.id)
      for (const agent of event.agents) {
        if (terminal(agent.status)) {
          settled(agent.id)
          next.pendingTasks = next.pendingTasks.filter(
            (task) => task.id !== agent.id || task.kind !== 'agent' || task.notificationOwed
          )
        }
      }
      break
  }
  return next
}

export function isNativeClaudeCoverageQuiet(
  state: NativeClaudeCoverageState | undefined,
  allowedSubmissionId?: string
): boolean {
  return (
    !!state &&
    !state.unknown &&
    !state.tools.length &&
    !state.spawns.length &&
    !state.requests.length &&
    !state.pendingTasks.length &&
    !state.liveAgents.length &&
    !state.draftActive &&
    !state.draftUnverifiable &&
    state.pendingPrompts.every((id) => id === allowedSubmissionId)
  )
}

export function isNativeClaudeCoverageSettled(
  state: NativeClaudeCoverageState | undefined,
  allowedSubmissionId?: string
): boolean {
  return isNativeClaudeCoverageQuiet(state, allowedSubmissionId) && !!state?.mainTurn
}
