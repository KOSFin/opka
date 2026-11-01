import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const REVIEWED_RELEASE_PATHS = new Set([
  'fork-docs/testing/ci-component-routing.md',
  '.github/workflows/opka-android-update-acceptance.yml',
  '.github/workflows/opka-release.yml',
  'config/scripts/opka_android_ci_acceptance_test.py',
  'config/scripts/opka-android-ci-acceptance.py',
  'config/scripts/opka_android_built_run.py',
  'config/scripts/opka_android_built_run_test.py',
  'config/scripts/opka_android_candidate_artifact.py',
  'config/scripts/opka_android_candidate_artifact_test.py',
  'config/scripts/opka-release-qualification.mjs',
  'config/scripts/opka-release-qualification.test.mjs',
  'config/scripts/opka-release-assets.test.mjs',
  'config/scripts/opka-verify-tested-android.mjs',
  'config/scripts/opka-verify-tested-android.test.mjs',
  'config/scripts/fork-ci-contract.test.mjs',
  'config/scripts/run-fork-tests.mjs'
])

export function validateQualificationSource(qualifiedCommit, releaseCommit, changedPaths) {
  if (![qualifiedCommit, releaseCommit].every((value) => /^[a-f0-9]{40}$/.test(value ?? ''))) {
    throw new Error('Qualification requires explicit full commit hashes.')
  }
  if (changedPaths.some((path) => !REVIEWED_RELEASE_PATHS.has(path))) {
    throw new Error(
      'Application source changed after qualification; fresh installers are required.'
    )
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

export function verifyBuiltReleaseArtifacts(build, jobs, artifacts, expected) {
  if (
    build?.id !== expected.runId ||
    build.path !== '.github/workflows/opka-release.yml' ||
    build.repository?.full_name !== expected.repository ||
    build.event !== 'workflow_dispatch' ||
    build.head_branch !== 'main' ||
    build.head_sha !== expected.source ||
    build.status !== 'completed'
  ) {
    throw new Error(
      'Built artifacts must belong to the requested main-only release run and source.'
    )
  }
  for (const label of ['Complete beta asset set', 'Opka Android installer']) {
    const producers = jobs.filter((job) => job.name === label || job.name.endsWith(` / ${label}`))
    if (
      producers.length !== 1 ||
      producers[0].run_id !== expected.runId ||
      producers[0].head_sha !== expected.source ||
      producers[0].status !== 'completed' ||
      producers[0].conclusion !== 'success'
    ) {
      throw new Error('Original installer and complete asset producers must have succeeded.')
    }
  }
  const found = {}
  for (const kind of ['beta-release', 'android']) {
    const name = `opka-${kind}-${expected.source}`
    const matches = artifacts.filter((artifact) => artifact.name === name)
    if (
      matches.length !== 1 ||
      !Number.isSafeInteger(matches[0].id) ||
      matches[0].id <= 0 ||
      matches[0].expired !== false ||
      matches[0].workflow_run?.id !== expected.runId ||
      matches[0].workflow_run?.head_sha !== expected.source
    ) {
      throw new Error('Original immutable release artifacts are missing, expired or unrelated.')
    }
    found[kind] = matches[0].id
  }
  return found
}

function successfulSourceQualification(api, repository, source) {
  const runs = api(
    `repos/${repository}/actions/workflows/pr.yml/runs?head_sha=${source}&status=completed&per_page=100`
  ).flatMap((page) => page.workflow_runs)
  for (const run of runs) {
    if (
      run.head_sha !== source ||
      run.path !== '.github/workflows/pr.yml' ||
      run.status !== 'completed' ||
      run.conclusion !== 'success'
    ) {
      continue
    }
    const jobs = api(
      `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`
    ).flatMap((page) => page.jobs)
    try {
      return verifyQualificationRun(run, jobs, source)
    } catch {
      // A failed or superseded gate cannot qualify this source.
    }
  }
  throw new Error('No successful exact-head PR aggregate gate was found.')
}

export function qualifyRelease(environment = process.env, execute = execFileSync) {
  const current = environment.GITHUB_SHA
  const qualified = environment.OPKA_QUALIFIED_COMMIT ?? current
  validateQualificationSource(qualified, current, [])
  if (qualified !== current) {
    throw new Error('Current QA source must be qualified exactly; use explicit built-run recovery.')
  }
  const repository = environment.GITHUB_REPOSITORY
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
    throw new Error('Repository is required.')
  }
  const api = (endpoint) =>
    JSON.parse(
      execute('gh', ['api', '--paginate', '--slurp', endpoint], {
        encoding: 'utf8',
        timeout: 30_000
      })
    )
  const qualification = successfulSourceQualification(api, repository, current)
  const source = environment.OPKA_BUILT_SOURCE || ''
  const builtRun = environment.OPKA_BUILT_RUN || ''
  if (!source && !builtRun) {
    return {
      ...qualification,
      release_source: current,
      artifact_run: environment.GITHUB_RUN_ID,
      reuse_built: false
    }
  }
  validateQualificationSource(source, current, [])
  if (!/^[1-9][0-9]*$/.test(builtRun) || !Number.isSafeInteger(Number(builtRun))) {
    throw new Error('Built run and source must be an explicit valid pair.')
  }
  const diff = execute(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', source, current, '--'],
    {
      encoding: 'utf8',
      timeout: 30_000
    }
  )
  validateQualificationSource(source, current, diff.split('\0').filter(Boolean))
  successfulSourceQualification(api, repository, source)
  const runId = Number(builtRun)
  const build = api(`repos/${repository}/actions/runs/${runId}`)[0]
  const jobs = api(
    `repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`
  ).flatMap((page) => page.jobs)
  const artifacts = api(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`).flatMap(
    (page) => page.artifacts
  )
  const identities = verifyBuiltReleaseArtifacts(build, jobs, artifacts, {
    source,
    runId,
    repository
  })
  return {
    ...qualification,
    release_source: source,
    artifact_run: builtRun,
    reuse_built: true,
    completeArtifactId: identities['beta-release'],
    androidArtifactId: identities.android
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = qualifyRelease()
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      ['release_source', 'artifact_run', 'reuse_built']
        .map((key) => `${key}=${result[key]}\n`)
        .join('')
    )
  }
  console.log(JSON.stringify(result))
}
