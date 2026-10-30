import { z } from 'zod'

export const AccountPoolMemberSchema = z.object({
  accountId: z.string().min(1).max(200),
  priority: z.number().int().min(1).max(1000),
  weight: z.number().int().min(1).max(100),
  maxConcurrent: z.number().int().min(1).max(100).optional(),
  state: z.enum(['enabled', 'draining', 'disabled']),
  role: z.enum(['primary', 'reserve', 'manual']),
  cooldownUntil: z.number().finite().nonnegative().optional()
})
export const AccountPoolPolicySchema = z.object({
  id: z.string().min(1).max(100),
  provider: z.enum(['claude', 'codex']),
  revision: z.number().int().nonnegative(),
  strategy: z.enum(['manual', 'sequential', 'balanced']),
  applyToNewWork: z.boolean().default(false),
  rotation: z.enum(['off', 'on-limit', 'after-turn']).default('off'),
  unknownQuota: z.enum(['allow', 'exclude']),
  allowReserve: z.boolean(),
  members: z
    .array(AccountPoolMemberSchema)
    .max(100)
    .refine(
      (members) => new Set(members.map((member) => member.accountId)).size === members.length,
      'An account can appear only once in a pool'
    )
})
export type AccountPoolPolicy = z.infer<typeof AccountPoolPolicySchema>
export type AccountPoolCandidate = {
  accountId: string
  quotaIdentity: string
  auth: 'ready' | 'unavailable'
  quota: 'available' | 'exhausted' | 'unknown'
  usedPercent: number | null
}
export const AccountPoolUpdateParams = z.object({
  policy: AccountPoolPolicySchema,
  expectedRevision: z.number().int().nonnegative()
})
export const ACCOUNT_POOL_CAPABILITY = 'orchestration.account-pools.v1' as const
