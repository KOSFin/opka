import { useCallback, useEffect, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ProjectTaskBoard } from '../../../../shared/project-task-board'
import { cachedProjectTaskBoard, readProjectTaskBoard } from './project-task-client'
import { subscribeRuntimeRpc } from '@/runtime/runtime-rpc-subscribe'
import { projectTaskError } from './project-task-projects'

export function useProjectTaskBoard(target: RuntimeClientTarget | null, worktree: string) {
  const key = JSON.stringify([target, worktree])
  const [loaded, setLoaded] = useState<{ key: string; board: ProjectTaskBoard } | null>(null)
  const board =
    loaded?.key === key
      ? loaded.board
      : target
        ? (cachedProjectTaskBoard(target, worktree) ?? null)
        : null
  const ready = !!board
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const [connectionRevision, setConnectionRevision] = useState(0)
  const reload = useCallback(() => setRevision((value) => value + 1), [])
  const refresh = useCallback(() => {
    reload()
    setConnectionRevision((value) => value + 1)
  }, [reload])
  useEffect(() => {
    if (!target || !worktree) {
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    void readProjectTaskBoard(target, worktree)
      .then((result) => {
        if (!cancelled) {
          setLoaded({ key, board: result })
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(projectTaskError(cause))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [target, worktree, key, revision])
  useEffect(() => {
    if (!target || !worktree || !ready) {
      return
    }
    let disposed = false
    let release: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    void subscribeRuntimeRpc(
      target,
      'projectTask.watch',
      { worktree },
      {
        onEvent: (event) => {
          if (
            disposed ||
            typeof event !== 'object' ||
            event === null ||
            !('type' in event) ||
            event.type !== 'changed'
          ) {
            return
          }
          clearTimeout(timer)
          timer = setTimeout(reload, 150)
        },
        onError: () => {
          if (!disposed) {
            setError(
              'Live updates unavailable. Refresh to reconnect; execution state has not been inferred.'
            )
          }
        },
        onClose: () => {
          if (!disposed) {
            setError('Task connection closed. Refresh to reconnect.')
          }
        }
      }
    )
      .then((subscription) => {
        if (disposed) {
          subscription.unsubscribe()
        } else {
          release = subscription.unsubscribe
        }
      })
      .catch(() => {
        if (!disposed) {
          setError(
            'This host does not support live project tasks. Update the host or refresh manually.'
          )
        }
      })
    return () => {
      disposed = true
      clearTimeout(timer)
      release?.()
    }
  }, [target, worktree, ready, reload, connectionRevision])
  return { board, error, loading, refresh }
}
