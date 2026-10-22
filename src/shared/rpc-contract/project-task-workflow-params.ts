import { z } from 'zod'
import { ProjectTaskIdentity } from './project-task-params'
import { WorkerStartParams } from './orchestration-worker-start-params'

export const ProjectTaskAction = ProjectTaskIdentity.extend({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  expectedExecutionHostId: z.string().min(1)
})
export const ProjectTaskDecision = ProjectTaskAction.extend({
  action: z.enum(['changes', 'integration', 'accept']),
  reason: z.string().trim().min(1).max(2000)
})
export const ProjectTaskArchive = ProjectTaskAction.extend({ archived: z.boolean() })
export const ProjectTaskMove = ProjectTaskAction.extend({
  phase: z.enum(['draft', 'active', 'review', 'done']),
  reason: z.string().trim().max(2000).default('')
})
export const ProjectTaskStop = ProjectTaskIdentity.extend({
  expectedExecutionHostId: z.string().min(1),
  dispatch: z.string().min(1).max(100)
})
export const ProjectTaskStart = ProjectTaskAction.extend({ launch: WorkerStartParams })
export const ProjectTaskRename = ProjectTaskAction.extend({
  title: z.string().trim().min(1).max(200)
})
