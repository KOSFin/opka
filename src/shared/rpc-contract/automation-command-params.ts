import { z } from 'zod'
import { AutomationCommandDefinitionCreateV1 } from '../automation-command-domain'

const id = z.string().min(1).max(256)
const requestKey = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 128,
    'Automation request key exceeds 128 bytes.'
  )
const revision = z.number().int().positive()
const localOwner = z.object({ selector: z.object({ kind: z.literal('self') }).strict() }).strict()

export const AutomationCreateV2 = z
  .object({ version: z.literal(2), definition: AutomationCommandDefinitionCreateV1 })
  .strict()

export const AutomationUpdateV2 = z
  .object({
    version: z.literal(2),
    id,
    expectedRevision: revision,
    expectedOwner: localOwner,
    updates: AutomationCommandDefinitionCreateV1.partial().strict()
  })
  .strict()

export const AutomationRunNowV2 = z
  .object({
    version: z.literal(2),
    id,
    expectedRevision: revision,
    expectedOwner: localOwner,
    requestKey,
    requestCreatedAt: z.number().int().nonnegative().finite(),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .strict()

export const AutomationDeleteV2 = z
  .object({
    version: z.literal(2),
    id,
    expectedRevision: revision,
    expectedOwner: localOwner
  })
  .strict()

export const AutomationCancelRunV1 = z
  .object({
    version: z.literal(1),
    id,
    runId: id,
    expectedOwner: localOwner,
    requestKey
  })
  .strict()
