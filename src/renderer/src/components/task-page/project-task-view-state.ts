import { z } from 'zod'

const KEY = 'orca.projectTask.view.v2'
const ViewState = z.object({
  workspace: z.string().max(8192).default(''),
  projectKeys: z.array(z.string().max(8192)).max(1000).optional(),
  selected: z.string().max(8192).default(''),
  mode: z.enum(['list', 'tree', 'board']).default('board'),
  collapsed: z.array(z.string().max(8192)).max(1000).default([]),
  query: z.string().max(8192).default(''),
  repo: z.string().max(8192).default('*'),
  source: z.string().max(8192).default('*'),
  archived: z.boolean().default(false),
  attention: z.boolean().default(false),
  listScrollTop: z.number().finite().nonnegative().default(0),
  boardScrollLeft: z.number().finite().nonnegative().default(0)
})
export type ProjectTaskViewState = Omit<z.infer<typeof ViewState>, 'projectKeys'> & {
  projectKeys: string[]
}
export function readProjectTaskView(): ProjectTaskViewState {
  try {
    const parsed = ViewState.safeParse(JSON.parse(window.localStorage.getItem(KEY) ?? '{}'))
    if (parsed.success) {
      return {
        ...parsed.data,
        projectKeys:
          parsed.data.projectKeys ??
          (parsed.data.workspace && parsed.data.workspace !== '*' ? [parsed.data.workspace] : ['*'])
      }
    }
  } catch {
    /* Storage is optional presentation state. */
  }
  return {
    workspace: '',
    projectKeys: ['*'],
    selected: '',
    mode: 'board',
    collapsed: [],
    query: '',
    repo: '*',
    source: '*',
    archived: false,
    attention: false,
    listScrollTop: 0,
    boardScrollLeft: 0
  }
}
export function saveProjectTaskView(patch: Partial<ProjectTaskViewState>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...readProjectTaskView(), ...patch }))
  } catch {
    /* A read-only client can still use the task view. */
  }
}
