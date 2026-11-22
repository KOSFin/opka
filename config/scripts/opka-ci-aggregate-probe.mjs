import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateCiResults, CI_LANES, writeQualification } from './opka-ci-aggregate.mjs'
import { context, head, tree } from './opka-ci-followup-proof-test-fixture.mjs'

const baselineDirectory = process.argv[2]
const historicalFile = process.argv[3]
if (!baselineDirectory) {
  assert.equal(existsSync('node_modules'), false, 'Cold probe requires no node_modules')
}
const cases = []
const all = Object.fromEntries(CI_LANES.map((lane) => [lane, true]))
const needsFor = (scope) => ({
  scope: { result: 'success' },
  ...Object.fromEntries(
    CI_LANES.map((lane) => [lane, { result: !scope.reused && scope[lane] ? 'success' : 'skipped' }])
  )
})
for (let mask = 0; mask < 64; mask++) {
  const scope = Object.fromEntries(CI_LANES.map((lane, i) => [lane, Boolean(mask & (1 << i))]))
  const needs = needsFor(scope)
  cases.push({ name: `lane-mask-${mask}`, scope, needs, accepted: true })
  for (const lane of ['scope', ...CI_LANES]) {
    const { [lane]: omitted, ...missing } = needs
    assert.ok(omitted)
    cases.push({ name: `missing-${mask}-${lane}`, scope, needs: missing, accepted: false })
    for (const result of ['success', 'failure', 'cancelled', 'skipped', 'timed_out']) {
      cases.push({
        name: `result-${mask}-${lane}-${result}`,
        scope,
        needs: { ...needs, [lane]: { result } },
        accepted: result === needs[lane].result
      })
    }
  }
}
const fixture = context()
const proof = {
  schemaVersion: 1,
  kind: 'test-only-followup',
  repository: 'example/project',
  prNumber: 16,
  head,
  sourceHead: fixture.event.pull_request.head.sha,
  sourceTree: tree,
  base: fixture.run.head_sha,
  runId: fixture.run.id,
  attempt: fixture.run.run_attempt,
  reusedLanes: ['desktop', 'electron', 'installers', 'android'],
  paths: fixture.paths,
  jobs: fixture.jobs.filter((job) => job.conclusion === 'success').map((job) => ({
    id: job.id, name: job.name, runId: job.run_id, head: job.head_sha,
    status: job.status, conclusion: job.conclusion
  }))
}
const followup = {
  ...all, desktop: false, electron: false, installers: false, android: false,
  head, tree, base: proof.base, reused: false, followupProof: proof
}
cases.push({ name: 'followup', scope: followup, needs: needsFor(followup), accepted: true })
for (const patch of [{ head: tree }, { attempt: 0 }, { jobs: [] }, { repository: '' }]) {
  cases.push({ name: 'invalid-followup', scope: { ...followup, followupProof: { ...proof, ...patch } }, needs: needsFor(followup), accepted: false })
}
const reused = { ...all, reused: true }
cases.push({ name: 'exact-tree-reuse', scope: reused, needs: needsFor(reused), accepted: true })
if (historicalFile) {
  for (const row of JSON.parse(readFileSync(historicalFile, 'utf8'))) {
    cases.push({ ...row, name: `historical-${row.runId}` })
  }
}
const verdict = (evaluate, row) => {
  try { evaluate(row.scope, row.needs); return true } catch { return false }
}
const start = performance.now()
for (const row of cases) {
  assert.equal(verdict(evaluateCiResults, row), row.accepted, row.name)
}
const candidateMs = performance.now() - start
const receipt = {
  candidate: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
  os: process.platform,
  cache: baselineDirectory ? 'after-dependency-install' : 'no-node-modules',
  noNodeModules: !existsSync('node_modules'),
  cases: cases.length,
  candidateMs
}
if (baselineDirectory) {
  const baseline = await import(pathToFileURL(resolve(baselineDirectory, 'config/scripts/opka-ci-component-scope.mjs')).href)
  const before = performance.now()
  for (const row of cases) {
    assert.equal(verdict(baseline.evaluateCiResults, row), row.accepted, row.name)
  }
  receipt.baselineMs = performance.now() - before
}
const scope = { ...all, head, tree }
Object.assign(process.env, {
  OPKA_CI_SCOPE: JSON.stringify(scope), OPKA_CI_RESULTS: JSON.stringify(needsFor(scope))
})
writeQualification()
const qualification = JSON.parse(readFileSync('out/opka-ci/qualification.json', 'utf8'))
assert.equal(qualification.head, head)
assert.equal(qualification.tree, tree)
assert.equal(qualification.schemaVersion, 1)
assert.equal(qualification.runId, Number(process.env.GITHUB_RUN_ID))
assert.equal(qualification.attempt, Number(process.env.GITHUB_RUN_ATTEMPT))
assert.equal(qualification.event, process.env.GITHUB_EVENT_NAME)
assert.deepEqual(qualification.scope, scope)
mkdirSync('out/aggregate-probe', { recursive: true })
writeFileSync(`out/aggregate-probe/${receipt.cache}.json`, `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify(receipt))
