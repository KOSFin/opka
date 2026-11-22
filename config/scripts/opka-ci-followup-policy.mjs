const SHA = /^[a-f0-9]{40}$/
const FIXTURE = 'config/scripts/mobile-web-app-project-work-fixtures.mjs'
const ALLOWED_PATHS = new Set([
  FIXTURE,
  'config/scripts/opka-ci-followup-proof.mjs',
  'config/scripts/opka-ci-followup-proof.test.mjs',
  'config/scripts/opka-ci-component-scope.mjs',
  'config/scripts/opka-ci-component-scope.test.mjs',
  'config/scripts/fork-ci-contract.test.mjs'
])
const LANES = ['desktop', 'electron', 'installers', 'android']
const REQUIRED_JOBS = [
  'Types and changed-code quality',
  ...[1, 2, 3, 4].map((index) => `Fork regression tests (${index}/4)`),
  'Desktop assets (macos-15)',
  'Desktop assets (ubuntu-24.04)',
  'Desktop assets (windows-2022)',
  'Hidden Electron journeys and Swift',
  'Beta installer qualification / Installer qualification passed',
  'Android component acceptance / Opka Android installer confirmation and retained state'
]
const ALLOWED_FAILURES = new Set([
  'Fork regression tests (mobile and integration)',
  'PR checks passed'
])
const MOBILE_FOLLOWUP = {
  kind: 'test-only-followup',
  fixtures: [FIXTURE],
  lanes: LANES,
  allowedPaths: ALLOWED_PATHS,
  requiredJobs: REQUIRED_JOBS,
  allowedFailures: ALLOWED_FAILURES
}
const READINESS_FIXTURE =
  'src/renderer/src/components/settings/AccountPoolSection.consistency.test.tsx'
const READINESS_FOLLOWUP = {
  kind: 'account-pool-readiness-followup',
  fixtures: [READINESS_FIXTURE],
  lanes: LANES,
  allowedPaths: new Set(
    [...ALLOWED_PATHS].filter((path) => path !== FIXTURE).concat(READINESS_FIXTURE)
  ),
  requiredJobs: REQUIRED_JOBS.map((name) =>
    name === 'Fork regression tests (4/4)' ? 'Fork regression tests (mobile and integration)' : name
  ),
  allowedFailures: new Set(['Fork regression tests (4/4)', 'PR checks passed'])
}
const ANDROID_VIEWPORT_FIXTURE = 'config/scripts/opka_android_target_viewport.py'
const READINESS_ANDROID_FOLLOWUP = {
  kind: 'account-pool-readiness-android-followup',
  fixtures: [READINESS_FIXTURE, ANDROID_VIEWPORT_FIXTURE],
  lanes: ['desktop', 'electron', 'installers'],
  allowedPaths: new Set([
    ...READINESS_FOLLOWUP.allowedPaths,
    ANDROID_VIEWPORT_FIXTURE,
    'config/scripts/opka_android_task_fields_test.py',
    'config/scripts/fixtures/android-webview-accessibility/accounts-offscreen.xml'
  ]),
  requiredJobs: READINESS_FOLLOWUP.requiredJobs.filter(
    (name) =>
      name !==
      'Android component acceptance / Opka Android installer confirmation and retained state'
  ),
  allowedFailures: new Set([
    'Fork regression tests (4/4)',
    'Android component acceptance / Opka Android installer confirmation and retained state',
    'PR checks passed'
  ])
}
const ACCOUNTS_SECTION_LIFETIME_FIXTURE =
  'src/renderer/src/components/settings/AccountsPane.section-lifetime.test.tsx'
const ACCOUNTS_SECTION_LIFETIME_FOLLOWUP = {
  kind: 'accounts-section-lifetime-followup',
  fixtures: [ACCOUNTS_SECTION_LIFETIME_FIXTURE],
  lanes: LANES,
  allowedPaths: new Set([
    ACCOUNTS_SECTION_LIFETIME_FIXTURE,
    'config/scripts/opka-ci-followup-proof.mjs',
    'config/scripts/opka-ci-followup-proof.test.mjs',
    'config/scripts/opka-ci-followup-proof-test-fixture.mjs',
    'config/scripts/opka-ci-accounts-lifetime-followup.test.mjs'
  ]),
  requiredJobs: [
    ...REQUIRED_JOBS.filter((name) => name !== 'Fork regression tests (1/4)'),
    'Fork regression tests (mobile and integration)'
  ],
  allowedFailures: new Set(['Fork regression tests (1/4)', 'PR checks passed'])
}
const profileForKind = (kind) =>
  kind === MOBILE_FOLLOWUP.kind
    ? MOBILE_FOLLOWUP
    : kind === READINESS_FOLLOWUP.kind
      ? READINESS_FOLLOWUP
      : kind === READINESS_ANDROID_FOLLOWUP.kind
        ? READINESS_ANDROID_FOLLOWUP
        : kind === ACCOUNTS_SECTION_LIFETIME_FOLLOWUP.kind
          ? ACCOUNTS_SECTION_LIFETIME_FOLLOWUP
          : null
const positive = (value) => Number.isSafeInteger(value) && value > 0
const repositoryName = (value) => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value)
const validPaths = (paths, profile) =>
  Array.isArray(paths) &&
  paths.length > 0 &&
  paths.length <= profile.allowedPaths.size &&
  new Set(paths).size === paths.length &&
  profile.fixtures.every((fixture) => paths.includes(fixture)) &&
  paths.every((path) => profile.allowedPaths.has(path))

export function isFollowupProof(proof) {
  const profile = profileForKind(proof?.kind)
  return Boolean(
    profile &&
    proof &&
    proof.schemaVersion === 1 &&
    proof.kind === profile.kind &&
    repositoryName(proof.repository) &&
    positive(proof.prNumber) &&
    [proof.head, proof.sourceHead, proof.base, proof.sourceTree].every(
      (sha) => typeof sha === 'string' && SHA.test(sha)
    ) &&
    proof.base !== proof.sourceHead &&
    positive(proof.runId) &&
    positive(proof.attempt) &&
    validPaths(proof.paths, profile) &&
    Array.isArray(proof.reusedLanes) &&
    proof.reusedLanes.length === profile.lanes.length &&
    profile.lanes.every((lane, index) => proof.reusedLanes[index] === lane) &&
    Array.isArray(proof.jobs) &&
    proof.jobs.length === profile.requiredJobs.length &&
    new Set(proof.jobs.map((job) => job?.id)).size === profile.requiredJobs.length &&
    profile.requiredJobs.every(
      (name) => proof.jobs.filter((job) => job?.name === name).length === 1
    ) &&
    proof.jobs.every(
      (job) =>
        positive(job?.id) &&
        job.runId === proof.runId &&
        job.head === proof.base &&
        job.status === 'completed' &&
        job.conclusion === 'success'
    )
  )
}

export { SHA, MOBILE_FOLLOWUP, READINESS_FOLLOWUP, READINESS_ANDROID_FOLLOWUP, ACCOUNTS_SECTION_LIFETIME_FOLLOWUP, positive, repositoryName, validPaths }
