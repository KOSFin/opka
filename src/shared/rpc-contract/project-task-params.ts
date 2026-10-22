import { z } from 'zod'
import { PROJECT_TASK_DOCUMENT_MAX_BYTES } from '../project-task-contract'

export const ProjectTaskTarget = z.object({ worktree: z.string().min(1).max(4096) })
export const ProjectTaskList = ProjectTaskTarget.extend({
  offset: z.number().int().min(0).max(1000).default(0),
  limit: z.number().int().min(1).max(100).default(50)
})
export const ProjectTaskIdentity = ProjectTaskTarget.extend({ id: z.string().min(1).max(80) })
export const ProjectTaskInit = ProjectTaskTarget.extend({
  content: z.string().max(PROJECT_TASK_DOCUMENT_MAX_BYTES).optional(),
  expectedExecutionHostId: z.string().min(1)
})
export const ProjectTaskCreate = ProjectTaskTarget.extend({
  source: z.string().min(1).max(64),
  slug: z.string().min(1).max(80),
  content: z.string().max(PROJECT_TASK_DOCUMENT_MAX_BYTES),
  expectedExecutionHostId: z.string().min(1)
})
export const ProjectTaskUpdate = ProjectTaskIdentity.extend({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string().max(PROJECT_TASK_DOCUMENT_MAX_BYTES),
  expectedExecutionHostId: z.string().min(1)
})
