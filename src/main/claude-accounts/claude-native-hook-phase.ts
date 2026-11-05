import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

type Boundary = { canSwitch: () => boolean; onBoundaryAccepted: () => void }
export type ClaudeNativeWake = { phaseId: string; step: 1 | 2; marker: string }
type Selection<T> = { accountId: string; snapshot: T }
type Phase<T> = {
  id: string
  promptId: string
  owner: string
  policy: string
  boundary: Boundary
  selection?: Selection<T>
  state: 'preparing' | 'ready' | 'wake-one' | 'publishing' | 'published' | 'wake-two'
}

/** Admission state only: canonical status, children and process ownership remain host-owned. */
export function createClaudeNativeHookPhase<T>(options: {
  readOwner: () => string | null
  readPolicy: () => string | null
  readBoundary: () => Boundary
  readCompletedSuccessfully: () => boolean
  select: (excludedAccountIds: ReadonlySet<string>) => Promise<Selection<T>>
  publish: (snapshot: T, canSwitch: () => boolean) => Promise<void>
}) {
  const secret = randomBytes(32)
  const attempted = new Set<string>()
  let phase: Phase<T> | undefined
  let disposed = false
  let activePromptId: string | undefined
  let lastFailurePromptId: string | undefined
  const waiters = new Set<() => void>()
  const notify = () => {
    for (const waiter of waiters) {
      waiter()
    }
  }
  const signature = (id: string, step: number) =>
    createHmac('sha256', secret).update(`${id}:${step}`).digest('hex')
  const wake = (held: Phase<T>, step: 1 | 2): ClaudeNativeWake => ({
    phaseId: held.id,
    step,
    marker: `<opka-native-wake:v1:${held.id}:${step}:${signature(held.id, step)}>`
  })
  const parse = (text: string): { phaseId: string; step: number } | null => {
    const matches = [
      ...text.matchAll(/<opka-native-wake:v1:([a-f0-9-]{36}):([12]):([a-f0-9]{64})>/g)
    ]
    if (matches.length !== 1) {
      return null
    }
    const match = matches[0]
    const expected = Buffer.from(signature(match[1], Number(match[2])), 'hex')
    const actual = Buffer.from(match[3], 'hex')
    return timingSafeEqual(actual, expected) ? { phaseId: match[1], step: Number(match[2]) } : null
  }
  const current = (held: Phase<T>) =>
    !disposed &&
    phase === held &&
    options.readOwner() === held.owner &&
    options.readPolicy() === held.policy
  return {
    async failure(promptId: string, currentAccountId: string): Promise<string | null> {
      if (disposed || !promptId || !currentAccountId || promptId !== activePromptId) {
        return null
      }
      if (phase?.promptId === promptId) {
        return phase.id
      }
      if (lastFailurePromptId === promptId) {
        return null
      }
      const owner = options.readOwner()
      const policy = options.readPolicy()
      const boundary = options.readBoundary()
      if (!owner || !policy || !boundary.canSwitch() || attempted.size >= 128) {
        return null
      }
      attempted.add(currentAccountId)
      lastFailurePromptId = promptId
      const held: Phase<T> = {
        id: randomUUID(),
        promptId,
        owner,
        policy,
        boundary,
        state: 'preparing'
      }
      phase = held
      try {
        const selection = await options.select(new Set(attempted))
        if (!current(held) || attempted.has(selection.accountId) || !held.boundary.canSwitch()) {
          if (phase === held) {
            phase = undefined
            notify()
          }
          return null
        }
        held.selection = selection
        held.state = 'ready'
        return held.id
      } catch {
        if (phase === held) {
          phase = undefined
          notify()
        }
        return null
      }
    },
    /** Each helper must claim immediately before exiting 2; cancelled helpers exit 0. */
    claimWake(phaseId: string, step: 1 | 2): ClaudeNativeWake | null {
      const held = phase
      if (!held || held.id !== phaseId || !current(held)) {
        return null
      }
      if (step === 1 && held.state === 'ready') {
        held.state = 'wake-one'
        return wake(held, 1)
      }
      if (step === 2 && held.state === 'published') {
        held.state = 'wake-two'
        return wake(held, 2)
      }
      return null
    },
    async freshWake(promptText: string, signal?: AbortSignal): Promise<ClaudeNativeWake | null> {
      const marker = parse(promptText)
      const held = phase
      if (
        !marker ||
        marker.step !== 1 ||
        !held ||
        marker.phaseId !== held.id ||
        waiters.size >= 128
      ) {
        return null
      }
      const stopped = AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])])
      return new Promise((resolve) => {
        const finish = (result: ClaudeNativeWake | null) => {
          waiters.delete(check)
          stopped.removeEventListener('abort', abort)
          resolve(result)
        }
        const check = () => {
          if (stopped.aborted || !current(held)) {
            finish(null)
          } else if (held.state === 'published') {
            held.state = 'wake-two'
            finish(wake(held, 2))
          } else if (held.state === 'wake-two') {
            finish(null)
          }
        }
        const abort = () => finish(null)
        waiters.add(check)
        stopped.addEventListener('abort', abort, { once: true })
        check()
      })
    },
    async prompt(
      promptId: string,
      promptText: string,
      isCallCurrent: () => boolean
    ): Promise<'allow' | 'block'> {
      if (disposed) {
        return 'block'
      }
      const marker = parse(promptText)
      if (!marker) {
        if (promptId === activePromptId) {
          return 'allow'
        }
        attempted.clear()
        lastFailurePromptId = undefined
        phase = undefined
        activePromptId = promptId
        notify()
        return 'allow'
      }
      const held = phase
      if (!held || marker.phaseId !== held.id || !current(held) || !isCallCurrent()) {
        return 'block'
      }
      if (marker.step === 2) {
        if (held.state !== 'wake-two') {
          return 'block'
        }
        phase = undefined
        activePromptId = promptId
        notify()
        return 'allow'
      }
      if (held.state !== 'wake-one' || !held.selection) {
        return 'block'
      }
      held.state = 'publishing'
      try {
        await options.publish(
          held.selection.snapshot,
          () => current(held) && isCallCurrent() && held.boundary.canSwitch()
        )
        if (!current(held) || !isCallCurrent()) {
          return 'block'
        }
        held.boundary.onBoundaryAccepted()
        held.state = 'published'
        notify()
      } catch {
        if (phase === held) {
          phase = undefined
          notify()
        }
      }
      return 'block'
    },
    completed(): void {
      if (!disposed && options.readCompletedSuccessfully()) {
        phase = undefined
        attempted.clear()
        lastFailurePromptId = undefined
        notify()
      }
    },
    dispose(): void {
      disposed = true
      phase = undefined
      attempted.clear()
      secret.fill(0)
      notify()
    }
  }
}
