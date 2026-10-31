import { z } from 'zod'

export const ACCOUNT_DEVICE_SIGN_IN_RUNTIME_CAPABILITY = 'accounts.device-sign-in.v1' as const
export const BeginAccountDeviceSignInParams = z.object({ provider: z.literal('codex') }).strict()
export const AccountDeviceSignInParams = z.object({ id: z.uuid() }).strict()
export const AccountDeviceSignInSchema = z
  .object({
    id: z.uuid(),
    provider: z.literal('codex'),
    status: z.enum(['starting', 'waiting', 'complete', 'failed', 'cancelled']),
    verificationUrl: z.literal('https://auth.openai.com/codex/device').optional(),
    userCode: z
      .string()
      .regex(/^[A-Z0-9]{4}-[A-Z0-9]{5}$/)
      .optional(),
    expiresAt: z.number().int().positive(),
    error: z.string().max(300).optional()
  })
  .strict()
export type AccountDeviceSignIn = z.infer<typeof AccountDeviceSignInSchema>
export type CodexDeviceAuthorization = {
  verificationUrl: 'https://auth.openai.com/codex/device'
  userCode: string
}
