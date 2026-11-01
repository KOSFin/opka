import { describe, expect, it } from 'vitest'
import { buildUnitDependencyGraph } from './ci-unit-dependency-graph.mjs'
import {
  parseForkSelectionArgs,
  selectForkTests,
  splitForkTestLanes
} from './fork-test-selection.mjs'

const sources = new Map(
  Object.entries({
    'src/shared/contract.ts': 'export const value = 1',
    'src/main/consumer.test.ts': "import '../shared/contract'",
    'mobile/src/adapter.ts': "export * from '../../src/shared/contract'",
    'mobile/src/feature.test.tsx': "import './adapter'",
    'mobile/src/aliased.test.ts': "import '@/adapter'",
    'mobile/src/unrelated.test.ts': 'export {}',
    'config/scripts/actual-render.test.mjs': "readFileSync('recorded-envelope.json')"
  })
)
const graph = { ...buildUnitDependencyGraph(sources), files: new Set(sources.keys()) }
const files = [...sources.keys()].filter((file) => /\.test\./.test(file))

describe('fork changed-component selection', () => {
  it('follows shared imports into both workspaces and retains opaque rendered consumers', () => {
    expect(selectForkTests(files, ['src/shared/contract.ts'], graph)).toMatchObject({
      full: false,
      files: [
        'src/main/consumer.test.ts',
        'mobile/src/feature.test.tsx',
        'mobile/src/aliased.test.ts',
        'config/scripts/actual-render.test.mjs'
      ]
    })
  })
  it('does not select unrelated native/root tests for a mobile leaf change', () => {
    const result = selectForkTests(files, ['mobile/src/adapter.ts'], graph)
    expect(result.full).toBe(false)
    expect(result.files).toContain('mobile/src/feature.test.tsx')
    expect(result.files).not.toContain('src/main/consumer.test.ts')
    expect(result.files).not.toContain('mobile/src/unrelated.test.ts')
  })
  it('includes a new changed test without adding it to a curated list', () => {
    expect(selectForkTests(files, ['mobile/src/unrelated.test.ts'], graph).files).toContain(
      'mobile/src/unrelated.test.ts'
    )
  })
  it.each(
    [
      [],
      ['mobile/src/deleted.ts'],
      ['pnpm-lock.yaml'],
      ['mobile/package.json'],
      ['config/vitest.config.ts'],
      ['unknown/new.ts']
    ].map((changed) => ({ changed }))
  )('falls back conservatively for $changed', ({ changed }) => {
    expect(selectForkTests(files, changed, graph)).toMatchObject({ full: true, files })
  })
  it('falls back for code with no proven consumer rather than claiming zero tests passed', () => {
    expect(
      selectForkTests(files, ['src/uncovered.ts'], {
        ...graph,
        files: new Set([...graph.files, 'src/uncovered.ts'])
      }).full
    ).toBe(true)
  })
  it('keeps root, mobile and real-browser lanes disjoint and complete', () => {
    const lanes = splitForkTestLanes(files)
    expect(Object.values(lanes).flat().sort()).toEqual([...files].sort())
    expect(new Set(Object.values(lanes).flat()).size).toBe(files.length)
    expect(lanes.render).toEqual(['config/scripts/actual-render.test.mjs'])
  })
  it('preserves full default and admits only immutable explicit changed refs', () => {
    expect(parseForkSelectionArgs([])).toBeNull()
    expect(parseForkSelectionArgs(['--', '--changed', 'a'.repeat(40), 'b'.repeat(40)])).toEqual({
      base: 'a'.repeat(40),
      head: 'b'.repeat(40)
    })
    expect(() => parseForkSelectionArgs(['--changed', 'HEAD~1', 'HEAD'])).toThrow('immutable')
  })
})
