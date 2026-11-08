import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcessSync } from '@orca/process-host'
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

function chainedContext(intermediate = 'e'.repeat(40)) {
  const { options, state } = accountsSectionLifetimeContext()
  state.event.before = intermediate
  const skippedRun = {
    ...state.run,
    id: 46,
    run_attempt: 1,
    head_sha: intermediate
  }
  const skippedJobs = state.jobs.map((job) => ({
    ...job,
    id: job.id + 1000,
    run_id: 46,
    head_sha: intermediate,
    conclusion: ['Desktop assets', 'Hidden Electron', 'Beta installer', 'Android component'].some(
      (name) => job.name.startsWith(name)
    )
      ? 'skipped'
      : job.conclusion
  }))
  const originalFetch = options.fetchApi
  options.fetchApi = async (url, requestOptions) => {
    const path = new URL(url).pathname
    if (path.endsWith('/actions/workflows/pr.yml/runs')) {
      return new Response(
        JSON.stringify({ total_count: 2, workflow_runs: [skippedRun, state.run] })
      )
    }
    if (path.endsWith('/actions/runs/46')) {
      return new Response(JSON.stringify(skippedRun))
    }
    if (path.endsWith('/attempts/1/jobs')) {
      return new Response(JSON.stringify({ total_count: skippedJobs.length, jobs: skippedJobs }))
    }
    return originalFetch(url, requestOptions)
  }
  return { options, state, skippedRun, intermediate }
}

it('reuses the older successful platform run across a second test-only commit', async () => {
  const { options, intermediate } = chainedContext()
  const git = options.runGit
  const calls = []
  options.runGit = (args) => {
    calls.push(args)
    return git(args)
  }
  const proof = await findReusableFollowupProof(options)
  expect(proof).toMatchObject({
    kind: 'accounts-section-lifetime-followup',
    base,
    runId: 45,
    attempt: 2,
    sourceHead
  })
  expect(proof.paths).toContain(accountsSectionLifetimeFixture)
  expect(calls).toContainEqual(['merge-base', '--is-ancestor', intermediate, sourceHead])
  expect(calls).toContainEqual(['merge-base', '--is-ancestor', base, sourceHead])
  expect(calls).toContainEqual([
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    base,
    options.head,
    '--'
  ])
})

it.each(['src/renderer/src/components/settings/AccountsPane.tsx', '.github/workflows/pr.yml'])(
  'rejects a cumulative production or workflow difference: %s',
  async (path) => {
    const { options } = chainedContext()
    const git = options.runGit
    options.runGit = (args) => {
      if (args[0] === 'diff' && args[4] === base) {
        return { code: 0, stdout: `${accountsSectionLifetimeFixture}\0${path}\0` }
      }
      return git(args)
    }
    expect(await findReusableFollowupProof(options)).toBeNull()
  }
)

it.each(['failed', 'pending', 'missing'])('rejects %s original platform evidence', async (kind) => {
  const { options, state } = chainedContext()
  const android = state.jobs.find((job) => job.name === androidAcceptance)
  if (kind === 'missing') {
    state.jobs.splice(state.jobs.indexOf(android), 1)
  }
  if (kind === 'failed') {
    android.conclusion = 'failure'
  }
  if (kind === 'pending') {
    android.status = 'in_progress'
  }
  expect(await findReusableFollowupProof(options)).toBeNull()
})

it.each(['repo', 'pr', 'branch', 'ancestor', 'attempt', 'api'])(
  'rejects %s evidence for an older source run',
  async (kind) => {
    const { options, state } = chainedContext()
    if (kind === 'repo') {
      state.run.repository.full_name = 'other/project'
    }
    if (kind === 'pr') {
      state.run.pull_requests[0].number = 17
    }
    if (kind === 'branch') {
      state.run.head_branch = 'other-branch'
    }
    if (kind === 'attempt') {
      state.finalRun = { ...state.run, run_attempt: 3 }
    }
    if (kind === 'ancestor') {
      const git = options.runGit
      options.runGit = (args) =>
        args[0] === 'merge-base' && args[2] === base ? { code: 1, stdout: '' } : git(args)
    }
    if (kind === 'api') {
      options.fetchApi = async (url) =>
        new URL(url).pathname.endsWith('/actions/workflows/pr.yml/runs')
          ? new Response(JSON.stringify({ total_count: 21, workflow_runs: [] }))
          : new Response('{}')
    }
    expect(await findReusableFollowupProof(options)).toBeNull()
  }
)

it.each(['failed', 'pending'])(
  'rejects an older successful run for the same SHA after a newer %s platform run',
  async (kind) => {
    const { options, state } = chainedContext()
    const newer = { ...state.run, id: 47, run_attempt: 1 }
    const newerJobs = state.jobs.map((job) => ({
      ...job,
      id: job.id + 2000,
      run_id: 47,
      status: kind === 'pending' && job.name === androidAcceptance ? 'in_progress' : job.status,
      conclusion: job.name === androidAcceptance ? 'failure' : job.conclusion
    }))
    const originalFetch = options.fetchApi
    options.fetchApi = async (url, requestOptions) => {
      const path = new URL(url).pathname
      if (path.endsWith('/actions/workflows/pr.yml/runs')) {
        return new Response(JSON.stringify({ total_count: 2, workflow_runs: [newer, state.run] }))
      }
      if (path.endsWith('/actions/runs/47')) {
        return new Response(JSON.stringify(newer))
      }
      if (path.endsWith('/attempts/1/jobs')) {
        return new Response(JSON.stringify({ total_count: newerJobs.length, jobs: newerJobs }))
      }
      return originalFetch(url, requestOptions)
    }
    expect(await findReusableFollowupProof(options)).toBeNull()
  }
)

it('recovers the older qualified ancestor from a cold shallow PR merge checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opka-followup-chain-'))
  const origin = join(root, 'origin')
  const checkout = join(root, 'checkout')
  const hooks = join(root, 'no-hooks')
  mkdirSync(origin)
  mkdirSync(hooks)
  const git = (cwd, args) =>
    runProcessSync({
      program: 'git',
      cwd,
      args: ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', ...args],
      timeoutMs: 10_000,
      maxOutputBytes: 128 * 1024
    })
  const success = (cwd, args) => {
    const result = git(cwd, args)
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error(`Synthetic Git fixture failed at ${args[0]}`)
    }
    return result.stdout.trim()
  }
  try {
    success(origin, ['init'])
    success(origin, ['symbolic-ref', 'HEAD', 'refs/heads/release-fix'])
    success(origin, ['config', 'user.name', 'Fixture'])
    success(origin, ['config', 'user.email', 'fixture@example.invalid'])
    const testPath = join(origin, accountsSectionLifetimeFixture)
    mkdirSync(join(testPath, '..'), { recursive: true })
    writeFileSync(testPath, 'initial\n')
    success(origin, ['add', '.'])
    success(origin, ['commit', '-m', 'Synthetic PR base'])
    const prBase = success(origin, ['rev-parse', 'HEAD'])
    writeFileSync(testPath, 'first test-only repair\n')
    success(origin, ['add', '.'])
    success(origin, ['commit', '-m', 'Qualified platform source'])
    const qualified = success(origin, ['rev-parse', 'HEAD'])
    writeFileSync(testPath, 'second test-only repair\n')
    success(origin, ['add', '.'])
    success(origin, ['commit', '-m', 'First follow-up'])
    const intermediate = success(origin, ['rev-parse', 'HEAD'])
    writeFileSync(testPath, 'third test-only repair\n')
    success(origin, ['add', '.'])
    success(origin, ['commit', '-m', 'Second follow-up'])
    const source = success(origin, ['rev-parse', 'HEAD'])
    success(origin, ['checkout', '-b', 'synthetic-merge', prBase])
    success(origin, ['merge', '--no-ff', 'release-fix', '-m', 'Synthetic PR merge'])
    const merge = success(origin, ['rev-parse', 'HEAD'])
    success(root, [
      'clone',
      '--depth=2',
      '--branch',
      'synthetic-merge',
      pathToFileURL(origin).href,
      checkout
    ])
    expect(success(checkout, ['rev-parse', '--is-shallow-repository'])).toBe('true')
    const { options, state } = chainedContext(intermediate)
    state.event.pull_request.head.sha = source
    state.run.head_sha = qualified
    state.jobs.forEach((job) => {
      job.head_sha = qualified
    })
    options.head = merge
    const calls = []
    options.runGit = (args) => {
      calls.push(args)
      return git(checkout, args)
    }
    const proof = await findReusableFollowupProof(options)
    expect(proof).toMatchObject({ base: qualified, sourceHead: source, head: merge, runId: 45 })
    expect(calls).toContainEqual(['merge-base', '--is-ancestor', qualified, source])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.each([true, false])(
  'requires the original Cursor fixture in the cumulative diff after a CI-only follow-up (%s)',
  async (fixturePresent) => {
    const { options, state } = chainedContext()
    state.paths = [
      'config/scripts/opka-ci-followup-proof.mjs',
      'config/scripts/opka-ci-accounts-lifetime-followup.test.mjs'
    ]
    const git = options.runGit
    options.runGit = (args) => {
      if (args[0] === 'diff' && args[4] === base) {
        const cumulative = fixturePresent
          ? [accountsSectionLifetimeFixture, ...state.paths]
          : state.paths
        return { code: 0, stdout: `${cumulative.join('\0')}\0` }
      }
      return git(args)
    }
    const proof = await findReusableFollowupProof(options)
    if (fixturePresent) {
      expect(proof).toMatchObject({ base, runId: 45 })
      expect(proof.paths).toContain(accountsSectionLifetimeFixture)
    } else {
      expect(proof).toBeNull()
    }
  }
)
