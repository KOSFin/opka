import { requireTaskSourcePlacement } from './task-attempt-placement'
import { taskAttemptAuthor, taskAttemptDispatchId } from './task-result-authors'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { TaskDelegationActor } from '../../shared/project-task-delegation'
import type { TaskWorkflowStore } from './task-workflow-store'
import { delegationDigest } from './task-delegation-policy'

const ResultEvidence = z
  .object({
    schema: z.literal(1),
    attemptId: z.string(),
    nativeTaskId: z.string(),
    dispatchId: z.string().nullable(),
    planRevision: z.string(),
    author: TaskDelegationActor,
    kind: z.enum(['code', 'document', 'analysis', 'other']),
    report: z
      .string()
      .max(10000)
      .refine((text) => text.trim().length > 0, 'Report must not be blank'),
    reportHash: z.string(),
    source: z
      .object({
        commit: z.string().regex(/^[a-f0-9]{40,64}$/),
        tree: z.string().regex(/^[a-f0-9]{40,64}$/),
        dirtyDigest: z.string().nullable(),
        worktreePath: z.string().min(1).max(4096),
        workspaceId: z.string().min(1).max(4096).optional(),
        placementDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional()
      })
      .nullable(),
    timestamp: z.string()
  })
  .strict()
export type TaskResultEvidence = z.infer<typeof ResultEvidence>

export function freezeTaskResult(
  store: TaskWorkflowStore,
  input: Omit<TaskResultEvidence, 'schema' | 'timestamp' | 'reportHash'>
) {
  if (!store.native.db.isTransaction) {
    throw new Error('Result evidence requires the workflow writer')
  }
  const evidence = ResultEvidence.parse({
    ...input,
    schema: 1,
    reportHash: createHash('sha256').update(input.report).digest('hex'),
    timestamp: new Date().toISOString()
  })
  if ((evidence.kind === 'code') !== (evidence.source !== null)) {
    throw new Error('Code results require their exact source snapshot')
  }
  const row = store.native.db
    .prepare(
      'SELECT a.revision,a.native_task_id,t.status FROM project_task_attempts a JOIN tasks t ON t.id=a.native_task_id WHERE a.id=?'
    )
    .get(input.attemptId)
  if (
    !row ||
    row.revision !== evidence.planRevision ||
    row.native_task_id !== evidence.nativeTaskId ||
    row.status !== 'completed'
  ) {
    throw new Error('Result must bind the exact completed attempt and reserved revision')
  }
  if (input.dispatchId) {
    const dispatch = store.native.getDispatchContextById(input.dispatchId)
    if (!dispatch || dispatch.task_id !== input.nativeTaskId || dispatch.status !== 'completed') {
      throw new Error('Result Dispatch is not the settled winner')
    }
  }
  if (evidence.source) {
    if (
      evidence.dispatchId !== taskAttemptDispatchId(store, evidence.attemptId) ||
      delegationDigest(evidence.author) !==
        delegationDigest(taskAttemptAuthor(store, evidence.attemptId))
    ) {
      throw new Error('Code source must bind the exact settled Dispatch or session author')
    }
    requireTaskSourcePlacement(store, evidence.attemptId, evidence.source)
  }
  const id = randomUUID()
  const digest = delegationDigest(evidence)
  store.native.db
    .prepare(
      'INSERT INTO project_task_results(id,attempt_id,digest,evidence_json) VALUES (?,?,?,?)'
    )
    .run(id, evidence.attemptId, digest, JSON.stringify(evidence))
  return { id, digest, evidence }
}

export function readTaskResult(store: TaskWorkflowStore, digest: string) {
  const row = store.native.db
    .prepare('SELECT id,attempt_id,evidence_json FROM project_task_results WHERE digest=?')
    .get(digest)
  if (!row || typeof row.evidence_json !== 'string') {
    throw new Error('Result evidence is missing')
  }
  const evidence = ResultEvidence.parse(JSON.parse(row.evidence_json))
  if (
    delegationDigest(evidence) !== digest ||
    createHash('sha256').update(evidence.report).digest('hex') !== evidence.reportHash
  ) {
    throw new Error('Result evidence changed')
  }
  const latest = store.native.db
    .prepare(
      'SELECT digest FROM project_task_results WHERE attempt_id=? ORDER BY rowid DESC LIMIT 1'
    )
    .get(evidence.attemptId)
  if (latest?.digest !== digest) {
    throw new Error('Result revision changed; obtain a new independent review')
  }
  return evidence
}
