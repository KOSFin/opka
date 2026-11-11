const fs = require('node:fs')
const path = require('node:path')

function installAutomationFixtureEnvironment(production, directory) {
  production.setAppEnvironment({
    getPath: () => directory,
    getAppPath: () => directory,
    getVersion: () => '0.0.0-automation-fixture',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
}

function openAutomationState(production, directory, initialState) {
  const file = path.join(directory, 'state.json')
  const state = initialState ?? JSON.parse(fs.readFileSync(file, 'utf8'))
  production.readAutomationCommandsV1Domain(state.automationCommandsV1)
  const persist = () => {
    const temporary = `${file}.tmp`
    const fd = fs.openSync(temporary, 'w', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify(state))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temporary, file)
    const parent = fs.openSync(directory, 'r')
    try {
      fs.fsyncSync(parent)
    } finally {
      fs.closeSync(parent)
    }
  }
  const operations = { state, markDomainsDirty: () => {}, flush: () => {} }
  const claims = () => production.readAutomationCommandsV1Domain(state.automationCommandsV1)
  const store = {
    listCommandAutomations: () => claims().definitions,
    listCommandAutomationClaims: () => claims().activeClaims,
    getCommandAutomationClaim: (automationId, runId) =>
      claims().activeClaims.find(
        (claim) => claim.automationId === automationId && claim.runId === runId
      ) ?? null,
    listAutomationRuns: (automationId) =>
      state.automationRuns.filter((run) => !automationId || run.automationId === automationId),
    automationChangeSelector: () => null,
    advanceCommandAutomationRun: (fence, update) =>
      production.advanceAutomationCommandRun(operations, fence, update),
    bindCommandAutomationProcessIntent: (fence, receipt) =>
      production.bindAutomationCommandProcessIntent(operations, fence, receipt),
    recordCommandAutomationExitProof: (fence, observation, verifiedAt) =>
      production.recordAutomationCommandExitProof(operations, fence, observation, verifiedAt),
    bindAutomationAgentProcessIntent: (fence, receipt) =>
      production.bindAutomationAgentProcessIntent(operations, fence, receipt),
    recordAutomationAgentExitProof: (fence, observation, verifiedAt) =>
      production.recordAutomationAgentExitProof(operations, fence, observation, verifiedAt),
    settleCommandAutomationRun: (fence, result) =>
      production.settleAutomationCommandRun(operations, fence, result),
    releaseCommandAutomationClaim: (fence) =>
      production.releaseAutomationCommandClaim(operations, fence),
    flushPendingOrThrowAsync: async () => persist()
  }
  return { file, state, store, persist }
}

module.exports = { installAutomationFixtureEnvironment, openAutomationState }
