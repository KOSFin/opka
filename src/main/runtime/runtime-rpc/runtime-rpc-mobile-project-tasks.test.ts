import { describe, expect, it } from 'vitest'
import { MOBILE_RPC_METHOD_ROUTES } from './runtime-rpc-mobile-method-routing'
import { denyRpcMethodForCaller } from '../rpc/rpc-caller-scope'
import { PROJECT_TASK_WORKFLOW_METHODS } from '../rpc/methods/project-task-workflow'
import { requireInteractiveTaskOperator } from '../project-task-workflow-service'

const PHONE_TASK_METHODS = [
  'projectTask.catalog',
  'projectTask.board',
  'projectTask.show',
  'projectTask.documents',
  'projectTask.resume',
  'projectTask.approve',
  'projectTask.decide'
]

describe('phone task workflow authorization', () => {
  it.each(PHONE_TASK_METHODS)('routes %s to its execution host', (name) => {
    expect(MOBILE_RPC_METHOD_ROUTES.get(name)).toBe('execution-host')
    expect(denyRpcMethodForCaller({ kind: 'mobile' }, name, 'workspace')).toBeNull()
    expect(
      denyRpcMethodForCaller({ kind: 'mobile', delegated: true }, name, 'workspace')
    ).toBeNull()
  })

  it.each(['claim', 'progress', 'complete', 'start', 'stop', 'delete', 'agentSettings'])(
    'does not grant the phone agent or administrative action %s',
    (action) => {
      expect(
        denyRpcMethodForCaller({ kind: 'mobile' }, `projectTask.${action}`, 'workspace')
      ).not.toBeNull()
    }
  )

  it.each(['approve', 'decide'])('requires owner and revision fences for %s', (action) => {
    const method = PROJECT_TASK_WORKFLOW_METHODS.find(
      (entry) => entry.name === `projectTask.${action}`
    )
    expect(method).toBeDefined()
    const params = {
      worktree: 'id:synthetic-project',
      id: 'synthetic-task',
      revision: 'a'.repeat(64),
      expectedExecutionHostId: 'synthetic-host',
      action: 'accept',
      reason: 'Reviewed the result'
    }
    expect(method?.params?.safeParse(params).success).toBe(true)
    expect(method?.params?.safeParse({ ...params, revision: undefined }).success).toBe(false)
    expect(
      method?.params?.safeParse({ ...params, expectedExecutionHostId: undefined }).success
    ).toBe(false)
  })

  it('keeps unbound task operators out of approval actions', () => {
    expect(() => requireInteractiveTaskOperator({})).toThrow('requires confirmation')
  })
})
