import { z } from 'zod'

export const MAX_AUTOMATION_COMMAND_INPUT_BYTES = 64 * 1024
export const MAX_AUTOMATION_COMMAND_ARGV_ITEMS = 128

const boundedText = z
  .string()
  .max(MAX_AUTOMATION_COMMAND_INPUT_BYTES)
  .refine((value) => !value.includes('\0'), { message: 'Command input contains a NUL byte.' })
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= MAX_AUTOMATION_COMMAND_INPUT_BYTES,
    {
      message: 'Command input exceeds 64 KiB.'
    }
  )

const programCommand = z
  .object({
    kind: z.literal('program'),
    executable: boundedText.min(1),
    argv: z
      .array(boundedText)
      .max(MAX_AUTOMATION_COMMAND_ARGV_ITEMS)
      .refine(
        (argv) =>
          argv.reduce(
            (total, argument) => total + new TextEncoder().encode(argument).byteLength,
            0
          ) <= MAX_AUTOMATION_COMMAND_INPUT_BYTES,
        { message: 'Command arguments exceed 64 KiB.' }
      )
  })
  .strict()

const scriptCommand = z
  .object({
    kind: z.literal('script'),
    language: z.enum(['shell', 'python']),
    text: boundedText.min(1),
    interpreter: boundedText.min(1).optional()
  })
  .strict()

export const AutomationCommandV1 = z.discriminatedUnion('kind', [programCommand, scriptCommand])
export const AutomationCommandConditionV1 = z.enum([
  'exit_zero',
  'exit_zero_and_changed',
  'never_agent'
])

export type AutomationCommandV1 = z.infer<typeof AutomationCommandV1>
export type AutomationCommandConditionV1 = z.infer<typeof AutomationCommandConditionV1>

const ChangedConditionResultV1 = z.object({ version: z.literal(1), changed: z.boolean() }).strict()

export type AutomationCommandObservation = {
  exitCode: number | null
  timedOut: boolean
  error: string | null
  stdout: string
  stdoutTruncated: boolean
  stderr?: string
  stderrTruncated?: boolean
}

export type AutomationCommandDecision =
  | {
      outcome: 'failed'
      reason: 'timeout' | 'command_error' | 'command_exit' | 'invalid_condition'
    }
  | { outcome: 'skipped'; reason: 'condition_false' }
  | { outcome: 'completed'; reason: 'never_agent' }
  | { outcome: 'proceed'; reason: 'condition_true' }

/** A false or malformed condition cannot reach agent acquisition. */
export function decideAutomationCommandCondition(
  condition: AutomationCommandConditionV1,
  observation: AutomationCommandObservation
): AutomationCommandDecision {
  if (observation.timedOut) {
    return { outcome: 'failed', reason: 'timeout' }
  }
  if (observation.error) {
    return { outcome: 'failed', reason: 'command_error' }
  }
  if (observation.exitCode !== 0) {
    return { outcome: 'failed', reason: 'command_exit' }
  }
  if (condition === 'never_agent') {
    return { outcome: 'completed', reason: 'never_agent' }
  }
  if (condition === 'exit_zero') {
    return { outcome: 'proceed', reason: 'condition_true' }
  }

  const output = observation.stdout.trimEnd()
  const finalLineStart = output.lastIndexOf('\n') + 1
  const finalLine = output.slice(finalLineStart)
  if (
    (observation.stdoutTruncated && finalLineStart === 0) ||
    new TextEncoder().encode(finalLine).byteLength > 4096
  ) {
    return { outcome: 'failed', reason: 'invalid_condition' }
  }
  try {
    const parsed = ChangedConditionResultV1.safeParse(JSON.parse(finalLine))
    if (!parsed.success) {
      return { outcome: 'failed', reason: 'invalid_condition' }
    }
    return parsed.data.changed
      ? { outcome: 'proceed', reason: 'condition_true' }
      : { outcome: 'skipped', reason: 'condition_false' }
  } catch {
    return { outcome: 'failed', reason: 'invalid_condition' }
  }
}
