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
export const ProjectTaskClaim = ProjectTaskAction.extend({
  from: z.string().min(1).max(4096).optional()
})
export const ProjectTaskProgress = ProjectTaskClaim.extend({
  attempt: z.string().uuid(),
  checkpoint: z.string().trim().min(1).max(10000),
  blocker: z.string().trim().min(1).max(2000).optional(),
  release: z.boolean().optional()
})
export const ProjectTaskComplete = ProjectTaskProgress.extend({
  report: z.string().trim().min(1).max(64000)
}).refine(
  (value) => !value.blocker && !value.release,
  'A blocked or released attempt cannot submit a completed result'
)
export const ProjectTaskDocuments = ProjectTaskIdentity.extend({
  path: z.string().min(1).max(1024).optional()
})
export const ProjectTaskAgentIntegration = ProjectTaskAction.omit({ id: true, revision: true })
