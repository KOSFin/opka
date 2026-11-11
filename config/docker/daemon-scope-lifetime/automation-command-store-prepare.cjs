const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { installAutomationFixtureEnvironment } = require('./automation-command-state.cjs')

const production = require(process.argv[2])
const root = process.argv[3]
assert.ok(root.startsWith('/tmp/orca-automation-case-'))
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
installAutomationFixtureEnvironment(production, root)
const source = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))
const database = path.join(root, 'profile-state.db')
const dataFile = path.join(root, 'orca-data.json')
const authority = new production.ProfileStateSqliteAuthority(
  database,
  'automation-disposable-fixture'
)
authority.scheduleBackup = () => {}
authority.writeSerializedState(Buffer.from(JSON.stringify(source)))
const store = new production.Store({ dataFile, profileStateAuthority: authority })

async function main() {
  const claim = store.listCommandAutomationClaims()[0]
  assert.equal(claim.runId, 'run-fixture')
  assert.equal(claim.phase, 'command')
  assert.equal(claim.processIntent.exitProof.exitCode, 0)
  assert.equal(store.listAutomationRuns(claim.automationId)[0].id, claim.runId)
  await store.flushPendingOrThrowAsync()
  store.freezeWrites()
  authority.close()
  console.log(
    JSON.stringify({
      oracle: 'automation-sqlite-store-prepared',
      runId: claim.runId,
      processId: process.pid
    })
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
