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
