import { expect, it } from 'vitest'
import { findReusableFollowupProof, isFollowupProof } from './opka-ci-followup-proof.mjs'

const base = 'a'.repeat(40)
const sourceHead = 'b'.repeat(40)
const head = 'c'.repeat(40)
const tree = 'd'.repeat(40)
const repository = 'example/project'
const fixturePath = 'config/scripts/mobile-web-app-project-work-fixtures.mjs'
const names = [
  'Types and changed-code quality',
  ...[1, 2, 3, 4].map((i) => `Fork regression tests (${i}/4)`),
  'Desktop assets (macos-15)',
  'Desktop assets (ubuntu-24.04)',
  'Desktop assets (windows-2022)',
  'Hidden Electron journeys and Swift',
  'Beta installer qualification / Installer qualification passed',
  'Android component acceptance / Opka Android installer confirmation and retained state'
]
function context() {
  const event = {
    action: 'synchronize',
    before: base,
    repository: { full_name: repository },
    pull_request: {
      number: 16,
      base: { repo: { full_name: repository } },
      head: { sha: sourceHead, ref: 'release-fix', repo: { full_name: repository } }
    }
  }
  const run = {
    id: 45,
    run_attempt: 2,
    repository: { id: 9, full_name: repository },
    head_repository: { full_name: repository },
    path: '.github/workflows/pr.yml',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    head_sha: base,
    head_branch: 'release-fix',
    pull_requests: [{ number: 16, base: { repo: { id: 9, name: 'project' } } }]
  }
  const jobs = names.map((name, i) => ({
    id: 100 + i,
    name,
    run_id: 45,
    head_sha: base,
    status: 'completed',
    conclusion: 'success'
  }))
  jobs.push({
    id: 500,
    name: 'Fork regression tests (mobile and integration)',
    run_id: 45,
    head_sha: base,
    status: 'completed',
    conclusion: 'cancelled'
  })
  jobs.push({
    id: 501,
    name: 'PR checks passed',
    run_id: 45,
    head_sha: base,
    status: 'completed',
    conclusion: 'failure'
  })
  const paths = [
    fixturePath,
    'config/scripts/opka-ci-followup-proof.mjs',
    'config/scripts/opka-ci-followup-proof.test.mjs',
    'config/scripts/opka-ci-component-scope.mjs',
    'config/scripts/opka-ci-component-scope.test.mjs',
    'config/scripts/fork-ci-contract.test.mjs'
  ]
  const calls = []
  const gitCalls = []
  const state = {
    event,
    run,
    jobs,
    paths,
    calls,
    gitCalls,
    finalRun: null,
    totalRuns: 1,
    totalJobs: null
  }
  const runGit = (args) => {
    gitCalls.push(args)
    let stdout = ''
    if (args[0] === 'rev-parse') {
      stdout = args[1] === 'HEAD' ? head : tree
    }
    if (args[0] === 'diff') {
      stdout = `${state.paths.join('\0')}\0`
    }
    return { code: 0, stdout }
  }
  const fetchApi = async (url, options) => {
    calls.push({ url, options })
    const path = new URL(url).pathname
    let data
    if (path.endsWith('/actions/workflows/pr.yml/runs')) {
      data = { total_count: state.totalRuns, workflow_runs: [state.run] }
    } else if (path.endsWith('/attempts/2/jobs')) {
      data = { total_count: state.totalJobs ?? state.jobs.length, jobs: state.jobs }
    } else if (path.endsWith('/actions/runs/45')) {
      data =
        state.calls.filter((call) => new URL(call.url).pathname.endsWith('/actions/runs/45'))
          .length > 1
          ? (state.finalRun ?? state.run)
          : state.run
    } else {
      throw new Error('Unexpected API request')
    }
    return new Response(JSON.stringify(data))
  }
  return {
    state,
    options: { repository, token: 'synthetic-read-only', event, head, runGit, fetchApi }
  }
}

it('proves a synthetic merge tree equals the source tree and reuses only four platform lanes', async () => {
  const { options, state } = context()
  const proof = await findReusableFollowupProof(options)
  expect(proof).toMatchObject({
    schemaVersion: 1,
    kind: 'test-only-followup',
    repository,
    prNumber: 16,
    base,
    head,
    sourceHead,
    sourceTree: tree,
    runId: 45,
    attempt: 2,
    reusedLanes: ['desktop', 'electron', 'installers', 'android']
  })
  expect(isFollowupProof(proof)).toBe(true)
  expect(proof.jobs.map((job) => job.name)).toEqual(names)
  expect(Object.isFrozen(proof)).toBe(true)
  expect(Object.isFrozen(proof.jobs[0])).toBe(true)
  expect(Object.isFrozen(proof.paths)).toBe(true)
  expect(state.gitCalls).toContainEqual(['merge-base', '--is-ancestor', base, sourceHead])
  expect(state.gitCalls).toContainEqual([
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    base,
    head,
    '--'
  ])
  expect(state.calls).toHaveLength(4)
  expect(state.calls.every(({ options }) => options.signal instanceof AbortSignal)).toBe(true)
})

it.each(names)('rejects a failed previously required job: %s', async (name) => {
  const { options, state } = context()
  state.jobs.find((job) => job.name === name).conclusion = 'failure'
  expect(await findReusableFollowupProof(options)).toBeNull()
})

it.each([
  'src/main/runtime/app.ts',
  'mobile/src/app.ts',
  '.github/workflows/pr.yml',
  '.github/actions/install-node-dependencies/action.yml',
  'pnpm-lock.yaml',
  'package.json',
  'config/scripts/unknown.mjs',
  '../outside',
  `${fixturePath}/child`
])('rejects shipping or unknown change %s', async (path) => {
  const { options, state } = context()
  state.paths.push(path)
  expect(await findReusableFollowupProof(options)).toBeNull()
  expect(state.calls).toEqual([])
})

it('requires the actual renderer fixture change rather than a helper-only follow-up', async () => {
  const { options, state } = context()
  state.paths = ['config/scripts/opka-ci-followup-proof.mjs']
  expect(await findReusableFollowupProof(options)).toBeNull()
})

it.each(['workflow', 'repository', 'head', 'event', 'pr', 'branch', 'baseRepo', 'pending'])(
  'rejects foreign run metadata: %s',
  async (kind) => {
    const { options, state } = context()
    if (kind === 'workflow') {
      state.run.path = '.github/workflows/mobile.yml'
    }
    if (kind === 'repository') {
      state.run.repository.full_name = 'foreign/project'
    }
    if (kind === 'head') {
      state.run.head_sha = 'e'.repeat(40)
    }
    if (kind === 'event') {
      state.run.event = 'push'
    }
    if (kind === 'pr') {
      state.run.pull_requests[0].number = 17
    }
    if (kind === 'branch') {
      state.run.head_branch = 'different-branch'
    }
    if (kind === 'baseRepo') {
      state.run.pull_requests[0].base.repo.id = 10
    }
    if (kind === 'pending') {
      state.run.status = 'in_progress'
    }
    expect(await findReusableFollowupProof(options)).toBeNull()
  }
)

it.each(['sourceRepo', 'baseRepo', 'event', 'before'])(
  'rejects invalid current event evidence: %s',
  async (kind) => {
    const { options, state } = context()
    if (kind === 'sourceRepo') {
      state.event.pull_request.head.repo.full_name = 'foreign/project'
    }
    if (kind === 'baseRepo') {
      state.event.pull_request.base.repo.full_name = 'foreign/project'
    }
    if (kind === 'event') {
      state.event.action = 'opened'
    }
    if (kind === 'before') {
      state.event.before = 'HEAD~1'
    }
    expect(await findReusableFollowupProof(options)).toBeNull()
    expect(state.gitCalls).toEqual([])
  }
)

it.each(['missing', 'duplicate', 'run', 'head', 'unknownFailure', 'unfinished', 'pages'])(
  'rejects incomplete job evidence: %s',
  async (kind) => {
    const { options, state } = context()
    if (kind === 'missing') {
      state.jobs.shift()
    }
    if (kind === 'duplicate') {
      state.jobs.push({ ...state.jobs[0], id: 999 })
    }
    if (kind === 'run') {
      state.jobs[0].run_id = 46
    }
    if (kind === 'head') {
      state.jobs[0].head_sha = sourceHead
    }
    if (kind === 'unknownFailure') {
      state.jobs.push({ ...state.jobs[0], id: 999, name: 'Unknown check', conclusion: 'failure' })
    }
    if (kind === 'unfinished') {
      state.jobs[0].status = 'in_progress'
    }
    if (kind === 'pages') {
      state.totalJobs = 101
    }
    expect(await findReusableFollowupProof(options)).toBeNull()
  }
)

it.each(['tree', 'ancestor', 'checkout', 'fetch', 'truncated'])(
  'rejects unverifiable real Git evidence: %s',
  async (kind) => {
    const { options } = context()
    const original = options.runGit
    options.runGit = (args) => {
      if (kind === 'tree' && args[1] === `${head}^{tree}`) {
        return { code: 0, stdout: 'e'.repeat(40) }
      }
      if (kind === 'ancestor' && args[0] === 'merge-base') {
        return { code: 1, stdout: '' }
      }
      if (kind === 'checkout' && args[1] === 'HEAD') {
        return { code: 0, stdout: sourceHead }
      }
      if (kind === 'fetch' && args[0] === 'fetch') {
        return { code: 1, stdout: '' }
      }
      if (kind === 'truncated') {
        return { code: 0, stdout: '', outputTruncated: true }
      }
      return original(args)
    }
    expect(await findReusableFollowupProof(options)).toBeNull()
  }
)

it('rejects a new latest attempt starting while the proof is being read', async () => {
  const { options, state } = context()
  state.finalRun = { ...state.run, run_attempt: 3, status: 'in_progress' }
  expect(await findReusableFollowupProof(options)).toBeNull()
})

it.each(['runs', 'network', 'body'])(
  'bounds unavailable or oversized API evidence: %s',
  async (kind) => {
    const { options, state } = context()
    if (kind === 'runs') {
      state.totalRuns = 101
    }
    if (kind === 'network') {
      options.fetchApi = async () => {
        throw new Error('private metadata must not escape')
      }
    }
    if (kind === 'body') {
      options.fetchApi = async () => new Response('x'.repeat(1024 * 1024 + 1))
    }
    expect(await findReusableFollowupProof(options)).toBeNull()
  }
)

it('structurally rejects missing or expanded reuse privileges and incomplete positive jobs', async () => {
  const { options } = context()
  const proof = await findReusableFollowupProof(options)
  expect(isFollowupProof(null)).toBe(false)
  expect(isFollowupProof({ ...proof, reusedLanes: [...proof.reusedLanes, 'static'] })).toBe(false)
  expect(
    isFollowupProof({ ...proof, reusedLanes: ['regression', ...proof.reusedLanes.slice(1)] })
  ).toBe(false)
  expect(isFollowupProof({ ...proof, jobs: proof.jobs.slice(1) })).toBe(false)
  expect(isFollowupProof({ ...proof, paths: ['src/main/app.ts'] })).toBe(false)
  expect(isFollowupProof({ ...proof, sourceHead: 'HEAD' })).toBe(false)
})

it.each(['missingRepositoryId', 'unknownConclusion'])(
  'rejects incomplete canonical run identity: %s',
  async (kind) => {
    const { options, state } = context()
    if (kind === 'missingRepositoryId') {
      delete state.run.repository.id
      delete state.run.pull_requests[0].base.repo.id
    } else {
      state.run.conclusion = null
    }
    expect(await findReusableFollowupProof(options)).toBeNull()
  }
)

it('rejects an unknown shared-job outcome rather than treating any label as a known failure', async () => {
  const { options, state } = context()
  state.jobs.find(
    (job) => job.name === 'Fork regression tests (mobile and integration)'
  ).conclusion = null
  expect(await findReusableFollowupProof(options)).toBeNull()
})

it('cancels the bounded API stream when response bytes exceed its cap', async () => {
  const { options } = context()
  let cancelled = false
  options.fetchApi = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024 + 1))
        },
        cancel() {
          cancelled = true
        }
      })
    )
  expect(await findReusableFollowupProof(options)).toBeNull()
  expect(cancelled).toBe(true)
})
