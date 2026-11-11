const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { openAutomationState } = require('./automation-command-state.cjs')

const production = require(process.argv[2])
const { createLinuxCommandAutomationAdapter, createAutomationRunWriter } = production
const root = process.argv[3]
assert.ok(root.startsWith('/tmp/orca-automation-case-'))
fs.mkdirSync(root, { recursive: true, mode: 0o700 })
const receiptDirectory = path.join(root, 'receipt')
const marker = path.join(root, 'command-starts')
const acquisitionId = randomUUID()
const unitName = `orca-automation-${acquisitionId}.scope`
const now = Date.now()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await pause(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function populated(cgroup) {
  return /^populated 1$/m.test(fs.readFileSync(path.join(cgroup, 'cgroup.events'), 'utf8'))
}

function startTime(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
}

const rootProgram = [
  "const fs=require('node:fs')",
  "const {spawn}=require('node:child_process')",
  'fs.appendFileSync(process.argv[1], "x")',
  "const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:'ignore'})",
  'child.unref()',
  'process.stdout.write("root-done")'
].join(';')
const definition = production.AutomationCommandDefinitionV1.parse({
  id: 'automation-fixture',
  name: 'Disposable scope fixture',
  revision: 1,
  runContext: {
    kind: 'workspace-run',
    projectId: 'folder-fixture',
    hostId: 'local',
    projectHostSetupId: 'setup-fixture',
    repoId: 'folder-fixture',
    path: root
  },
  sourceContext: null,
  projectId: 'folder-fixture',
  executionTargetType: 'local',
  executionTargetId: 'local',
  schedulerOwner: 'local_host_service',
  workspaceMode: 'existing',
  workspaceId: null,
  baseBranch: null,
  timezone: 'UTC',
  rrule: 'FREQ=DAILY;BYHOUR=12;BYMINUTE=0',
  dtstart: now,
  enabled: true,
  nextRunAt: now + 86_400_000,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 720,
  createdAt: now,
  updatedAt: now,
  execution: {
    version: 1,
    command: { kind: 'program', executable: process.execPath, argv: ['-e', rootProgram, marker] },
    condition: 'exit_zero',
    agent: null,
    reportTarget: null,
    policy: { timeoutSeconds: 60, commandTimeoutSeconds: 45, idempotent: false, maxAttempts: 1 }
  }
})
let claim = {
  automationId: definition.id,
  runId: 'run-fixture',
  definitionRevision: 1,
  hostId: 'local',
  hostGeneration: 1,
  acquisitionId,
  attempt: 1,
  phase: 'acquiring',
  createdAt: now,
  observation: 'unverifiable',
  processIntent: { backend: 'linux_cgroup_v1', unitName, childName: 'command', receiptDirectory },
  runSnapshot: {
    title: 'Disposable scope fixture run 1',
    scheduledFor: now,
    trigger: 'manual',
    workspaceId: null,
    createdAt: now,
    runNumber: 1
  }
}
const state = production.getDefaultPersistedState(root)
state.automationCommandsV1 = {
  version: 1,
  definitions: [definition],
  activeClaims: [claim],
  manualReceipts: []
}
state.automationRuns = production.recoverActiveAutomationCommandRuns(state, [], () => {})
const authority = openAutomationState(production, root, state)
authority.persist()
const runs = createAutomationRunWriter(authority.store, null)
const fence = {
  automationId: claim.automationId,
  runId: claim.runId,
  acquisitionId: claim.acquisitionId,
  hostGeneration: claim.hostGeneration,
  expectedPhase: 'acquiring'
}
authority.store.advanceCommandAutomationRun(fence, { phase: 'command', observation: 'live' })
authority.persist()
claim = authority.store.getCommandAutomationClaim(claim.automationId, claim.runId)
let receipt
let emptyAtProof = false
let bound
const boundPromise = new Promise((resolve) => {
  bound = resolve
})
let adapter
const checkedRuns = {
  bindCommandProcessIntent: async (binding, candidate) => {
    receipt = candidate
    assert.equal(startTime(candidate.blockedChildPid), candidate.blockedChildStartTime)
    assert.ok(
      fs
        .readFileSync(`/proc/${candidate.blockedChildPid}/cgroup`, 'utf8')
        .includes(`0::${candidate.childCgroupPath.slice('/sys/fs/cgroup'.length)}`)
    )
    assert.ok(populated(candidate.childCgroupPath))
    assert.equal(fs.existsSync(path.join(receiptDirectory, 'gate.json')), false)
    const refuseBeforeGate = async (stale) => {
      assert.deepEqual(await adapter.executeCommand(definition, stale), { verdict: 'unverifiable' })
      assert.equal(fs.existsSync(path.join(receiptDirectory, 'gate.json')), false)
    }
    await refuseBeforeGate({ ...claim, acquisitionId: randomUUID() })
    await refuseBeforeGate({
      ...claim,
      hostGeneration: claim.hostGeneration + 1,
      processIntent: { ...claim.processIntent, ...candidate, execMayHappen: true }
    })
    await refuseBeforeGate({
      ...claim,
      processIntent: { ...claim.processIntent, unitName: `stale-${unitName}` }
    })
    await refuseBeforeGate({
      ...claim,
      processIntent: {
        ...claim.processIntent,
        execMayHappen: true,
        childCgroupPath: `${candidate.childCgroupPath}-stale`,
        blockedChildPid: candidate.blockedChildPid,
        blockedChildStartTime: candidate.blockedChildStartTime
      }
    })
    await refuseBeforeGate({
      ...claim,
      processIntent: {
        ...claim.processIntent,
        execMayHappen: true,
        childCgroupPath: candidate.childCgroupPath,
        blockedChildPid: candidate.blockedChildPid,
        blockedChildStartTime: `${candidate.blockedChildStartTime}0`
      }
    })
    claim = await runs.bindCommandProcessIntent(binding, candidate)
    bound()
  },
  recordCommandExitProof: async (binding, observation, verifiedAt) => {
    const empty = JSON.parse(fs.readFileSync(path.join(receiptDirectory, 'empty.json'), 'utf8'))
    assert.equal(empty.acquisitionId, acquisitionId)
    assert.equal(empty.childCgroupPath, receipt.childCgroupPath)
    assert.equal(populated(receipt.childCgroupPath), false)
    emptyAtProof = true
    claim = await runs.recordCommandExitProof(binding, observation, verifiedAt)
  }
}
adapter = createLinuxCommandAutomationAdapter({
  store: authority.store,
  runs: checkedRuns,
  resolveExistingWorkspaceCwd: async () => root
})

async function main() {
  assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
  assert.equal(adapter.isHostReady(), true, 'disposable user bus and delegated cgroup required')
  assert.equal(await adapter.supportsDefinition(definition), true)
  assert.equal(
    await adapter.supportsDefinition({ ...definition, executionTargetType: 'ssh' }),
    false
  )
  assert.equal(fs.existsSync(marker), false, 'unsupported host must not run the command')
  const executing = adapter.executeCommand(definition, claim)
  await boundPromise
  await until(() => fs.existsSync(path.join(receiptDirectory, 'gate.json')), 'durable effect gate')
  await until(() => fs.existsSync(path.join(receiptDirectory, 'root.json')), 'root result')
  assert.ok(populated(receipt.childCgroupPath), 'detached descendant must keep child cgroup live')
  assert.equal(fs.existsSync(path.join(receiptDirectory, 'empty.json')), false)
  assert.equal(await adapter.cancelRun(claim), 'live')
  const outcome = await executing
  assert.equal(outcome.verdict, 'exited')
  assert.equal(outcome.observation.exitCode, 0)
  assert.equal(outcome.observation.stdout, 'root-done')
  assert.equal(emptyAtProof, true)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x')
  await until(() => !fs.existsSync(receiptDirectory), 'scope cleanup')

  const persisted = JSON.parse(fs.readFileSync(authority.file, 'utf8'))
  const retained = production.readAutomationCommandsV1Domain(persisted.automationCommandsV1)
  assert.equal(retained.activeClaims[0].runId, claim.runId)
  assert.equal(retained.activeClaims[0].phase, 'command')
  assert.equal(retained.activeClaims[0].processIntent.exitProof.exitCode, 0)
  assert.equal(persisted.automationRuns[0].id, claim.runId)
  assert.equal(persisted.automationRuns[0].status, 'dispatching')
  console.log(
    JSON.stringify({
      oracle: 'automation-scope-prepared-for-fresh-process',
      unitName,
      acquisitionId,
      runId: claim.runId,
      blockedChildPid: receipt.blockedChildPid,
      blockedChildStartTime: receipt.blockedChildStartTime,
      childCgroupPath: receipt.childCgroupPath,
      rootExitedBeforeDescendant: true,
      childEmptyAfterCancel: true,
      persistedPhase: retained.activeClaims[0].phase,
      commandStarts: 1
    })
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
