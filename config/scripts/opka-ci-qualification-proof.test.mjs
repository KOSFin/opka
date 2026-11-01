import { describe, expect, it } from 'vitest'
import { qualificationMatches } from './opka-ci-qualification-proof.mjs'

const tree = 'a'.repeat(40)
function fixture() {
  return {
    repository: 'KOSFin/opka',
    tree,
    sourceTree: tree,
    run: {
      id: 14,
      run_attempt: 2,
      head_sha: 'b'.repeat(40),
      repository: { full_name: 'KOSFin/opka' },
      path: '.github/workflows/pr.yml',
      event: 'pull_request',
      status: 'completed',
      conclusion: 'success'
    },
    proof: {
      schemaVersion: 1,
      tree,
      head: 'c'.repeat(40),
      runId: 14,
      attempt: 2,
      event: 'pull_request'
    },
    jobs: [
      {
        name: 'PR checks passed',
        run_id: 14,
        head_sha: 'b'.repeat(40),
        status: 'completed',
        conclusion: 'success'
      }
    ]
  }
}
describe('main push qualification reuse', () => {
  it('requires exact full source tree and a unique successful same-run aggregate', () => {
    expect(qualificationMatches(fixture())).toBe(true)
    for (const patch of [
      { sourceTree: 'd'.repeat(40) },
      { tree: 'd'.repeat(40) },
      { repository: 'other/repo' }
    ]) {
      expect(qualificationMatches({ ...fixture(), ...patch })).toBe(false)
    }
  })
  it('rejects a receipt from another attempt, workflow, event or run', () => {
    for (const patch of [
      { attempt: 1 },
      { runId: 15 },
      { event: 'push' },
      { tree: 'd'.repeat(40) }
    ]) {
      const value = fixture()
      value.proof = { ...value.proof, ...patch }
      expect(qualificationMatches(value)).toBe(false)
    }
    const value = fixture()
    value.run.path = '.github/workflows/mobile.yml'
    expect(qualificationMatches(value)).toBe(false)
  })
  it('rejects missing, duplicated, failed, cancelled and foreign-head aggregate jobs', () => {
    const value = fixture()
    expect(qualificationMatches({ ...value, jobs: [] })).toBe(false)
    expect(qualificationMatches({ ...value, jobs: [...value.jobs, ...value.jobs] })).toBe(false)
    for (const patch of [
      { conclusion: 'failure' },
      { status: 'in_progress' },
      { conclusion: 'cancelled' },
      { run_id: 15 },
      { head_sha: 'e'.repeat(40) }
    ]) {
      expect(qualificationMatches({ ...value, jobs: [{ ...value.jobs[0], ...patch }] })).toBe(false)
    }
  })
})
