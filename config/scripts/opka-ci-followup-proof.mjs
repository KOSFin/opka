import { runProcessSync } from '@orca/process-host'

const SHA = /^[a-f0-9]{40}$/
const WORKFLOW = '.github/workflows/pr.yml'
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
  fixture: FIXTURE,
  allowedPaths: ALLOWED_PATHS,
  requiredJobs: REQUIRED_JOBS,
  allowedFailures: ALLOWED_FAILURES
}
const READINESS_FIXTURE =
  'src/renderer/src/components/settings/AccountPoolSection.consistency.test.tsx'
const READINESS_FOLLOWUP = {
  kind: 'account-pool-readiness-followup',
  fixture: READINESS_FIXTURE,
  allowedPaths: new Set(
    [...ALLOWED_PATHS].filter((path) => path !== FIXTURE).concat(READINESS_FIXTURE)
  ),
  requiredJobs: REQUIRED_JOBS.map((name) =>
    name === 'Fork regression tests (4/4)' ? 'Fork regression tests (mobile and integration)' : name
  ),
  allowedFailures: new Set(['Fork regression tests (4/4)', 'PR checks passed'])
}
const profileForKind = (kind) =>
  kind === MOBILE_FOLLOWUP.kind
    ? MOBILE_FOLLOWUP
    : kind === READINESS_FOLLOWUP.kind
      ? READINESS_FOLLOWUP
      : null
const positive = (value) => Number.isSafeInteger(value) && value > 0
const repositoryName = (value) => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value)
const validPaths = (paths, profile) =>
  Array.isArray(paths) &&
  paths.length > 0 &&
  paths.length <= profile.allowedPaths.size &&
  new Set(paths).size === paths.length &&
  paths.includes(profile.fixture) &&
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
    proof.reusedLanes.length === LANES.length &&
    LANES.every((lane, index) => proof.reusedLanes[index] === lane) &&
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

function runGit(args) {
  return runProcessSync({ program: 'git', args, timeoutMs: 10_000, maxOutputBytes: 128 * 1024 })
}

function checkedGit(execute, args) {
  const result = execute(args)
  if (
    result?.code !== 0 ||
    result.timedOut ||
    result.outputTruncated ||
    typeof result.stdout !== 'string' ||
    Buffer.byteLength(result.stdout) > 128 * 1024
  ) {
    throw new Error('Follow-up source evidence unavailable')
  }
  return result.stdout
}

async function boundedJson(response) {
  if (!response.ok || !response.body) {
    throw new Error('Follow-up metadata unavailable')
  }
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      length += value.byteLength
      if (length > 1024 * 1024) {
        throw new Error('Follow-up metadata exceeds bound')
      }
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'))
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

function completeRun(run, repository, sourceHead, prNumber, branch) {
  return (
    run?.path === WORKFLOW &&
    run.repository?.full_name === repository &&
    positive(run.repository.id) &&
    run.event === 'pull_request' &&
    run.head_sha === sourceHead &&
    run.head_branch === branch &&
    run.head_repository?.full_name === repository &&
    run.status === 'completed' &&
    ['success', 'failure', 'cancelled', 'timed_out'].includes(run.conclusion) &&
    positive(run.id) &&
    positive(run.run_attempt) &&
    Array.isArray(run.pull_requests) &&
    run.pull_requests.length === 1 &&
    run.pull_requests[0].number === prNumber &&
    run.pull_requests[0].base?.repo?.name === repository.split('/')[1] &&
    run.pull_requests[0].base?.repo?.id === run.repository.id
  )
}

function positiveJobs(jobs, run, profile) {
  if (
    !jobs ||
    !Number.isSafeInteger(jobs.total_count) ||
    jobs.total_count < profile.requiredJobs.length ||
    jobs.total_count > 100 ||
    !Array.isArray(jobs.jobs) ||
    jobs.jobs.length !== jobs.total_count
  ) {
    return null
  }
  const rows = jobs.jobs
  if (
    new Set(rows.map((job) => job.name)).size !== rows.length ||
    new Set(rows.map((job) => job.id)).size !== rows.length ||
    rows.some(
      (job) =>
        !positive(job.id) ||
        job.run_id !== run.id ||
        job.head_sha !== run.head_sha ||
        job.status !== 'completed' ||
        !['success', 'skipped', 'failure', 'cancelled', 'timed_out'].includes(job.conclusion) ||
        (!['success', 'skipped'].includes(job.conclusion) && !profile.allowedFailures.has(job.name))
    )
  ) {
    return null
  }
  const required = profile.requiredJobs.map((name) => rows.find((job) => job.name === name))
  return required.every((job) => job?.conclusion === 'success') ? required : null
}

/** Reuses platform work only when the preceding same-PR source differs solely in these test inputs. */
export async function findReusableFollowupProof({
  repository,
  token,
  event,
  head,
  fetchApi = fetch,
  runGit: execute = runGit
}) {
  try {
    const pr = event?.pull_request
    const before = event?.before
    const sourceHead = pr?.head?.sha
    if (
      !repositoryName(repository) ||
      typeof token !== 'string' ||
      !token ||
      event?.action !== 'synchronize' ||
      !SHA.test(before ?? '') ||
      !SHA.test(sourceHead ?? '') ||
      !SHA.test(head ?? '') ||
      before === sourceHead ||
      event.repository?.full_name !== repository ||
      pr?.base?.repo?.full_name !== repository ||
      pr?.head?.repo?.full_name !== repository ||
      !positive(pr?.number) ||
      typeof pr.head.ref !== 'string' ||
      !pr.head.ref
    ) {
      return null
    }
    checkedGit(execute, ['fetch', '--no-tags', '--depth=2', 'origin', sourceHead])
    checkedGit(execute, ['fetch', '--no-tags', '--depth=1', 'origin', before])
    if (checkedGit(execute, ['rev-parse', 'HEAD']).trim() !== head) {
      return null
    }
    const sourceTree = checkedGit(execute, ['rev-parse', `${sourceHead}^{tree}`]).trim()
    if (
      !SHA.test(sourceTree) ||
      sourceTree !== checkedGit(execute, ['rev-parse', `${head}^{tree}`]).trim()
    ) {
      return null
    }
    checkedGit(execute, ['merge-base', '--is-ancestor', before, sourceHead])
    const diff = checkedGit(execute, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      before,
      head,
      '--'
    ])
    if (!diff.endsWith('\0')) {
      return null
    }
    const paths = diff.slice(0, -1).split('\0')
    const profile = [MOBILE_FOLLOWUP, READINESS_FOLLOWUP].find((entry) => validPaths(paths, entry))
    if (!profile) {
      return null
    }
    const deadline = Date.now() + 30_000
    const request = async (path) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error('Follow-up metadata deadline exceeded')
      }
      return boundedJson(
        await fetchApi(`https://api.github.com/repos/${repository}/${path}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          },
          signal: AbortSignal.timeout(Math.min(10_000, remaining))
        })
      )
    }
    const list = await request(
      `actions/workflows/pr.yml/runs?event=pull_request&head_sha=${before}&per_page=100`
    )
    if (
      !list ||
      !Number.isSafeInteger(list.total_count) ||
      list.total_count > 100 ||
      !Array.isArray(list.workflow_runs) ||
      list.workflow_runs.length !== list.total_count
    ) {
      return null
    }
    const candidates = list.workflow_runs.filter(
      (run) =>
        run.head_sha === before &&
        Array.isArray(run.pull_requests) &&
        run.pull_requests.some((row) => row.number === pr.number)
    )
    if (!candidates.length || candidates.some((run) => !positive(run.id))) {
      return null
    }
    const latest = candidates.toSorted((a, b) => b.id - a.id)[0]
    const run = await request(`actions/runs/${latest.id}`)
    if (run.id !== latest.id || !completeRun(run, repository, before, pr.number, pr.head.ref)) {
      return null
    }
    const jobs = positiveJobs(
      await request(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`),
      run,
      profile
    )
    if (!jobs) {
      return null
    }
    const current = await request(`actions/runs/${run.id}`)
    if (
      !completeRun(current, repository, before, pr.number, pr.head.ref) ||
      current.id !== run.id ||
      current.run_attempt !== run.run_attempt
    ) {
      return null
    }
    const proof = {
      schemaVersion: 1,
      kind: profile.kind,
      repository,
      prNumber: pr.number,
      head,
      sourceHead,
      sourceTree,
      base: before,
      runId: run.id,
      attempt: run.run_attempt,
      reusedLanes: [...LANES],
      paths,
      jobs: jobs.map((job) => ({
        id: job.id,
        name: job.name,
        runId: job.run_id,
        head: job.head_sha,
        status: job.status,
        conclusion: job.conclusion
      }))
    }
    if (!isFollowupProof(proof)) {
      return null
    }
    proof.jobs.forEach(Object.freeze)
    for (const value of [proof.jobs, proof.paths, proof.reusedLanes]) {
      Object.freeze(value)
    }
    return Object.freeze(proof)
  } catch {
    return null
  }
}
