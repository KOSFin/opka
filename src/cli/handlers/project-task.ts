import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { buildCurrentWorktreeSelector } from '../selectors'
import { RuntimeClientError } from '../runtime-client'
import { printResult } from '../format'
import { projectTaskTemplate } from '../../shared/project-task-template'
import { PROJECT_TASK_DOCUMENT_MAX_BYTES } from '../../shared/project-task-contract'
import { readArtifactFileWithinLimit } from '../../shared/artifact-file-read'

function worktree(ctx: HandlerContext): string {
  const selector = getOptionalStringFlag(ctx.flags, 'worktree')
  if (selector && selector !== 'current' && selector !== 'active') {
    return selector
  }
  if (ctx.client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass an explicit --worktree selector on the execution host'
    )
  }
  return buildCurrentWorktreeSelector(ctx.cwd)
}

async function fileContent(ctx: HandlerContext): Promise<string | undefined> {
  const path = getOptionalStringFlag(ctx.flags, 'file')
  if (!path) {
    return undefined
  }
  if (process.env.ORCA_CLI_CWD && resolve(ctx.cwd) !== resolve(process.cwd())) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Bridged --file input is not supported for project tasks yet. Run the CLI on the execution host; no local fallback file was read.'
    )
  }
  const result = await readArtifactFileWithinLimit(
    resolve(ctx.cwd, path),
    PROJECT_TASK_DOCUMENT_MAX_BYTES
  )
  if (result.status !== 'ok') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Input must be a readable file of at most 256 KiB'
    )
  }
  return result.content
}

async function call(ctx: HandlerContext, method: string, params: Record<string, unknown>) {
  try {
    return await ctx.client.call(method, params)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'Update the execution host: this Orca runtime does not support file-backed project tasks'
      )
    }
    throw error
  }
}

function pageNumber(ctx: HandlerContext, name: string, fallback: number): number {
  const value = getOptionalStringFlag(ctx.flags, name)
  if (value === undefined) {
    return fallback
  }
  if (!/^\d+$/.test(value)) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be an integer`)
  }
  return Number(value)
}

function handler(operation: string): CommandHandler {
  return async (ctx) => {
    const target = worktree(ctx)
    const params: Record<string, unknown> = { worktree: target }
    if (['show', 'context', 'resume', 'workflow', 'start', 'update'].includes(operation)) {
      params.id = getRequiredStringFlag(ctx.flags, 'id')
    }
    if (['list', 'board'].includes(operation)) {
      params.offset = pageNumber(ctx, 'offset', 0)
      params.limit = pageNumber(ctx, 'limit', 50)
    }
    if (operation === 'init') {
      params.content = await fileContent(ctx)
    }
    if (operation === 'create') {
      params.source = getOptionalStringFlag(ctx.flags, 'source') ?? 'project'
      params.slug = getRequiredStringFlag(ctx.flags, 'slug')
      params.content =
        (await fileContent(ctx)) ??
        projectTaskTemplate({
          id: `task-${randomUUID()}`,
          title: getRequiredStringFlag(ctx.flags, 'title'),
          detailed: ctx.flags.has('detailed')
        })
    }
    if (operation === 'update') {
      params.revision = getRequiredStringFlag(ctx.flags, 'revision')
      params.content = await fileContent(ctx)
      if (params.content === undefined) {
        throw new RuntimeClientError('invalid_argument', 'Missing required --file')
      }
    }
    if (operation === 'start') {
      params.revision = getRequiredStringFlag(ctx.flags, 'revision')
      const content = await fileContent(ctx)
      if (!content) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Pass --file with the explicit worker launch JSON (from, worktree, optional repo/agent/model/effort)'
        )
      }
      const launch: unknown = JSON.parse(content)
      if (!launch || typeof launch !== 'object' || Array.isArray(launch)) {
        throw new RuntimeClientError('invalid_argument', 'Launch JSON must be an object')
      }
      params.launch = { ...launch, spec: 'approved-project-plan' }
    }
    if (['init', 'create', 'update', 'start'].includes(operation)) {
      const targetReply = await call(ctx, 'projectTask.target', { worktree: target })
      const result = targetReply.result
      if (
        !result ||
        typeof result !== 'object' ||
        !('executionHostId' in result) ||
        typeof result.executionHostId !== 'string'
      ) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'Project task host could not be verified'
        )
      }
      params.expectedExecutionHostId = result.executionHostId
    }
    const reply = await call(ctx, `projectTask.${operation}`, params)
    if (['context', 'resume'].includes(operation) && !ctx.json) {
      const context = reply.result
      if (
        context &&
        typeof context === 'object' &&
        'text' in context &&
        typeof context.text === 'string'
      ) {
        console.log(context.text)
        return
      }
    }
    printResult(reply, ctx.json, (value) => JSON.stringify(value, null, 2))
  }
}

export const PROJECT_TASK_HANDLERS: Record<string, CommandHandler> = {
  'project-task init': handler('init'),
  'project-task list': handler('list'),
  'project-task show': handler('show'),
  'project-task context': handler('context'),
  'project-task create': handler('create'),
  'project-task update': handler('update'),
  'project-task board': handler('board'),
  'project-task workflow': handler('workflow'),
  'project-task resume': handler('resume'),
  'project-task start': handler('start')
}
