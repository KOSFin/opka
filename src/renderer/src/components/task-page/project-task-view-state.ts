import { z } from 'zod'

const KEY = 'orca.projectTask.view.v2'
const ViewState = z.object({
  workspace: z.string().max(8192).default(''),
  selected: z.string().max(8192).default(''),
  mode: z.enum(['list', 'tree', 'board']).default('board'),
  collapsed: z.array(z.string().max(8192)).max(1000).default([])
})
export type ProjectTaskViewState = z.infer<typeof ViewState>
export function readProjectTaskView(): ProjectTaskViewState {
  try {
    const parsed = ViewState.safeParse(JSON.parse(window.localStorage.getItem(KEY) ?? '{}'))
    if (parsed.success) {
      return parsed.data
    }
  } catch {
    /* Storage is optional presentation state. */
  }
  return { workspace: '', selected: '', mode: 'board', collapsed: [] }
}
export function saveProjectTaskView(patch: Partial<ProjectTaskViewState>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...readProjectTaskView(), ...patch }))
  } catch {
    /* A read-only client can still use the task view. */
  }
}
