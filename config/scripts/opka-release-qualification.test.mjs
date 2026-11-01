import { describe, expect, it } from 'vitest'
import {
  qualifyRelease,
  validateQualificationSource,
  verifyQualificationRun
} from './opka-release-qualification.mjs'

const qualified = 'a'.repeat(40)
const release = 'b'.repeat(40)
const run = {
  id: 42,
  path: '.github/workflows/pr.yml',
  head_sha: qualified,
  status: 'completed',
  conclusion: 'success'
}
const gate = {
  name: 'PR checks passed',
  head_sha: qualified,
  run_id: 42,
  status: 'completed',
  conclusion: 'success'
}

describe('release qualification reuse', () => {
  it('requires explicit full hashes and rejects changed application source', () => {
    for (const invalid of ['', 'main', 'a'.repeat(39), undefined]) {
      expect(() => validateQualificationSource(invalid, release, [])).toThrow()
    }
    for (const path of [
      'mobile/app.config.js',
      'src/main/index.ts',
      'pnpm-lock.yaml',
      '.github/workflows/pr.yml'
    ]) {
      expect(() => validateQualificationSource(qualified, release, [path])).toThrow()
    }
  })
  it('permits only reviewed environment and release guard paths', () => {
    expect(() =>
      validateQualificationSource(qualified, release, [
        '.github/workflows/opka-release.yml',
        '.github/workflows/opka-android-update-acceptance.yml',
        'config/scripts/opka-android-native-fixture.py',
        'config/scripts/opka-android-ui-journey.py',
        'config/scripts/opka_android_fixture_proxy_test.py',
        'config/scripts/opka_android_ui_journey_test.py',
        'config/scripts/opka-release-qualification.mjs',
        'config/scripts/opka-release-qualification.test.mjs',
        'config/scripts/run-fork-tests.mjs',
        'config/scripts/fork-ci-contract.test.mjs'
      ])
    ).not.toThrow()
  })
  it('requires the exact full workflow and completed successful aggregate', () => {
    expect(verifyQualificationRun(run, [gate], qualified)).toEqual({
      qualifiedCommit: qualified,
      runId: 42,
      gate: 'PR checks passed'
    })
    for (const patch of [
      { path: '.github/workflows/mobile.yml' },
      { head_sha: release },
      { status: 'in_progress' },
      { conclusion: 'failure' }
    ]) {
      expect(() => verifyQualificationRun({ ...run, ...patch }, [gate], qualified)).toThrow()
    }
    for (const jobs of [
      [],
      [gate, gate],
      [{ ...gate, head_sha: release }],
      [{ ...gate, run_id: 99 }],
      [{ ...gate, conclusion: 'skipped' }],
      [{ ...gate, status: 'in_progress' }]
    ]) {
      expect(() => verifyQualificationRun(run, jobs, qualified)).toThrow()
    }
  })
  it('uses read-only exact-head API and git diff before accepting a receipt', () => {
    const calls = []
    const execute = (command, args) => {
      calls.push([command, args])
      if (command === 'git') return 'config/scripts/opka-android-native-fixture.py\0'
      return JSON.stringify(
        args.at(-1).includes('/jobs?') ? [{ jobs: [gate] }] : [{ workflow_runs: [run] }]
      )
    }
    expect(
      qualifyRelease(
        { OPKA_QUALIFIED_COMMIT: qualified, GITHUB_SHA: release, GITHUB_REPOSITORY: 'KOSFin/opka' },
        execute
      ).runId
    ).toBe(42)
    expect(calls[0][1]).toEqual([
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      qualified,
      release,
      '--'
    ])
    expect(calls[1][1].at(-1)).toContain(`head_sha=${qualified}`)
    expect(
      calls
        .slice(1)
        .every(
          ([command, args]) =>
            command === 'gh' && args.slice(0, 3).join(' ') === 'api --paginate --slurp'
        )
    ).toBe(true)
    expect(() =>
      qualifyRelease(
        { OPKA_QUALIFIED_COMMIT: qualified, GITHUB_SHA: release, GITHUB_REPOSITORY: 'KOSFin/opka' },
        () => 'mobile/app.config.js\0'
      )
    ).toThrow('Application source')
  })
})
