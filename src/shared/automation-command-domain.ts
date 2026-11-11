import { z } from 'zod'
import { AutomationCommandConditionV1, AutomationCommandV1 } from './automation-command-execution'
import { EXTRA_AGENT_ARGS_MAX_BYTES } from './automation-extra-agent-args'
import { TaskSourceContext, TuiAgent, WorkspaceRunContext } from './rpc-contract/automation-params'

const finiteTimestamp = z.number().int().nonnegative().finite()
const positiveRevision = z.number().int().positive()
const ianaTimeZone = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value })
      return true
    } catch {
      return false
    }
  }, 'Unsupported automation time zone.')

export const AutomationCommandExecutionV1 = z
  .object({
    version: z.literal(1),
    command: AutomationCommandV1,
    condition: AutomationCommandConditionV1,
    agent: z
      .object({
        agentId: TuiAgent,
        prompt: z
          .string()
          .min(1)
          .max(64 * 1024)
          .refine((value) => new TextEncoder().encode(value).byteLength <= 64 * 1024),
        extraAgentArgs: z
          .string()
          .refine(
            (value) => new TextEncoder().encode(value).byteLength <= EXTRA_AGENT_ARGS_MAX_BYTES
          )
          .optional(),
        sessionPolicy: z.literal('ephemeral')
      })
      .strict()
      .nullable(),
    policy: z
      .object({
        timeoutSeconds: z.number().int().min(1).max(3600),
        commandTimeoutSeconds: z.number().int().min(1).max(3600),
        idempotent: z.boolean(),
        maxAttempts: z.union([z.literal(1), z.literal(2)])
      })
      .strict(),
    reportTarget: z
      .object({
        runtimeId: z.string().min(1),
        hostId: z.string().min(1),
        workspaceId: z.string().min(1),
        chatSessionId: z.string().min(1),
        registrationGeneration: positiveRevision
      })
      .strict()
      .nullable()
  })
  .strict()
  .superRefine((execution, ctx) => {
    if (execution.policy.commandTimeoutSeconds > execution.policy.timeoutSeconds) {
      ctx.addIssue({ code: 'custom', message: 'Command timeout exceeds lifecycle timeout.' })
    }
    if (execution.policy.maxAttempts === 2 && (!execution.policy.idempotent || execution.agent)) {
      ctx.addIssue({ code: 'custom', message: 'Only an idempotent command-only run may retry.' })
    }
  })

export const AutomationCommandDefinitionV1 = z
  .object({
    id: z.string().min(1),
    creationKey: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => new TextEncoder().encode(value).byteLength <= 128)
      .optional(),
    creationPayloadHash: z.string().length(64).optional(),
    name: z.string().min(1).max(256),
    revision: positiveRevision,
    runContext: WorkspaceRunContext,
    sourceContext: TaskSourceContext,
    projectId: z.string().min(1),
    executionTargetType: z.enum(['local', 'ssh']),
    executionTargetId: z.string().min(1),
    executionTargetGeneration: positiveRevision.optional(),
    schedulerOwner: z.enum(['local_host_service', 'ssh_bridge', 'remote_host_service']),
    workspaceMode: z.enum(['existing', 'new_per_run']),
    workspaceId: z.string().nullable(),
    baseBranch: z.string().nullable(),
    setupDecision: z.enum(['inherit', 'run', 'skip']).optional(),
    timezone: ianaTimeZone,
    rrule: z.string().min(1).max(2048),
    dtstart: finiteTimestamp,
    enabled: z.boolean(),
    nextRunAt: finiteTimestamp,
    lastAdmittedOccurrenceAt: finiteTimestamp.optional(),
    lastRunAt: finiteTimestamp.optional(),
    missedRunPolicy: z.literal('run_once_within_grace'),
    missedRunGraceMinutes: z.number().int().nonnegative(),
    createdAt: finiteTimestamp,
    updatedAt: finiteTimestamp,
    execution: AutomationCommandExecutionV1
  })
  .strict()

export const AutomationCommandRunSnapshotV1 = z
  .object({
    title: z.string().min(1).max(512),
    scheduledFor: finiteTimestamp,
    trigger: z.enum(['scheduled', 'manual']),
    workspaceId: z.string().nullable(),
    createdAt: finiteTimestamp,
    runNumber: positiveRevision,
    outputSnapshot: z
      .object({
        format: z.literal('plain_text'),
        content: z.string().max(16 * 1024),
        capturedAt: finiteTimestamp,
        truncated: z.boolean()
      })
      .strict()
      .optional(),
    finalReason: z.string().max(4096).nullable().optional()
  })
  .strict()

export const AutomationCommandClaimV1 = z
  .object({
    automationId: z.string().min(1),
    runId: z.string().min(1),
    definitionRevision: positiveRevision,
    hostId: z.string().min(1),
    hostGeneration: positiveRevision,
    acquisitionId: z.string().min(1),
    attempt: z.number().int().min(1).max(2),
    phase: z.enum(['acquiring', 'command', 'condition', 'agent', 'report', 'unverifiable']),
    createdAt: finiteTimestamp,
    observation: z.enum(['live', 'unverifiable', 'exited']).optional(),
    cancelRequestedAt: finiteTimestamp.optional(),
    cancelRequestKey: z.string().min(1).max(128).optional(),
    overlapCount: z.number().int().nonnegative().max(1_000_000_000).optional(),
    lastOverlapAt: finiteTimestamp.optional(),
    processIntent: z
      .object({
        backend: z.literal('linux_cgroup_v1'),
        unitName: z.string().regex(/^orca-automation-[0-9a-f-]{36}\.scope$/),
        childName: z.literal('command'),
        receiptDirectory: z.string().min(1).max(4096),
        childCgroupPath: z.string().min(1).max(4096).optional(),
        blockedChildPid: z.number().int().positive().optional(),
        blockedChildStartTime: z.string().regex(/^\d+$/).optional(),
        execMayHappen: z.literal(true).optional(),
        exitProof: z
          .object({
            verifiedAt: finiteTimestamp,
            exitCode: z.number().int().nullable(),
            timedOut: z.boolean(),
            error: z.string().max(4096).nullable(),
            stdout: z.string().max(16 * 1024),
            stdoutTruncated: z.boolean(),
            stderr: z.string().max(16 * 1024),
            stderrTruncated: z.boolean()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    runSnapshot: AutomationCommandRunSnapshotV1.optional()
  })
  .strict()

export const AutomationCommandManualReceiptV1 = z
  .object({
    automationId: z.string().min(1),
    requestKey: z.string().min(1).max(128),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: finiteTimestamp,
    runId: z.string().min(1),
    outcome: z.literal('overlap').optional()
  })
  .strict()

export const AutomationCommandsV1Domain = z
  .object({
    version: z.literal(1),
    definitions: z.array(AutomationCommandDefinitionV1).max(1000),
    activeClaims: z.array(AutomationCommandClaimV1).max(1000),
    manualReceipts: z.array(AutomationCommandManualReceiptV1).max(100_000)
  })
  .strict()
  .superRefine((domain, ctx) => {
    const ids = new Set(domain.definitions.map((definition) => definition.id))
    if (ids.size !== domain.definitions.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate command automation ID.' })
    }
    const claims = new Set(domain.activeClaims.map((claim) => claim.automationId))
    if (claims.size !== domain.activeClaims.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate active command claim.' })
    }
    const receiptsByAutomation = new Map<string, number>()
    for (const receipt of domain.manualReceipts) {
      const count = (receiptsByAutomation.get(receipt.automationId) ?? 0) + 1
      if (count > 100) {
        ctx.addIssue({ code: 'custom', message: 'Too many manual command receipts.' })
        break
      }
      receiptsByAutomation.set(receipt.automationId, count)
    }
  })

export type AutomationCommandDefinitionV1 = z.infer<typeof AutomationCommandDefinitionV1>
export const AutomationCommandDefinitionCreateV1 = AutomationCommandDefinitionV1.omit({
  id: true,
  revision: true,
  creationPayloadHash: true,
  nextRunAt: true,
  lastAdmittedOccurrenceAt: true,
  lastRunAt: true,
  createdAt: true,
  updatedAt: true
})
export type AutomationCommandDefinitionCreateV1 = z.infer<
  typeof AutomationCommandDefinitionCreateV1
>
export type AutomationCommandClaimV1 = z.infer<typeof AutomationCommandClaimV1>
export type AutomationCommandManualReceiptV1 = z.infer<typeof AutomationCommandManualReceiptV1>
export type AutomationCommandsV1Domain = z.infer<typeof AutomationCommandsV1Domain>

export function readAutomationCommandsV1Domain(value: unknown): AutomationCommandsV1Domain {
  return AutomationCommandsV1Domain.parse(
    value ?? { version: 1, definitions: [], activeClaims: [], manualReceipts: [] }
  )
}
