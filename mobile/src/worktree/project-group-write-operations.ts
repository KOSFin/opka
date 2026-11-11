import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

export const projectGroupUpdateWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-group.update',
    method: 'projectGroup.update',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('group-update', z.unknown())
  })
)

export const projectGroupMoveProjectWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-group.move-project',
    method: 'projectGroup.moveProject',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('group-move-project', z.unknown())
  })
)
