import { basename, dirname, resolve } from 'node:path'
import type { AutomationCommandObservation } from '../../../shared/automation-command-execution'
import type { AutomationCommandClaimV1 } from '../../../shared/automation-command-domain'
import {
  readFencedClaim,
  type CommandProgressFence,
  type CommandProgressOperations
} from './automation-command-progress-operations'

export function bindAutomationCommandProcessIntent(
  operations: CommandProgressOperations,
  fence: CommandProgressFence,
  receipt: { childCgroupPath: string; blockedChildPid: number; blockedChildStartTime: string }
): AutomationCommandClaimV1 {
  const { domain, claim } = readFencedClaim(operations, fence)
  const intent = claim.processIntent
  if (
    claim.phase !== 'command' ||
    !intent ||
    intent.execMayHappen ||
    !Number.isSafeInteger(receipt.blockedChildPid) ||
    receipt.blockedChildPid < 1 ||
    !/^\d+$/.test(receipt.blockedChildStartTime) ||
    receipt.childCgroupPath.length > 4096 ||
    !receipt.childCgroupPath.startsWith('/sys/fs/cgroup/') ||
    basename(receipt.childCgroupPath) !== intent.childName ||
    basename(dirname(receipt.childCgroupPath)) !== intent.unitName ||
    resolve(receipt.childCgroupPath) !== receipt.childCgroupPath
  ) {
    throw new Error('Command process receipt does not match its durable acquisition.')
  }
  const updated: AutomationCommandClaimV1 = {
    ...claim,
    observation: 'live',
    processIntent: {
      ...intent,
      childCgroupPath: receipt.childCgroupPath,
      blockedChildPid: receipt.blockedChildPid,
      blockedChildStartTime: receipt.blockedChildStartTime,
      execMayHappen: true
    }
  }
  operations.state.automationCommandsV1 = {
    ...domain,
    activeClaims: domain.activeClaims.map((entry) =>
      entry.automationId === claim.automationId ? updated : entry
    )
  }
  operations.markDomainsDirty()
  operations.flush()
  return updated
}

export function recordAutomationCommandExitProof(
  operations: CommandProgressOperations,
  fence: CommandProgressFence,
  observation: AutomationCommandObservation,
  verifiedAt: number
): AutomationCommandClaimV1 {
  const { domain, claim } = readFencedClaim(operations, fence)
  const intent = claim.processIntent
  if (
    claim.phase !== 'command' ||
    !intent?.execMayHappen ||
    !intent.childCgroupPath ||
    intent.exitProof ||
    !Number.isSafeInteger(verifiedAt) ||
    verifiedAt < claim.createdAt ||
    Buffer.byteLength(observation.stdout, 'utf8') > 16 * 1024 ||
    Buffer.byteLength(observation.stderr ?? '', 'utf8') > 16 * 1024 ||
    Buffer.byteLength(observation.error ?? '', 'utf8') > 4096
  ) {
    throw new Error('Command exit proof does not match its durable acquisition.')
  }
  const updated: AutomationCommandClaimV1 = {
    ...claim,
    observation: 'exited',
    processIntent: {
      ...intent,
      exitProof: {
        ...observation,
        verifiedAt,
        stderr: observation.stderr ?? '',
        stderrTruncated: observation.stderrTruncated ?? false
      }
    }
  }
  operations.state.automationCommandsV1 = {
    ...domain,
    activeClaims: domain.activeClaims.map((entry) =>
      entry.automationId === claim.automationId ? updated : entry
    )
  }
  operations.markDomainsDirty()
  operations.flush()
  return updated
}

export function bindAutomationAgentProcessIntent(
  operations: CommandProgressOperations,
  fence: CommandProgressFence,
  receipt: {
    childCgroupPath: string
    blockedChildPid: number
    blockedChildStartTime: string
    binaryPath: string
    binaryFingerprint: string
  }
): AutomationCommandClaimV1 {
  const { domain, claim } = readFencedClaim(operations, fence)
  const intent = claim.agentIntent
  if (
    claim.phase !== 'agent' ||
    !intent ||
    intent.execMayHappen ||
    !Number.isSafeInteger(receipt.blockedChildPid) ||
    receipt.blockedChildPid < 1 ||
    !/^\d+$/.test(receipt.blockedChildStartTime) ||
    receipt.childCgroupPath.length > 4096 ||
    receipt.binaryPath.length > 4096 ||
    !receipt.binaryPath.startsWith('/') ||
    resolve(receipt.binaryPath) !== receipt.binaryPath ||
    receipt.binaryFingerprint.length > 256 ||
    !receipt.childCgroupPath.startsWith('/sys/fs/cgroup/') ||
    basename(receipt.childCgroupPath) !== 'agent' ||
    basename(dirname(receipt.childCgroupPath)) !== intent.unitName ||
    resolve(receipt.childCgroupPath) !== receipt.childCgroupPath
  ) {
    throw new Error('Agent process receipt does not match its durable acquisition.')
  }
  const updated: AutomationCommandClaimV1 = {
    ...claim,
    observation: 'live',
    agentIntent: {
      ...intent,
      childCgroupPath: receipt.childCgroupPath,
      blockedChildPid: receipt.blockedChildPid,
      blockedChildStartTime: receipt.blockedChildStartTime,
      binaryPath: receipt.binaryPath,
      binaryFingerprint: receipt.binaryFingerprint,
      execMayHappen: true
    }
  }
  operations.state.automationCommandsV1 = {
    ...domain,
    activeClaims: domain.activeClaims.map((entry) =>
      entry.automationId === claim.automationId ? updated : entry
    )
  }
  operations.markDomainsDirty()
  operations.flush()
  return updated
}

export function recordAutomationAgentExitProof(
  operations: CommandProgressOperations,
  fence: CommandProgressFence,
  observation: AutomationCommandObservation,
  verifiedAt: number
): AutomationCommandClaimV1 {
  const { domain, claim } = readFencedClaim(operations, fence)
  const intent = claim.agentIntent
  if (
    claim.phase !== 'agent' ||
    !intent?.execMayHappen ||
    !intent.childCgroupPath ||
    intent.exitProof ||
    !Number.isSafeInteger(verifiedAt) ||
    verifiedAt < claim.createdAt ||
    Buffer.byteLength(observation.stdout, 'utf8') > 16 * 1024 ||
    Buffer.byteLength(observation.stderr ?? '', 'utf8') > 16 * 1024 ||
    Buffer.byteLength(observation.error ?? '', 'utf8') > 4096
  ) {
    throw new Error('Agent exit proof does not match its durable acquisition.')
  }
  const updated: AutomationCommandClaimV1 = {
    ...claim,
    observation: 'exited',
    agentIntent: {
      ...intent,
      exitProof: {
        ...observation,
        verifiedAt,
        stderr: observation.stderr ?? '',
        stderrTruncated: observation.stderrTruncated ?? false
      }
    }
  }
  operations.state.automationCommandsV1 = {
    ...domain,
    activeClaims: domain.activeClaims.map((entry) =>
      entry.automationId === claim.automationId ? updated : entry
    )
  }
  operations.markDomainsDirty()
  operations.flush()
  return updated
}
