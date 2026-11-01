import { describe, expect, it } from 'vitest'
import { CI_LANES, classifyCiPaths, evaluateCiResults } from './opka-ci-component-scope.mjs'

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
    }
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
