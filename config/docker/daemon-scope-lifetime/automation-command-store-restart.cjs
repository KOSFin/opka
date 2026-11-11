const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { installAutomationFixtureEnvironment } = require('./automation-command-state.cjs')

const production = require(process.argv[2])
const root = process.argv[3]
assert.ok(root.startsWith('/tmp/orca-automation-case-'))
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
installAutomationFixtureEnvironment(production, root)
const database = path.join(root, 'profile-state.db')
const dataFile = path.join(root, 'orca-data.json')
const authority = new production.ProfileStateSqliteAuthority(
  database,
  'automation-disposable-fixture'
)
authority.scheduleBackup = () => {}
const store = new production.Store({ dataFile, profileStateAuthority: authority })
const original = store.listCommandAutomationClaims()[0]
assert.ok(original)
assert.equal(original.runId, 'run-fixture')
assert.equal(original.phase, 'command')
assert.equal(original.processIntent.exitProof.exitCode, 0)
const runs = production.createAutomationRunWriter(store, null)
const adapter = production.createLinuxCommandAutomationAdapter({
  hostGeneration: 1,
  isCurrentOwner: () => true,
  store,
  runs,
  resolveExistingWorkspaceCwd: async () => root
})
let providerAcquisitions = 0
let chatDeliveries = 0
const service = new production.AutomationCommandService({
  store,
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
  assert.equal(adapter.isHostReady(), true)
  await service.reconcileRetainedCommands()
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const final = store
      .listAutomationRuns(original.automationId)
      .find((run) => run.id === original.runId)
    if (final?.status === 'completed' && store.listCommandAutomationClaims().length === 0) {
      assert.equal(final.commandExecution.phase, 'settled')
      assert.equal(final.commandExecution.deliveryStatus, 'history_only')
      assert.match(final.outputSnapshot.content, /root-done/)
      assert.equal(fs.readFileSync(path.join(root, 'command-starts'), 'utf8'), 'x')
      assert.equal(providerAcquisitions, 0)
      assert.equal(chatDeliveries, 0)
      await store.flushPendingOrThrowAsync()
      store.freezeWrites()
      authority.close()
      const reloadedAuthority = new production.ProfileStateSqliteAuthority(
        database,
        'automation-disposable-fixture'
      )
      const snapshot = JSON.parse(reloadedAuthority.readSerializedState())
      reloadedAuthority.close()
      assert.equal(
        snapshot.automationRuns.find((run) => run.id === original.runId).status,
        'completed'
      )
      assert.equal(
        production.readAutomationCommandsV1Domain(snapshot.automationCommandsV1).activeClaims
          .length,
        0
      )
      console.log(
        JSON.stringify({
          oracle: 'automation-fresh-process-sqlite-store-recovery',
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
  throw new Error('SQLite Store did not settle the retained command claim')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
