import { globSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { verifyRequiredPrContext } from '../../.github/scripts/check-required-pr-context.mjs'
import { FORK_TEST_FILTERS } from './run-fork-tests.mjs'
import { UNIT_INCLUDE } from './ci-unit-files.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))

describe('fork CI safety and required checks', () => {
  it('executes the aggregate gate against success, missing, failed, cancelled and skipped checks', () => {
    const command = workflow.jobs.verify.steps.find((step) => step.run).run.trim()
    const match = command.match(/^node -e '([\s\S]+)'$/)
    expect(match).not.toBeNull()
    const script = match[1]
    const results = Object.fromEntries(
      workflow.jobs.verify.needs.map((name) => [name, { result: 'success' }])
    )
    const run = (value) =>
      execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, RESULTS: JSON.stringify(value) },
        stdio: 'pipe'
      })
    expect(() => run(results)).not.toThrow()
    for (const name of workflow.jobs.verify.needs) {
      const { [name]: omitted, ...missing } = results
      expect(omitted.result).toBe('success')
      expect(() => run(missing)).toThrow()
      for (const result of ['failure', 'cancelled', 'skipped']) {
        expect(() => run({ ...results, [name]: { result } })).toThrow()
      }
    }
  })
  it('does not silently accept misspelled test filters', () => {
    const files = globSync(UNIT_INCLUDE).map((file) => file.replaceAll('\\', '/'))
    for (const filter of FORK_TEST_FILTERS) {
      expect(
        files.some((file) => file.includes(filter)),
        filter
      ).toBe(true)
    }
  })

  it('runs the suites when invoked as the package script', () => {
    expect(readFileSync('config/scripts/run-fork-tests.mjs', 'utf8')).toContain(
      'isDirectInvocation(import.meta.url, process.argv[1])'
    )
  })

  it('owns the existing required context without shadow workflows', () => {
    expect(() => verifyRequiredPrContext(parse)).not.toThrow()
  })

  it('requires tests, all desktop platforms and hidden GUI checks', () => {
    expect(workflow.jobs.verify.needs).toEqual([
      'static',
      'regression',
      'desktop',
      'electron',
      'installers'
    ])
    expect(workflow.jobs.desktop.strategy.matrix.os).toEqual([
      'ubuntu-24.04',
      'macos-15',
      'windows-2022'
    ])
    expect(workflow.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    expect(
      workflow.jobs.electron.steps.find((step) => step.name === 'Build test renderer').run
    ).toContain('pnpm run build:cli')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const text = readFileSync('.github/workflows/pr.yml', 'utf8')
    expect(text).not.toMatch(
      /secrets\.|pull_request_target|self-hosted|blacksmith|continue-on-error|gh release|electron-builder/
    )
    expect(text).toContain('job.result !== "success"')
    expect(text).toContain('if-no-files-found: error')
  })
})
