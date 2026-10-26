import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import type { z } from 'zod'
import type { RpcContext } from './rpc/core'
import type {
  ProjectTaskClaim,
  ProjectTaskProgress,
  ProjectTaskComplete
} from '../../shared/rpc-contract/project-task-workflow-params'
import { resolveOrchestrationCaller } from './rpc/methods/orchestration/runs/run-scope'
import { projectTaskResources } from './project-task-workflow-service'
import {
  claimTaskSession,
  readTaskSessionAttempt,
  isTaskSessionReleased,
  requireTaskSessionOwner,
  recordTaskSessionProgress
} from '../project-tasks/task-session-attempt'
import { taskFilePath, readTaskText } from '../project-tasks/task-file-io'
import { taskRevision } from '../project-tasks/task-document'
import { writePluginFileAtomically } from '../plugins/plugin-atomic-file-write'
import { exportProjectTaskActivity } from '../project-tasks/task-activity'
import { resumeProjectTask } from './project-task-resume'
import { verifyProjectTaskTerminalProof } from './project-task-terminal-proof'

function taskSessionCaller(context: RpcContext, from: string | undefined) {
  if (context.pairedDeviceId) {
    throw new Error(
      'Take the task from the agent on its owning execution host, not a paired client'
    )
  }
  const evidence = context.orchestrationCompatibilityEvidence
  if (!context.orchestrationCaller && !evidence) {
    throw new Error(
      'Run this command inside an Opka agent chat or terminal with its injected identity'
    )
  }
  const authority = context.orchestrationCaller
    ? null
    : evidence?.terminalTaskProof !== undefined
      ? verifyProjectTaskTerminalProof(context.runtime, evidence)
      : context.runtime.verifyOrchestrationCompatibilityCaller(evidence, {
          currentRuntimeLaunchSufficient: true
        })
  if (!context.orchestrationCaller && !authority) {
    throw new Error('The owning host could not verify this terminal identity; no task was taken')
  }
  const caller = resolveOrchestrationCaller(context.runtime, {
    callerTerminalHandle: from ?? evidence?.terminalHandle ?? '',
    callerEvidence: evidence,
    callerAuthority: authority ?? context.orchestrationCompatibilityCallerAuthority,
    callerSession: context.orchestrationCaller,
    requireStablePane: true
  })
  if (
    authority &&
    (caller.terminalHandle !== authority.terminalHandle || caller.paneKey !== authority.paneKey)
  ) {
    throw new Error(
      'The terminal caller does not match its owning host identity; no task was taken'
    )
  }
  const ownerKey = createHash('sha256')
    .update(
      JSON.stringify(
        context.orchestrationCaller
          ? ['session', caller.orcaSessionId]
          : evidence?.terminalTaskProof && authority
            ? [
                'terminal-proof',
                authority.processIncarnation,
                caller.paneKey,
                evidence.terminalTaskProof
              ]
            : ['terminal', caller.terminalHandle, caller.paneKey, evidence?.launchToken]
      )
    )
    .digest('hex')
  return { caller, ownerKey }
}

export async function claimProjectTaskSession(
  params: z.infer<typeof ProjectTaskClaim>,
  context: RpcContext
) {
  const { caller, ownerKey } = taskSessionCaller(context, params.from)
  const resources = await projectTaskResources(
    context.runtime,
    params.worktree,
    params.expectedExecutionHostId
  )
  const attempt = await resources.workspace.withTaskRevision(
    params.id,
    params.revision,
    async (task, snapshot) => {
      if (resources.store.active(resources.projectId, task.id)) {
        const prior = readTaskSessionAttempt(resources.store, resources.projectId, task.id)
        if (!prior || ['completed', 'failed', 'unknown'].includes(prior.nativeStatus)) {
          throw new Error('An active or unverified attempt already owns this task')
        }
        return requireTaskSessionOwner(
          resources.store,
          resources.projectId,
          task,
          prior.id,
          ownerKey
        )
      }
      const dependencies = snapshot.tasks.filter((entry) => task.depends_on.includes(entry.id))
      resources.store.requireReady(resources.projectId, task, dependencies)
      const db = resources.store.native
      const run =
        db.getCurrentRunForCoordinator(caller) ??
        db.createRun({
          objective: task.title,
          coordinatorHandle: caller.terminalHandle,
          coordinatorPaneKey: caller.paneKey,
          coordinatorOrcaSessionId: caller.orcaSessionId
        })
      return claimTaskSession(
        resources.store,
        resources.projectId,
        task,
        run.id,
        ownerKey,
        dependencies,
        caller.address
      )
    }
  )
  await exportProjectTaskActivity(resources.store.native.db)
  resources.workspace.notifyChanged()
  return { attempt, ...(await resumeProjectTask(context.runtime, params.worktree, params.id)) }
}

export async function progressProjectTaskSession(
  params: z.infer<typeof ProjectTaskProgress> | z.infer<typeof ProjectTaskComplete>,
  context: RpcContext
) {
  const { ownerKey } = taskSessionCaller(context, params.from)
  const resources = await projectTaskResources(
    context.runtime,
    params.worktree,
    params.expectedExecutionHostId
  )
  const attempt = await resources.workspace.withTaskRevision(
    params.id,
    params.revision,
    async (task) => {
      const prior = requireTaskSessionOwner(
        resources.store,
        resources.projectId,
        task,
        params.attempt,
        ownerKey,
        params.release
      )
      if (params.release && isTaskSessionReleased(resources.store, prior.id)) {
        return prior
      }
      const report = 'report' in params ? params.report : undefined
      const resultHash =
        report === undefined
          ? undefined
          : createHash('sha256')
              .update(JSON.stringify([params.checkpoint, report]))
              .digest('hex')
      if (prior.resultHash !== null) {
        if (resultHash === prior.resultHash) {
          return prior
        }
        throw new Error('The result was already submitted; no saved report was overwritten')
      }
      if (['completed', 'failed', 'unknown'].includes(prior.nativeStatus)) {
        throw new Error(
          'The previous attempt is settled or unverifiable; no documents were written'
        )
      }
      const directory = dirname(task.path).replaceAll('\\', '/')
      const checkpointPath = `${directory}/checkpoint.md`
      const reportPath = report === undefined ? undefined : `${directory}/reports/${prior.id}.md`
      const stamp = `Task: ${task.id}\nRevision: ${task.revision}\nAttempt: ${prior.id}\n\n`
      try {
        const checkpoint = await taskFilePath(resources.root, checkpointPath, true)
        await writePluginFileAtomically(checkpoint, stamp + params.checkpoint, { mode: 0o644 })
        if (reportPath && report !== undefined) {
          await writePluginFileAtomically(
            await taskFilePath(resources.root, reportPath, true),
            stamp + report,
            { mode: 0o644 }
          )
        }
      } catch (error) {
        recordTaskSessionProgress(resources.store, resources.projectId, task, prior.id, ownerKey, {
          checkpointPath: prior.checkpointPath,
          blocker:
            'Task documents could not be saved. Repair storage on the owning host and retry; no result was submitted.'
        })
        await exportProjectTaskActivity(resources.store.native.db)
        resources.workspace.notifyChanged()
        throw error
      }
      if (taskRevision(await readTaskText(resources.root, task.path)) !== task.revision) {
        throw new Error('The plan changed while saving; the result was not accepted')
      }
      return recordTaskSessionProgress(
        resources.store,
        resources.projectId,
        task,
        prior.id,
        ownerKey,
        {
          checkpointPath,
          blocker: params.blocker ?? null,
          reportPath,
          resultHash,
          release: params.release
        }
      )
    }
  )
  await exportProjectTaskActivity(resources.store.native.db)
  resources.workspace.notifyChanged()
  return { attempt, ...(await resumeProjectTask(context.runtime, params.worktree, params.id)) }
}
