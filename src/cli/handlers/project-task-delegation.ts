import { z } from 'zod'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { buildCurrentWorktreeSelector } from '../selectors'
import { readArtifactFileWithinLimit } from '../../shared/artifact-file-read'
import { resolve } from 'node:path'
import { RuntimeClientError } from '../runtime-client'
import { printResult } from '../format'
import { PROJECT_TASK_DELEGATION_CAPABILITY } from '../../shared/project-task-delegation'
import { readInjectedAgentSessionId } from '../../shared/agent-session-caller-env'

export async function requireProjectTaskDelegationHost(ctx: HandlerContext): Promise<void> {
  const status = await ctx.client.call('status.get', {})
  const supported = z.object({ capabilities: z.array(z.string()).optional() }).parse(status.result)
  if (!supported.capabilities?.includes(PROJECT_TASK_DELEGATION_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Owning host does not support delegated project tasks; no manual-approval fallback was attempted'
    )
  }
}
const methods: Readonly<Record<string, string>> = {
  'approve-plan': 'projectTask.approveDelegated',
  snapshot: 'projectTask.resultSnapshot',
  'assign-review': 'projectTask.reviewAssign',
  'submit-review': 'projectTask.reviewSubmit',
  decide: 'projectTask.decideDelegated',
  resume: 'projectTask.resumeDelegated'
}
export const projectTaskDelegationHandler: CommandHandler = async (ctx) => {
  if (ctx.client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Run delegated decisions on the owning execution host with its verified agent identity'
    )
  }
  await requireProjectTaskDelegationHost(ctx)
  const action = getRequiredStringFlag(ctx.flags, 'action')
  const method = methods[action]
  if (!method) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Choose approve-plan, snapshot, assign-review, submit-review, decide or resume; policy installation is interactive only'
    )
  }
  const input = await readArtifactFileWithinLimit(
    resolve(ctx.cwd, getRequiredStringFlag(ctx.flags, 'file')),
    64_000
  )
  if (input.status !== 'ok') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Read a bounded JSON request file on the owning host'
    )
  }
  const fields = z.record(z.string(), z.unknown()).parse(JSON.parse(input.content))
  const worktree =
    getOptionalStringFlag(ctx.flags, 'worktree') ?? buildCurrentWorktreeSelector(ctx.cwd)
  const target = await ctx.client.call('projectTask.target', { worktree })
  const host = z.object({ executionHostId: z.string().min(1) }).parse(target.result)
  const response = await ctx.client.call(method, {
    ...fields,
    worktree,
    expectedExecutionHostId: host.executionHostId,
    capability: PROJECT_TASK_DELEGATION_CAPABILITY,
    from: readInjectedAgentSessionId(process.env) ? undefined : process.env.ORCA_TERMINAL_HANDLE
  })
  printResult(response, ctx.json, (value) => JSON.stringify(value, null, 2))
}
