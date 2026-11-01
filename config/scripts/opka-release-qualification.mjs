import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const REVIEWED_RELEASE_PATHS = new Set([
  '.github/workflows/opka-android-update-acceptance.yml',
  '.github/workflows/opka-release.yml',
  'config/scripts/opka-android-native-fixture.py',
  'config/scripts/opka-android-ui-journey.py',
  'config/scripts/opka_android_fixture_proxy_test.py',
  'config/scripts/opka_android_ui_journey_test.py',
  'config/scripts/opka-release-qualification.mjs',
  'config/scripts/opka-release-qualification.test.mjs',
  'config/scripts/run-fork-tests.mjs',
  'config/scripts/fork-ci-contract.test.mjs'
])

export function validateQualificationSource(qualifiedCommit, releaseCommit, changedPaths) {
  if (![qualifiedCommit, releaseCommit].every((value) => /^[a-f0-9]{40}$/.test(value ?? ''))) {
    throw new Error('Qualification requires explicit full commit hashes.')
  }
  if (changedPaths.some((path) => !REVIEWED_RELEASE_PATHS.has(path))) {
    throw new Error('Application source changed after qualification; full PR checks are required.')
  }
}

export function verifyQualificationRun(run, jobs, qualifiedCommit) {
  if (
    !Number.isSafeInteger(run?.id) ||
    run.path !== '.github/workflows/pr.yml' ||
    run.head_sha !== qualifiedCommit ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  ) {
    throw new Error('A successful full PR workflow for the exact qualified commit is required.')
  }
  const gates = jobs.filter((job) => job.name === 'PR checks passed')
  if (
    gates.length !== 1 ||
    gates[0].head_sha !== qualifiedCommit ||
    gates[0].run_id !== run.id ||
    gates[0].status !== 'completed' ||
    gates[0].conclusion !== 'success'
  ) {
    throw new Error('The exact qualified workflow must have a successful PR aggregate gate.')
  }
  return { qualifiedCommit, runId: run.id, gate: 'PR checks passed' }
}

export function qualifyRelease(environment = process.env, execute = execFileSync) {
  const qualifiedCommit = environment.OPKA_QUALIFIED_COMMIT
  const releaseCommit = environment.GITHUB_SHA
  validateQualificationSource(qualifiedCommit, releaseCommit, [])
  const repository = environment.GITHUB_REPOSITORY
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Repository is required.')
  const diff = execute(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', qualifiedCommit, releaseCommit, '--'],
    {
      encoding: 'utf8'
    }
  )
  validateQualificationSource(qualifiedCommit, releaseCommit, diff.split('\0').filter(Boolean))
  const api = (endpoint) =>
    JSON.parse(execute('gh', ['api', '--paginate', '--slurp', endpoint], { encoding: 'utf8' }))
  const runs = api(
    `repos/${repository}/actions/workflows/pr.yml/runs?head_sha=${qualifiedCommit}&status=completed&per_page=100`
  ).flatMap((page) => page.workflow_runs)
  const successful = runs.filter(
    (run) =>
      run.head_sha === qualifiedCommit &&
      run.path === '.github/workflows/pr.yml' &&
      run.status === 'completed' &&
      run.conclusion === 'success'
  )
  if (!successful.length)
    throw new Error('No successful full PR workflow for the qualified commit.')
  for (const run of successful) {
    const jobs = api(
      `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`
    ).flatMap((page) => page.jobs)
    try {
      return verifyQualificationRun(run, jobs, qualifiedCommit)
    } catch {
      // A rerun can supersede an earlier gate; inspect only successful exact-head runs.
    }
  }
  throw new Error('No successful exact-head PR aggregate gate was found.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(qualifyRelease()))
}
