import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { PROJECT_TASK_METHODS } from '../../src/main/runtime/rpc/methods/project-tasks'
import { PROJECT_TASK_WORKFLOW_METHODS } from '../../src/main/runtime/rpc/methods/project-task-workflow'
import { ORCHESTRATION_WORKER_START_METHODS } from '../../src/main/runtime/rpc/methods/orchestration/worker/workers'
import { closeProjectTaskWorkspaces } from '../../src/main/runtime/project-task-workspaces'
import { OrchestrationDb } from '../../src/main/runtime/orchestration/db'
import { projectTaskTemplate } from '../../src/shared/project-task-template'
import { PROJECT_TASK_HANDLERS } from '../../src/cli/handlers/project-task'

vi.mock('../../src/main/runtime/file-watcher-host', () => ({
  watchFileExplorerInWatcherProcess: vi.fn(async () => async () => undefined)
}))
const cleanups = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanups.splice(0).map((clean) => clean()))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-task-workflow-rpc-')))
  const db = new OrchestrationDb(join(root, 'runtime.db'))
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    listVisibleFolderWorkspaces: () => [],
    listVisibleProjectGroups: () => [],
    listVisibleRepos: () => [],
    getOrchestrationDb: () => db,
    getTerminalPaneKey: () => 'test-pane',
    resolveRuntimeFileTarget: vi.fn(async () => ({
      worktree: { id: 'folder-1', path: root, repoId: 'repo-1' },
      executionHostId: 'local'
    })),
    listRepos: () => [{ id: 'repo-1', path: root }]
  }
  cleanups.push(async () => {
    await closeProjectTaskWorkspaces(runtime)
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [...PROJECT_TASK_METHODS, ...PROJECT_TASK_WORKFLOW_METHODS]
  })
  const invoke = (method, params, desktop = false) =>
    dispatcher.dispatch(
      {
        id: 'fixture',
        authToken: 'test',
        method: `projectTask.${method}`,
        params: { worktree: 'folder:folder-1', ...params }
      },
      desktop ? { caller: { kind: 'desktop' } } : undefined
    )
  await invoke('init', { expectedExecutionHostId: 'local' })
  const content = projectTaskTemplate({
    id: 'task-11111111-1111-4111-8111-111111111111',
    title: 'Synthetic workflow'
  })
  const created = await invoke('create', {
    expectedExecutionHostId: 'local',
    source: 'project',
    slug: 'one',
    content
  })
  expect(created.ok).toBe(true)
  return { root, db, runtime, dispatcher, invoke, task: created.result }
}
describe('project workflow RPC admission and native launch bridge', () => {
  it('revokes deleted-plan approval so recreating the same Markdown cannot silently authorize another start', async () => {
    const { invoke, task } = await fixture()
    const action = { id: task.id, revision: task.revision, expectedExecutionHostId: 'local' }
    await invoke('approve', action, true)
    expect(await invoke('delete', action, true)).toMatchObject({
      ok: true,
      result: { deleted: true }
    })
    const restored = await invoke('create', {
      expectedExecutionHostId: 'local',
      source: 'project',
      slug: 'one',
      content: task.content
    })
    expect(restored.ok).toBe(true)
    expect(await invoke('workflow', { id: task.id })).toMatchObject({
      ok: true,
      result: { archived: true, approvedRevision: null }
    })
  })
  it('reconciles the list/subscription gap and tears down the watch when its client leaves', async () => {
    const { dispatcher } = await fixture()
    const abort = new AbortController(),
      frames = []
    const subscription = dispatcher.dispatchStreaming(
      {
        id: 'watch',
        authToken: 'test',
        method: 'projectTask.watch',
        params: { worktree: 'folder:folder-1' }
      },
      (frame) => frames.push(JSON.parse(frame)),
      { signal: abort.signal }
    )
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.ok && frame.result?.type === 'changed')).toBe(true)
    )
    abort.abort()
    await subscription
    expect(frames.some((frame) => frame.ok && frame.result?.type === 'ready')).toBe(true)
  })
  it('only the transport-stamped operator may approve, and resume distinguishes durable facts', async () => {
    const { invoke, task } = await fixture()
    const action = { id: task.id, revision: task.revision, expectedExecutionHostId: 'local' }
    expect(await invoke('approve', { ...action, caller: { kind: 'desktop' } })).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/confirmation/) }
    })
    expect(await invoke('approve', action, true)).toMatchObject({
      ok: true,
      result: { phase: 'ready' }
    })
    const resumed = await invoke('resume', { id: task.id })
    expect(resumed).toMatchObject({
      ok: true,
      result: { workflow: { approvedRevision: task.revision } }
    })
    expect(resumed.result.text).toContain('NOT a liveness check')
    expect(resumed.result.text.length).toBeLessThanOrEqual(8000)
    const call = vi.fn(async (method, params) => {
      const reply = await invoke(method.slice('projectTask.'.length), params)
      if (!reply.ok) {
        throw new Error(reply.error.message)
      }
      return reply
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await PROJECT_TASK_HANDLERS['project-task resume']({
      client: { call, isRemote: false },
      cwd: '/synthetic',
      flags: new Map([
        ['worktree', 'folder:folder-1'],
        ['id', task.id]
      ]),
      json: false
    })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Current plan approved: true'))
  })
  it('binds before the native handler and rejects a concurrent claim without a second launch', async () => {
    const { db, invoke, task } = await fixture()
    db.createRun({
      objective: 'Bridge fixture only',
      coordinatorHandle: 'coordinator',
      coordinatorPaneKey: 'test-pane'
    })
    const action = { id: task.id, revision: task.revision, expectedExecutionHostId: 'local' }
    await invoke('approve', action, true)
    let release
    const ready = new Promise((resolve) => {
      release = resolve
    })
    const start = vi
      .spyOn(ORCHESTRATION_WORKER_START_METHODS[0], 'handler')
      .mockImplementation(async (params) => {
        expect(
          db.db
            .prepare('SELECT native_task_id FROM project_task_attempts WHERE native_task_id=?')
            .get(params.task)
        ).toBeTruthy()
        await ready
        return { fixtureOnly: true }
      })
    const first = invoke('start', {
      ...action,
      launch: { from: 'coordinator', worktree: 'new-child', repo: 'repo-1', spec: 'placeholder' }
    })
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    expect(
      await invoke('start', {
        ...action,
        launch: { from: 'coordinator', worktree: 'new-child', repo: 'repo-1', spec: 'placeholder' }
      })
    ).toMatchObject({ ok: false, error: { message: expect.stringMatching(/active/) } })
    expect(await invoke('delete', action, true)).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/active/) }
    })
    release()
    expect(await first).toMatchObject({ ok: true })
    expect(start).toHaveBeenCalledTimes(1)
  })
  it('fences wrong host and changed plan before any native launch', async () => {
    const { invoke, task } = await fixture()
    expect(
      await invoke(
        'approve',
        { id: task.id, revision: task.revision, expectedExecutionHostId: 'remote' },
        true
      )
    ).toMatchObject({ ok: false, error: { message: expect.stringMatching(/host changed/) } })
    expect(
      await invoke(
        'approve',
        { id: task.id, revision: 'a'.repeat(64), expectedExecutionHostId: 'local' },
        true
      )
    ).toMatchObject({ ok: false, error: { message: expect.stringMatching(/revision conflict/) } })
    expect(
      await invoke('start', {
        id: task.id,
        revision: task.revision,
        expectedExecutionHostId: 'local',
        launch: { from: 'missing', worktree: 'new-child', spec: 'placeholder' }
      })
    ).toMatchObject({ ok: false, error: { message: expect.stringMatching(/coordinator/) } })
  })
})
