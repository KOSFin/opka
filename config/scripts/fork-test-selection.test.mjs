import { describe, expect, it } from 'vitest'
import { buildUnitDependencyGraph } from './ci-unit-dependency-graph.mjs'
import {
  forkGraphFailureReason,
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
  it('follows shared imports into both workspaces and retains approved rendered coverage', () => {
    expect(
      selectForkTests(files, ['src/shared/contract.ts'], graph, [
        'config/scripts/actual-render.test.mjs'
      ])
    ).toMatchObject({
      full: false,
      files: [
        'config/scripts/actual-render.test.mjs',
        'mobile/src/aliased.test.ts',
        'mobile/src/feature.test.tsx',
        'src/main/consumer.test.ts'
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
    expect(selectForkTests(files, changed, graph)).toMatchObject({ full: true, files: [...files].sort() })
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
  it('falls back to approved qualification plus every changed discovered test, not the upstream world', () => {
    const fallback = ['src/main/consumer.test.ts']
    const result = selectForkTests(
      files,
      ['config/vitest.config.ts', 'mobile/src/unrelated.test.ts'],
      graph,
      fallback
    )
    expect(result.full).toBe(true)
    expect(result.files).toEqual(['mobile/src/unrelated.test.ts', 'src/main/consumer.test.ts'])
    expect(result.files).not.toContain('mobile/src/aliased.test.ts')
  })
  it('never fans an unrelated opaque upstream reader into the approved fork inventory', () => {
    const result = selectForkTests(files, ['mobile/src/adapter.ts'], graph, [
      'mobile/src/unrelated.test.ts'
    ])
    expect(result.files).toEqual([
      'mobile/src/aliased.test.ts',
      'mobile/src/feature.test.tsx',
      'mobile/src/unrelated.test.ts'
    ])
    expect(result.files).not.toContain('config/scripts/actual-render.test.mjs')
  })
  it('keeps transitive consumers beyond the fallback inventory when the graph is proven', () => {
    expect(selectForkTests(files, ['mobile/src/adapter.ts'], graph, []).files).toContain(
      'mobile/src/feature.test.tsx'
    )
  })
  it('reports a bounded public missing export but never echoes arbitrary exception content', () => {
    expect(
      forkGraphFailureReason(new Error('No public orca-source export for @orca/expo-two-way-audio'))
    ).toContain('missing-source:@orca/expo-two-way-audio')
    expect(forkGraphFailureReason(new Error('private-token /private/path'))).toBe(
      'Dependency graph unavailable (Error)'
    )
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
