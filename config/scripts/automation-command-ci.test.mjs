import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { classifyNodeServerChanges } from './node-server-change-scope.mjs'
import { nodeServerTestPaths } from './node-server-test-paths.mjs'

it('runs the mandatory actual package check on the existing Linux x64 artifact runner', async () => {
  const workflow = parse(readFileSync('.github/workflows/opka-server-template.yml', 'utf8'))
  const steps = workflow.jobs.persistence.steps
  const check = steps.find(
    (step) => step.name === 'Verify actual Linux command automations and retained reports'
  )
  expect(check.if).toBe("runner.os == 'Linux' && runner.arch == 'X64'")
  expect(check.env).toEqual({
    ORCA_COMMAND_AUTOMATION_PACKAGE: '${{ github.workspace }}/out/orcad',
    ORCA_COMMAND_AUTOMATION_REQUIRED: '1'
  })
  expect(check['timeout-minutes']).toBe(5)
  expect(check['continue-on-error']).toBeUndefined()
  expect(check.run).toContain('timeout 30s sudo loginctl enable-linger "$(id -un)"')
  expect(check.run).toContain('timeout 30s sudo systemctl start "user@${runner_uid}.service"')
  expect(check.run).toContain('timeout 10s busctl --user --no-pager list >/dev/null')
  expect(check.run).toContain(
    'pnpm test:node-server --artifact src/main/orcad/orcad-command-automation.integration.test.ts --maxWorkers=1'
  )
  expect(check.run).not.toContain('sudo pnpm')
  expect(nodeServerTestPaths({ systemd: true })).toContain(
    'src/main/orcad/orcad-command-automation.integration.test.ts'
  )
  expect(nodeServerTestPaths({ artifact: true })).not.toContain(
    'src/main/orcad/orcad-command-automation.integration.test.ts'
  )
  expect(steps.indexOf(check)).toBeGreaterThan(
    steps.findIndex((step) => step.run === 'pnpm build:orcad')
  )
  expect(
    (
      await classifyNodeServerChanges(
        ['src/main/orcad/orcad-command-automation.integration.test.ts'],
        async () => new Set()
      )
    ).shouldRun
  ).toBe(true)
})
