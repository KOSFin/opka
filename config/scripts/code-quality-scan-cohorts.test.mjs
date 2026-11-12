import { describe, expect, it } from 'vitest'
import { planTypeAwareCohorts, runCodeQualityScan } from './code-quality-scan-cohorts.mjs'

const scan = {
  label: 'type-aware code quality',
  args: ['--type-aware', '--config', 'config/oxlint-code-quality-type-aware.json']
}
const files = [
  'src/main/host.ts',
  'src/renderer/src/page.tsx',
  'config/scripts/build.mjs',
  'mobile/src/page.tsx',
  'src/renderer/src/page.test.tsx',
  'src/shared/domain.ts',
  'mobile/scripts/build.ts'
]

describe('type-aware scan cohorts', () => {
  it('partitions every path exactly once with stable ordering within each project cohort', () => {
    const cohorts = planTypeAwareCohorts(files)
    expect(cohorts).toEqual([
      [files[1], files[4]],
      [files[3], files[6]],
      [files[0], files[2], files[5]]
    ])
    expect(cohorts.flat().toSorted()).toEqual(files.toSorted())
    expect(new Set(cohorts.flat()).size).toBe(files.length)
    expect(planTypeAwareCohorts([])).toEqual([])
    expect(planTypeAwareCohorts([files[0]])).toEqual([[files[0]]])
  })

  it('keeps cwd and config discovery unchanged and collects diagnostics from every cohort', () => {
    const calls = []
    const run = (root, current, cohort) => {
      calls.push({ root, current, cohort })
      return cohort.map((filename) => ({ filename }))
    }
    const result = runCodeQualityScan('/workspace', scan, files, run)
    expect(result.diagnostics.map((diagnostic) => diagnostic.filename).toSorted()).toEqual(
      files.toSorted()
    )
    expect(result.errors).toEqual([])
    expect(calls.map((call) => call.cohort)).toEqual(planTypeAwareCohorts(files))
    for (const call of calls) {
      expect(call.root).toBe('/workspace')
      expect(call.current).toEqual({ ...scan, args: [...scan.args, '--threads=1'] })
    }
    expect(runCodeQualityScan('/workspace', scan, [], run)).toEqual({ diagnostics: [], errors: [] })
    expect(calls).toHaveLength(3)
  })

  it('retains failures and still scans subsequent cohorts', () => {
    const failure = new Error('synthetic scan failure')
    const visited = []
    const result = runCodeQualityScan('/workspace', scan, files, (_root, _scan, cohort) => {
      visited.push(cohort)
      if (visited.length === 1) {
        throw failure
      }
      return cohort.map((filename) => ({ filename }))
    })
    expect(visited).toEqual(planTypeAwareCohorts(files))
    expect(result.errors).toEqual([failure])
    expect(result.diagnostics.map((diagnostic) => diagnostic.filename)).toEqual(
      planTypeAwareCohorts(files).slice(1).flat()
    )
  })

  it('leaves the other scans as a single invocation with their original flags and files', () => {
    const untyped = { label: 'code quality', args: ['--config', 'nested-config.json'] }
    const calls = []
    const diagnostics = [{ filename: files[0] }]
    const result = runCodeQualityScan('/workspace', untyped, files, (...args) => {
      calls.push(args)
      return diagnostics
    })
    expect(calls).toEqual([['/workspace', untyped, files]])
    expect(result).toEqual({ diagnostics, errors: [] })
  })
})
