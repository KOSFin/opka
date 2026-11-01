import { useRef } from 'react'
import type { ListAndDetailEffectsModel } from './use-mobile-tasks-list-and-detail-effects'
import { useEffect } from './mobile-tasks-dependencies'
import {
  githubAssignableUserListRead,
  githubRepoLabelListRead
} from './mobile-task-item-detail-operations'
import { detailPayloadBody } from './mobile-tasks-provider-detail-types'

type MetadataInput = Pick<
  ListAndDetailEffectsModel,
  | 'actionItem'
  | 'client'
  | 'detailPayload'
  | 'setItemAssignableUsers'
  | 'setItemAssignableUsersError'
  | 'setItemAssignableUsersLoading'
  | 'setItemAvailableLabels'
  | 'setItemBodyDraft'
  | 'setItemLabelsError'
  | 'setItemLabelsLoading'
  | 'tasksSupported'
>
export function useMobileTasksItemDetailMetadataEffects<Model extends MetadataInput>(model: Model) {
  const {
    actionItem,
    client,
    detailPayload,
    setItemAssignableUsers,
    setItemAssignableUsersError,
    setItemAssignableUsersLoading,
    setItemAvailableLabels,
    setItemBodyDraft,
    setItemLabelsError,
    setItemLabelsLoading,
    tasksSupported
  } = model
  const lastBody = useRef<{
    client: typeof client
    key: string | undefined
    generation: number
    body: string
  } | null>(null)
  useEffect(() => {
    if (!detailPayload) {
      return
    }
    const previous = lastBody.current
    const generation = client?.getGeneration?.() ?? 0
    const sameOwner =
      previous?.client === client &&
      previous?.key === actionItem?.key &&
      previous?.generation === generation
    const body = detailPayloadBody(detailPayload)
    setItemBodyDraft((draft) => (!sameOwner || draft === previous?.body ? body : draft))
    lastBody.current = { client, key: actionItem?.key, generation, body }
  }, [detailPayload])

  useEffect(() => {
    if (!tasksSupported || !client || actionItem?.provider !== 'github') {
      setItemAvailableLabels([])
      setItemLabelsLoading(false)
      setItemLabelsError('')
      setItemAssignableUsers([])
      setItemAssignableUsersLoading(false)
      setItemAssignableUsersError('')
      return
    }

    let stale = false
    if (actionItem.source.type === 'issue' || actionItem.source.type === 'pr') {
      setItemAvailableLabels([])
      setItemLabelsError('')
      setItemLabelsLoading(true)
      void githubRepoLabelListRead
        .request(client, { repo: `id:${actionItem.source.repoId}` }, { timeoutMs: 30_000 })
        .then((response) => {
          if (stale) {
            return
          }
          setItemAvailableLabels(githubRepoLabelListRead.interpret(response))
        })
        .catch((err) => {
          if (!stale) {
            setItemLabelsError(err instanceof Error ? err.message : 'Failed to load labels')
          }
        })
        .finally(() => {
          if (!stale) {
            setItemLabelsLoading(false)
          }
        })
    } else {
      setItemAvailableLabels([])
      setItemLabelsLoading(false)
      setItemLabelsError('')
    }

    setItemAssignableUsers([])
    setItemAssignableUsersError('')
    setItemAssignableUsersLoading(true)
    void githubAssignableUserListRead
      .request(client, { repo: `id:${actionItem.source.repoId}` }, { timeoutMs: 30_000 })
      .then((response) => {
        if (stale) {
          return
        }
        setItemAssignableUsers(githubAssignableUserListRead.interpret(response))
      })
      .catch((err) => {
        if (!stale) {
          setItemAssignableUsersError(
            err instanceof Error ? err.message : 'Failed to load assignees'
          )
        }
      })
      .finally(() => {
        if (!stale) {
          setItemAssignableUsersLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [actionItem, client, tasksSupported])
  return model
}

export type ItemDetailMetadataEffectsModel = ListAndDetailEffectsModel
