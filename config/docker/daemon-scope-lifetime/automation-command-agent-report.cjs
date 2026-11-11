const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { openAutomationState } = require('./automation-command-state.cjs')

const production = require(process.argv[2])
const root = process.argv[3]
assert.ok(root.startsWith('/tmp/orca-automation-case-'))
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
fs.mkdirSync(root, { recursive: true, mode: 0o700 })
const acquisitionId = randomUUID()
const now = Date.now()
const commandReceiptDirectory = path.join(root, 'command-receipt')
const agentMarker = path.join(root, 'agent-starts')
const chatSessionId = 'synthetic-chat'
const workspaceId = 'synthetic-workspace'
const target = {
  runtimeId: 'synthetic-runtime',
  hostId: 'local',
  workspaceId,
  chatSessionId,
  registrationGeneration: 1
}
const dummyAgent = [
  "const fs=require('node:fs')",
  "let prompt=''",
  "process.stdin.on('data',chunk=>prompt+=chunk)",
  "process.stdin.on('end',()=>{if(prompt!=='synthetic-review')process.exit(3);fs.appendFileSync(process.argv[1],'x');process.stdout.write('agent-ok')})"
].join(';')
const definition = production.AutomationCommandDefinitionV1.parse({
  id: 'automation-agent-report-fixture',
  name: 'Synthetic agent report',
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
  workspaceId,
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
    command: {
      kind: 'program',
      executable: process.execPath,
      argv: ['-e', "process.stdout.write('command-ok')"]
    },
    condition: 'exit_zero',
    agent: { agentId: 'codex', prompt: 'synthetic-review', sessionPolicy: 'ephemeral' },
    reportTarget: target,
    policy: { timeoutSeconds: 70, commandTimeoutSeconds: 30, idempotent: false, maxAttempts: 1 }
  }
})
const claim = {
  automationId: definition.id,
  runId: 'run-agent-report-fixture',
  definitionRevision: 1,
  hostId: 'local',
  hostGeneration: 1,
  acquisitionId,
  attempt: 1,
  phase: 'command',
  createdAt: now,
  observation: 'live',
  processIntent: {
    backend: 'linux_cgroup_v1',
    unitName: `orca-automation-${acquisitionId}.scope`,
    childName: 'command',
    receiptDirectory: commandReceiptDirectory
  },
  runSnapshot: {
    title: 'Synthetic agent report run 1',
    scheduledFor: now,
    trigger: 'manual',
    workspaceId,
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
const runs = production.createAutomationRunWriter(authority.store, null)
const database = production.JournalHostDatabase.open(root)
const journalIdentity = {
  sessionId: chatSessionId,
  workspaceId,
  hostId: 'local',
  agent: 'codex',
  providerHandle: null
}
const chatRecord = {
  sessionId: chatSessionId,
  location: { executionHostId: 'local', wslDistro: null, workspaceId },
  lease: { runtimeFence: 1 }
}
const reportDeps = {
  store: {
    readOnly: false,
    getRecord: (sessionId) => (sessionId === chatSessionId ? chatRecord : null),
    getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [chatSessionId] })
  },
  resolveWorkspacePath: async () => root
}
let journal
let agentReceiptDirectory
let agentBindings = 0
let reportDeliveries = 0

function fingerprint(program) {
  const stat = fs.statSync(program)
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join(':')
}

async function until(predicate, label) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function runDummyAgent(_agent, _definition, enteredClaim) {
  const current = authority.store.getCommandAutomationClaim(claim.automationId, claim.runId)
  assert.equal(current.phase, 'agent')
  assert.equal(enteredClaim.acquisitionId, current.acquisitionId)
  agentReceiptDirectory = current.agentIntent.receiptDirectory
  const fence = {
    automationId: current.automationId,
    runId: current.runId,
    acquisitionId: current.acquisitionId,
    hostGeneration: current.hostGeneration,
    expectedPhase: 'agent'
  }
  const binaryFingerprint = fingerprint(process.execPath)
  const result = await production.executeLinuxCgroupAutomationAgent({
    claim: current,
    cwd: root,
    executable: process.execPath,
    args: ['-e', dummyAgent, agentMarker],
    prompt: 'synthetic-review',
    timeoutSeconds: 20,
    binaryFingerprint,
    bindReceipt: async (receipt) => {
      assert.equal(fs.existsSync(path.join(agentReceiptDirectory, 'gate.json')), false)
      assert.throws(
        () =>
          authority.store.bindAutomationAgentProcessIntent(
            { ...fence, hostGeneration: fence.hostGeneration + 1 },
            { ...receipt, binaryPath: process.execPath, binaryFingerprint }
          ),
        /acquisition changed/
      )
      await runs.bindAgentProcessIntent(fence, {
        ...receipt,
        binaryPath: process.execPath,
        binaryFingerprint
      })
      agentBindings += 1
    },
    persistExitProof: async (observation) => {
      await runs.recordAgentExitProof(fence, observation, Date.now())
    },
    mayReleaseGate: () => {
      const latest = authority.store.getCommandAutomationClaim(claim.automationId, claim.runId)
      return (
        latest?.acquisitionId === current.acquisitionId &&
        latest.hostGeneration === current.hostGeneration &&
        latest.phase === 'agent' &&
        latest.agentIntent?.execMayHappen === true &&
        latest.cancelRequestedAt === undefined
      )
    }
  })
  return result.verdict === 'exited'
    ? { verdict: 'exited', success: result.observation.exitCode === 0 }
    : result
}

async function main() {
  journal = await production.openAgentSessionJournal({ database, identity: journalIdentity })
  const adapter = production.createLinuxCommandAutomationAdapter({
    store: authority.store,
    runs,
    hostGeneration: 1,
    isCurrentOwner: () => true,
    resolveExistingWorkspaceCwd: async () => root,
    oneShotAgent: { supportsDefinition: async () => true, run: runDummyAgent },
    reportDelivery: {
      supportsTarget: async () => true,
      deliver: async (selected, run) => {
        reportDeliveries += 1
        return (
          (await production.appendStructuredAutomationReport({
            deps: reportDeps,
            runtimeId: target.runtimeId,
            target: selected,
            run,
            openJournal: async () => journal
          })) === 'delivered'
        )
      }
    }
  })
  assert.equal(await adapter.supportsDefinition(definition), true)
  assert.deepEqual(await adapter.executeCommand(definition, { ...claim, hostGeneration: 2 }), {
    verdict: 'unverifiable'
  })
  const outcome = await production.runClaimedAutomationCommand({ definition, claim, runs, adapter })
  assert.equal(outcome.kind, 'settled')
  assert.equal(outcome.run.status, 'completed')
  assert.equal(outcome.run.commandExecution.deliveryStatus, 'delivered')
  assert.match(outcome.run.outputSnapshot.content, /command-ok/)
  assert.equal(agentBindings, 1)
  assert.equal(fs.readFileSync(agentMarker, 'utf8'), 'x')
  assert.equal(reportDeliveries, 1)
  assert.equal(authority.store.listCommandAutomationClaims().length, 0)
  await until(
    () => !fs.existsSync(commandReceiptDirectory) && !fs.existsSync(agentReceiptDirectory),
    'both physical scopes to release'
  )
  await journal.close()
  database.close()

  const restarted = openAutomationState(production, root)
  assert.equal(restarted.store.listCommandAutomationClaims().length, 0)
  assert.equal(restarted.store.listAutomationRuns(definition.id)[0].status, 'completed')
  const reopenedDatabase = production.JournalHostDatabase.open(root)
  const reopened = await production.openAgentSessionJournal({
    database: reopenedDatabase,
    identity: journalIdentity
  })
  const reports = () =>
    reopened.snapshot().items.filter((item) => item.body.presentation === 'automation-report')
  assert.equal(reports().length, 1)
  assert.equal(reports()[0].body.automationReport.runId, claim.runId)
  assert.equal(
    await production.appendStructuredAutomationReport({
      deps: reportDeps,
      runtimeId: target.runtimeId,
      target,
      run: restarted.store.listAutomationRuns(definition.id)[0],
      openJournal: async () => reopened
    }),
    'delivered'
  )
  assert.equal(
    await production.appendStructuredAutomationReport({
      deps: reportDeps,
      runtimeId: target.runtimeId,
      target: { ...target, registrationGeneration: 2 },
      run: restarted.store.listAutomationRuns(definition.id)[0],
      openJournal: async () => reopened
    }),
    'undelivered'
  )
  assert.equal(reports().length, 1)
  await reopened.close()
  reopenedDatabase.close()
  console.log(
    JSON.stringify({
      oracle: 'automation-physical-agent-and-durable-report',
      dummyAgentStarts: 1,
      agentBindings,
      reportRowsAfterRestart: 1,
      reportDeliveries,
      finalStatus: outcome.run.status,
      scopesReleased: true
    })
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
