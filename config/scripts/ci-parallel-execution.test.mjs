import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { CI_LANES, classifyCiPaths, evaluateCiResults, verifyCiCheckout } from './opka-ci-component-scope.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))

describe('independent CI execution retains qualification', () => {
  it('runs native qualification in the required regression matrix, outside static analysis', () => {
    const job = workflow.jobs.regression
    expect(job.strategy.matrix.include).toContainEqual({
      shard: 1, group: 'native-replay', label: 'pinned native replay'
    })
    for (const name of [
      'Build exact native replay engine from pinned public inputs',
      'Qualify public Codex opaque compact and resumed request in isolation',
      'Keep exact synthetic native transport evidence'
    ]) {
      const step = job.steps.find((entry) => entry.name === name)
      expect(step.if).toContain("matrix.group == 'native-replay'")
      expect(workflow.jobs.static.steps.some((entry) => entry.name === name)).toBe(false)
    }
    const host = job.steps.find((step) => step.name === 'Test host accounts, mobile state and generated pages')
    expect(host.if).toContain("matrix.group != 'native-replay'")
    expect(job.steps.find((step) => step.uses === './.github/actions/install-node-dependencies').with['native-runtime']).toBe('node')
    expect(workflow.jobs.verify.needs).toContain('regression')
  })

  it('partitions the complete journey inventory and executes the account-free contract once', () => {
    const job = workflow.jobs.electron_shards
    expect(job.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2] } })
    const journey = job.steps.find((step) => step.name === 'Exercise project navigation and task boards')
    expect(journey.run.match(/tests\/e2e\/[^\s]+\.spec\.ts/g)).toEqual([
      'tests/e2e/fork-nested-project-tree.spec.ts',
      'tests/e2e/fork-project-navigation.spec.ts',
      'tests/e2e/fork-project-task-scope.spec.ts',
      'tests/e2e/fork-vibe-board.spec.ts',
      'tests/e2e/fork-five-projects.spec.ts',
      'tests/e2e/fork-beta-update.spec.ts',
      'tests/e2e/fork-project-tasks.spec.ts',
      'tests/e2e/fork-delegation-controls.spec.ts',
      'tests/e2e/fork-task-rpc-discovery.spec.ts',
      'tests/e2e/fork-packaged-tasks.spec.ts',
      'tests/e2e/fork-account-pool-settings.spec.ts',
      'tests/e2e/fork-worker-capacity-settings.spec.ts',
      'tests/e2e/fork-usage-extra-review.spec.ts',
      'tests/e2e/git-project-trackers-hidden.spec.ts',
      'tests/e2e/sparse-explorer-proof.spec.ts',
      'tests/e2e/sparse-preset-proof.spec.ts',
      'tests/e2e/automation-command-ui.spec.ts'
    ])
    expect(journey.run).toContain('--workers=1 --shard=${{ matrix.shard }}/2')
    for (const step of job.steps.filter((entry) => /account-free terminal contract|actual Codex command tools/.test(entry.name ?? ''))) {
      expect(step.if).toBe('matrix.shard == 1')
    }
    for (const name of ['Build Swift components from source', 'Build test renderer']) {
      expect(job.steps.find((step) => step.name === name).if).toBeUndefined()
    }
    const evidence = job.steps.find((step) => step.name === 'Save task lifecycle visual evidence')
    expect(evidence.with.name).toContain('${{ matrix.shard }}')
  })

  it('preserves the required Electron context and refuses every incomplete shard outcome', () => {
    const gate = workflow.jobs.electron
    expect(gate.name).toBe('Hidden Electron journeys and Swift')
    expect(gate.needs).toEqual(['scope', 'electron_shards'])
    expect(gate.if).toContain('!cancelled()')
    const run = (results) => runInNewContext(gate.steps[0].run, {
      process: { env: { RESULTS: JSON.stringify(results) } }
    })
    const success = { scope: { result: 'success' }, electron_shards: { result: 'success' } }
    expect(() => run(success)).not.toThrow()
    for (const name of gate.needs) {
      for (const result of ['failure', 'cancelled', 'skipped', 'unknown', undefined]) {
        expect(() => run({ ...success, [name]: { result } })).toThrow()
      }
      const missing = { ...success }
      delete missing[name]
      expect(() => run(missing)).toThrow()
    }
    expect(workflow.jobs.verify.needs).toContain('electron')
  })

  it('rejects missing or nonboolean scope flags instead of accepting unexplained skips', () => {
    const scope = classifyCiPaths(['src/shared/pairing.ts'])
    const results = Object.fromEntries(['scope', ...CI_LANES].map((name) => [name, { result: 'success' }]))
    for (const lane of CI_LANES) {
      for (const value of [undefined, null, 'false', 'true', 0, 1]) {
        expect(() => evaluateCiResults({ ...scope, [lane]: value }, results)).toThrow()
      }
    }
    for (const reused of ['false', 0, null]) {
      expect(() => evaluateCiResults({ ...scope, reused }, results)).toThrow()
    }
    expect(() => evaluateCiResults({}, {
      scope: { result: 'success' },
      ...Object.fromEntries(CI_LANES.map((lane) => [lane, { result: 'skipped' }]))
    })).toThrow()
  })

  it('binds aggregate qualification to the actual checked-out head and tree', () => {
    const scope = { head: 'a'.repeat(40), tree: 'b'.repeat(40) }
    const readGit = (_, ref) => ref === 'HEAD' ? scope.head : scope.tree
    expect(() => verifyCiCheckout(scope, readGit)).not.toThrow()
    for (const key of ['head', 'tree']) {
      expect(() => verifyCiCheckout({ ...scope, [key]: 'c'.repeat(40) }, readGit)).toThrow()
      expect(() => verifyCiCheckout({ ...scope, [key]: undefined }, readGit)).toThrow()
    }
  })

  it('keeps CI policy and mirrored cloud contracts on the full qualification path', () => {
    for (const path of [
      'config/scripts/opka-ci-component-scope.mjs',
      'config/scripts/opka-ci-followup-proof.mjs',
      'config/scripts/opka-release-qualification.mjs',
      'config/scripts/build-orcad.test.mjs',
      'cloud/packages/push-contract/src/index.ts',
      'cloud/packages/relay-contract/src/index.ts'
    ]) {
      const scope = classifyCiPaths([path])
      expect(CI_LANES.every((lane) => scope[lane]), path).toBe(true)
      expect(scope.full, path).toBe(true)
    }
    expect(classifyCiPaths(['cloud/apps/push/src/config.ts']).android).toBe(false)
  })
})
