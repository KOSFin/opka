import { delegationDigest, recordDelegationMutation } from './task-delegation-mutations'
export { delegationDigest } from './task-delegation-mutations'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  TaskDelegationGrant,
  type DelegationAction,
  type DelegationActor,
  type DelegationBinding,
  type DelegationGrant
} from '../../shared/project-task-delegation'
import type { TaskWorkflowStore } from './task-workflow-store'
import type { ProjectTaskEntry } from '../../shared/project-task-contract'

const Policy = z.object({ generation: z.number(), grant_json: z.string().nullable() })
const Proposal = z.object({
  issuer: z.string(),
  connection_id: z.string(),
  digest: z.string(),
  grant_json: z.string().nullable(),
  binding_json: z.string(),
  generation: z.number(),
  expires_at: z.number()
})
export type DelegationContext = {
  binding: DelegationBinding
  actor: DelegationActor
  runId: string | null
  callerProjectId?: string
}

export class TaskDelegationPolicy {
  constructor(
    private readonly store: TaskWorkflowStore,
    private readonly clock: () => number = Date.now
  ) {}

  read(projectId: string) {
    const row = this.store.native.db
      .prepare(
        'SELECT generation,grant_json FROM project_task_delegation_policy WHERE project_id=?'
      )
      .get(projectId)
    if (!row) {
      return { generation: 0, grant: null }
    }
    const state = Policy.parse(row)
    return {
      generation: state.generation,
      grant: state.grant_json ? TaskDelegationGrant.parse(JSON.parse(state.grant_json)) : null
    }
  }

  propose(
    projectId: string,
    issuer: string,
    connectionId: string,
    expectedGeneration: number,
    grant: DelegationGrant | null,
    binding: DelegationBinding
  ) {
    const current = this.read(projectId)
    if (current.generation !== expectedGeneration) {
      throw new Error('Policy generation conflict; refresh before confirming')
    }
    const normalized = grant
      ? TaskDelegationGrant.parse({
          ...grant,
          generation: expectedGeneration + 1,
          actions: [...new Set(grant.actions)].sort(),
          ...(grant.schema === 1
            ? { taskIds: grant.taskIds ? [...new Set(grant.taskIds)].sort() : null }
            : {})
        })
      : null
    if (
      normalized &&
      (normalized.binding.projectId !== projectId ||
        (normalized.expiresAt !== null && normalized.expiresAt <= this.clock()))
    ) {
      throw new Error('Invalid project or expired delegation proposal')
    }
    const id = randomUUID()
    const digest = delegationDigest({
      projectId,
      issuer,
      connectionId,
      expectedGeneration,
      grant: normalized,
      binding
    })
    this.store.native.db
      .prepare('DELETE FROM project_task_delegation_proposals WHERE expires_at<=?')
      .run(this.clock())
    const count = this.store.native.db
      .prepare('SELECT COUNT(*) AS n FROM project_task_delegation_proposals WHERE project_id=?')
      .get(projectId)
    if (Number(count?.n) >= 32) {
      throw new Error('Too many pending policy confirmations')
    }
    this.store.native.db
      .prepare(
        'INSERT INTO project_task_delegation_proposals(id,project_id,issuer,connection_id,digest,grant_json,binding_json,generation,expires_at) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        projectId,
        issuer,
        connectionId,
        digest,
        normalized ? JSON.stringify(normalized) : null,
        JSON.stringify(binding),
        expectedGeneration,
        this.clock() + 300_000
      )
    return { id, digest, grant: normalized, expectedGeneration }
  }

  confirm(
    projectId: string,
    issuer: string,
    connectionId: string,
    proposalId: string,
    digest: string,
    requestId: string,
    binding: DelegationBinding,
    revalidateActor: (grant: DelegationGrant) => void = () => {}
  ) {
    return this.mutate(
      projectId,
      'policy.confirm',
      requestId,
      issuer,
      { proposalId, digest, binding },
      () => {
        const row = this.store.native.db
          .prepare('SELECT * FROM project_task_delegation_proposals WHERE id=? AND project_id=?')
          .get(proposalId, projectId)
        if (!row) {
          throw new Error('Unknown delegation proposal')
        }
        const proposal = Proposal.parse(row)
        if (
          proposal.issuer !== issuer ||
          proposal.connection_id !== connectionId ||
          proposal.digest !== digest ||
          proposal.expires_at <= this.clock()
        ) {
          throw new Error('Delegation confirmation does not match this authenticated connection')
        }
        if (delegationDigest(JSON.parse(proposal.binding_json)) !== delegationDigest(binding)) {
          throw new Error('Project binding changed before confirmation')
        }
        const current = this.read(projectId)
        if (current.generation !== proposal.generation) {
          throw new Error('Policy generation conflict; refresh before confirming')
        }
        const grant = proposal.grant_json
          ? TaskDelegationGrant.parse(JSON.parse(proposal.grant_json))
          : null
        if (
          grant &&
          (delegationDigest(grant.binding) !== delegationDigest(binding) ||
            (grant.expiresAt !== null && grant.expiresAt <= this.clock()))
        ) {
          throw new Error('Project binding or expiry changed before confirmation')
        }
        if (grant) {
          revalidateActor(grant)
        }
        this.store.native.db
          .prepare(
            'INSERT INTO project_task_delegation_policy(project_id,generation,grant_json) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET generation=excluded.generation,grant_json=excluded.grant_json'
          )
          .run(projectId, current.generation + 1, proposal.grant_json)
        return {
          id: randomUUID(),
          operation: grant ? 'policy.installed' : 'policy.manual',
          generation: current.generation + 1
        }
      }
    )
  }

  require(context: DelegationContext, taskId: string, action: DelegationAction): DelegationGrant {
    const state = this.read(context.binding.projectId)
    const grant = state.grant
    if (
      !grant ||
      grant.generation !== state.generation ||
      (grant.expiresAt !== null && grant.expiresAt <= this.clock()) ||
      delegationDigest(grant.binding) !== delegationDigest(context.binding) ||
      (grant.schema === 1 && grant.actor.key !== context.actor.key) ||
      (grant.schema === 2 && context.callerProjectId !== context.binding.projectId) ||
      !grant.actions.includes(action) ||
      (grant.schema === 1 && grant.taskIds && !grant.taskIds.includes(taskId)) ||
      (grant.schema === 1 && grant.runId !== null && grant.runId !== context.runId)
    ) {
      throw new Error(
        'Delegation is missing, revoked, expired or outside this actor/project/action/Run scope'
      )
    }
    return grant
  }

  approve(context: DelegationContext, task: ProjectTaskEntry, requestId: string) {
    return this.mutate(
      context.binding.projectId,
      'plan.approveDelegated',
      requestId,
      context.actor.key,
      { context, taskId: task.id, revision: task.revision },
      () => {
        const projectId = context.binding.projectId
        const grant = this.require(context, task.id, 'approve-plan')
        const state = this.store.item(projectId, task.id)
        if (
          state.archived ||
          state.current_revision !== task.revision ||
          this.store.active(projectId, task.id) ||
          ['review', 'integration', 'done'].includes(state.phase)
        ) {
          throw new Error('Settle/review the current attempt before approving this exact plan')
        }
        const id = randomUUID()
        this.store.native.db
          .prepare(
            'INSERT INTO project_task_delegated_plans(id,project_id,task_id,revision,generation,grant_digest,actor,run_id) VALUES (?,?,?,?,?,?,?,?)'
          )
          .run(
            id,
            projectId,
            task.id,
            task.revision,
            grant.generation,
            delegationDigest(grant),
            context.actor.key,
            context.runId
          )
        this.store.native.db
          .prepare("UPDATE project_task_items SET phase='ready' WHERE project_id=? AND task_id=?")
          .run(projectId, task.id)
        this.store.event(
          projectId,
          task,
          'plan.delegated',
          `Delegated actor ${context.actor.key}; generation ${grant.generation}; receipt ${id}`,
          id
        )
        return { id, operation: 'plan.delegated', generation: grant.generation }
      }
    )
  }

  admission(context: DelegationContext, task: ProjectTaskEntry) {
    const grant = this.require(context, task.id, 'approve-plan')
    const row = this.store.native.db
      .prepare(
        'SELECT id FROM project_task_delegated_plans WHERE project_id=? AND task_id=? AND revision=? AND generation=? AND grant_digest=? ORDER BY rowid DESC LIMIT 1'
      )
      .get(
        context.binding.projectId,
        task.id,
        task.revision,
        grant.generation,
        delegationDigest(grant)
      )
    if (!row || typeof row.id !== 'string') {
      throw new Error('Approve the current plan revision before starting')
    }
    return { id: row.id, generation: grant.generation }
  }

  mutate(
    ...args: Parameters<typeof recordDelegationMutation> extends [TaskWorkflowStore, ...infer Rest]
      ? Rest
      : never
  ) {
    return recordDelegationMutation(this.store, ...args)
  }
}
