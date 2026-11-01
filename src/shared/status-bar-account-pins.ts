import { z } from 'zod'

export const StatusBarAccountPinSchema = z.object({
  owner: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => value === 'local' || value.startsWith('environment:')),
  provider: z.enum(['claude', 'codex']),
  runtimeKey: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => value === 'host' || value.startsWith('wsl:')),
  accountId: z.string().min(1).max(200).nullable(),
  label: z.string().trim().min(1).max(160)
})
export type StatusBarAccountPin = z.infer<typeof StatusBarAccountPinSchema>
export const MAX_STATUS_BAR_ACCOUNT_PINS = 64
export const VISIBLE_STATUS_BAR_ACCOUNT_PINS = 3

export function statusBarAccountPinKey(pin: StatusBarAccountPin): string {
  return JSON.stringify([pin.owner, pin.provider, pin.runtimeKey, pin.accountId])
}

export function normalizeStatusBarAccountPins(value: unknown): StatusBarAccountPin[] {
  if (!Array.isArray(value)) {
    return []
  }
  const result: StatusBarAccountPin[] = []
  const keys = new Set<string>()
  for (const item of value.slice(0, MAX_STATUS_BAR_ACCOUNT_PINS * 2)) {
    const parsed = StatusBarAccountPinSchema.safeParse(item)
    if (!parsed.success) {
      continue
    }
    const key = statusBarAccountPinKey(parsed.data)
    if (keys.has(key)) {
      continue
    }
    keys.add(key)
    result.push(parsed.data)
    if (result.length === MAX_STATUS_BAR_ACCOUNT_PINS) {
      break
    }
  }
  return result
}
