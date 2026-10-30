import { globSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { verifyRequiredPrContext } from '../../.github/scripts/check-required-pr-context.mjs'
import { FORK_TEST_FILTERS } from './run-fork-tests.mjs'
import { UNIT_INCLUDE } from './ci-unit-files.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))

describe('fork CI safety and required checks', () => {
  it('blocks beta publication until Android confirms a same-signer update', () => {
    const release = parse(readFileSync('.github/workflows/opka-release.yml', 'utf8'))
    expect(release.jobs.publish.needs).toEqual(['qualification', 'android_update'])
    expect(release.jobs.android_update).toMatchObject({
      needs: 'admission',
      uses: './.github/workflows/opka-android-update-acceptance.yml',
      with: { release_signer: true }
    })
    const acceptance = parse(
      readFileSync('.github/workflows/opka-android-update-acceptance.yml', 'utf8')
    )
    expect(acceptance.on.workflow_call.inputs.release_signer.default).toBe(false)
    expect(acceptance.permissions).toEqual({ contents: 'read' })
    const steps = acceptance.jobs.update_confirmation.steps
    expect(
      steps.find((step) => step.name === 'Exercise Android confirmation and data retention').with
        .script
    ).toContain('--handoff')
    expect(steps.find((step) => step.name === 'Require KVM acceleration').run).toContain(
      'test -c /dev/kvm'
    )
  })
  it('checks an immutable released updater without write permissions or installed app replacement', () => {
    const verification = parse(readFileSync('.github/workflows/opka-updater-smoke.yml', 'utf8'))
    expect(verification.permissions).toEqual({ contents: 'read' })
    expect(verification.on.pull_request.paths).toContain('.github/workflows/opka-updater-smoke.yml')
    const job = verification.jobs.verify_released_updater
    expect(job.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    const commands = job.steps.map((step) => step.run ?? '').join('\n')
    expect(commands).toContain('c12231d4e035abb39ac40a23cf8d2a78af38ebe0444b1625d1e1cb933a0343b6')
    expect(commands).toContain('codesign --verify --deep --strict')
    expect(commands).toContain('tests/playwright.packaged.config.ts')
    expect(commands).not.toMatch(/gh release (?:create|edit)|\/Applications\//)
    const config = readFileSync('tests/playwright.packaged.config.ts', 'utf8')
    expect(config).toMatch(/projects:[\s\S]*testMatch: '\*\*\/fork-packaged-installer\.spec\.ts'/)
  })
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

  it('qualifies ordinary-chat lifecycle without spending model credentials in CI', () => {
    for (const filter of [
      'src/main/runtime/project-task-session.test.ts',
      'src/main/runtime/project-task-target.test.ts',
      'src/main/runtime/project-task-terminal-caller.test.ts',
      'src/cli/handlers/project-task.test.ts',
      'src/cli/runtime-client.test.ts',
      'tests/e2e/helpers/fork-task-approvals.unit.test.ts',
      'tests/e2e/helpers/fork-codex-startup.unit.test.ts'
    ]) {
      expect(FORK_TEST_FILTERS).toContain(filter)
    }
    const journey = workflow.jobs.electron.steps.find(
      (step) => step.name === 'Exercise project navigation and task boards'
    ).run
    expect(journey).toContain('tests/e2e/fork-project-tasks.spec.ts')
    expect(journey).toContain('tests/e2e/fork-task-rpc-discovery.spec.ts')
    expect(journey).toContain('tests/e2e/fork-packaged-tasks.spec.ts')
    expect(journey).not.toContain('fork-task-real-codex.spec.ts')
    const installer = parse(readFileSync('.github/workflows/opka-installers.yml', 'utf8'))
    const packaged = installer.jobs.mac.steps.find(
      (step) => step.name === 'Exercise the packaged task lifecycle without a model'
    )
    expect(packaged.env.ORCA_FORK_PACKAGED_APP).toContain('/dist/mac-arm64/Opka.app')
    expect(packaged.run).toContain('fork-packaged-tasks.spec.ts')
    expect(packaged.run).toContain('fork-packaged-installer.spec.ts')
  })

  it('owns the existing required context without shadow workflows', () => {
    expect(() => verifyRequiredPrContext(parse)).not.toThrow()
  })

  it('requires actual Codex command-tool execution without model credentials before release', () => {
    const steps = workflow.jobs.electron.steps
    const install = steps.find(
      (step) => step.name === 'Install pinned Codex for the account-free terminal contract'
    )
    expect(install.run).toContain('@openai/codex@0.160.0')
    expect(install.run).toContain('$RUNNER_TEMP/opka-codex-contract')
    const contract = steps.find(
      (step) => step.name === 'Exercise actual Codex command tools with local scripted responses'
    )
    expect(contract.env.ORCA_CODEX_TERMINAL_SCRIPTED).toBe('1')
    expect(contract.env.ORCA_REAL_CODEX_BINARY).toContain('/opka-codex-contract/')
    expect(contract.env.ORCA_REAL_CODEX_BINARY).toContain(
      '/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'
    )
    expect(contract.env.ORCA_REAL_CODEX_AUTH_FILE).toBeUndefined()
    expect(contract.run).toContain('fork-task-real-terminal-codex.spec.ts')
    expect(contract['continue-on-error']).toBeUndefined()
    expect(workflow.jobs.verify.needs).toContain('electron')
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
