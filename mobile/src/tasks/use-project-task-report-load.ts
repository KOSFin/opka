import { useEffect } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ProjectTaskScreenState } from './project-task-presentation-state'
import type { MobileProjectTask } from './project-task-rpc'
import { documentsRead, PROJECT_TASK_PRESENTATION_READ_OPTIONS } from './project-task-rpc'
import {
  projectTaskCacheKey,
  projectTaskPresentationIsFresh,
  readProjectTaskPresentation,
  saveProjectTaskPresentation
} from './project-task-presentation-cache'

type ReportLoad = {
  client: RpcClient | null
  connection: string
  hostId: string
  generation: number
  project: string | null
  task: MobileProjectTask | null
  document: string | null
  verified: boolean
  refresh: number
  owns: () => boolean
  patch: (next: Partial<ProjectTaskScreenState>) => void
}

export function useProjectTaskReportLoad({
  client,
  connection,
  hostId,
  generation,
  project,
  task,
  document,
  verified,
  refresh,
  owns,
  patch
}: ReportLoad): void {
  useEffect(() => {
    if (!client || !project || !task || !document || !verified || connection !== 'connected') {
      return
    }
    let current = true
    const valid = () => current && owns()
    const key = projectTaskCacheKey(hostId, 'report', project, task.id, task.revision, document)
    const retained = readProjectTaskPresentation(client, key)
    if (retained?.kind === 'report') {
      patch({ report: retained.report })
    }
    if (retained?.kind === 'report' && projectTaskPresentationIsFresh(client, key)) {
      return
    }
    void documentsRead
      .request(
        client,
        { worktree: project, id: task.id, path: document },
        PROJECT_TASK_PRESENTATION_READ_OPTIONS
      )
      .then(documentsRead.interpret)
      .then((result) => {
        if (!valid()) {
          return
        }
        const report = result.content ?? ''
        saveProjectTaskPresentation(client, key, { kind: 'report', project, report })
        patch({ report })
      })
      .catch((failure: unknown) => {
        if (valid()) {
          patch({ error: String(failure) })
        }
      })
    return () => {
      current = false
    }
  }, [
    client,
    connection,
    hostId,
    generation,
    project,
    task?.id,
    task?.revision,
    document,
    verified,
    refresh
  ])
}
