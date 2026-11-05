import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareForkTestSelection } from './fork-test-selection.mjs'
import { NODE_FORK_TESTS, runForkTestPlan } from './run-fork-tests.mjs'

it('normal baseline selection needs no Git and separates Node without widening filters', () => {
  const root = mkdtempSync(join(tmpdir(), 'opka-fork-runners-'))
  try {
    const sources = {
      'config/scripts/selected-node.test.mjs': "import { test } from 'node:test'",
      'config/scripts/selected-vitest.test.mjs': "import { it } from 'vitest'",
      'config/scripts/selected-render.test.mjs': "import { it } from 'vitest'",
      'mobile/src/selected.test.ts': "import { it } from 'vitest'",
      'src/unrelated.test.ts': "import { it } from 'vitest'"
    }
    for (const [file, source] of Object.entries(sources)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), source)
    }
    const plan = prepareForkTestSelection(null, root, ['selected'])
    expect(plan.files).toHaveLength(4)
    expect(plan.files).not.toContain('src/unrelated.test.ts')
    expect(plan.lanes).toEqual({
      root: ['config/scripts/selected-vitest.test.mjs'],
      mobile: ['mobile/src/selected.test.ts'],
      render: ['config/scripts/selected-render.test.mjs'],
      node: ['config/scripts/selected-node.test.mjs']
    })
    expect(
      JSON.parse(readFileSync(join(root, 'out/opka-ci/fork-test-selection.json'), 'utf8'))
    ).toEqual(plan)
    const calls = []
    expect(
      runForkTestPlan(plan, (...args) => {
        calls.push(args)
        return true
      })
    ).toBe(true)
    expect(calls.filter(([, args]) => args.includes('--test'))).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const plan = () => ({
  lanes: {
    root: ['config/scripts/ordinary.test.mjs'],
    mobile: ['mobile/src/unit.test.ts'],
    render: ['config/scripts/browser-render.test.mjs'],
    node: ['config/scripts/native.test.mjs', NODE_FORK_TESTS[0], 'config/scripts/native.test.mjs']
  }
})

it('executes selected Node scripts and always-required fixtures exactly once under pinned Node', () => {
  const calls = []
  expect(
    runForkTestPlan(plan(), (...args) => {
      calls.push(args)
      return true
    })
  ).toBe(true)
  const node = calls.filter(([, args]) => args.includes('--test'))
  expect(node).toEqual([
    [
      process.execPath,
      ['--test', '--test-concurrency=1', 'config/scripts/native.test.mjs', ...NODE_FORK_TESTS]
    ]
  ])
  const vitest = calls.filter(([, args]) => args.includes('node_modules/vitest/vitest.mjs'))
  expect(vitest.map(([, , env]) => env.OPKA_FORK_TEST_LANE)).toEqual(['root', 'mobile', 'render'])
  expect(vitest.every(([, args]) => !args.includes('config/scripts/native.test.mjs'))).toBe(true)
})

it('does not mask a Node test failure with successful Vitest lanes', () => {
  expect(runForkTestPlan(plan(), (_program, args) => !args.includes('--test'))).toBe(false)
})

it('reports preparation failure while still attempting the selected Node tests exactly once', () => {
  const calls = []
  expect(
    runForkTestPlan(plan(), (program, args) => {
      calls.push([program, args])
      return program !== 'pnpm'
    })
  ).toBe(false)
  expect(calls.filter(([, args]) => args.includes('--test'))).toHaveLength(1)
  expect(calls.some(([, , env]) => env?.OPKA_FORK_TEST_LANE === 'root')).toBe(false)
})
