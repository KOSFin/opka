import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { AutomationCommandClaimV1 } from '../../shared/automation-command-domain'
import { writeDurableJson } from './automation-durable-receipt-write'

type Intent = AutomationCommandClaimV1['processIntent' | 'agentIntent']

export function isAutomationCgroupEmpty(childCgroupPath: string): boolean {
  return /^populated 0$/m.test(readFileSync(join(childCgroupPath, 'cgroup.events'), 'utf8'))
}

export function cancelLinuxCgroupAutomationCommand(
  claim: AutomationCommandClaimV1
): 'live' | 'unverifiable' | 'exited' {
  return cancelLinuxCgroupAutomationProcess(claim.processIntent, claim.acquisitionId)
}

export function cancelLinuxCgroupAutomationAgent(
  claim: AutomationCommandClaimV1
): 'live' | 'unverifiable' | 'exited' {
  return cancelLinuxCgroupAutomationProcess(claim.agentIntent, claim.acquisitionId)
}

function cancelLinuxCgroupAutomationProcess(
  intent: Intent,
  acquisitionId: string
): 'live' | 'unverifiable' | 'exited' {
  if (
    !intent?.childCgroupPath ||
    basename(intent.childCgroupPath) !== intent.childName ||
    basename(dirname(intent.childCgroupPath)) !== intent.unitName
  ) {
    return 'unverifiable'
  }
  try {
    if (isAutomationCgroupEmpty(intent.childCgroupPath)) {
      const empty = z
        .object({ acquisitionId: z.string().uuid(), childCgroupPath: z.string() })
        .strict()
        .safeParse(JSON.parse(readFileSync(join(intent.receiptDirectory, 'empty.json'), 'utf8')))
      const root = z
        .object({
          exitCode: z.number().int().nullable(),
          error: z.string().nullable(),
          stdout: z.string().max(16 * 1024),
          stderr: z.string().max(16 * 1024),
          stdoutTruncated: z.boolean(),
          stderrTruncated: z.boolean()
        })
        .strict()
        .safeParse(JSON.parse(readFileSync(join(intent.receiptDirectory, 'root.json'), 'utf8')))
      return empty.success &&
        empty.data.acquisitionId === acquisitionId &&
        empty.data.childCgroupPath === intent.childCgroupPath &&
        root.success
        ? 'exited'
        : 'unverifiable'
    }
    writeFileSync(join(intent.childCgroupPath, 'cgroup.kill'), '1')
    return 'live'
  } catch {
    return 'unverifiable'
  }
}

export function releaseLinuxCgroupAutomationProcess(
  intent: NonNullable<Intent>,
  acquisitionId: string
): void {
  if (!intent.childCgroupPath || !isAutomationCgroupEmpty(intent.childCgroupPath)) {
    return
  }
  const release = join(intent.receiptDirectory, 'release.json')
  if (!existsSync(release)) {
    writeDurableJson(release, { acquisitionId })
  }
}

export function releaseLinuxCgroupAutomationCommand(claim: AutomationCommandClaimV1): void {
  if (claim.processIntent) {
    releaseLinuxCgroupAutomationProcess(claim.processIntent, claim.acquisitionId)
  }
}

/** A prior command's durable exit proof is valid only while its own child is gone or empty. */
export function provePriorCommandChildExited(claim: AutomationCommandClaimV1): boolean {
  const intent = claim.processIntent
  if (
    !intent?.exitProof ||
    !intent.execMayHappen ||
    !intent.childCgroupPath ||
    !intent.blockedChildPid ||
    !intent.blockedChildStartTime ||
    basename(intent.childCgroupPath) !== 'command' ||
    basename(dirname(intent.childCgroupPath)) !== intent.unitName ||
    resolve(intent.childCgroupPath) !== intent.childCgroupPath
  ) {
    return false
  }
  try {
    statSync(intent.childCgroupPath)
    return isAutomationCgroupEmpty(intent.childCgroupPath)
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
  }
}
