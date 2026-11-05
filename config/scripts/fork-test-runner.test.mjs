import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { BaseSequencer } from 'vitest/node'
import { prepareForkTestSelection } from './fork-test-selection.mjs'
import { NODE_FORK_TESTS, readForkTestShard, runForkTestPlan } from './run-fork-tests.mjs'

const runUnshardedPlan = (plan, execute) => runForkTestPlan(plan, execute, {})

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
      runUnshardedPlan(plan, (...args) => {
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
    runUnshardedPlan(plan(), (...args) => {
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
  expect(runUnshardedPlan(plan(), (_program, args) => !args.includes('--test'))).toBe(false)
})

it('reports preparation failure while still attempting the selected Node tests exactly once', () => {
  const calls = []
  expect(
    runUnshardedPlan(plan(), (program, args) => {
      calls.push([program, args])
      return program !== 'pnpm'
    })
  ).toBe(false)
  expect(calls.filter(([, args]) => args.includes('--test'))).toHaveLength(1)
  expect(calls.some(([, , env]) => env?.OPKA_FORK_TEST_LANE === 'root')).toBe(false)
})

const shardEnvironment = (index) => ({
  OPKA_FORK_TEST_SHARD_INDEX: String(index),
  OPKA_FORK_TEST_SHARD_COUNT: '4'
})

it('uses the pinned native sequencer to cover a 3348-file root selection exactly once', async () => {
  const files = Array.from({ length: 3348 }, (_, index) => ({
    moduleId: `/selected/src/root-${index}.test.ts`
  }))
  const shards = await Promise.all(
    [1, 2, 3, 4].map((index) =>
      new BaseSequencer({ config: { root: '/selected', shard: { index, count: 4 } } }).shard(files)
    )
  )
  const assigned = shards.flat().map((file) => file.moduleId)
  expect(shards.map((shard) => shard.length)).toEqual([837, 837, 837, 837])
  expect(new Set(assigned).size).toBe(files.length)
  expect(assigned.toSorted()).toEqual(files.map((file) => file.moduleId).toSorted())
})

it('runs the identical selected root plan in four native shards and extras only once', () => {
  const selection = { ...plan(), lanes: { ...plan().lanes, root: ['a', 'b', 'c', 'd', 'e'] } }
  const calls = []
  for (const index of [1, 2, 3, 4]) {
    expect(
      runForkTestPlan(
        selection,
        (...args) => {
          calls.push({ index, args })
          return true
        },
        shardEnvironment(index)
      )
    ).toBe(true)
  }
  const vitest = calls.filter(({ args: [, args] }) =>
    args.includes('node_modules/vitest/vitest.mjs')
  )
  const roots = vitest.filter(({ args: [, , env] }) => env.OPKA_FORK_TEST_LANE === 'root')
  expect(roots.map(({ args: [, args] }) => args.at(-1))).toEqual([
    '--shard=1/4',
    '--shard=2/4',
    '--shard=3/4',
    '--shard=4/4'
  ])
  expect(
    roots.every(
      ({ args: [, args] }) =>
        args.includes('--maxWorkers=1') && args.includes('config/vitest.fork-selected.config.mjs')
    )
  ).toBe(true)
  expect(
    vitest
      .filter(({ args: [, , env] }) => env.OPKA_FORK_TEST_LANE !== 'root')
      .map(({ index, args: [, , env] }) => [index, env.OPKA_FORK_TEST_LANE])
  ).toEqual([
    [1, 'mobile'],
    [1, 'render']
  ])
  expect(
    calls.filter(({ args: [, args] }) => args.includes('--test')).map(({ index }) => index)
  ).toEqual([1])
  expect(selection.lanes.root).toEqual(['a', 'b', 'c', 'd', 'e'])
})

it.each([0, 1, 2, 3])(
  'skips only known empty logical root shards for %i selected files',
  (size) => {
    const calls = []
    const selection = {
      lanes: {
        root: Array.from({ length: size }, (_, i) => `root-${i}`),
        mobile: [],
        render: [],
        node: []
      }
    }
    for (const index of [1, 2, 3, 4]) {
      expect(
        runForkTestPlan(
          selection,
          (_program, args, env) => {
            calls.push({ index, args, env })
            return true
          },
          shardEnvironment(index)
        )
      ).toBe(true)
    }
    expect(
      calls
        .filter(({ env }) => env?.OPKA_FORK_TEST_LANE === 'root')
        .map(({ index, args }) => [index, args.at(-1)])
    ).toEqual(Array.from({ length: size }, (_, i) => [i + 1, `--shard=${i + 1}/${size}`]))
    expect(calls.some(({ args }) => args.includes('--passWithNoTests'))).toBe(false)
  }
)

it('propagates a root shard failure without retrying or running first-shard extras', () => {
  const calls = []
  expect(
    runForkTestPlan(
      { lanes: { ...plan().lanes, root: ['a', 'b', 'c', 'd'] } },
      (_program, args, env) => {
        calls.push({ args, env })
        return env?.OPKA_FORK_TEST_LANE !== 'root'
      },
      shardEnvironment(2)
    )
  ).toBe(false)
  expect(calls.filter(({ env }) => env?.OPKA_FORK_TEST_LANE === 'root')).toHaveLength(1)
  expect(calls.some(({ args }) => args.includes('--test'))).toBe(false)
})

it.each([
  { OPKA_FORK_TEST_SHARD_INDEX: '1' },
  { OPKA_FORK_TEST_SHARD_COUNT: '4' },
  { OPKA_FORK_TEST_SHARD_INDEX: '0', OPKA_FORK_TEST_SHARD_COUNT: '4' },
  { OPKA_FORK_TEST_SHARD_INDEX: '5', OPKA_FORK_TEST_SHARD_COUNT: '4' },
  { OPKA_FORK_TEST_SHARD_INDEX: '01', OPKA_FORK_TEST_SHARD_COUNT: '4' },
  { OPKA_FORK_TEST_SHARD_INDEX: '1', OPKA_FORK_TEST_SHARD_COUNT: '3' },
  { OPKA_FORK_TEST_SHARD_INDEX: '', OPKA_FORK_TEST_SHARD_COUNT: '' }
])('refuses invalid shard settings before executing any command: %j', (environment) => {
  const calls = []
  expect(() => runForkTestPlan(plan(), (...args) => calls.push(args), environment)).toThrow(
    'COUNT=4 and INDEX=1..4'
  )
  expect(calls).toEqual([])
})

it('keeps ordinary local execution unsharded when both settings are absent', () => {
  expect(readForkTestShard({})).toEqual({ index: 1, count: 1 })
  const calls = []
  expect(
    runUnshardedPlan(plan(), (...args) => {
      calls.push(args)
      return true
    })
  ).toBe(true)
  expect(calls.every(([, args]) => args.every((arg) => !arg.startsWith('--shard=')))).toBe(true)
})
