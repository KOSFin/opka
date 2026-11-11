import { useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  projectTaskCacheKey,
  projectTaskPresentationIsFresh,
  readProjectTaskPresentation,
  saveProjectTaskPresentation,
  type ProjectTaskCatalogRow
} from './project-task-presentation-cache'
import {
  loadProjectTaskBoard,
  PROJECT_TASK_PRESENTATION_READ_OPTIONS,
  type MobileProjectTask
} from './project-task-rpc'

export type ProjectTaskOverviewRow = {
  project: string
  task: MobileProjectTask
}

export function useProjectTaskOverview(
  client: RpcClient | null,
  connection: string,
  hostId: string,
  projects: ProjectTaskCatalogRow[],
  selected: string[],
  limit: number,
  revision: number
) {
  const generation = client?.getGeneration?.() ?? 0
  const owner = useRef({ client, hostId, generation })
  owner.current = { client, hostId, generation }
  const [result, setResult] = useState<{
    key: string
    owner: RpcClient
    rows: ProjectTaskOverviewRow[]
    errors: string[]
  }>()
  const [loading, setLoading] = useState(false)
  const chosen = projects.filter(
    (project) =>
      project.state === 'configured' &&
      (selected.includes('*') || selected.includes(project.selector))
  )
  const key = JSON.stringify([
    hostId,
    generation,
    chosen.map((item) => [item.selector, item.name]),
    limit,
    revision
  ])
  useEffect(() => {
    if (!client || connection !== 'connected' || chosen.length === 0) {
      setLoading(false)
      return
    }
    let active = true
    const valid = () =>
      active &&
      owner.current.client === client &&
      owner.current.hostId === hostId &&
      owner.current.generation === generation &&
      (client.getGeneration?.() ?? 0) === generation &&
      client.getState() === 'connected'
    setLoading(true)
    void (async () => {
      const rows: ProjectTaskOverviewRow[] = []
      const errors: string[] = []
      for (const project of chosen.slice(0, limit)) {
        if (!valid()) {
          return
        }
        try {
          const cacheKey = projectTaskCacheKey(hostId, 'board', project.selector)
          const retained = readProjectTaskPresentation(client, cacheKey)
          const board =
            retained?.kind === 'board' && projectTaskPresentationIsFresh(client, cacheKey)
              ? retained.board
              : await loadProjectTaskBoard(
                  client,
                  project.selector,
                  PROJECT_TASK_PRESENTATION_READ_OPTIONS
                )
          if (!valid()) {
            return
          }
          saveProjectTaskPresentation(client, cacheKey, {
            kind: 'board',
            project: project.selector,
            board
          })
          rows.push(...board.tasks.map((task) => ({ project: project.selector, task })))
          setResult({ key, owner: client, rows: [...rows], errors: [...errors] })
        } catch (error) {
          if (!valid()) {
            return
          }
          errors.push(
            `${project.name}: ${error instanceof Error ? error.message : 'Could not read tasks.'}`
          )
          setResult({ key, owner: client, rows: [...rows], errors: [...errors] })
        }
      }
      if (valid()) {
        setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [client, connection, hostId, generation, key])
  return {
    rows:
      result?.key === key && result.owner === client && connection === 'connected'
        ? result.rows
        : [],
    errors:
      result?.key === key && result.owner === client && connection === 'connected'
        ? result.errors
        : [],
    loading: connection === 'connected' && loading,
    selectedCount: chosen.length
  }
}
