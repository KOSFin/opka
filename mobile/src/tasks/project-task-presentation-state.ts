import type { RpcClient } from '../transport/rpc-client'
import type { MobileProjectTask } from './project-task-rpc'
import {
  projectTaskCacheKey,
  readProjectTaskPresentation,
  readProjectTaskSelection,
  type ProjectTaskCatalogRow,
  type ProjectTaskSelection
} from './project-task-presentation-cache'

export type ProjectTaskScreenState = {
  projects: ProjectTaskCatalogRow[]
  catalogTruncated: boolean
  selection: ProjectTaskSelection
  tasks: MobileProjectTask[]
  executionHostId: string
  sources: { id: string; path: string }[]
  detailRevision: string
  body: string
  content: string
  documents: string[]
  report: string
  loading: boolean
  verified: boolean
  error: string
  creating: boolean
}
export function readProjectTaskScreenState(
  client: RpcClient | null,
  hostId: string
): ProjectTaskScreenState {
  const selection = readProjectTaskSelection(client, hostId)
  const catalog = readProjectTaskPresentation(client, projectTaskCacheKey(hostId, 'catalog'))
  const board = selection.project
    ? readProjectTaskPresentation(client, projectTaskCacheKey(hostId, 'board', selection.project))
    : null
  const task =
    board?.kind === 'board' ? board.board.tasks.find((item) => item.id === selection.taskId) : null
  const detail =
    task && selection.project
      ? readProjectTaskPresentation(
          client,
          projectTaskCacheKey(hostId, 'detail', selection.project, task.id, task.revision)
        )
      : null
  const report =
    task && selection.project && selection.document
      ? readProjectTaskPresentation(
          client,
          projectTaskCacheKey(
            hostId,
            'report',
            selection.project,
            task.id,
            task.revision,
            selection.document
          )
        )
      : null
  return {
    projects: catalog?.kind === 'catalog' ? catalog.projects : [],
    catalogTruncated: catalog?.kind === 'catalog' ? catalog.truncated : false,
    selection,
    tasks: board?.kind === 'board' ? board.board.tasks : [],
    executionHostId: board?.kind === 'board' ? board.board.executionHostId : '',
    sources: board?.kind === 'board' ? (board.board.project.sources ?? []) : [],
    detailRevision: detail?.kind === 'detail' ? detail.revision : '',
    body: detail?.kind === 'detail' ? detail.body : '',
    content: detail?.kind === 'detail' ? detail.content : '',
    documents: detail?.kind === 'detail' ? detail.documents : [],
    report: report?.kind === 'report' ? report.report : '',
    loading: false,
    verified: false,
    error: '',
    creating: false
  }
}

export function selectProjectTaskPresentation(
  client: RpcClient | null,
  hostId: string,
  previousSelection: ProjectTaskSelection,
  project: string | null
): Partial<ProjectTaskScreenState> {
  const board = project
    ? readProjectTaskPresentation(client, projectTaskCacheKey(hostId, 'board', project))
    : null
  return {
    selection: { ...previousSelection, project, taskId: null, document: null },
    tasks: board?.kind === 'board' ? board.board.tasks : [],
    sources: board?.kind === 'board' ? (board.board.project.sources ?? []) : [],
    executionHostId: board?.kind === 'board' ? board.board.executionHostId : '',
    verified: false,
    detailRevision: '',
    body: '',
    content: '',
    documents: [],
    report: ''
  }
}
