export const base = 'a'.repeat(40)
export const sourceHead = 'b'.repeat(40)
export const head = 'c'.repeat(40)
export const tree = 'd'.repeat(40)
export const repository = 'example/project'
export const fixturePath = 'config/scripts/mobile-web-app-project-work-fixtures.mjs'
export const names = [
  'Types and changed-code quality',
  ...[1, 2, 3, 4].map((i) => `Fork regression tests (${i}/4)`),
  'Desktop assets (macos-15)',
  'Desktop assets (ubuntu-24.04)',
  'Desktop assets (windows-2022)',
  'Hidden Electron journeys and Swift',
  'Beta installer qualification / Installer qualification passed',
  'Android component acceptance / Opka Android installer confirmation and retained state'
]
export function context() {
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
