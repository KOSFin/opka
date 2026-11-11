import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { spawnProcess } from '@orca/process-host'
import type {
  AutomationCommandClaimV1,
  AutomationCommandDefinitionV1
} from '../../shared/automation-command-domain'
import type {
  AutomationCommandObservation,
  AutomationCommandV1
} from '../../shared/automation-command-execution'
import { userManagerEnv, isDurableDaemonScopeSupported } from '../daemon/daemon-cgroup-scope'
import { AUTOMATION_CGROUP_SUPERVISOR_SOURCE } from './automation-cgroup-supervisor-source'
import { writeDurableJson, writeDurableText } from './automation-durable-receipt-write'
import {
  isAutomationCgroupEmpty,
  releaseLinuxCgroupAutomationProcess
} from './automation-linux-cgroup-lifecycle'
export {
  cancelLinuxCgroupAutomationAgent,
  cancelLinuxCgroupAutomationCommand,
  releaseLinuxCgroupAutomationCommand
} from './automation-linux-cgroup-lifecycle'

import { verifyAutomationCommandReceipt, type Receipt } from './automation-cgroup-command-receipt'

const RootSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    error: z.string().nullable(),
    stdout: z.string().max(16 * 1024),
    stderr: z.string().max(16 * 1024),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean()
  })
  .strict()

type LinuxProcessInput = {
  claim: AutomationCommandClaimV1
  intent: NonNullable<AutomationCommandClaimV1['processIntent' | 'agentIntent']>
  command: AutomationCommandV1
  cwd: string
  timeoutSeconds: number
  deadlineAt?: number
  stdinText?: string
  binaryFingerprint?: string
  bindReceipt(
    receipt: Pick<Receipt, 'childCgroupPath' | 'blockedChildPid' | 'blockedChildStartTime'>
  ): Promise<void>
  persistExitProof(observation: AutomationCommandObservation): Promise<void>
  mayReleaseGate(): boolean | Promise<boolean>
}

const RECEIPT_WAIT_MS = 15_000

const readJsonFile = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))

async function waitForFile(file: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return existsSync(file)
}

function startSupervisor(input: LinuxProcessInput): void {
  const { intent } = input
  const directory = intent.receiptDirectory
  mkdirSync(directory, { mode: 0o700 })
  const command = input.command
  writeDurableJson(join(directory, 'spec.json'), {
    acquisitionId: input.claim.acquisitionId,
    unitName: intent.unitName,
    childName: intent.childName,
    command,
    cwd: input.cwd,
    timeoutMs: input.timeoutSeconds * 1000,
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    ...(input.stdinText !== undefined ? { stdinFile: 'agent-prompt.txt' } : {}),
    ...(input.binaryFingerprint ? { binaryFingerprint: input.binaryFingerprint } : {})
  })
  if (input.stdinText !== undefined) {
    writeDurableText(join(directory, 'agent-prompt.txt'), input.stdinText)
  }
  if (command.kind === 'script') {
    writeDurableText(
      join(directory, command.language === 'shell' ? 'command.sh' : 'command.py'),
      command.text
    )
  }
  writeDurableText(join(directory, 'supervisor.cjs'), AUTOMATION_CGROUP_SUPERVISOR_SOURCE)
  const child = spawnProcess({
    program: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--property=Delegate=yes',
      `--unit=${intent.unitName}`,
      '--',
      process.execPath,
      join(directory, 'supervisor.cjs'),
      'supervisor',
      directory
    ],
    env: { ...userManagerEnv(process.env), ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
    detached: true
  })
  child.on('error', () => {})
  child.unref()
}

/** A checked receipt permits the gate; physical cgroup emptiness permits an exited verdict. */
export async function executeLinuxCgroupAutomationProcess(
  input: LinuxProcessInput
): Promise<
  { verdict: 'exited'; observation: AutomationCommandObservation } | { verdict: 'unverifiable' }
> {
  const { intent } = input
  if (intent.exitProof) {
    try {
      releaseLinuxCgroupAutomationProcess(intent, input.claim.acquisitionId)
    } catch {}
    const { verifiedAt: _verifiedAt, ...observation } = intent.exitProof
    return { verdict: 'exited', observation }
  }
  if (process.platform !== 'linux' || !isDurableDaemonScopeSupported()) {
    return { verdict: 'unverifiable' }
  }
  const directory = intent.receiptDirectory
  try {
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      return { verdict: 'unverifiable' }
    }
    if (!existsSync(directory)) {
      startSupervisor(input)
    }
    if (
      !(await waitForFile(
        join(directory, 'receipt.json'),
        Math.min(Date.now() + RECEIPT_WAIT_MS, input.deadlineAt ?? Infinity)
      ))
    ) {
      return { verdict: 'unverifiable' }
    }
    const receipt = verifyAutomationCommandReceipt(
      input,
      readJsonFile(join(directory, 'receipt.json'))
    )
    if (!receipt) {
      return { verdict: 'unverifiable' }
    }
    if (!intent.execMayHappen) {
      await input.bindReceipt(receipt)
    } else if (
      intent.childCgroupPath !== receipt.childCgroupPath ||
      intent.blockedChildPid !== receipt.blockedChildPid ||
      intent.blockedChildStartTime !== receipt.blockedChildStartTime
    ) {
      return { verdict: 'unverifiable' }
    }
    if (
      !(await input.mayReleaseGate()) ||
      (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt)
    ) {
      return { verdict: 'unverifiable' }
    }
    if (!existsSync(join(directory, 'gate.json'))) {
      writeDurableJson(join(directory, 'gate.json'), { acquisitionId: input.claim.acquisitionId })
    }
    const deadline = Date.now() + input.timeoutSeconds * 1000 + 20_000
    if (!(await waitForFile(join(directory, 'empty.json'), deadline))) {
      return { verdict: 'unverifiable' }
    }
    const empty = z
      .object({ acquisitionId: z.string().uuid(), childCgroupPath: z.string() })
      .strict()
      .safeParse(readJsonFile(join(directory, 'empty.json')))
    if (
      !empty.success ||
      empty.data.acquisitionId !== input.claim.acquisitionId ||
      empty.data.childCgroupPath !== receipt.childCgroupPath ||
      !isAutomationCgroupEmpty(receipt.childCgroupPath)
    ) {
      return { verdict: 'unverifiable' }
    }
    if (!existsSync(join(directory, 'root.json'))) {
      return { verdict: 'unverifiable' }
    }
    const root = RootSchema.safeParse(readJsonFile(join(directory, 'root.json')))
    if (!root.success) {
      return { verdict: 'unverifiable' }
    }
    const result = root.data
    const timedOut = existsSync(join(directory, 'timeout.json'))
    const observation: AutomationCommandObservation = {
      exitCode: result.exitCode,
      timedOut,
      error: result.error,
      stdout: result.stdout,
      stdoutTruncated: result.stdoutTruncated,
      stderr: result.stderr,
      stderrTruncated: result.stderrTruncated
    }
    await input.persistExitProof(observation)
    releaseLinuxCgroupAutomationProcess(
      { ...intent, childCgroupPath: receipt.childCgroupPath },
      input.claim.acquisitionId
    )
    return { verdict: 'exited', observation }
  } catch {
    return { verdict: 'unverifiable' }
  }
}

export async function executeLinuxCgroupAutomationCommand(
  input: Omit<
    LinuxProcessInput,
    'intent' | 'command' | 'timeoutSeconds' | 'stdinText' | 'binaryFingerprint'
  > & {
    definition: AutomationCommandDefinitionV1
    resolvedExecutable: string
  }
): Promise<
  { verdict: 'exited'; observation: AutomationCommandObservation } | { verdict: 'unverifiable' }
> {
  const intent = input.claim.processIntent
  if (!intent) {
    return { verdict: 'unverifiable' }
  }
  const command = input.definition.execution.command
  return executeLinuxCgroupAutomationProcess({
    ...input,
    intent,
    command:
      command.kind === 'program'
        ? { ...command, executable: input.resolvedExecutable }
        : { ...command, interpreter: input.resolvedExecutable },
    timeoutSeconds: input.definition.execution.policy.commandTimeoutSeconds,
    ...(input.claim.attempt === 2
      ? {
          deadlineAt: Math.min(
            input.claim.createdAt + input.definition.execution.policy.timeoutSeconds * 1000,
            Date.now() + input.definition.execution.policy.commandTimeoutSeconds * 1000
          )
        }
      : {})
  })
}

export async function executeLinuxCgroupAutomationAgent(
  input: Omit<
    LinuxProcessInput,
    'intent' | 'command' | 'timeoutSeconds' | 'stdinText' | 'binaryFingerprint'
  > & {
    executable: string
    args: string[]
    prompt: string
    timeoutSeconds: number
    binaryFingerprint: string
  }
): Promise<
  { verdict: 'exited'; observation: AutomationCommandObservation } | { verdict: 'unverifiable' }
> {
  const intent = input.claim.agentIntent
  if (!intent) {
    return { verdict: 'unverifiable' }
  }
  return executeLinuxCgroupAutomationProcess({
    ...input,
    intent,
    command: { kind: 'program', executable: input.executable, argv: input.args },
    stdinText: input.prompt
  })
}
