import { z } from 'zod'

export const NativeAccountPoolEnrollmentSchema = z.object({
  poolId: z.string().min(1).max(100),
  accountId: z.string().min(1).max(200),
  policyRevision: z.number().int().nonnegative(),
  lastRotatedTurn: z.string().min(1).max(512).optional()
})
export type NativeAccountPoolEnrollment = z.infer<typeof NativeAccountPoolEnrollmentSchema>
