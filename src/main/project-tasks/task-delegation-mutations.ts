import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { TaskWorkflowStore } from './task-workflow-store'
export function delegationDigest(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) {
      return input.map(canonical)
    }
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)])
      )
    }
    return input
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}
const Mutation = z.object({ actor: z.string(), payload_hash: z.string(), receipt_json: z.string() })
export const DelegationMutationReceipt = z.object({
  id: z.string(),
  operation: z.string(),
  generation: z.number().nullable(),
  resultDigest: z.string().optional()
})
export function recordDelegationMutation(
  store: TaskWorkflowStore,
  projectId: string,
  operation: string,
  requestId: string,
  actor: string,
  payload: unknown,
  apply: () => z.infer<typeof DelegationMutationReceipt>
) {
  if (!store.native.db.isTransaction) {
    throw new Error('Delegation mutation requires the workflow writer transaction')
  }
  z.string().uuid().parse(requestId)
  const replay = readDelegationMutation(store, projectId, operation, requestId, actor, payload)
  if (replay) {
    return replay
  }
  const payloadHash = delegationDigest(payload)
  const receipt = DelegationMutationReceipt.parse(apply())
  store.native.db
    .prepare(
      'INSERT INTO project_task_delegation_audit(id,project_id,operation,actor,payload_hash,receipt_json) VALUES (?,?,?,?,?,?)'
    )
    .run(receipt.id, projectId, operation, actor, payloadHash, JSON.stringify({ payload, receipt }))
  store.native.db
    .prepare(
      'INSERT INTO project_task_delegation_mutations(project_id,operation,request_id,actor,payload_hash,receipt_json) VALUES (?,?,?,?,?,?)'
    )
    .run(projectId, operation, requestId, actor, payloadHash, JSON.stringify(receipt))
  return { ...receipt, replayed: false }
}

export function readDelegationMutation(
  store: TaskWorkflowStore,
  projectId: string,
  operation: string,
  requestId: string,
  actor: string,
  payload: unknown
) {
  const payloadHash = delegationDigest(payload)
  const existing = store.native.db
    .prepare(
      'SELECT actor,payload_hash,receipt_json FROM project_task_delegation_mutations WHERE project_id=? AND operation=? AND request_id=?'
    )
    .get(projectId, operation, requestId)
  if (existing) {
    const prior = Mutation.parse(existing)
    if (prior.actor !== actor || prior.payload_hash !== payloadHash) {
      throw new Error('Request replay conflicts with the original actor or payload')
    }
    return {
      ...DelegationMutationReceipt.parse(JSON.parse(prior.receipt_json)),
      replayed: true as const
    }
  }
  return null
}
