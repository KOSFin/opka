import type { CodexTranscriptReadBudget } from '../../shared/codex-rollout-jsonl-cursor'
import { randomUUID } from 'node:crypto'
import type {
  NativeCodexInventorySource,
  NativeCodexInventorySourceOptions
} from '../agent-hooks/native-codex-inventory-source'

type RootTurn = { threadId: string; turnId: string }
export type NativeCodexRootContext = { settledPrevious: boolean; previousTurn?: RootTurn }
type Root = { source?: NativeCodexInventorySource; previousTurn?: string }

/** Bounded immutable transcript readers belong to the capability, never to fabricated pane rows. */
export class NativeCodexRootInventory {
  private readonly roots = new Map<string, Root>()
  private current: string | null = null
  private turnId: string | null = null
  private unknown = false
  private closed = false
  constructor(
    private readonly options: {
      home: string
      launchId: string
      isCurrent: () => boolean
      register: (options: NativeCodexInventorySourceOptions) => NativeCodexInventorySource
    }
  ) {}
  bindRoot = (threadId: string | null, context?: NativeCodexRootContext): void => {
    if (this.closed) {
      return
    }
    if (!threadId) {
      this.unknown = true
      return
    }
    if (context?.settledPrevious) {
      for (const [id, root] of this.roots) {
        if (id !== threadId) {
          root.source?.dispose()
          this.roots.delete(id)
        }
      }
    } else if (context?.previousTurn) {
      const previous = this.roots.get(context.previousTurn.threadId)
      if (previous) {
        previous.previousTurn = context.previousTurn.turnId
      } else {
        this.unknown = true
      }
    }
    if (!this.roots.has(threadId)) {
      if (this.roots.size >= 64) {
        throw new Error('Native ROOT inventory capacity is unavailable.')
      }
      this.roots.set(threadId, {})
    }
    if (this.current !== threadId) {
      this.turnId = null
    }
    this.current = threadId
    this.source(threadId)
  }
  private source(id: string): NativeCodexInventorySource | undefined {
    const root = this.roots.get(id)
    if (!root || this.closed) {
      return undefined
    }
    if (!root.source) {
      try {
        const source = this.options.register({
          launchId: `${this.options.launchId}-${randomUUID()}`,
          home: this.options.home,
          isCurrent: () => !this.closed && this.roots.get(id) === root && this.options.isCurrent()
        })
        root.source = source
        source.bindRoot(id)
      } catch {
        return undefined
      }
    }
    return root.source
  }
  acceptTurn = (threadId: string, turnId: string): void => {
    if (!this.closed && threadId === this.current) {
      this.turnId = turnId
    }
  }
  expectedSessionId = (): string | null => this.current
  retainedSettled = (
    turns?: readonly RootTurn[],
    suppliedBudget?: CodexTranscriptReadBudget,
    nextTurn?: RootTurn
  ): boolean => {
    if (this.closed || this.unknown || !this.options.isCurrent()) {
      return false
    }
    const required =
      turns ??
      [...this.roots].flatMap(([threadId, root]) =>
        threadId !== this.current ? [{ threadId, turnId: root.previousTurn }] : []
      )
    const budget = suppliedBudget ?? { remainingBytes: 1024 * 1024 }
    for (const root of required) {
      if (
        !root.turnId ||
        !this.source(root.threadId)?.readBoundaryTurn(
          root.turnId,
          budget,
          nextTurn?.threadId === root.threadId ? nextTurn.turnId : undefined
        )
      ) {
        return false
      }
    }
    return true
  }
  currentChildrenSettled = (budget?: CodexTranscriptReadBudget): boolean => {
    return (
      !!this.current &&
      !this.unknown &&
      this.retainedSettled(undefined, budget) &&
      this.source(this.current)?.read(budget).status === 'settled'
    )
  }
  currentMainSettled = (): boolean => {
    return (
      !!this.current &&
      !!this.turnId &&
      !this.closed &&
      !this.unknown &&
      this.options.isCurrent() &&
      this.source(this.current)?.readBoundaryTurn(this.turnId) === true
    )
  }
  completedBoundary = (nextTurn?: RootTurn) => {
    const root = this.current,
      turn = this.turnId
    return {
      canSwitch: () =>
        !!root &&
        !!turn &&
        this.current === root &&
        this.turnId === turn &&
        this.retainedSettled() &&
        this.source(root)?.readBoundaryTurn(
          turn,
          undefined,
          nextTurn?.threadId === root ? nextTurn.turnId : undefined
        ) === true,
      onBoundaryAccepted: () => {}
    }
  }
  async prepare(signal: AbortSignal, suppliedBudget?: CodexTranscriptReadBudget): Promise<void> {
    signal.throwIfAborted()
    const deadline = new AbortController()
    const bounded = AbortSignal.any([signal, deadline.signal])
    const timeout = Math.max(
      0,
      Math.min(2000, (suppliedBudget?.expiresAt ?? performance.now() + 2000) - performance.now())
    )
    const timer = setTimeout(() => deadline.abort(), timeout)
    const budget = suppliedBudget ?? {
      remainingBytes: 8 * 1024 * 1024,
      expiresAt: performance.now() + 2000
    }
    try {
      if (budget.expiresAt !== undefined && budget.expiresAt <= performance.now()) {
        budget.remainingBytes = 0
      }
      for (const id of this.roots.keys()) {
        bounded.throwIfAborted()
        if (this.closed || budget.remainingBytes <= 0) {
          return
        }
        await this.source(id)?.prepare(bounded, budget)
      }
    } finally {
      clearTimeout(timer)
    }
  }
  dispose = (): void => {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const root of this.roots.values()) {
      root.source?.dispose()
    }
    this.roots.clear()
  }
}
