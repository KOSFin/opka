import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../../shared/constants'
import type { AutomationRun } from '../../shared/automations-types'
import { MAX_AUTOMATION_RUNS_PER_AUTOMATION } from '../../shared/automation-run-retention'
import { readAutomationCommandsV1Domain } from '../../shared/automation-command-domain'
import {
  closeTestStores,
  createStore,
  readPersistedStateJson,
  testState,
  writeDataFile
} from '../persistence-test-harness'
import { openProfileStateDatabaseReadOnly } from '../persistence/profile-state/profile-state-database'
import { AutomationCommandService } from './automation-command-service'
import { createAutomationRunWriter } from './automation-run-writer'

const START = Date.UTC(2032, 0, 1, 9)
const END = Date.UTC(2033, 0, 1, 9)
const DAY = 24 * 60 * 60 * 1000
const OUTPUT_LIMIT = 16 * 1024
const DISK_LIMIT = 16 * 1024 * 1024

afterEach(async () => {
  await closeTestStores()
  vi.restoreAllMocks()
  if (testState.dir) {
    rmSync(testState.dir, { recursive: true, force: true })
    testState.dir = ''
  }
})

function diskBytes(directory: string): number {
  return readdirSync(directory).reduce((bytes, name) => {
    const file = join(directory, name)
    const stats = statSync(file)
    return bytes + (stats.isDirectory() ? diskBytes(file) : stats.size)
  }, 0)
}

function seedFolder() {
  const state = getDefaultPersistedState(testState.dir)
  state.projectGroups = [
    {
      id: 'calendar-group',
      name: 'Calendar fixture',
      parentPath: testState.dir,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: START - 1,
      updatedAt: START - 1
    }
  ]
  state.folderWorkspaces = [
    {
      id: 'calendar-folder',
      projectGroupId: 'calendar-group',
      name: 'Calendar fixture',
      folderPath: testState.dir,
      executionHostId: 'local',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: START - 1,
      createdAt: START - 1,
      updatedAt: START - 1
    }
  ]
  writeDataFile(state)
}

describe('bounded no-LLM command calendar and SQLite history', () => {
  it('persists one leap year of daily success/skip/failure and bounded history across reopen', async () => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-command-calendar-year-'))
    let now = START - 1
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    seedFolder()
    const store = createStore()
    expect(store.getFolderWorkspaces()).toContainEqual(
      expect.objectContaining({ id: 'calendar-folder', folderPath: testState.dir })
    )
    const hostGeneration = store.advanceCommandHostEpoch()
    const definition = store.createCommandAutomation(
      {
        name: 'Calendar year fixture',
        projectId: 'calendar-folder',
        runContext: {
          kind: 'workspace-run',
          projectId: 'calendar-folder',
          hostId: 'local',
          projectHostSetupId: 'calendar-setup',
          repoId: 'calendar-folder',
          path: testState.dir
        },
        sourceContext: null,
        executionTargetType: 'local',
        executionTargetId: 'local',
        schedulerOwner: 'local_host_service',
        workspaceMode: 'existing',
        workspaceId: null,
        baseBranch: null,
        timezone: 'UTC',
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: START,
        enabled: true,
        missedRunPolicy: 'run_once_within_grace',
        missedRunGraceMinutes: 60,
        execution: {
          version: 1,
          command: { kind: 'program', executable: 'fixture-no-child', argv: [] },
          condition: 'exit_zero_and_changed',
          agent: null,
          reportTarget: null,
          policy: {
            timeoutSeconds: 60,
            commandTimeoutSeconds: 60,
            idempotent: false,
            maxAttempts: 1
          }
        }
      },
      now
    )
    await store.flushPendingOrThrowAsync()
    expect(definition.nextRunAt).toBe(START)
    const writer = createAutomationRunWriter(store, null)
    let settlement = Promise.withResolvers<AutomationRun>()
    const counts = { completed: 0, skipped_precheck: 0, dispatch_failed: 0 }
    const executed = new Set<number>()
    const retainedByMonth: number[] = []
    let maximumRows = 0
    let peakDiskBytes = 0
    const provider = vi.fn(async () => ({ verdict: 'unverifiable' as const }))
    const delivery = vi.fn(async () => true)
    const service = new AutomationCommandService({
      store,
      hostGeneration,
      isActive: () => true,
      runInLane: async (_id, operation) => operation(),
      runs: {
        ...writer,
        settleCommandRun: async (fence, result) => {
          const run = await writer.settleCommandRun(fence, result)
          settlement.resolve(run)
          return run
        }
      },
      adapter: {
        isHostReady: () => true,
        supportsDefinition: async () => true,
        cancelRun: async () => 'unverifiable',
        now: () => now,
        runOneShotAgent: provider,
        deliverReport: delivery,
        executeCommand: async (_definition, claim) => {
          expect(executed.has(now)).toBe(false)
          executed.add(now)
          const day = (now - START) / DAY
          const changed = day % 3 === 0
          const json = JSON.stringify({ version: 1, changed })
          const stdout = new Date(now).getUTCDate() === 1 ? json.padEnd(OUTPUT_LIMIT, ' ') : json
          const fence = {
            automationId: claim.automationId,
            runId: claim.runId,
            acquisitionId: claim.acquisitionId,
            hostGeneration,
            expectedPhase: 'command' as const
          }
          // Exercise durable receipts without launching a real child or cgroup.
          await writer.bindCommandProcessIntent(fence, {
            childCgroupPath: `/sys/fs/cgroup/${claim.processIntent?.unitName}/command`,
            blockedChildPid: 42,
            blockedChildStartTime: '500'
          })
          const observation = {
            exitCode: day % 3 === 2 ? 7 : 0,
            timedOut: false,
            error: null,
            stdout,
            stdoutTruncated: false
          }
          await writer.recordCommandExitProof(fence, observation, now)
          return { verdict: 'exited', observation }
        }
      }
    })
    const realStart = performance.now()
    for (let day = 0; day < 366; day++) {
      now = START + day * DAY
      settlement = Promise.withResolvers<AutomationRun>()
      await service.evaluateDue(now)
      const run = await settlement.promise
      const expected =
        day % 3 === 0 ? 'completed' : day % 3 === 1 ? 'skipped_precheck' : 'dispatch_failed'
      expect(run.status).toBe(expected)
      expect(run.runNumber).toBe(day + 1)
      expect(run.scheduledFor).toBe(now)
      expect(run.commandExecution).toMatchObject({
        phase: 'settled',
        attempt: 1,
        deliveryStatus: 'history_only'
      })
      expect(Buffer.byteLength(run.outputSnapshot?.content ?? '')).toBeLessThanOrEqual(OUTPUT_LIMIT)
      if (new Date(now).getUTCDate() === 1) {
        expect(run.outputSnapshot?.truncated).toBe(true)
      }
      counts[expected]++
      await service.evaluateDue(now)
      expect(executed.size).toBe(day + 1)
      expect(store.listCommandAutomationClaims()).toHaveLength(0)
      const rows = store.listAutomationRuns(definition.id).length
      maximumRows = Math.max(maximumRows, rows)
      expect(rows).toBeLessThanOrEqual(MAX_AUTOMATION_RUNS_PER_AUTOMATION + 1)
      if (day === 365 || new Date(now + DAY).getUTCMonth() !== new Date(now).getUTCMonth()) {
        retainedByMonth.push(rows)
        peakDiskBytes = Math.max(peakDiskBytes, diskBytes(testState.dir))
        expect(peakDiskBytes).toBeLessThan(DISK_LIMIT)
      }
    }
    expect(counts).toEqual({ completed: 122, skipped_precheck: 122, dispatch_failed: 122 })
    expect(executed.size).toBe(366)
    expect(executed.has(Date.UTC(2032, 1, 29, 9))).toBe(true)
    expect(retainedByMonth).toHaveLength(12)
    expect(store.listCommandAutomations()[0].nextRunAt).toBe(END)
    expect(provider).not.toHaveBeenCalled()
    expect(delivery).not.toHaveBeenCalled()
    await closeTestStores()
    const restarted = createStore()
    await restarted.flushPendingOrThrowAsync()
    const retained = restarted.listAutomationRuns(definition.id)
    expect(retained).toHaveLength(MAX_AUTOMATION_RUNS_PER_AUTOMATION)
    expect(retained.map((run) => run.runNumber).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 267)
    )
    expect(new Set(retained.map((run) => run.status))).toEqual(
      new Set(['completed', 'skipped_precheck', 'dispatch_failed'])
    )
    expect(restarted.listCommandAutomations()[0]).toMatchObject({
      nextRunAt: END,
      lastAdmittedOccurrenceAt: END - DAY
    })
    await closeTestStores()
    const opened = openProfileStateDatabaseReadOnly(
      join(testState.dir, 'profile-state.db'),
      'persistence-test'
    )
    let sqliteRows: unknown
    try {
      sqliteRows = opened.db
        .prepare('SELECT COUNT(*) AS rows FROM profile_state_automation_runs')
        .get()
      expect(sqliteRows).toEqual({ rows: 100 })
      expect(opened.db.pragma('quick_check', { simple: true })).toBe('ok')
    } finally {
      opened.db.close()
    }
    const domain = readAutomationCommandsV1Domain(
      JSON.parse(readPersistedStateJson(join(testState.dir, 'orca-data.json'))).automationCommandsV1
    )
    expect(domain.activeClaims).toHaveLength(0)
    expect(domain.manualReceipts).toHaveLength(0)
    const finalDiskBytes = diskBytes(testState.dir)
    expect(finalDiskBytes).toBeLessThan(DISK_LIMIT)
    const receipt = {
      simulatedFrom: new Date(START).toISOString(),
      simulatedUntil: new Date(END).toISOString(),
      days: 366,
      fakeCommandExecutions: executed.size,
      providerAcquisitions: provider.mock.calls.length,
      reportDeliveries: delivery.mock.calls.length,
      counts,
      retainedByMonth,
      maximumRows,
      finalRows: retained.length,
      sqliteRows,
      peakDiskBytes,
      finalDiskBytes,
      realElapsedMs: performance.now() - realStart
    }
    console.log(JSON.stringify(receipt))
    if (process.env.ORCA_CALENDAR_YEAR_RECEIPT) {
      writeFileSync(process.env.ORCA_CALENDAR_YEAR_RECEIPT, JSON.stringify(receipt, null, 2))
    }
  }, 180_000)
})
