import { mkdirSync, writeFileSync } from 'node:fs'
import { isFollowupProof } from './opka-ci-followup-policy.mjs'
import { isDirectInvocation } from './script-entry-detection.mjs'

export const CI_LANES = ['static', 'regression', 'desktop', 'electron', 'installers', 'android']

export function evaluateCiResults(scope, needs) {
  if (!scope || needs.scope?.result !== 'success') {
    throw new Error('CI scope did not succeed')
  }
  if (Object.keys(needs).length !== CI_LANES.length + 1) {
    throw new Error('Unexpected CI dependency set')
  }
  if (scope.followupProof) {
    const proof = scope.followupProof
    if (
      !isFollowupProof(proof) ||
      proof.head !== scope.head ||
      proof.sourceTree !== scope.tree ||
      proof.base !== scope.base ||
      scope.reused !== false ||
      scope.static !== true ||
      scope.regression !== true ||
      CI_LANES.some((lane) => scope[lane] !== !proof.reusedLanes.includes(lane))
    ) {
      throw new Error('Invalid test-only follow-up qualification')
    }
  }
  for (const lane of CI_LANES) {
    const expected = scope.reused ? 'skipped' : scope[lane] ? 'success' : 'skipped'
    if (needs[lane]?.result !== expected) {
      throw new Error(`Unexpected ${lane} result; required ${expected}`)
    }
  }
}

export function writeQualification() {
  mkdirSync('out/opka-ci', { recursive: true })
  const scope = JSON.parse(process.env.OPKA_CI_SCOPE)
  evaluateCiResults(scope, JSON.parse(process.env.OPKA_CI_RESULTS))
  writeFileSync(
    'out/opka-ci/qualification.json',
    `${JSON.stringify({
      schemaVersion: 1,
      tree: scope.tree,
      head: scope.head,
      runId: Number(process.env.GITHUB_RUN_ID),
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      event: process.env.GITHUB_EVENT_NAME,
      scope
    })}\n`
  )
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  writeQualification()
}
