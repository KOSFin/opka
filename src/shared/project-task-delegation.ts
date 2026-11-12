import { z } from 'zod'

export const PROJECT_TASK_DELEGATION_CAPABILITY = 'project-task-delegation-v1'
export const PROJECT_TASK_PROJECT_AGENTS_CAPABILITY = 'project-task-project-agents-v2'
export const TaskDelegationAction = z.enum([
  'approve-plan',
  'request-changes',
  'send-to-integration',
  'accept-result'
])
export const TaskDelegationActor = z
  .object({
    key: z.string().min(1).max(256),
    aliases: z.array(z.string().min(1).max(256)).min(1).max(8)
  })
  .strict()
export const TaskDelegationBinding = z
  .object({
    installationId: z.string().min(1).max(256),
    machineBinding: z.string().min(1).max(256),
    projectId: z.string().min(1).max(256),
    root: z.string().min(1).max(4096),
    configRevision: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
const SessionTaskDelegationGrant = z
  .object({
    schema: z.literal(1),
    binding: TaskDelegationBinding,
    actor: TaskDelegationActor,
    actorAddress: z.string().min(1).max(4096),
    actions: z.array(TaskDelegationAction).min(1).max(4),
    runId: z.string().min(1).max(256).nullable(),
    taskIds: z.array(z.string().min(1).max(256)).min(1).max(1000).nullable(),
    expiresAt: z.number().int().positive(),
    generation: z.number().int().nonnegative()
  })
  .strict()
export const ProjectAgentsTaskDelegationGrant = z
  .object({
    schema: z.literal(2),
    binding: TaskDelegationBinding,
    scope: z.literal('project-agents'),
    actions: z.array(TaskDelegationAction).min(1).max(4),
    expiresAt: z.null(),
    generation: z.number().int().nonnegative()
  })
  .strict()
export const TaskDelegationGrant = z.union([
  SessionTaskDelegationGrant,
  ProjectAgentsTaskDelegationGrant
])
export type DelegationActor = z.infer<typeof TaskDelegationActor>
export type DelegationBinding = z.infer<typeof TaskDelegationBinding>
export type DelegationGrant = z.infer<typeof TaskDelegationGrant>
export type DelegationAction = z.infer<typeof TaskDelegationAction>

export function taskDelegationActorsOverlap(
  left: DelegationActor,
  right: DelegationActor
): boolean {
  return left.key === right.key || left.aliases.some((alias) => right.aliases.includes(alias))
}
