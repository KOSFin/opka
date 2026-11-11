import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { spawnProcess } from '@orca/process-host'
import type {
  AutomationCommandClaimV1,
  AutomationCommandDefinitionV1
} from '../../shared/automation-command-domain'
import type { AutomationCommandObservation } from '../../shared/automation-command-execution'
import { userManagerEnv, isDurableDaemonScopeSupported } from '../daemon/daemon-cgroup-scope'
import { AUTOMATION_CGROUP_SUPERVISOR_SOURCE } from './automation-cgroup-supervisor-source'
import { writeDurableJson, writeDurableText } from './automation-durable-receipt-write'

const ReceiptSchema = z
  .object({
    acquisitionId: z.string().uuid(),
    unitName: z.string(),
    childCgroupPath: z.string(),
    blockedChildPid: z.number().int().positive(),
    blockedChildStartTime: z.string().regex(/^\d+$/)
  })
  .strict()
type Receipt = z.infer<typeof ReceiptSchema>
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

type LinuxCommandInput = {
  definition: AutomationCommandDefinitionV1
  claim: AutomationCommandClaimV1
  cwd: string
  resolvedExecutable: string
  bindReceipt(
    receipt: Pick<Receipt, 'childCgroupPath' | 'blockedChildPid' | 'blockedChildStartTime'>
  ): Promise<void>
  persistExitProof(observation: AutomationCommandObservation): Promise<void>
  mayReleaseGate(): boolean
}

const CGROUP_ROOT = '/sys/fs/cgroup'
const RECEIPT_WAIT_MS = 15_000

function readJsonFile(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}

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

function verifyReceipt(claim: AutomationCommandClaimV1, candidate: unknown): Receipt | null {
  const intent = claim.processIntent
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

function isEmpty(childCgroupPath: string): boolean {
  return /^populated 0$/m.test(readFileSync(join(childCgroupPath, 'cgroup.events'), 'utf8'))
}

async function waitForFile(file: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return existsSync(file)
}

function startSupervisor(input: LinuxCommandInput): void {
  const intent = input.claim.processIntent
  if (!intent) {
    throw new Error('command_process_intent_missing')
  }
  const directory = intent.receiptDirectory
  mkdirSync(directory, { mode: 0o700 })
  const command = input.definition.execution.command
  writeDurableJson(join(directory, 'spec.json'), {
    acquisitionId: input.claim.acquisitionId,
    unitName: intent.unitName,
    command:
      command.kind === 'program'
        ? { ...command, executable: input.resolvedExecutable }
        : { ...command, interpreter: input.resolvedExecutable },
    cwd: input.cwd,
    timeoutMs: input.definition.execution.policy.commandTimeoutSeconds * 1000
  })
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
export async function executeLinuxCgroupAutomationCommand(
  input: LinuxCommandInput
): Promise<
  { verdict: 'exited'; observation: AutomationCommandObservation } | { verdict: 'unverifiable' }
> {
  const intent = input.claim.processIntent
  if (!intent) {
    return { verdict: 'unverifiable' }
  }
  if (intent.exitProof) {
    try {
      releaseLinuxCgroupAutomationCommand(input.claim)
    } catch {}
    const { verifiedAt: _verifiedAt, ...observation } = intent.exitProof
    return { verdict: 'exited', observation }
  }
  if (process.platform !== 'linux' || !isDurableDaemonScopeSupported()) {
    return { verdict: 'unverifiable' }
  }
  const directory = intent.receiptDirectory
  try {
    if (!existsSync(directory)) {
      startSupervisor(input)
    }
    if (!(await waitForFile(join(directory, 'receipt.json'), Date.now() + RECEIPT_WAIT_MS))) {
      return { verdict: 'unverifiable' }
    }
    const receipt = verifyReceipt(input.claim, readJsonFile(join(directory, 'receipt.json')))
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
    if (!input.mayReleaseGate()) {
      return { verdict: 'unverifiable' }
    }
    if (!existsSync(join(directory, 'gate.json'))) {
      writeDurableJson(join(directory, 'gate.json'), { acquisitionId: input.claim.acquisitionId })
    }
    const deadline =
      Date.now() + input.definition.execution.policy.commandTimeoutSeconds * 1000 + 20_000
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
      !isEmpty(receipt.childCgroupPath)
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
    releaseLinuxCgroupAutomationCommand({
      ...input.claim,
      processIntent: { ...intent, childCgroupPath: receipt.childCgroupPath }
    })
    return { verdict: 'exited', observation }
  } catch {
    return { verdict: 'unverifiable' }
  }
}

export function cancelLinuxCgroupAutomationCommand(
  claim: AutomationCommandClaimV1
): 'live' | 'unverifiable' | 'exited' {
  const intent = claim.processIntent
  if (
    !intent?.childCgroupPath ||
    basename(intent.childCgroupPath) !== intent.childName ||
    basename(dirname(intent.childCgroupPath)) !== intent.unitName
  ) {
    return 'unverifiable'
  }
  try {
    if (isEmpty(intent.childCgroupPath)) {
      const empty = z
        .object({ acquisitionId: z.string().uuid(), childCgroupPath: z.string() })
        .strict()
        .safeParse(readJsonFile(join(intent.receiptDirectory, 'empty.json')))
      const root = RootSchema.safeParse(readJsonFile(join(intent.receiptDirectory, 'root.json')))
      return empty.success &&
        empty.data.acquisitionId === claim.acquisitionId &&
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

export function releaseLinuxCgroupAutomationCommand(claim: AutomationCommandClaimV1): void {
  const intent = claim.processIntent
  if (!intent?.childCgroupPath || !isEmpty(intent.childCgroupPath)) {
    return
  }
  const release = join(intent.receiptDirectory, 'release.json')
  if (!existsSync(release)) {
    writeDurableJson(release, { acquisitionId: claim.acquisitionId })
  }
}
