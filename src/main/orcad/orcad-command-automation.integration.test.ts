import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY } from '../../shared/automation-runtime-capabilities'
import type {
  AutomationCommandDefinitionCreateV1,
  AutomationCommandDefinitionV1
} from '../../shared/automation-command-domain'
import type { AutomationRun } from '../../shared/automations-types'
import type { ProjectHostSetup } from '../../shared/project-types'
import { createCommandAutomationFixture } from './orcad-command-automation-fixture'

const packagePath = process.env.ORCA_COMMAND_AUTOMATION_PACKAGE
const required = process.env.ORCA_COMMAND_AUTOMATION_REQUIRED === '1'
const enabled = required || (process.platform === 'linux' && !!packagePath)

describe.skipIf(!enabled)('packaged Linux command automations', () => {
  it('runs real program/script conditions and one scheduled report, retaining ownership and reports across restart', async () => {
    if (process.platform !== 'linux' || process.arch !== 'x64') {
      throw new Error('The actual command automation artifact test requires Linux x64')
    }
    if (!packagePath || !existsSync(resolve(packagePath, 'orcad.js'))) {
      throw new Error('Build the actual orcad package before this integration test')
    }
    const fixture = createCommandAutomationFixture(packagePath)
    let scenarioError: unknown
    try {
      await fixture.start()
      await vi.waitFor(
        async () => {
          const status = await fixture.call<{ runtimeId: string; capabilities: string[] }>(
            'status.get',
            undefined
          )
          expect(status.runtimeId).toBe(fixture.runtimeId())
          expect(status.capabilities).toContain(AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY)
        },
        { timeout: 30_000, interval: 100 }
      )
      expect(await fixture.commandList()).toMatchObject({
        ok: true,
        result: { commandAutomations: [] }
      })
      const legacy = await fixture.call<Record<string, unknown>>('automation.list', {}, false)
      expect(legacy.automations).toEqual([])
      expect(legacy.commandAutomations).toBeUndefined()
      const { repo } = await fixture.call<{ repo: { id: string } }>('repo.add', {
        path: fixture.workspace,
        kind: 'folder'
      })
      const { setups } = await fixture.call<{ setups: ProjectHostSetup[] }>(
        'projectHostSetup.list',
        undefined
      )
      const setup = setups.find((entry) => entry.repoId === repo.id && entry.hostId === 'local')
      expect(setup?.setupState).toBe('ready')
      if (!setup) {
        throw new Error('The isolated folder must have an owning-host setup')
      }
      const definition = (name: string): AutomationCommandDefinitionCreateV1 => ({
        creationKey: randomUUID(),
        name,
        runContext: {
          kind: 'workspace-run',
          projectId: repo.id,
          hostId: 'local',
          projectHostSetupId: setup.id,
          repoId: repo.id,
          path: fixture.workspace
        },
        sourceContext: null,
        projectId: repo.id,
        executionTargetType: 'local',
        executionTargetId: 'local',
        schedulerOwner: 'local_host_service',
        workspaceMode: 'existing',
        workspaceId: repo.id,
        baseBranch: null,
        timezone: 'UTC',
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: Date.now() + 86_400_000,
        enabled: true,
        missedRunPolicy: 'run_once_within_grace',
        missedRunGraceMinutes: 1,
        execution: {
          version: 1,
          command: {
            kind: 'program',
            executable: '/usr/bin/prlimit',
            argv: [
              '--as=67108864',
              '--cpu=5',
              '--nproc=1024',
              '--',
              '/usr/bin/printf',
              'safe-program-output\\n'
            ]
          },
          condition: 'never_agent',
          agent: null,
          policy: {
            timeoutSeconds: 20,
            commandTimeoutSeconds: 10,
            idempotent: true,
            maxAttempts: 1
          },
          reportTarget: null
        }
      })
      const create = async (input: AutomationCommandDefinitionCreateV1) =>
        (
          await fixture.call<{ automation: AutomationCommandDefinitionV1 }>('automation.createV2', {
            version: 2,
            definition: input
          })
        ).automation
      const self = { selector: { kind: 'self' } }
      const run = (
        automation: AutomationCommandDefinitionV1,
        requestKey = randomUUID(),
        requestCreatedAt = Date.now()
      ) => {
        const expectedRevision = automation.revision
        return fixture.call<{ admission: { kind: string; run: AutomationRun } }>(
          'automation.runNowV2',
          {
            version: 2,
            id: automation.id,
            expectedRevision,
            expectedOwner: self,
            requestKey,
            requestCreatedAt,
            payloadHash: createHash('sha256')
              .update(JSON.stringify({ id: automation.id, expectedRevision }))
              .digest('hex')
          }
        )
      }
      const finished = async (
        automation: AutomationCommandDefinitionV1,
        runId?: string,
        timeout = 45_000
      ) => {
        let result: AutomationRun | undefined
        await vi.waitFor(
          async () => {
            const { runs } = await fixture.call<{ runs: AutomationRun[] }>('automation.runs', {
              automationId: automation.id,
              expectedOwner: self
            })
            result = runs.find((entry) => !runId || entry.id === runId)
            expect(result?.commandExecution?.phase).toBe('settled')
            expect(result?.commandExecution?.observation).toBe('exited')
          },
          { timeout, interval: 100 }
        )
        if (!result) {
          throw new Error('A retained command report is required')
        }
        return result
      }
      const program = await create(definition('Safe program'))
      const requestKey = randomUUID()
      const requestCreatedAt = Date.now()
      const admitted = await run(program, requestKey, requestCreatedAt)
      const programReport = await finished(program, admitted.admission.run.id)
      expect(programReport.status).toBe('completed')
      expect(programReport.outputSnapshot?.content).toContain('safe-program-output')
      expect(programReport.automationId).toBe(program.id)
      expect(programReport.commandExecution?.deliveryStatus).toBe('history_only')
      await expect(
        fixture.call('automation.runNowV2', {
          version: 2,
          id: program.id,
          expectedRevision: program.revision,
          expectedOwner: {
            selector: { kind: 'ssh', targetId: 'foreign-fixture', targetGeneration: 1 }
          },
          requestKey: randomUUID(),
          requestCreatedAt: Date.now(),
          payloadHash: createHash('sha256')
            .update(JSON.stringify({ id: program.id, expectedRevision: program.revision }))
            .digest('hex')
        })
      ).rejects.toThrow(/invalid_argument:.*expected.*self/)
      const conditionInput = definition('No-change condition')
      conditionInput.execution.command = {
        kind: 'script',
        language: 'shell',
        interpreter: '/bin/bash',
        text: 'ulimit -v 65536; ulimit -t 5; ulimit -u 1024; printf \'{"version":1,"changed":false}\\n\''
      }
      conditionInput.execution.condition = 'exit_zero_and_changed'
      const condition = await create(conditionInput)
      const conditionRun = await run(condition)
      const conditionReport = await finished(condition, conditionRun.admission.run.id)
      expect(conditionReport.status).toBe('skipped_precheck')
      expect(conditionReport.outputSnapshot?.content).toContain('changed')
      const scheduledInput = definition('One scheduled script')
      scheduledInput.execution.command = {
        kind: 'script',
        language: 'shell',
        interpreter: '/bin/bash',
        text: [
          'ulimit -v 65536; ulimit -t 5; ulimit -u 1024',
          "printf 'safe-scheduled-report\\n'",
          'printf "as_kib="; ulimit -v',
          'printf "cpu_seconds="; ulimit -t',
          'printf "nproc="; ulimit -u',
          'cg=$(cut -d: -f3 /proc/self/cgroup)',
          'for limit in memory.max cpu.max pids.max; do',
          'printf "%s=" "$limit"',
          'if [ -r "/sys/fs/cgroup$cg/$limit" ]; then',
          'cat "/sys/fs/cgroup$cg/$limit"',
          'else printf "unavailable\\n"; fi',
          'done'
        ].join('\n')
      }
      const scheduledFor = Math.ceil((Date.now() + 3000) / 60_000) * 60_000
      const scheduledDate = new Date(scheduledFor)
      scheduledInput.rrule = `${scheduledDate.getUTCMinutes()} ${scheduledDate.getUTCHours()} ${scheduledDate.getUTCDate()} ${scheduledDate.getUTCMonth() + 1} *`
      scheduledInput.dtstart = scheduledFor
      scheduledInput.missedRunGraceMinutes = 2
      const scheduled = await create(scheduledInput)
      expect(scheduled.nextRunAt).toBe(scheduledFor)
      const scheduledReport = await finished(scheduled, undefined, 135_000)
      expect(scheduledReport.trigger).toBe('scheduled')
      console.log(
        JSON.stringify({
          scheduledStatus: scheduledReport.status,
          finalReason: scheduledReport.commandExecution?.finalReason,
          boundedOutput: scheduledReport.outputSnapshot?.content.slice(0, 2048)
        })
      )
      expect(scheduledReport.status).toBe('completed')
      expect(scheduledReport.outputSnapshot?.content).toContain('safe-scheduled-report')
      expect(scheduledReport.outputSnapshot?.content).toContain('as_kib=65536')
      expect(scheduledReport.outputSnapshot?.content).toContain('cpu_seconds=5')
      expect(scheduledReport.outputSnapshot?.content).toContain('nproc=1024')
      const paused = await fixture.call<{ automation: AutomationCommandDefinitionV1 }>(
        'automation.updateV2',
        {
          version: 2,
          id: scheduled.id,
          expectedRevision: scheduled.revision,
          expectedOwner: self,
          updates: { enabled: false }
        }
      )
      expect(paused.automation.enabled).toBe(false)
      const wrongReport = definition('Reject foreign report chat')
      wrongReport.execution.reportTarget = {
        runtimeId: 'foreign-fixture',
        hostId: 'local',
        workspaceId: repo.id,
        chatSessionId: 'missing-fixture-chat',
        registrationGeneration: 1
      }
      await expect(create(wrongReport)).rejects.toThrow('report chat')
      const priorRuntimeId = fixture.runtimeId()
      await fixture.stop()
      await fixture.start()
      expect(fixture.runtimeId()).not.toBe(priorRuntimeId)
      expect(await finished(program, programReport.id)).toEqual(programReport)
      expect(await finished(condition, conditionReport.id)).toEqual(conditionReport)
      expect(await finished(scheduled, scheduledReport.id)).toEqual(scheduledReport)
      const replay = await run(program, requestKey, requestCreatedAt)
      expect(replay.admission.kind).toBe('replayed')
      expect(replay.admission.run.id).toBe(programReport.id)
      const history = await fixture.call<{ runs: AutomationRun[] }>('automation.runs', {
        limit: 100
      })
      expect(history.runs).toHaveLength(3)
      expect(new Set(history.runs.map((entry) => entry.id)).size).toBe(3)
      console.log(
        JSON.stringify({
          program: programReport.status,
          condition: conditionReport.status,
          scheduled: scheduledReport.status,
          reportDelivery: programReport.commandExecution?.deliveryStatus,
          scopeLimits: scheduledReport.outputSnapshot?.content,
          retainedReports: history.runs.length,
          replayAfterRestart: replay.admission.kind
        })
      )
    } catch (error) {
      scenarioError = error
    }
    let cleanupError: unknown
    try {
      await fixture.dispose()
    } catch (error) {
      cleanupError = error
    }
    if (scenarioError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [scenarioError, cleanupError],
        'Scenario failed; isolated cleanup receipt retained'
      )
    }
    if (scenarioError !== undefined) {
      throw scenarioError
    }
    if (cleanupError !== undefined) {
      throw cleanupError
    }
  }, 240_000)
})
