import { describe, expect, it } from 'vitest'
import {
  qualifyRelease,
  validateQualificationSource,
  verifyQualificationRun,
  verifyBuiltReleaseArtifacts
} from './opka-release-qualification.mjs'

const source = 'a'.repeat(40)
const qa = 'b'.repeat(40)
const repository = 'KOSFin/opka'
const run = {
  id: 42,
  path: '.github/workflows/pr.yml',
  head_sha: source,
  status: 'completed',
  conclusion: 'success'
}
const gate = {
  name: 'PR checks passed',
  head_sha: source,
  run_id: 42,
  status: 'completed',
  conclusion: 'success'
}
function builtFixture() {
  return {
    build: {
      id: 100,
      path: '.github/workflows/opka-release.yml',
      head_sha: source,
      head_branch: 'main',
      repository: { full_name: repository },
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'failure'
    },
    jobs: ['Complete beta asset set', 'Opka Android installer'].map((name) => ({
      name: `Build installers / ${name}`,
      run_id: 100,
      head_sha: source,
      status: 'completed',
      conclusion: 'success'
    })),
    artifacts: ['beta-release', 'android'].map((kind, index) => ({
      id: 200 + index,
      name: `opka-${kind}-${source}`,
      expired: false,
      workflow_run: { id: 100, head_sha: source }
    })),
    expected: { source, runId: 100, repository }
  }
}
function verifyFixture(fixture) {
  return verifyBuiltReleaseArtifacts(
    fixture.build,
    fixture.jobs,
    fixture.artifacts,
    fixture.expected
  )
}
function fakeExecute(
  paths = ['config/scripts/opka_android_ci_acceptance_test.py'],
  fixture = builtFixture()
) {
  return (command, args) => {
    if (command === 'git') {
      return paths.map((path) => `${path}\0`).join('')
    }
    const endpoint = args.at(-1)
    if (endpoint.includes('workflows/pr.yml/runs')) {
      const head = endpoint.includes(`head_sha=${source}`) ? source : qa
      return JSON.stringify([
        { workflow_runs: [{ ...run, id: head === source ? 42 : 43, head_sha: head }] }
      ])
    }
    if (endpoint.includes('/runs/42/jobs')) {
      return JSON.stringify([{ jobs: [gate] }])
    }
    if (endpoint.includes('/runs/43/jobs')) {
      return JSON.stringify([{ jobs: [{ ...gate, run_id: 43, head_sha: qa }] }])
    }
    if (endpoint.includes('/runs/100/jobs')) {
      return JSON.stringify([{ jobs: fixture.jobs }])
    }
    if (endpoint.includes('/runs/100/artifacts')) {
      return JSON.stringify([{ artifacts: fixture.artifacts }])
    }
    if (endpoint.endsWith('/runs/100')) {
      return JSON.stringify([fixture.build])
    }
    throw new Error('Unexpected API query')
  }
}
const env = {
  GITHUB_SHA: qa,
  OPKA_QUALIFIED_COMMIT: qa,
  GITHUB_REPOSITORY: repository,
  GITHUB_RUN_ID: '101'
}

describe('explicit release qualification and artifact recovery', () => {
  it('keeps fresh mode pinned to the current QA source and current build run', () => {
    expect(qualifyRelease(env, fakeExecute())).toMatchObject({
      qualifiedCommit: qa,
      release_source: qa,
      artifact_run: '101',
      reuse_built: false
    })
    expect(() => qualifyRelease({ ...env, OPKA_QUALIFIED_COMMIT: source }, fakeExecute())).toThrow(
      'exactly'
    )
  })
  it('requires explicit full hashes and rejects all application, lock and driver changes', () => {
    for (const invalid of ['', 'main', 'a'.repeat(39), undefined]) {
      expect(() => validateQualificationSource(invalid, qa, [])).toThrow()
    }
    for (const path of [
      'mobile/app.config.js',
      'src/main/index.ts',
      'pnpm-lock.yaml',
      'assets/icon.png',
      'fork-docs/releases/beta-notes.md',
      'config/scripts/opka-release-assets.mjs',
      '.github/workflows/pr.yml',
      'config/scripts/opka-android-native-fixture.py',
      'config/scripts/opka-release-assets.mjs',
      'config/scripts/opka-android-ui-journey.py',
      'config/scripts/opka_android_target_viewport_other.py',
      'config/scripts/fixtures/android-webview-accessibility/other.xml'
    ]) {
      expect(() => validateQualificationSource(source, qa, [path])).toThrow('Application source')
    }
  })
  it('permits only the exact CI admission, artifact consumer and test repair paths', () => {
    expect(() =>
      validateQualificationSource(source, qa, [
        'fork-docs/testing/ci-component-routing.md',
        'config/scripts/opka_android_target_viewport.py',
        'config/scripts/opka_android_task_fields_test.py',
        'config/scripts/fixtures/android-webview-accessibility/accounts-deep-offscreen.xml',
        'config/scripts/opka-ci-component-scope.mjs',
        'config/scripts/opka-ci-component-scope.test.mjs',
        '.github/workflows/opka-release.yml',
        '.github/workflows/opka-android-update-acceptance.yml',
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
        'config/scripts/fork-ci-contract.test.mjs'
      ])
    ).not.toThrow()
  })
  it('requires exact workflow and a unique completed same-run aggregate', () => {
    expect(verifyQualificationRun(run, [gate], source)).toMatchObject({ runId: 42 })
    for (const patch of [
      { path: '.github/workflows/mobile.yml' },
      { head_sha: qa },
      { status: 'in_progress' },
      { conclusion: 'failure' }
    ]) {
      expect(() => verifyQualificationRun({ ...run, ...patch }, [gate], source)).toThrow()
    }
    for (const jobs of [
      [],
      [gate, gate],
      [{ ...gate, head_sha: qa }],
      [{ ...gate, run_id: 99 }],
      [{ ...gate, conclusion: 'skipped' }]
    ]) {
      expect(() => verifyQualificationRun(run, jobs, source)).toThrow()
    }
  })
  it('can reuse completed good producers even when a later original acceptance failed', () => {
    expect(verifyFixture(builtFixture())).toEqual({ 'beta-release': 200, android: 201 })
    expect(
      qualifyRelease({ ...env, OPKA_BUILT_RUN: '100', OPKA_BUILT_SOURCE: source }, fakeExecute())
    ).toMatchObject({
      release_source: source,
      artifact_run: '100',
      reuse_built: true,
      completeArtifactId: 200,
      androidArtifactId: 201
    })
  })
  it('refuses wrong workflow, source, branch, repository, event or original run', () => {
    for (const patch of [
      { id: 99 },
      { path: '.github/workflows/pr.yml' },
      { head_sha: qa },
      { head_branch: 'other' },
      { repository: { full_name: 'other/repo' } },
      { event: 'pull_request' },
      { status: 'in_progress' }
    ]) {
      const fixture = builtFixture()
      fixture.build = { ...fixture.build, ...patch }
      expect(() => verifyFixture(fixture)).toThrow()
    }
  })
  it('refuses failed, skipped, missing or duplicate installer and complete-set producers', () => {
    for (const index of [0, 1]) {
      for (const patch of [
        { conclusion: 'failure' },
        { conclusion: 'skipped' },
        { run_id: 99 },
        { head_sha: qa }
      ]) {
        const fixture = builtFixture()
        fixture.jobs[index] = { ...fixture.jobs[index], ...patch }
        expect(() => verifyFixture(fixture)).toThrow()
      }
      const missing = builtFixture()
      missing.jobs.splice(index, 1)
      expect(() => verifyFixture(missing)).toThrow()
      const duplicate = builtFixture()
      duplicate.jobs.push(duplicate.jobs[index])
      expect(() => verifyFixture(duplicate)).toThrow()
    }
  })
  it('refuses expired, missing, duplicate or foreign artifact identities', () => {
    for (const index of [0, 1]) {
      for (const patch of [
        { expired: true },
        { id: -1 },
        { name: 'other-artifact' },
        { workflow_run: { id: 99, head_sha: source } },
        { workflow_run: { id: 100, head_sha: qa } }
      ]) {
        const fixture = builtFixture()
        fixture.artifacts[index] = { ...fixture.artifacts[index], ...patch }
        expect(() => verifyFixture(fixture)).toThrow()
      }
      const duplicate = builtFixture()
      duplicate.artifacts.push(duplicate.artifacts[index])
      expect(() => verifyFixture(duplicate)).toThrow()
    }
  })
  it('requires paired recovery inputs and checks the complete NUL diff before accepting artifacts', () => {
    for (const patch of [
      { OPKA_BUILT_RUN: '100' },
      { OPKA_BUILT_SOURCE: source },
      { OPKA_BUILT_RUN: '1;echo bad', OPKA_BUILT_SOURCE: source }
    ]) {
      expect(() => qualifyRelease({ ...env, ...patch }, fakeExecute())).toThrow()
    }
    const recovery = { ...env, OPKA_BUILT_RUN: '100', OPKA_BUILT_SOURCE: source }
    expect(() => qualifyRelease(recovery, fakeExecute(['src/main/any.ts']))).toThrow(
      'Application source'
    )
    const calls = []
    const execute = fakeExecute()
    qualifyRelease(recovery, (command, args) => {
      calls.push([command, args])
      return execute(command, args)
    })
    expect(calls.find(([command]) => command === 'git')?.[1]).toEqual([
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      source,
      qa,
      '--'
    ])
    expect(
      calls
        .filter(([command]) => command === 'gh')
        .every(([, args]) => args.slice(0, 3).join(' ') === 'api --paginate --slurp')
    ).toBe(true)
  })
  it('requires successful canonical qualification for both current QA and original binary source', () => {
    const execute = fakeExecute()
    for (const head of [source, qa]) {
      expect(() =>
        qualifyRelease(
          { ...env, OPKA_BUILT_RUN: '100', OPKA_BUILT_SOURCE: source },
          (command, args) =>
            command === 'gh' && args.at(-1).includes(`head_sha=${head}`)
              ? JSON.stringify([{ workflow_runs: [] }])
              : execute(command, args)
        )
      ).toThrow('No successful')
    }
  })
})
