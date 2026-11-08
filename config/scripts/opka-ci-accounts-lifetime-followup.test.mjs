import { expect, it } from 'vitest'
import { findReusableFollowupProof, isFollowupProof } from './opka-ci-followup-proof.mjs'
import { base, sourceHead, names, context } from './opka-ci-followup-proof-test-fixture.mjs'

const shared = 'Fork regression tests (mobile and integration)'
const androidAcceptance =
  'Android component acceptance / Opka Android installer confirmation and retained state'

const accountsSectionLifetimeFixture =
  'src/renderer/src/components/settings/AccountsPane.section-lifetime.test.tsx'
const rootOne = 'Fork regression tests (1/4)'
function accountsSectionLifetimeContext() {
  const value = context()
  value.state.paths = [
    accountsSectionLifetimeFixture,
    'config/scripts/opka-ci-followup-proof.mjs',
    'config/scripts/opka-ci-followup-proof.test.mjs',
    'config/scripts/opka-ci-followup-proof-test-fixture.mjs',
    'config/scripts/opka-ci-accounts-lifetime-followup.test.mjs'
  ]
  value.state.jobs.find((job) => job.name === rootOne).conclusion = 'failure'
  value.state.jobs.find((job) => job.name === shared).conclusion = 'success'
  return value
}

it('reuses only successful platform jobs after the exact AccountsPane lifetime fixture changes', async () => {
  const { options } = accountsSectionLifetimeContext()
  const proof = await findReusableFollowupProof(options)
  expect(proof).toMatchObject({
    kind: 'accounts-section-lifetime-followup',
    reusedLanes: ['desktop', 'electron', 'installers', 'android']
  })
  expect(isFollowupProof(proof)).toBe(true)
  expect(proof.jobs.map((job) => job.name)).toEqual([
    ...names.filter((name) => name !== rootOne),
    shared
  ])
  expect(proof.jobs.every((job) => job.conclusion === 'success')).toBe(true)
})

it.each([
  'src/renderer/src/components/settings/AccountsPane.tsx',
  'src/renderer/src/components/settings/AccountsPane.test.tsx',
  'mobile/src/accounts/MobileAccountsScreen.tsx',
  '.github/workflows/pr.yml'
])(
  'rejects production or unrelated fixture changes for AccountsPane follow-up: %s',
  async (path) => {
    const { options, state } = accountsSectionLifetimeContext()
    state.paths.push(path)
    expect(await findReusableFollowupProof(options)).toBeNull()
    expect(state.calls).toEqual([])
  }
)

it.each(['unrelatedFailure', 'pendingAndroid', 'failedDesktop', 'wrongPr', 'wrongHead'])(
  'rejects incomplete source-run evidence for AccountsPane follow-up: %s',
  async (kind) => {
    const { options, state } = accountsSectionLifetimeContext()
    if (kind === 'unrelatedFailure') {
      state.jobs.push({
        id: 999,
        name: 'Unrelated check',
        run_id: state.run.id,
        head_sha: base,
        status: 'completed',
        conclusion: 'failure'
      })
    } else if (kind === 'pendingAndroid') {
      state.jobs.find((job) => job.name === androidAcceptance).status = 'in_progress'
    } else if (kind === 'failedDesktop') {
      state.jobs.find((job) => job.name === 'Desktop assets (ubuntu-24.04)').conclusion = 'failure'
    } else if (kind === 'wrongPr') {
      state.run.pull_requests[0].number = 17
    } else {
      state.run.head_sha = sourceHead
    }
    expect(await findReusableFollowupProof(options)).toBeNull()
  }
)
