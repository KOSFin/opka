import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

export const taskCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.create',
    method: 'projectTask.create',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('task-created', z.unknown())
  })
)
export const taskUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.update',
    method: 'projectTask.update',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('task-updated', z.unknown())
  })
)
export const taskMove = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.move',
    method: 'projectTask.move',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('task-moved', z.unknown())
  })
)
