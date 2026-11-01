import {
  readProjectTaskScreenState,
  selectProjectTaskPresentation,
  type ProjectTaskScreenState
} from './project-task-presentation-state'
import { useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  catalogRead,
  documentsRead,
  loadProjectTaskBoard,
  PROJECT_TASK_PRESENTATION_READ_OPTIONS,
  taskRead,
  type MobileProjectTask
} from './project-task-rpc'
import {
  invalidateProjectTaskPresentation,
  projectTaskCacheKey,
  projectTaskPresentationIsFresh,
  readProjectTaskPresentation,
  saveProjectTaskPresentation,
  saveProjectTaskSelection,
  type ProjectTaskSelection
} from './project-task-presentation-cache'

export function useProjectTaskPresentation(
  client: RpcClient | null,
  connection: string,
  hostId: string
) {
  const generation = client?.getGeneration?.() ?? 0
  const owner = useRef({ client, generation, hostId })
  const [ui, setUi] = useState(() => readProjectTaskScreenState(client, hostId))
  const [refresh, setRefresh] = useState(0)
  if (
    owner.current.client !== client ||
    owner.current.generation !== generation ||
    owner.current.hostId !== hostId
  ) {
    owner.current = { client, generation, hostId }
    setUi(readProjectTaskScreenState(client, hostId))
  }
  const { project, taskId, document } = ui.selection
  const task = ui.tasks.find((item) => item.id === taskId) ?? null
  const owns = () =>
    owner.current.client === client &&
    owner.current.hostId === hostId &&
    owner.current.generation === generation &&
    generation === (client?.getGeneration?.() ?? 0)
  const patch = (next: Partial<ProjectTaskScreenState>) => {
    if (owns()) {
      setUi((previous) => ({ ...previous, ...next }))
    }
  }
  useEffect(() => {
    if (client && owns()) {
      saveProjectTaskSelection(client, hostId, ui.selection)
    }
  }, [client, generation, hostId, ui.selection])
  useEffect(() => {
    if (!client || connection !== 'connected') {
      patch({ verified: false })
      return
    }
    let current = true
    const valid = () => current && owns()
    const retainedKey = projectTaskCacheKey(
      hostId,
      project ? 'board' : 'catalog',
      project ?? undefined
    )
    if (projectTaskPresentationIsFresh(client, retainedKey)) {
      patch({ loading: false, verified: project !== null, error: '' })
      return
    }
    patch({ loading: true, verified: false, error: '' })
    void (async () => {
      if (!project) {
        const result = catalogRead.interpret(
          await catalogRead.request(client, undefined, PROJECT_TASK_PRESENTATION_READ_OPTIONS)
        )
        if (!valid()) {
          return
        }
        saveProjectTaskPresentation(client, projectTaskCacheKey(hostId, 'catalog'), {
          kind: 'catalog',
          projects: result.projects
        })
        patch({ projects: result.projects })
      } else {
        const board = await loadProjectTaskBoard(
          client,
          project,
          PROJECT_TASK_PRESENTATION_READ_OPTIONS
        )
        if (!valid()) {
          return
        }
        saveProjectTaskPresentation(client, projectTaskCacheKey(hostId, 'board', project), {
          kind: 'board',
          project,
          board
        })
        setUi((previous) => {
          const selected = board.tasks.find((item) => item.id === previous.selection.taskId)
          const old = previous.tasks.find((item) => item.id === previous.selection.taskId)
          return {
            ...previous,
            tasks: board.tasks,
            sources: board.project.sources ?? [],
            executionHostId: board.executionHostId,
            verified: true,
            selection: {
              ...previous.selection,
              taskId: selected?.id ?? null,
              document:
                selected && selected.revision === old?.revision ? previous.selection.document : null
            }
          }
        })
      }
    })()
      .catch((failure: unknown) => {
        if (valid()) {
          patch({
            error: failure instanceof Error ? failure.message : 'Could not read project tasks.'
          })
        }
      })
      .finally(() => {
        if (valid()) {
          patch({ loading: false })
        }
      })
    return () => {
      current = false
    }
  }, [client, connection, hostId, generation, project, refresh])
  useEffect(() => {
    if (!client || !project || !task || !ui.verified || connection !== 'connected') {
      return
    }
    let current = true
    const valid = () => current && owns()
    const key = projectTaskCacheKey(hostId, 'detail', project, task.id, task.revision)
    const retained = readProjectTaskPresentation(client, key)
    patch(
      retained?.kind === 'detail'
        ? { ...retained, detailRevision: retained.revision }
        : { detailRevision: '', body: '', content: '', documents: [] }
    )
    if (retained?.kind === 'detail' && projectTaskPresentationIsFresh(client, key)) {
      return
    }
    void Promise.all([
      taskRead
        .request(client, { worktree: project, id: task.id }, PROJECT_TASK_PRESENTATION_READ_OPTIONS)
        .then(taskRead.interpret),
      documentsRead
        .request(client, { worktree: project, id: task.id }, PROJECT_TASK_PRESENTATION_READ_OPTIONS)
        .then(documentsRead.interpret)
    ])
      .then(([detail, files]) => {
        if (!valid()) {
          return
        }
        if (detail.revision !== task.revision) {
          throw new Error('Task changed. Return to the board and refresh.')
        }
        const value = {
          kind: 'detail' as const,
          project,
          revision: detail.revision,
          body: detail.body,
          content: detail.content ?? '',
          documents: files.paths
        }
        saveProjectTaskPresentation(client, key, value)
        patch({ ...value, detailRevision: value.revision })
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
    ui.verified,
    refresh
  ])
  useEffect(() => {
    if (!client || !project || !task || !document || !ui.verified || connection !== 'connected') {
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
    ui.verified,
    refresh
  ])
  function refreshTasks() {
    if (!owns()) {
      return
    }
    if (client) {
      invalidateProjectTaskPresentation(client, hostId, project)
    }
    patch({ verified: false })
    setRefresh((value) => value + 1)
  }
  function setProject(next: string | null) {
    patch(selectProjectTaskPresentation(client, hostId, ui.selection, next))
  }
  function changeSelection(
    selection: Partial<ProjectTaskSelection>,
    next: Partial<ProjectTaskScreenState> = {}
  ) {
    if (!owns()) {
      return
    }
    setUi((previous) => ({
      ...previous,
      ...next,
      selection: { ...previous.selection, ...selection }
    }))
  }
  const detailCurrent = task?.revision === ui.detailRevision
  return {
    ...ui,
    body: detailCurrent ? ui.body : '',
    content: detailCurrent ? ui.content : '',
    documents: detailCurrent ? ui.documents : [],
    report: detailCurrent ? ui.report : '',
    verified: ui.verified && (!task || detailCurrent),
    task,
    project,
    document,
    refreshTasks,
    setProject,
    setTask: (next: MobileProjectTask | null) =>
      changeSelection(
        { taskId: next?.id ?? null, document: null },
        { detailRevision: '', body: '', content: '', documents: [], report: '' }
      ),
    setDocument: (next: string | null) => changeSelection({ document: next }, { report: '' }),
    setQuery: (query: string) => changeSelection({ query }),
    setPhase: (phase: string) => changeSelection({ phase }),
    setCreating: (creating: boolean) => patch({ creating }),
    setError: (error: string) => patch({ error })
  }
}
