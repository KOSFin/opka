import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AutomationCommandClaimV1 } from '../../shared/automation-command-domain'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { isDurableDaemonScopeSupported } from '../daemon/daemon-cgroup-scope'
import { executeLinuxCgroupAutomationProcess } from './automation-linux-cgroup-command'
import { writeDurableJson } from './automation-durable-receipt-write'

/** Proves this owning host can gate a disposable child and observe descendant emptiness. */
export async function probeLinuxAutomationHost(input: {
  root: string
  hostEpoch: number
  runtimeId: string
  stillOwns(): boolean
}): Promise<boolean> {
  if (
    process.platform !== 'linux' ||
    !isDurableDaemonScopeSupported() ||
    !Number.isSafeInteger(input.hostEpoch) ||
    input.hostEpoch < 1 ||
    !input.runtimeId ||
    !input.stillOwns()
  ) {
    return false
  }
  const root = resolve(input.root)
  const trueBinary = await resolveCommandOnLocalPath('true', { cwd: root, env: process.env })
  let rootReady = false
  try {
    rootReady = (await stat(root)).isDirectory()
  } catch {
    return false
  }
  if (!trueBinary || !rootReady || !input.stillOwns()) {
    return false
  }
  const acquisitionId = randomUUID()
  const receiptDirectory = join(tmpdir(), `orca-automation-${acquisitionId}`)
  const intent = {
    backend: 'linux_cgroup_v1' as const,
    unitName: `orca-automation-${acquisitionId}.scope`,
    childName: 'command' as const,
    receiptDirectory
  }
  const claim: AutomationCommandClaimV1 = {
    automationId: 'host-probe',
    runId: acquisitionId,
    definitionRevision: 1,
    hostId: LOCAL_EXECUTION_HOST_ID,
    hostGeneration: input.hostEpoch,
    acquisitionId,
    attempt: 1,
    phase: 'command',
    createdAt: Date.now(),
    processIntent: intent
  }
  let bound = false
  const result = await executeLinuxCgroupAutomationProcess({
    claim,
    intent,
    command: { kind: 'program', executable: trueBinary, argv: [] },
    cwd: root,
    timeoutSeconds: 5,
    bindReceipt: async () => {
      bound = true
    },
    persistExitProof: async () => {},
    mayReleaseGate: () => bound && input.stillOwns()
  })
  const proved =
    result.verdict === 'exited' &&
    result.observation.exitCode === 0 &&
    !result.observation.timedOut &&
    bound &&
    input.stillOwns()
  if (existsSync(receiptDirectory) && !existsSync(join(receiptDirectory, 'release.json'))) {
    try {
      writeDurableJson(join(receiptDirectory, 'release.json'), { acquisitionId })
    } catch {
      return false
    }
  }
  const deadline = Date.now() + 25_000
  while (existsSync(receiptDirectory) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50))
  }
  return proved && !existsSync(receiptDirectory) && input.stillOwns()
}
