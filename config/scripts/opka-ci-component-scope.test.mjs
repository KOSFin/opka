import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { describe, expect, it, vi } from 'vitest'
import {
  CI_LANES,
  classifyCiPaths,
  evaluateCiResults,
  detectCiScope
} from './opka-ci-component-scope.mjs'

vi.mock('@orca/process-host', () => ({ runProcessSync: vi.fn() }))

function results(scope) {
  return {
    scope: { result: 'success' },
    ...Object.fromEntries(
      CI_LANES.map((lane) => [
        lane,
        { result: scope[lane] && !scope.reused ? 'success' : 'skipped' }
      ])
    )
  }
}

describe('component CI routing', () => {
  it('keeps documentation checks without building applications', () => {
    const scope = classifyCiPaths(['docs/architecture.md', 'fork-docs/iterations/009.md'])
    expect(scope.docs_only).toBe(true)
    expect(CI_LANES.filter((lane) => scope[lane])).toEqual(['static'])
  })
  it('checks mobile tests without native packaging but native/runtime inputs require Android', () => {
    expect(classifyCiPaths(['mobile/src/cache/x.test.ts']).android).toBe(false)
    expect(classifyCiPaths(['mobile/src/cache/x.ts']).android).toBe(true)
    expect(classifyCiPaths(['mobile/modules/updater/build.gradle']).android).toBe(true)
  })
  it('covers shared host behavior on desktop, mobile and packaged hosts', () => {
    const scope = classifyCiPaths(['src/shared/pairing.ts'])
    for (const lane of CI_LANES) {
      expect(scope[lane]).toBe(true)
    }
  })
  it('does not silently discard unknown paths or policy inputs', () => {
    for (const path of [
      'pnpm-lock.yaml',
      '.github/workflows/pr.yml',
      'new-system/foo.ts',
      'resources/skills/orchestration/SKILL.md'
    ]) {
      const scope = classifyCiPaths([path])
      expect(CI_LANES.every((lane) => scope[lane])).toBe(true)
      expect(scope.full).toBe(true)
    }
  })
  it('keeps source-only selection targeted but routes build policy through the approved full suite', () => {
    expect(classifyCiPaths(['src/renderer/src/App.tsx']).full).toBe(false)
    expect(classifyCiPaths(['src/shared/pairing.ts']).full).toBe(false)
    for (const path of [
      'config/scripts/opka-ci-component-scope.mjs',
      'config/vitest.config.ts',
      '.github/workflows/pr.yml'
    ]) {
      expect(classifyCiPaths([path]).full).toBe(true)
    }
    expect(classifyCiPaths(['src/renderer/src/App.tsx', 'pnpm-lock.yaml']).full).toBe(true)
  })
  it('routes only exact CI contract test files without rebuilding native applications', () => {
    for (const path of [
      'config/scripts/build-orcad.test.mjs',
      '.github/scripts/check-pr.test.mjs'
    ]) {
      const scope = classifyCiPaths([path])
      expect(CI_LANES.filter((lane) => scope[lane])).toEqual(['static', 'regression'])
      expect(scope.full).toBe(false)
    }
    for (const path of [
      'config/scripts/build-orcad.mjs',
      '.github/scripts/check-pr.mjs',
      'config/scripts/nested/file.test.mjs',
      'config/scripts/build-orcad.test.ts'
    ]) {
      expect(classifyCiPaths([path]).full).toBe(true)
    }
    expect(classifyCiPaths(['config/scripts/contract.test.mjs', 'pnpm-lock.yaml']).full).toBe(true)
  })
  it('routes Android acceptance drivers without rebuilding unrelated desktop and server installers', () => {
    const drivers = [
      'config/scripts/opka-android-ui-journey.py',
      'config/scripts/opka_android_task_fields.py',
      'config/scripts/opka_android_task_fields_test.py',
      'config/scripts/opka_android_candidate_artifact.py',
      'config/scripts/build-android-update-handoff.py',
      'config/android-update-handoff/AndroidManifest.xml',
      'config/android-update-handoff/src/InstallerActivity.java',
      'config/scripts/fixtures/android-webview-accessibility/editor.xml'
    ]
    for (const path of drivers) {
      const scope = classifyCiPaths([path])
      expect(CI_LANES.filter((lane) => scope[lane])).toEqual(['static', 'regression', 'android'])
      expect(scope.full).toBe(false)
    }
    for (const path of [
      'config/scripts/opka-android-release-assets.mjs',
      'config/scripts/opka_android_fixture_proxy.mjs',
      'config/scripts/nested/opka-android-ui.py',
      'config/scripts/build-android-update-handoff.mjs',
      'config/android-update-handoff-production/AndroidManifest.xml',
      'config/scripts/fixtures/android-webview-accessibility-other/editor.xml',
      'config/scripts/fixtures/nested/android-webview-accessibility/editor.xml',
      'config/scripts/fixtures/another-ui/editor.xml'
    ]) {
      expect(classifyCiPaths([path]).full).toBe(true)
    }
    const mixed = classifyCiPaths([drivers[0], 'src/main/runtime/rpc/dispatcher.ts'])
    expect(CI_LANES.every((lane) => mixed[lane])).toBe(true)
    expect(classifyCiPaths([drivers[0], 'pnpm-lock.yaml']).full).toBe(true)
  })
  it('aggregates every requested lane and refuses unexplained skips and failures', () => {
    const scope = classifyCiPaths(['src/renderer/src/App.tsx'])
    expect(() => evaluateCiResults(scope, results(scope))).not.toThrow()
    for (const result of ['skipped', 'failure', 'cancelled']) {
      expect(() => evaluateCiResults(scope, { ...results(scope), electron: { result } })).toThrow()
    }
    expect(() =>
      evaluateCiResults(scope, { ...results(scope), scope: { result: 'failure' } })
    ).toThrow()
  })
  it('only allows deliberate whole-tree proof reuse, with no pretend job passes', () => {
    const scope = { ...classifyCiPaths(['src/shared/pairing.ts']), reused: true }
    expect(() => evaluateCiResults(scope, results(scope))).not.toThrow()
    expect(() =>
      evaluateCiResults(scope, { ...results(scope), desktop: { result: 'success' } })
    ).toThrow()
  })
})

describe('valid comparison versus full fallback', () => {
  it('preserves changed-test discovery for a valid global policy diff', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'opka-ci-scope-test-'))
    const event = join(directory, 'event.json')
    writeFileSync(event, '{}')
    const git = vi.mocked(runProcessSync)
    git.mockImplementation(({ args }) => ({
      code: 0,
      stdout: args[0] === 'diff' ? 'config/scripts/new-policy.mjs\0' : 'a'.repeat(40),
      stderr: '',
      signal: null,
      timedOut: false
    }))
    try {
      const scope = await detectCiScope({
        GITHUB_EVENT_PATH: event,
        GITHUB_EVENT_NAME: 'pull_request'
      })
      expect(scope.full).toBe(true)
      expect(scope.comparison_valid).toBe(true)
      expect(scope.paths).toContain('config/scripts/new-policy.mjs')
    } finally {
      rmSync(directory, { recursive: true, force: true })
      git.mockReset()
    }
  })
  it('never sends an unavailable comparison to selective tests', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'opka-ci-scope-test-'))
    const event = join(directory, 'event.json')
    writeFileSync(event, '{}')
    const git = vi.mocked(runProcessSync)
    git.mockImplementation(({ args }) => ({
      code: args[0] === 'diff' ? 1 : 0,
      stdout: 'a'.repeat(40),
      stderr: '',
      signal: null,
      timedOut: false
    }))
    try {
      for (const name of ['pull_request', 'workflow_dispatch']) {
        const scope = await detectCiScope({ GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: name })
        expect(scope.full).toBe(true)
        expect(scope.comparison_valid).toBe(false)
        expect(CI_LANES.every((lane) => scope[lane])).toBe(true)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
      git.mockReset()
    }
  })
})

function followupProof(kind = 'test-only-followup') {
  const names = [
    'Types and changed-code quality',
    ...[1, 2, 3, 4].map((index) =>
      kind === 'account-pool-readiness-followup' && index === 4
        ? 'Fork regression tests (mobile and integration)'
        : `Fork regression tests (${index}/4)`
    ),
    'Desktop assets (macos-15)',
    'Desktop assets (ubuntu-24.04)',
    'Desktop assets (windows-2022)',
    'Hidden Electron journeys and Swift',
    'Beta installer qualification / Installer qualification passed',
    'Android component acceptance / Opka Android installer confirmation and retained state'
  ]
  return {
    schemaVersion: 1,
    kind,
    repository: 'KOSFin/opka',
    prNumber: 16,
    head: 'a'.repeat(40),
    sourceHead: 'c'.repeat(40),
    sourceTree: 'd'.repeat(40),
    base: 'b'.repeat(40),
    runId: 17,
    attempt: 2,
    reusedLanes: ['desktop', 'electron', 'installers', 'android'],
    paths: [
      kind === 'account-pool-readiness-followup'
        ? 'src/renderer/src/components/settings/AccountPoolSection.consistency.test.tsx'
        : 'config/scripts/mobile-web-app-project-work-fixtures.mjs'
    ],
    jobs: names.map((name, index) => ({
      id: index + 1,
      name,
      runId: 17,
      head: 'b'.repeat(40),
      status: 'completed',
      conclusion: 'success'
    }))
  }
}

function followupScope(proof = followupProof()) {
  return {
    ...classifyCiPaths(proof.paths),
    ...Object.fromEntries(proof.reusedLanes.map((lane) => [lane, false])),
    reused: false,
    head: proof.head,
    tree: proof.sourceTree,
    base: proof.base,
    followupProof: proof
  }
}

describe('verified test-only follow-up qualification', () => {
  it('keeps current static and regression checks mandatory and reused platform jobs skipped', () => {
    const scope = followupScope()
    expect(() => evaluateCiResults(scope, results(scope))).not.toThrow()
    for (const lane of ['static', 'regression']) {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        expect(() => evaluateCiResults(scope, { ...results(scope), [lane]: { result } })).toThrow()
      }
      expect(() => evaluateCiResults({ ...scope, [lane]: false }, results(scope))).toThrow()
    }
    for (const lane of scope.followupProof.reusedLanes) {
      expect(() =>
        evaluateCiResults(scope, { ...results(scope), [lane]: { result: 'success' } })
      ).toThrow()
    }
  })

  it('rejects incomplete, stale or broadened component evidence', () => {
    const scope = followupScope()
    for (const altered of [
      { ...scope, tree: 'e'.repeat(40) },
      { ...scope, head: 'e'.repeat(40) },
      { ...scope, base: 'e'.repeat(40) },
      { ...scope, reused: true },
      followupScope({ ...followupProof(), jobs: [] }),
      followupScope({ ...followupProof(), paths: ['src/main/runtime/x.ts'] }),
      followupScope({ ...followupProof(), reusedLanes: ['static', 'regression'] })
    ]) {
      expect(() => evaluateCiResults(altered, results(altered))).toThrow()
    }
  })

  it.each(['test-only-followup', 'account-pool-readiness-followup'])(
    'uses verified preceding source for %s and rejects foreign or stale evidence',
    async (kind) => {
      const directory = mkdtempSync(join(tmpdir(), 'opka-ci-followup-scope-'))
      const event = join(directory, 'event.json')
      writeFileSync(event, JSON.stringify({ number: 16 }))
      const git = vi.mocked(runProcessSync)
      git.mockImplementation(({ args }) => ({
        code: 0,
        stdout:
          args[0] === 'diff'
            ? 'src/main/runtime/x.ts\0'
            : args[1]?.endsWith('^{tree}')
              ? 'd'.repeat(40)
              : 'a'.repeat(40),
        stderr: '',
        signal: null,
        timedOut: false
      }))
      const env = {
        GITHUB_EVENT_PATH: event,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'KOSFin/opka'
      }
      try {
        const proof = followupProof(kind)
        const scope = await detectCiScope(env, async () => proof)
        expect(scope.base).toBe(proof.base)
        expect(scope.comparison_valid).toBe(true)
        expect(scope.paths).toEqual(proof.paths)
        expect(CI_LANES.filter((lane) => scope[lane])).toEqual(['static', 'regression'])
        expect(() => evaluateCiResults(scope, results(scope))).not.toThrow()
        for (const invalid of [
          { ...proof, repository: 'foreign/repo' },
          { ...proof, prNumber: 42 },
          { ...proof, head: 'e'.repeat(40) },
          { ...proof, sourceTree: 'e'.repeat(40) },
          null
        ]) {
          const fallback = await detectCiScope(env, async () => invalid)
          expect(fallback.followupProof).toBeUndefined()
          expect(CI_LANES.every((lane) => fallback[lane])).toBe(true)
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
        git.mockReset()
      }
    }
  )
})

it('requires fresh static and all regression groups for readiness without borrowing the failed root shard', () => {
  const scope = followupScope(followupProof('account-pool-readiness-followup'))
  expect(() => evaluateCiResults(scope, results(scope))).not.toThrow()
  for (const lane of ['static', 'regression']) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(() => evaluateCiResults(scope, { ...results(scope), [lane]: { result } })).toThrow()
    }
    const forged = { ...scope, [lane]: false }
    expect(() => evaluateCiResults(forged, results(forged))).toThrow()
  }
  for (const lane of ['desktop', 'electron', 'installers', 'android']) {
    const forged = { ...scope, [lane]: true }
    expect(() => evaluateCiResults(forged, results(forged))).toThrow()
  }
})
