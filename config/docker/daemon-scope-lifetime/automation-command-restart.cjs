const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { openAutomationState } = require('./automation-command-state.cjs')

const production = require(process.argv[2])
const root = process.argv[3]
assert.ok(root.startsWith('/tmp/orca-automation-case-'))
const authority = openAutomationState(production, root)
const before = production.readAutomationCommandsV1Domain(authority.state.automationCommandsV1)
const original = before.activeClaims[0]
assert.ok(original)
assert.equal(original.phase, 'command')
assert.equal(original.processIntent.exitProof.exitCode, 0)
assert.equal(authority.state.automationRuns[0].id, original.runId)
assert.equal(authority.state.automationRuns[0].status, 'dispatching')

// The production loader repairs a retained row before the service resumes its claim.
authority.state.automationRuns = production.recoverActiveAutomationCommandRuns(
  authority.state,
  authority.state.automationRuns,
  () => {}
)
authority.persist()
const runs = production.createAutomationRunWriter(authority.store, null)
const adapter = production.createLinuxCommandAutomationAdapter({
  hostGeneration: 1,
  isCurrentOwner: () => true,
  store: authority.store,
  runs,
  resolveExistingWorkspaceCwd: async () => root
})
let providerAcquisitions = 0
let chatDeliveries = 0
const service = new production.AutomationCommandService({
  store: authority.store,
  runs,
  adapter: {
    ...adapter,
    runOneShotAgent: async () => {
      providerAcquisitions += 1
      throw new Error('unexpected provider acquisition')
    },
    deliverReport: async () => {
      chatDeliveries += 1
      throw new Error('unexpected chat delivery')
    }
  },
  hostGeneration: original.hostGeneration,
  isActive: () => true,
  runInLane: async (_id, operation) => operation()
})

async function main() {
  assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
  assert.equal(adapter.isHostReady(), true)
  await service.reconcileRetainedCommands()
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const final = authority.state.automationRuns.find((run) => run.id === original.runId)
    if (
      final?.status === 'completed' &&
      authority.store.listCommandAutomationClaims().length === 0
    ) {
      assert.equal(final.commandExecution.phase, 'settled')
      assert.equal(final.commandExecution.deliveryStatus, 'history_only')
      assert.match(final.outputSnapshot.content, /root-done/)
      assert.equal(fs.readFileSync(path.join(root, 'command-starts'), 'utf8'), 'x')
      assert.equal(providerAcquisitions, 0)
      assert.equal(chatDeliveries, 0)
      const reloaded = JSON.parse(fs.readFileSync(authority.file, 'utf8'))
      assert.equal(
        reloaded.automationRuns.find((run) => run.id === original.runId).status,
        'completed'
      )
      assert.equal(
        production.readAutomationCommandsV1Domain(reloaded.automationCommandsV1).activeClaims
          .length,
        0
      )
      console.log(
        JSON.stringify({
          oracle: 'automation-fresh-process-service-recovery',
          runId: original.runId,
          acquisitionId: original.acquisitionId,
          processId: process.pid,
          commandStarts: 1,
          providerAcquisitions,
          chatDeliveries,
          finalStatus: final.status
        })
      )
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Production service did not settle the retained command claim')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
