import { globSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { verifyRequiredPrContext } from '../../.github/scripts/check-required-pr-context.mjs'
import { FORK_TEST_FILTERS, MOBILE_RENDER_TEST_FILTERS } from './run-fork-tests.mjs'
import { evaluateCiResults, classifyCiPaths } from './opka-ci-component-scope.mjs'
import { UNIT_INCLUDE } from './ci-unit-files.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))

describe('fork CI safety and required checks', () => {
  it('partitions root regressions across bounded runners and runs shared checks once', () => {
    const job = workflow.jobs.regression
    expect(job.strategy).toEqual({
      'fail-fast': false,
      matrix: {
        include: [
          { shard: 1, group: 'root', label: '1/4' },
          { shard: 2, group: 'root', label: '2/4' },
          { shard: 3, group: 'root', label: '3/4' },
          { shard: 4, group: 'root', label: '4/4' },
          { shard: 1, group: 'shared', label: 'mobile and integration' }
        ]
      }
    })
    expect(job.name).toBe('Fork regression tests (${{ matrix.label }})')
    expect(job['timeout-minutes']).toBe(25)
    expect(job.env).toEqual({
      OPKA_FORK_TEST_GROUP: '${{ matrix.group }}',
      OPKA_FORK_TEST_SHARD_INDEX: '${{ matrix.shard }}',
      OPKA_FORK_TEST_SHARD_COUNT: '4',
      NODE_OPTIONS: '--max-old-space-size=1536'
    })
    for (const step of job.steps.filter(
      (entry) =>
        entry.name === 'Install the pinned headless renderer browser' ||
        entry['working-directory'] === 'cloud'
    )) {
      expect(step.if).toBe("matrix.group == 'shared'")
    }
    expect(
      job.steps.find((entry) => entry.uses === './.github/actions/install-mobile-dependencies').if
    ).toBeUndefined()
    const mobileEvidence = job.steps.find(
      (entry) => entry.name === 'Save synthetic mobile page evidence'
    )
    expect(mobileEvidence.if).toBe("${{ always() && matrix.group == 'shared' }}")
    const selection = job.steps.find((entry) => entry.name === "Save this shard's test selection")
    expect(selection.with.name).toBe(
      'fork-test-selection-${{ github.sha }}-${{ matrix.group }}-${{ matrix.shard }}'
    )
    expect(workflow.jobs.verify.needs).toContain('regression')
  })
  it('runs rendered pages with Node and installs the browser their library owns', () => {
    const steps = workflow.jobs.regression.steps
    expect(
      steps.find((step) => step.run?.includes('install --with-deps chromium webkit')).run
    ).toBe('node node_modules/playwright-core/cli.js install --with-deps chromium webkit')
    expect(
      steps.find((step) => step.name === 'Test host accounts, mobile state and generated pages').env
        .ORCA_MOBILE_WEB_APP_DEPS_REQUIRED
    ).toBe('1')
    for (const filter of MOBILE_RENDER_TEST_FILTERS) {
      expect(FORK_TEST_FILTERS).not.toContain(filter)
      expect(readFileSync(filter, 'utf8')).toContain('playwright-core')
    }
    const runner = readFileSync('config/scripts/run-fork-tests.mjs', 'utf8')
    expect(runner).toContain('execute(process.execPath, [')
    expect(runner).toContain('...MOBILE_RENDER_TEST_FILTERS')
    expect(runner).toContain("for (const lane of ['root', 'mobile', 'render'])")
    expect(runner).toContain('return results.every(Boolean)')
  })
  it('blocks beta publication until Android confirms a same-signer update', () => {
    const release = parse(readFileSync('.github/workflows/opka-release.yml', 'utf8'))
    expect(release.jobs.publish.needs).toEqual(['admission', 'qualification', 'android_update'])
    expect(release.jobs.qualification).toMatchObject({
      needs: 'admission',
      uses: './.github/workflows/opka-installers.yml',
      with: { version: '${{ inputs.version }}' }
    })
    const qualification = release.jobs.admission.steps.find(
      (step) => step.name === 'Require qualified source and verify any reused immutable build'
    )
    expect(qualification.run).toBe('node config/scripts/opka-release-qualification.mjs')
    expect(qualification.env.OPKA_QUALIFIED_COMMIT).toBe('${{ github.sha }}')
    expect(FORK_TEST_FILTERS).toContain('config/scripts/opka-release-qualification.test.mjs')
    expect(release.jobs.android_update).toMatchObject({
      needs: ['admission', 'qualification'],
      uses: './.github/workflows/opka-android-update-acceptance.yml',
      with: { release_signer: true }
    })
    const acceptance = parse(
      readFileSync('.github/workflows/opka-android-update-acceptance.yml', 'utf8')
    )
    expect(acceptance.on.workflow_call.inputs.release_signer.default).toBe(false)
    expect(acceptance.permissions).toEqual({ contents: 'read', actions: 'read' })
    const steps = acceptance.jobs.update_confirmation.steps
    expect(
      steps.find((step) => step.name === 'Exercise Android confirmation and data retention').with
        .script
    ).toBe('python3 config/scripts/opka-android-ci-acceptance.py')
    expect(release.jobs.android_update.with.candidate_version).toBe('${{ inputs.version }}')
    expect(release.jobs.android_update.with.candidate_artifact).toBe(
      "${{ format('opka-android-{0}', needs.admission.outputs.release_source) }}"
    )
    expect(acceptance.on.pull_request).toBeUndefined()
    const native = readFileSync('config/scripts/opka-android-ci-acceptance.py', 'utf8')
    expect(native).toContain('opka-android-native-fixture.py')
    expect(native).toContain('--legacy-a')
    expect(native).toContain('opka-android-ui-journey.py')
    expect(steps.find((step) => step.name === 'Require KVM acceleration').run).toContain(
      'test -c /dev/kvm'
    )
  })
  it('admits immutable artifact recovery without skipping required qualification or publishing an untested APK', () => {
    const release = parse(readFileSync('.github/workflows/opka-release.yml', 'utf8'))
    const evaluate = (expression, values, cancelled = false) =>
      runInNewContext(expression.replace(/^\$\{\{(.*)\}\}$/s, '$1'), {
        ...values,
        cancelled: () => cancelled
      })
    for (const built_run of ['', '123']) {
      expect(evaluate(release.jobs.qualification.if, { inputs: { built_run } })).toBe(!built_run)
      for (const admission of ['success', 'failure', 'skipped']) {
        for (const qualification of ['success', 'failure', 'skipped']) {
          for (const android_update of ['success', 'failure', 'skipped']) {
            const context = {
              inputs: { built_run },
              needs: {
                admission: { result: admission },
                qualification: { result: qualification },
                android_update: { result: android_update }
              }
            }
            const admitted =
              admission === 'success' &&
              (qualification === 'success' || (Boolean(built_run) && qualification === 'skipped'))
            expect(evaluate(release.jobs.android_update.if, context)).toBe(admitted)
            expect(evaluate(release.jobs.publish.if, context)).toBe(
              admitted && android_update === 'success'
            )
            expect(evaluate(release.jobs.publish.if, context, true)).toBe(false)
          }
        }
      }
    }
    const admission = release.jobs.admission.steps.find((step) => step.id === 'qualification')
    expect(admission.env.OPKA_QUALIFIED_COMMIT).toBe('${{ github.sha }}')
    expect(admission.env.OPKA_BUILT_RUN).toBe('${{ inputs.built_run }}')
    expect(admission.env.OPKA_BUILT_SOURCE).toBe('${{ inputs.built_source }}')
    const publish = release.jobs.publish
    expect(publish.permissions).toEqual({ contents: 'write', actions: 'read' })
    expect(publish.env.OPKA_RELEASE_SOURCE).toBe('${{ needs.admission.outputs.release_source }}')
    expect(publish.env.GITHUB_SHA).toBeUndefined()
    const original = publish.steps.find(
      (step) => step.uses === 'actions/checkout@v6' && step.with?.path === '.release-source'
    )
    expect(original.with.ref).toBe('${{ needs.admission.outputs.release_source }}')
    const artifacts = publish.steps.filter((step) => step.uses === 'actions/download-artifact@v8')
    expect(artifacts[0].with).toMatchObject({
      name: 'opka-beta-release-${{ needs.admission.outputs.release_source }}',
      'run-id': '${{ needs.admission.outputs.artifact_run }}',
      'github-token': '${{ github.token }}'
    })
    expect(artifacts[1].with.name).toBe('opka-android-tested-${{ github.sha }}')
    const originalCheck = publish.steps.find(
      (step) => step.name === 'Recheck original build provenance without changing installer bytes'
    )
    expect(originalCheck['working-directory']).toBe('.release-source')
    expect(originalCheck.run).toContain(
      "['node', 'config/scripts/opka-release-assets.mjs', 'complete', str(directory)]"
    )
    expect(originalCheck.run).toContain("pathlib.Path(os.environ['GITHUB_WORKSPACE']) / 'dist'")
    expect(originalCheck.run).toContain('before = inventory()')
    expect(originalCheck.run).toContain('assert before == inventory()')
    const commands = publish.steps.map((step) => step.run ?? '').join('\n')
    expect(commands).toContain('--target "$OPKA_RELEASE_SOURCE"')
    expect(commands).toContain('[ "$published" = "$OPKA_RELEASE_SOURCE" ]')
    expect(commands).not.toContain('--target "$GITHUB_SHA"')
  })
  it('caches only unsigned fixtures under an exact Android input key', () => {
    const acceptance = parse(
      readFileSync('.github/workflows/opka-android-update-acceptance.yml', 'utf8')
    )
    const steps = acceptance.jobs.update_confirmation.steps
    const restore = steps.find((step) => step.name === 'Restore unsigned Android fixtures')
    const save = steps.find((step) => step.name === 'Save unsigned Android fixtures')
    expect(restore.uses).toBe('actions/cache/restore@v5')
    expect(save.uses).toBe('actions/cache/save@v5')
    expect(restore.with.path).toBe('out/android-update-fixtures/*-unsigned.apk')
    expect(save.with).toEqual(restore.with)
    expect(restore.with['restore-keys']).toBeUndefined()
    const fingerprintStep = steps.find((step) => step.id === 'fixture_key')
    expect(fingerprintStep.env).toEqual({
      FIREBASE_CLIENT_SHA256: '${{ steps.firebase.outputs.client_sha256 }}',
      ANDROID_BUILD_ENV_SHA256: '${{ steps.firebase.outputs.build_env_sha256 }}'
    })
    const fingerprint = fingerprintStep.run
    expect(fingerprint).toContain('$FIREBASE_CLIENT_SHA256')
    expect(fingerprint).toContain('$ANDROID_BUILD_ENV_SHA256')
    expect(restore.if).toBe("inputs.candidate_artifact == ''")
    expect(save.if).not.toContain('firebase')
    expect(
      steps.find((step) => step.name === 'Test native update ownership, validation and cleanup').if
    ).toBe("inputs.candidate_artifact == ''")
    expect(
      steps.find((step) => step.name === 'Validate idle baseline and traffic measurement contracts')
        .run
    ).toContain('opka_android_ci_acceptance_test.py')
    for (const input of [
      'mobile',
      'src/shared',
      'src/packages',
      'config/patches',
      'pnpm-lock.yaml',
      '.github/actions',
      '.github/workflows/opka-android-update-acceptance.yml'
    ]) {
      expect(fingerprint).toContain(input)
    }
    expect(steps.indexOf(save)).toBeLessThan(
      steps.findIndex((step) => step.name === 'Sign both versions with one identity and verify it')
    )
  })
  it.runIf(process.platform === 'linux')(
    'keeps the fixture handoff and published UI routes separate',
    () => {
      const entryArgv = (published, candidate = '1.4.236-rc.6') =>
        JSON.parse(
          execFileSync(
            'python3',
            [
              '-c',
              "import json,runpy,subprocess,sys; sys.path.insert(0,'config/scripts'); original=subprocess.run; subprocess.run=lambda args,**kwargs: original(args,**kwargs) if args[0]=='node' else print(json.dumps(args)); runpy.run_path('config/scripts/opka-android-update-acceptance-entry.py')"
            ],
            {
              encoding: 'utf8',
              env: { ...process.env, PUBLISHED_VERSION: published, CANDIDATE_VERSION: candidate }
            }
          )
        ).slice(2)
      expect(entryArgv('')).toEqual([
        '--a',
        'out/android-update-fixtures/rc5.apk',
        '--b',
        'out/android-update-fixtures/candidate.apk',
        '--expected-code',
        '104236006',
        '--handoff',
        'out/android-update-handoff/handoff.apk'
      ])
      expect(entryArgv('1.4.236-rc.6')).toEqual([
        '--a',
        'out/android-update-fixtures/rc5.apk',
        '--published-version',
        '1.4.236-rc.6',
        '--surface',
        'settings'
      ])
      expect(entryArgv('', '1.4.236-rc.8')).toContain('104236008')
    }
  )
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
    expect(command).toBe('node config/scripts/opka-ci-component-scope.mjs --verify')
    const scope = classifyCiPaths(['src/shared/pairing.ts'])
    const results = Object.fromEntries(
      workflow.jobs.verify.needs.map((name) => [name, { result: 'success' }])
    )
    expect(() => evaluateCiResults(scope, results)).not.toThrow()
    for (const name of workflow.jobs.verify.needs) {
      const { [name]: omitted, ...missing } = results
      expect(omitted.result).toBe('success')
      expect(() => evaluateCiResults(scope, missing)).toThrow()
      for (const result of ['failure', 'cancelled', 'skipped']) {
        expect(() => evaluateCiResults(scope, { ...results, [name]: { result } })).toThrow()
      }
    }
  })

  it('builds Android once per PR and keeps requested installer failures blocking', () => {
    const installer = parse(readFileSync('.github/workflows/opka-installers.yml', 'utf8'))
    expect(installer.on.workflow_call.inputs.build_android).toEqual({
      type: 'boolean',
      default: true
    })
    expect(workflow.jobs.installers.with.build_android).toBe(false)
    expect(workflow.jobs.android.if).toContain("needs.scope.outputs.android == 'true'")
    expect(workflow.jobs.verify.needs).toContain('android')
    expect(workflow.jobs.electron.steps.map((step) => step.run ?? '').join('\n')).toContain(
      'tests/e2e/fork-beta-update.spec.ts'
    )
    expect(installer.jobs.android.if).toBe('inputs.build_android')
    expect(installer.jobs.release_files.if).toBe('inputs.build_android')
    expect(installer.jobs.mac.if).toBeUndefined()
    expect(installer.jobs.server_template.if).toBeUndefined()
    const gate = installer.jobs.installer_gate
    expect(gate.name).not.toBe('PR checks passed')
    expect(gate.if).toBe('${{ !cancelled() }}')
    expect(gate.needs).toEqual(['mac', 'server_template', 'android', 'release_files'])
    const match = gate.steps[0].run.match(/node --input-type=module -e '([\s\S]+)'/)
    expect(match).not.toBeNull()
    const run = (value, android) =>
      execFileSync(process.execPath, ['--input-type=module', '-e', match[1]], {
        env: { ...process.env, RESULTS: JSON.stringify(value), BUILD_ANDROID: String(android) },
        stdio: 'pipe'
      })
    for (const android of [true, false]) {
      const results = Object.fromEntries(
        gate.needs.map((name) => [
          name,
          {
            result: !android && ['android', 'release_files'].includes(name) ? 'skipped' : 'success'
          }
        ])
      )
      expect(() => run(results, android)).not.toThrow()
      for (const name of gate.needs) {
        const { [name]: omitted, ...missing } = results
        expect(omitted).toBeDefined()
        expect(() => run(missing, android)).toThrow()
        for (const result of [
          'failure',
          'cancelled',
          results[name].result === 'success' ? 'skipped' : 'success'
        ]) {
          expect(() => run({ ...results, [name]: { result } }, android)).toThrow()
        }
      }
    }
  })
  it('uses changed-test discovery for every valid comparison including global-policy changes', () => {
    expect(workflow.jobs.scope.outputs.comparison_valid).toBe(
      '${{ steps.scope.outputs.comparison_valid }}'
    )
    const step = workflow.jobs.regression.steps.find(
      (entry) => entry.name === 'Test host accounts, mobile state and generated pages'
    )
    expect(step.env.OPKA_CI_COMPARISON_VALID).toBe('${{ needs.scope.outputs.comparison_valid }}')
    expect(step.env.OPKA_CI_FULL).toBeUndefined()
    expect(step.run).toContain('if [ "$OPKA_CI_COMPARISON_VALID" = true ]; then')
    expect(step.run).toContain(
      'pnpm run test:fork -- --changed "$OPKA_CI_DIFF_BASE" "$OPKA_CI_DIFF_HEAD"'
    )
    expect(step.run).toContain('else\n  pnpm run test:fork\nfi')
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
      'scope',
      'static',
      'regression',
      'desktop',
      'electron',
      'installers',
      'android'
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
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' })
    const text = readFileSync('.github/workflows/pr.yml', 'utf8')
    expect(text).not.toMatch(
      /secrets\.|pull_request_target|self-hosted|blacksmith|continue-on-error|gh release|electron-builder/
    )
    expect(workflow.jobs.android.uses).toBe(
      './.github/workflows/opka-android-update-acceptance.yml'
    )
    expect(workflow.jobs.android.needs).toBe('scope')
    expect(
      workflow.jobs.regression.steps.find(
        (step) => step.name === 'Test host accounts, mobile state and generated pages'
      ).run
    ).toContain('--changed')
    expect(text).toContain('if-no-files-found: error')
  })
})

it('bundles Android synthetic host with ESM-safe Node filenames', () => {
  const android = parse(
    readFileSync('.github/workflows/opka-android-update-acceptance.yml', 'utf8')
  )
  const fixtureStep = android.jobs.update_confirmation.steps.find(
    (step) => step.name === 'Build the current synthetic host and generated mobile pages'
  )
  expect(fixtureStep.run).toContain('--define:__filename=import.meta.filename')
  expect(fixtureStep.run).toContain('--define:__dirname=import.meta.dirname')
  expect(fixtureStep.run).toContain('CI=true node out/android-ui-fixture/fixture.mjs --check')
})

it('checks the real Android Metro bundle before either native build', () => {
  for (const file of ['opka-installers.yml', 'opka-android-update-acceptance.yml']) {
    const jobs = parse(readFileSync(`.github/workflows/${file}`, 'utf8')).jobs
    const steps = (jobs.android ?? jobs.update_confirmation).steps
    const preflight = steps.findIndex(
      (step) => step.name === 'Validate Android JavaScript before native compilation'
    )
    expect(preflight).toBeGreaterThan(-1)
    expect(steps[preflight].run).toContain(
      'expo export --platform android --no-bytecode --max-workers 1'
    )
    expect(preflight).toBeLessThan(steps.findIndex((step) => step.run?.includes('expo prebuild')))
  }
})
