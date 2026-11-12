import { z } from 'zod'
import { ProjectTaskAction } from './project-task-workflow-params'
import {
  PROJECT_TASK_DELEGATION_CAPABILITY,
  PROJECT_TASK_PROJECT_AGENTS_CAPABILITY,
  TaskDelegationAction
} from '../project-task-delegation'
export const TaskPolicyTarget = z
  .object({
    worktree: z.string().min(1).max(4096),
    expectedExecutionHostId: z.string().min(1).max(256),
    capability: z.union([
      z.literal(PROJECT_TASK_DELEGATION_CAPABILITY),
      z.literal(PROJECT_TASK_PROJECT_AGENTS_CAPABILITY)
    ])
  })
  .strict()
export const TaskPolicyPropose = TaskPolicyTarget.extend({
  expectedGeneration: z.number().int().nonnegative(),
  grant: z
    .union([
      z
        .object({
          grantee: z.string().min(1).max(4096),
          actions: z.array(TaskDelegationAction).min(1).max(4),
          runId: z.string().min(1).max(256).nullable(),
          taskIds: z.array(z.string().min(1).max(256)).min(1).max(1000).nullable(),
          expiresAt: z.number().int().positive()
        })
        .strict(),
      z.object({ mode: z.literal('project-agents') }).strict()
    ])
    .nullable()
}).strict()
export const TaskPolicyConfirm = TaskPolicyTarget.extend({
  proposal: z.string().uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().uuid()
}).strict()
export const TaskDelegatedApproval = ProjectTaskAction.extend({
  capability: z.literal(PROJECT_TASK_DELEGATION_CAPABILITY),
  requestId: z.string().uuid(),
  from: z.string().min(1).max(4096).optional()
}).strict()

export const TaskDelegationRead = TaskPolicyTarget.extend({
  id: z.string().min(1).max(256),
  from: z.string().min(1).max(4096).optional()
}).strict()
