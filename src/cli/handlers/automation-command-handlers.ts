import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { AutomationCommandDefinitionCreateV1 } from '../../shared/automation-command-domain'
import { AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY } from '../../shared/automation-runtime-capabilities'
import {
  AutomationCreateV2,
  AutomationUpdateV2,
  AutomationRunNowV2,
  AutomationDeleteV2,
  AutomationCancelRunV1
} from '../../shared/rpc-contract/automation-command-params'
import { readArtifactFileWithinLimit } from '../../shared/artifact-file-read'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

const MAX_DEFINITION_FILE_BYTES = 128 * 1024
const self = { selector: { kind: 'self' as const } }
const display = (value: unknown): string => JSON.stringify(value, null, 2)

async function requireCommandHost(ctx: HandlerContext): Promise<void> {
  const status = await ctx.client.call<{ capabilities?: string[] }>('status.get')
  if (!status.result.capabilities?.includes(AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This execution host cannot run command automations. Update or select a supported host.'
    )
  }
}

function revision(ctx: HandlerContext): number {
  const value = Number(getRequiredStringFlag(ctx.flags, 'expected-revision'))
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--expected-revision must be a positive integer.'
    )
  }
  return value
}

async function readDefinitionFile(ctx: HandlerContext): Promise<unknown> {
  const file = resolve(ctx.cwd, getRequiredStringFlag(ctx.flags, 'execution-file'))
  const result = await readArtifactFileWithinLimit(file, MAX_DEFINITION_FILE_BYTES)
  if (result.status !== 'ok') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Execution file must be a nonempty regular JSON file under 128 KiB.'
    )
  }
  try {
    return JSON.parse(result.content)
  } catch {
    throw new RuntimeClientError('invalid_argument', 'Execution file contains invalid JSON.')
  }
}

function requireParsed<T>(
  result: { success: true; data: T } | { success: false },
  label: string
): T {
  if (!result.success) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${label} does not match the versioned command automation schema.`
    )
  }
  return result.data
}

function requestCreatedAt(ctx: HandlerContext): number {
  const value = Number(getRequiredStringFlag(ctx.flags, 'request-created-at'))
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--request-created-at must be a Unix millisecond timestamp.'
    )
  }
  return value
}

export const AUTOMATION_COMMAND_MODE_HANDLERS: Record<string, CommandHandler> = {
  'automations command list': async (ctx) => {
    await requireCommandHost(ctx)
    const result = await ctx.client.call<{ commandAutomations?: unknown[] }>('automation.list', {})
    printResult(
      { ...result, result: { commandAutomations: result.result.commandAutomations ?? [] } },
      ctx.json,
      display
    )
  },
  'automations command show': async (ctx) => {
    await requireCommandHost(ctx)
    const id = getRequiredStringFlag(ctx.flags, 'id')
    const response = await ctx.client.call<{ commandAutomations?: { id: string }[] }>(
      'automation.list',
      {}
    )
    const automation = response.result.commandAutomations?.find((entry) => entry.id === id)
    if (!automation) {
      throw new RuntimeClientError('not_found', 'Command automation was not found on this host.')
    }
    printResult({ ...response, result: { automation } }, ctx.json, display)
  },
  'automations command create': async (ctx) => {
    await requireCommandHost(ctx)
    const definition = requireParsed(
      AutomationCommandDefinitionCreateV1.safeParse(await readDefinitionFile(ctx)),
      'Execution file'
    )
    const params = requireParsed(
      AutomationCreateV2.safeParse({ version: 2, definition }),
      'Create request'
    )
    printResult(await ctx.client.call('automation.createV2', params), ctx.json, display)
  },
  'automations command edit': async (ctx) => {
    await requireCommandHost(ctx)
    const params = requireParsed(
      AutomationUpdateV2.safeParse({
        version: 2,
        id: getRequiredStringFlag(ctx.flags, 'id'),
        expectedRevision: revision(ctx),
        expectedOwner: self,
        updates: await readDefinitionFile(ctx)
      }),
      'Edit request'
    )
    printResult(await ctx.client.call('automation.updateV2', params), ctx.json, display)
  },
  'automations command remove': async (ctx) => {
    await requireCommandHost(ctx)
    const params = requireParsed(
      AutomationDeleteV2.safeParse({
        version: 2,
        id: getRequiredStringFlag(ctx.flags, 'id'),
        expectedRevision: revision(ctx),
        expectedOwner: self
      }),
      'Remove request'
    )
    printResult(await ctx.client.call('automation.deleteV2', params), ctx.json, display)
  },
  'automations command run': async (ctx) => {
    await requireCommandHost(ctx)
    const id = getRequiredStringFlag(ctx.flags, 'id')
    const expectedRevision = revision(ctx)
    const requestKey = getRequiredStringFlag(ctx.flags, 'request-key')
    const createdAt = requestCreatedAt(ctx)
    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ id, expectedRevision }))
      .digest('hex')
    const params = requireParsed(
      AutomationRunNowV2.safeParse({
        version: 2,
        id,
        expectedRevision,
        expectedOwner: self,
        requestKey,
        requestCreatedAt: createdAt,
        payloadHash
      }),
      'Run request'
    )
    printResult(await ctx.client.call('automation.runNowV2', params), ctx.json, display)
  },
  'automations command cancel': async (ctx) => {
    await requireCommandHost(ctx)
    const params = requireParsed(
      AutomationCancelRunV1.safeParse({
        version: 1,
        id: getRequiredStringFlag(ctx.flags, 'id'),
        runId: getRequiredStringFlag(ctx.flags, 'run-id'),
        expectedOwner: self,
        requestKey: getRequiredStringFlag(ctx.flags, 'request-key')
      }),
      'Cancel request'
    )
    printResult(await ctx.client.call('automation.cancelRunV1', params), ctx.json, display)
  },
  'automations command runs': async (ctx) => {
    await requireCommandHost(ctx)
    const result = await ctx.client.call('automation.runs', {
      automationId: getRequiredStringFlag(ctx.flags, 'id')
    })
    printResult(result, ctx.json, display)
  }
}
