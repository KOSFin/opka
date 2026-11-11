import { z } from 'zod'
import {
  TaskDelegationGrant,
  type DelegationGrant
} from '../../../src/shared/project-task-delegation'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

export type TaskPolicy = { generation: number; grant: DelegationGrant | null }
export type TaskPolicyProposal = {
  id: string
  digest: string
  grant: DelegationGrant | null
  expectedGeneration: number
}

export const taskPolicyRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.policy-read',
    method: 'projectTask.policy.read',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'task-policy',
      z.object({
        generation: z.number().int().nonnegative(),
        grant: TaskDelegationGrant.nullable()
      })
    )
  })
)
export const taskPolicyPropose = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.policy-propose',
    method: 'projectTask.policy.propose',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'task-policy-proposal',
      z.object({
        id: z.string().uuid(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        grant: TaskDelegationGrant.nullable(),
        expectedGeneration: z.number().int().nonnegative()
      })
    )
  })
)
export const taskPolicyConfirm = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.policy-confirm',
    method: 'projectTask.policy.confirm',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('task-policy-confirmed', z.unknown())
  })
)
