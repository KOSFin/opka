import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { AutomationCommandClaimV1 } from '../../shared/automation-command-domain'

const CGROUP_ROOT = '/sys/fs/cgroup'
const ReceiptSchema = z
  .object({
    acquisitionId: z.string().uuid(),
    unitName: z.string(),
    childCgroupPath: z.string(),
    blockedChildPid: z.number().int().positive(),
    blockedChildStartTime: z.string().regex(/^\d+$/)
  })
  .strict()
export type Receipt = z.infer<typeof ReceiptSchema>
function readStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
  } catch {
    return null
  }
}

function blockedChildMatches(receipt: Receipt): boolean {
  try {
    const procCgroup = readFileSync(`/proc/${receipt.blockedChildPid}/cgroup`, 'utf8')
    return (
      procCgroup.split('\n').includes(`0::${receipt.childCgroupPath.slice(CGROUP_ROOT.length)}`) &&
      readStartTime(receipt.blockedChildPid) === receipt.blockedChildStartTime
    )
  } catch {
    return false
  }
}

export function verifyAutomationCommandReceipt(
  input: {
    claim: AutomationCommandClaimV1
    intent: NonNullable<AutomationCommandClaimV1['processIntent' | 'agentIntent']>
  },
  candidate: unknown
): Receipt | null {
  const { claim, intent } = input
  const parsed = ReceiptSchema.safeParse(candidate)
  if (!intent || !parsed.success) {
    return null
  }
  const receipt = parsed.data
  if (
    receipt.acquisitionId !== claim.acquisitionId ||
    receipt.unitName !== intent.unitName ||
    !receipt.childCgroupPath.startsWith(`${CGROUP_ROOT}/`) ||
    resolve(receipt.childCgroupPath) !== receipt.childCgroupPath
  ) {
    return null
  }
  const segments = receipt.childCgroupPath.split('/')
  if (segments.at(-1) !== intent.childName || segments.at(-2) !== intent.unitName) {
    return null
  }
  const priorBindingMatches =
    intent.execMayHappen === true &&
    intent.childCgroupPath === receipt.childCgroupPath &&
    intent.blockedChildPid === receipt.blockedChildPid &&
    intent.blockedChildStartTime === receipt.blockedChildStartTime &&
    existsSync(join(intent.receiptDirectory, 'gate.json'))
  return blockedChildMatches(receipt) || priorBindingMatches ? receipt : null
}
