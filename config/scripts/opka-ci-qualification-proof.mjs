import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'

export function qualificationMatches({ proof, run, jobs, repository, tree, sourceTree }) {
  return (
    run.path === '.github/workflows/pr.yml' &&
    run.repository?.full_name === repository &&
    run.event === 'pull_request' &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    sourceTree === tree &&
    proof.schemaVersion === 1 &&
    proof.tree === tree &&
    proof.runId === run.id &&
    proof.attempt === run.run_attempt &&
    proof.event === 'pull_request' &&
    /^[a-f0-9]{40}$/.test(proof.head) &&
    jobs.filter((job) => job.name === 'PR checks passed').length === 1 &&
    jobs.some(
      (job) =>
        job.name === 'PR checks passed' &&
        job.status === 'completed' &&
        job.conclusion === 'success' &&
        job.run_id === run.id &&
        job.head_sha === run.head_sha
    )
  )
}

export async function findReusableQualification({ repository, token, tree, fetchApi = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !token) {
    return null
  }
  const request = async (path) => {
    const response = await fetchApi(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) {
      throw new Error('CI proof metadata unavailable')
    }
    return response.json()
  }
  const runs = await request(
    'actions/workflows/pr.yml/runs?event=pull_request&status=success&per_page=10'
  )
  for (const run of runs.workflow_runs.slice(0, 10)) {
    if (run.path !== '.github/workflows/pr.yml' || run.conclusion !== 'success') {
      continue
    }
    const source = await request(`git/commits/${run.head_sha}`)
    if (source.tree?.sha !== tree) {
      continue
    }
    const artifacts = await request(`actions/runs/${run.id}/artifacts?per_page=100`)
    const name = `opka-ci-proof-${run.id}-${run.run_attempt}`
    const matches = artifacts.artifacts.filter(
      (artifact) => artifact.name === name && !artifact.expired
    )
    if (matches.length !== 1) {
      continue
    }
    const directory = mkdtempSync(join(tmpdir(), 'opka-ci-proof-'))
    try {
      const result = runProcessSync({
        program: 'gh',
        args: [
          'run',
          'download',
          String(run.id),
          '--repo',
          repository,
          '--name',
          name,
          '--dir',
          directory
        ],
        timeoutMs: 20_000
      })
      if (result.code !== 0) {
        continue
      }
      const proof = JSON.parse(readFileSync(join(directory, 'qualification.json'), 'utf8'))
      if (proof.tree !== tree) {
        continue
      }
      const jobs = await request(
        `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`
      )
      if (jobs.total_count > 100) {
        continue
      }
      if (
        qualificationMatches({
          proof,
          run,
          jobs: jobs.jobs,
          repository,
          tree,
          sourceTree: source.tree.sha
        })
      ) {
        return proof
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  return null
}
