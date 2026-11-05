export const STRUCTURED_AGENT_INACTIVE_RESIDENT_LIMIT = 4
const MAX_REST_ATTEMPTS_PER_PASS = 16

export type InactiveStructuredResident = {
  sessionId: string
  child: object
  revision: number | undefined
  lastActivityAt: number
  assertCurrent?: () => void
}

/** Limits only positively restable, unobserved children; active work has no residency budget. */
export class StructuredAgentSessionResidentBudget {
  private running: Promise<void> | null = null
  private disposed = false

  constructor(
    private readonly deps: {
      candidates: () => InactiveStructuredResident[]
      serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
      rest: (sessionId: string) => Promise<void>
      stillResident: (candidate: InactiveStructuredResident) => boolean
      failed: (error: unknown) => void
    }
  ) {}

  dispose(): void {
    this.disposed = true
  }

  tick = (): Promise<void> => {
    if (this.disposed) {
      return Promise.resolve()
    }
    if (this.running) {
      return this.running
    }
    const run = Promise.resolve()
      .then(() => this.trim())
      .catch(this.deps.failed)
    this.running = run.finally(() => {
      this.running = null
    })
    return this.running
  }

  private async trim(): Promise<void> {
    const attempted = new Set<string>()
    const unproven = new Map<string, InactiveStructuredResident>()
    const read = () => {
      const rows = new Map(this.deps.candidates().map((row) => [row.sessionId, row]))
      for (const row of unproven.values()) {
        if (this.deps.stillResident(row) && !rows.has(row.sessionId)) {
          rows.set(row.sessionId, row)
        }
      }
      return [...rows.values()]
    }
    while (!this.disposed && attempted.size < MAX_REST_ATTEMPTS_PER_PASS) {
      const candidates = read()
      if (candidates.length <= STRUCTURED_AGENT_INACTIVE_RESIDENT_LIMIT) {
        return
      }
      const oldest = candidates
        .filter((row) => !attempted.has(row.sessionId))
        .sort(
          (a, b) => a.lastActivityAt - b.lastActivityAt || a.sessionId.localeCompare(b.sessionId)
        )[0]
      if (!oldest) {
        return
      }
      attempted.add(oldest.sessionId)
      try {
        await this.deps.serialize(oldest.sessionId, async () => {
          if (this.disposed) {
            return
          }
          const current = read()
          const same = current.find((row) => row.sessionId === oldest.sessionId)
          if (
            current.length <= STRUCTURED_AGENT_INACTIVE_RESIDENT_LIMIT ||
            same?.child !== oldest.child ||
            same.revision !== oldest.revision ||
            same.lastActivityAt !== oldest.lastActivityAt
          ) {
            return
          }
          oldest.assertCurrent?.()
          try {
            await this.deps.rest(oldest.sessionId)
          } finally {
            if (this.deps.stillResident(oldest)) {
              unproven.set(oldest.sessionId, oldest)
            }
          }
        })
      } catch (error) {
        this.deps.failed(error)
      }
    }
  }
}
