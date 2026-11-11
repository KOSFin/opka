import { z } from 'zod'
import { TaskDelegatedApproval } from './project-task-delegation-params'
export const TaskResultSnapshot = TaskDelegatedApproval.extend({
  attempt: z.string().uuid(),
  sourceWorktree: z.string().min(1).max(4096)
}).strict()
export const TaskReviewAssignment = TaskDelegatedApproval.extend({
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reviewerAttempt: z.string().uuid()
}).strict()
export const TaskReviewSubmission = TaskReviewAssignment.extend({
  verdict: z.enum(['pass', 'changes']),
  report: z
    .string()
    .max(10000)
    .refine((text) => text.trim().length > 0, 'Report must not be blank')
}).strict()
export const TaskDelegatedDecision = TaskDelegatedApproval.extend({
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reviewId: z.string().uuid(),
  action: z.enum(['changes', 'integration', 'accept']),
  note: z.string().trim().max(2000).default('')
}).strict()
