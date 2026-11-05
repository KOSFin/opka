import type { CodexTranscriptReadBudget } from '../../shared/codex-rollout-jsonl-cursor'
import { isAbsolute, join } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { setImmediate as yieldToHost } from 'node:timers/promises'
import type { HookListenerState } from '../../shared/agent-hook-listener/listener-state'
import {
  readCodexNativeChildInventory,
  type NativeCodexChildInventory
} from '../../shared/codex-native-child-inventory'
import {
  createCodexSubagentTranscriptState,
  reconcileCodexSubagentTranscript
} from '../../shared/codex-subagent-transcript'
import type { CodexSubagentRoster } from '../../shared/codex-subagent-roster'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { readIndexedCodexRolloutPath } from '../codex/codex-indexed-rollout-path'
import { resolvePinnedCodexRolloutProof } from '../codex/codex-pinned-rollout-proof'
import { listCodexSessionJsonlFilesIncrementally } from '../codex/codex-session-file-listing'
import { readCodexRolloutSessionMetaId } from '../codex/codex-rollout-session-meta'

export type NativeCodexInventorySourceOptions = {
  launchId: string
  home: string
  isCurrent: () => boolean
}
export type NativeCodexInventorySource = {
  bindRoot: (threadId: string | null) => void
  read: (budget?: CodexTranscriptReadBudget) => NativeCodexChildInventory
  readTurn: (turnId: string, budget?: CodexTranscriptReadBudget) => boolean
  readBoundaryTurn: (
    turnId: string,
    budget?: CodexTranscriptReadBudget,
    allowedActiveTurnId?: string
  ) => boolean
  prepare: (signal: AbortSignal, budget?: CodexTranscriptReadBudget) => Promise<void>
  dispose: () => void
}
const unknown = (reason: string): NativeCodexChildInventory => ({ status: 'unverifiable', reason })

async function discover(
  home: string,
  id: string,
  signal: AbortSignal,
  budget: CodexTranscriptReadBudget
): Promise<string | null> {
  const root = join(home, 'sessions')
  const verify = async (path: string): Promise<string | null> => {
    signal.throwIfAborted()
    try {
      if (!relativePathInsideRoot(root, path)) {
        return null
      }
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) {
        return null
      }
      const [actualRoot, actualFile] = await Promise.all([realpath(root), realpath(path)])
      if (!relativePathInsideRoot(actualRoot, actualFile)) {
        return null
      }
      if (
        budget.remainingBytes < 64 * 1024 ||
        (budget.expiresAt !== undefined && performance.now() >= budget.expiresAt)
      ) {
        return null
      }
      budget.remainingBytes -= 64 * 1024
      return (await readCodexRolloutSessionMetaId(actualFile, signal)) === id ? actualFile : null
    } catch {
      signal.throwIfAborted()
      return null
    }
  }
  const indexed = readIndexedCodexRolloutPath(home, id)
  if (indexed) {
    const path = await verify(indexed)
    if (path) {
      return path
    }
  }
  return resolvePinnedCodexRolloutProof(home, id, {
    listFiles: (directory) =>
      listCodexSessionJsonlFilesIncrementally(
        directory,
        { batchSize: 64, yieldMs: 0, maxEntries: 4096, signal },
        () => {
          throw new Error('Native session source unavailable')
        }
      ),
    readSessionMetaId: async (path) => ((await verify(path)) ? id : null)
  })
}

/** Uses the hook server's existing reader caches, without inventing a pane or status row. */
export function createNativeCodexInventorySource(
  state: HookListenerState,
  options: NativeCodexInventorySourceOptions,
  release: () => void
): NativeCodexInventorySource {
  if (!isAbsolute(options.home) || !/^[A-Za-z0-9-]{1,200}$/.test(options.launchId)) {
    throw new Error('A trusted host native launch and absolute history home are required')
  }
  const key = `@native-codex-source/${options.launchId}`
  const transcript = createCodexSubagentTranscriptState(),
    roster: CodexSubagentRoster = new Map()
  const controller = new AbortController()
  let bound = false,
    sessionId: string | null = null,
    closed = false,
    path: string | null = null
  let preparing: Promise<void> | undefined
  const current = () => {
    try {
      return !closed && options.isCurrent()
    } catch {
      return false
    }
  }
  const refresh = (budget = { remainingBytes: 1024 * 1024 }) => {
    if (path && current()) {
      reconcileCodexSubagentTranscript(transcript, roster, path, budget)
    }
  }
  const read = (budget = { remainingBytes: 1024 * 1024 }): NativeCodexChildInventory => {
    if (!current() || !sessionId) {
      return unknown('native-owner-unverifiable')
    }
    if (!path) {
      return unknown('source-discovery-pending')
    }
    refresh(budget)
    return readCodexNativeChildInventory(transcript, roster, sessionId)
  }
  const start = (
    budget = { remainingBytes: 8 * 1024 * 1024 },
    parentSignal?: AbortSignal,
    discoveryOnly = false
  ): Promise<void> => {
    if (preparing) {
      return preparing
    }
    const deadline = new AbortController()
    const signal = AbortSignal.any(
      parentSignal
        ? [controller.signal, deadline.signal, parentSignal]
        : [controller.signal, deadline.signal]
    )
    let finishDeadline = () => {}
    const expires = new Promise<void>((resolve) => {
      finishDeadline = resolve
    })
    const timer = setTimeout(() => {
      deadline.abort()
      finishDeadline()
    }, 2000)
    const work = async () => {
      if (!sessionId || !current()) {
        return
      }
      path ??= await discover(options.home, sessionId, signal, budget)
      signal.throwIfAborted()
      if (!path || !current()) {
        return
      }
      state.codexSubagentTranscriptByPaneKey.set(key, transcript)
      state.codexSubagentRosterByPaneKey.set(key, roster)
      if (discoveryOnly) {
        return
      }
      for (; budget.remainingBytes > 0;) {
        signal.throwIfAborted()
        const before =
          transcript.parent.offset +
          [...transcript.subagents.values()].reduce((sum, child) => sum + child.offset, 0)
        const inventory = read(budget)
        const after =
          transcript.parent.offset +
          [...transcript.subagents.values()].reduce((sum, child) => sum + child.offset, 0)
        if (inventory.status !== 'unverifiable' || after === before) {
          return
        }
        await yieldToHost(undefined, { signal })
      }
    }
    preparing = Promise.race([work().catch(() => {}), expires]).finally(() => {
      clearTimeout(timer)
      preparing = undefined
    })
    return preparing
  }
  return {
    bindRoot(id) {
      if (bound) {
        if (id !== sessionId) {
          throw new Error('The native inventory session is already bound')
        }
        return
      }
      bound = true
      sessionId = id && /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null
      if (sessionId) {
        void start({ remainingBytes: 64 * 1024 }, undefined, true)
      }
    },
    read,
    readTurn(turnId, budget) {
      return (
        read(budget).status === 'settled' &&
        (transcript.turnEnds.has(turnId) ||
          (transcript.rootTurn.turnId === turnId && transcript.rootTurn.interrupted))
      )
    },
    readBoundaryTurn(turnId, budget, allowedActiveTurnId) {
      const inventory = read(budget)
      const ended = (id: string) =>
        transcript.turnEnds.has(id) ||
        (transcript.rootTurn.turnId === id && transcript.rootTurn.interrupted)
      const latest = transcript.rootTurn.turnId
      return (
        inventory.status === 'settled' &&
        ended(turnId) &&
        latest !== undefined &&
        (ended(latest) || latest === allowedActiveTurnId)
      )
    },
    async prepare(signal, budget = { remainingBytes: 8 * 1024 * 1024 }) {
      signal.throwIfAborted()
      const timeout = new AbortController()
      const waitSignal = AbortSignal.any([signal, timeout.signal])
      const timer = setTimeout(() => timeout.abort(), 2000)
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            cleanup()
            reject(new Error('Native inventory wait cancelled'))
          }
          const cleanup = () => waitSignal.removeEventListener('abort', abort)
          waitSignal.addEventListener('abort', abort, { once: true })
          if (waitSignal.aborted) {
            abort()
            return
          }
          if (preparing) {
            budget.remainingBytes = Math.max(0, budget.remainingBytes - 64 * 1024)
          }
          const discovery = preparing ?? Promise.resolve()
          void discovery
            .then(() => {
              waitSignal.throwIfAborted()
              return start(budget, waitSignal)
            })
            .then(
              () => {
                cleanup()
                resolve()
              },
              (error) => {
                cleanup()
                reject(error)
              }
            )
        })
      } finally {
        clearTimeout(timer)
      }
    },
    dispose() {
      if (closed) {
        return
      }
      closed = true
      controller.abort()
      state.codexSubagentTranscriptByPaneKey.delete(key)
      state.codexSubagentRosterByPaneKey.delete(key)
      release()
    }
  }
}
