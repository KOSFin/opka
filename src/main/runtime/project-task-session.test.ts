import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TaskWorkspace } from '../project-tasks/task-workspace'
import { projectTaskTemplate } from '../../shared/project-task-template'
import { projectTaskWorkflow } from '../project-tasks/task-workflow-view'
import { TaskWorkflowStore } from '../project-tasks/task-workflow-store'
import { taskDocuments } from '../project-tasks/task-documents'
import { RpcDispatcher } from './rpc/dispatcher'
import { PROJECT_TASK_SESSION_METHODS } from './rpc/methods/project-task-session'
import {
  createSessionCallerHarness,
  orchestrationRequest,
  SESSION_X,
  SESSION_Y,
  type SessionCallerHarness
} from './rpc/orchestration-session-caller-test-fixture'
import { closeProjectTaskWorkspaces } from './project-task-workspaces'
import { closeProjectTaskActivity, exportProjectTaskActivity } from '../project-tasks/task-activity'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
vi.mock('../project-tasks/task-project-roots', () => ({
  resolveRegisteredTaskRoot: async (_runtime: unknown, path: string) => path
}))
vi.mock('./file-watcher-host', () => ({
  watchFileExplorerInWatcherProcess: async () => async () => {}
}))

let root: string
let h: SessionCallerHarness
let workspace: TaskWorkspace
let dispatcher: RpcDispatcher
let projectId: string
let task: Awaited<ReturnType<TaskWorkspace['show']>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opka-session-task-'))
  h = createSessionCallerHarness(hostRef)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this local file-target fixture never accesses terminal or repository metadata.
  const target = { executionHostId: 'local', worktree: { path: root } } as Awaited<
    ReturnType<typeof h.runtime.resolveRuntimeFileTarget>
  >
  vi.spyOn(h.runtime, 'resolveRuntimeFileTarget').mockResolvedValue(target)
  workspace = new TaskWorkspace(root)
  projectId = (await workspace.initialize()).id
  task = await workspace.create(
    'project',
    'example',
    projectTaskTemplate({
      id: 'task-11111111-1111-4111-8111-111111111111',
      title: 'Synthetic task'
    })
  )
  const store = new TaskWorkflowStore(h.db)
  store.register(projectId, root, task)
  store.approve(projectId, task)
  dispatcher = new RpcDispatcher({ runtime: h.runtime, methods: PROJECT_TASK_SESSION_METHODS })
})
afterEach(async () => {
  await workspace.close()
  await closeProjectTaskWorkspaces(h.runtime)
  closeProjectTaskActivity(h.db.db)
  await exportProjectTaskActivity(h.db.db)
  h.close()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

const base = () => ({
  worktree: `path:${root}`,
  id: task.id,
  revision: task.revision,
  expectedExecutionHostId: 'local'
})
async function claim(sessionId = SESSION_X) {
  const response = await dispatcher.dispatch(
    orchestrationRequest('projectTask.claim', base(), { sessionId })
  )
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const result: unknown = response.result
  if (
    !result ||
    typeof result !== 'object' ||
    !('attempt' in result) ||
    !result.attempt ||
    typeof result.attempt !== 'object' ||
    !('id' in result.attempt) ||
    typeof result.attempt.id !== 'string'
  ) {
    throw new Error('No attempt')
  }
  return result.attempt.id
}

it('takes a task in an existing chat and saves a visible result for operator review', async () => {
  const id = await claim()
  expect(await claim()).toBe(id)
  await expect(claim(SESSION_Y)).rejects.toThrow(/another chat/)
  const response = await dispatcher.dispatch(
    orchestrationRequest(
      'projectTask.complete',
      {
        ...base(),
        attempt: id,
        checkpoint: 'Next: human review.',
        report: '# Result\nSynthetic checks passed; no external writes.'
      },
      { sessionId: SESSION_X }
    )
  )
  expect(response.ok).toBe(true)
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const store = new TaskWorkflowStore(h.db)
  const state = projectTaskWorkflow(store, projectId, task)
  expect(state.phase).toBe('review')
  expect(state.attempts[0].session?.reportPath).toContain(`${id}.md`)
  const documents = await taskDocuments(root, task.path)
  expect(documents.paths).toContain(`docs/work/tasks/example/reports/${id}.md`)
  expect(await readFile(join(root, `docs/work/tasks/example/reports/${id}.md`), 'utf8')).toContain(
    'Synthetic checks passed'
  )
  expect(await workspace.context(task.id)).toMatchObject({
    checkpoint: { freshness: 'unverified' }
  })
  store.decide(projectId, task, 'accept', 'Synthetic operator reviewed the exact result')
  expect(store.item(projectId, task.id).phase).toBe('done')
})

it('rejects a paired caller and a wrong owner without creating documents', async () => {
  const replies: string[] = []
  await dispatcher.dispatchStreaming(
    orchestrationRequest('projectTask.claim', base(), { sessionId: SESSION_X }),
    (reply) => replies.push(reply),
    { pairedDeviceId: 'another-host' }
  )
  expect(JSON.parse(replies[0])).toMatchObject({
    ok: false,
    error: { code: 'session_caller_host_boundary' }
  })
  const id = await claim()
  const response = await dispatcher.dispatch(
    orchestrationRequest(
      'projectTask.progress',
      {
        ...base(),
        attempt: id,
        checkpoint: 'Wrong owner'
      },
      { sessionId: SESSION_Y }
    )
  )
  expect(response.ok).toBe(false)
  expect((await taskDocuments(root, task.path)).paths).toEqual([])
})

it('keeps a saved blocker visible and clears it only on a successful result, with idempotent completion', async () => {
  const id = await claim()
  const params = {
    ...base(),
    attempt: id,
    checkpoint: 'Waiting for the API contract',
    blocker: 'API unavailable'
  }
  const progress = await dispatcher.dispatch(
    orchestrationRequest('projectTask.progress', params, { sessionId: SESSION_X })
  )
  expect(progress.ok).toBe(true)
  const store = new TaskWorkflowStore(h.db)
  expect(projectTaskWorkflow(store, projectId, task).attempts[0].session?.blocker).toBe(
    'API unavailable'
  )
  const complete = () =>
    dispatcher.dispatch(
      orchestrationRequest(
        'projectTask.complete',
        {
          ...base(),
          attempt: id,
          checkpoint: 'Next: review',
          report: 'API contract verified'
        },
        { sessionId: SESSION_X }
      )
    )
  expect((await complete()).ok).toBe(true)
  const count = () => h.db.db.prepare('SELECT COUNT(*) AS n FROM project_task_events').get()?.n
  const before = count()
  expect((await complete()).ok).toBe(true)
  expect(count()).toBe(before)
  expect(projectTaskWorkflow(store, projectId, task).attempts[0].session?.blocker).toBeNull()
  const changedResult = await dispatcher.dispatch(
    orchestrationRequest(
      'projectTask.complete',
      {
        ...base(),
        attempt: id,
        checkpoint: 'Next: review',
        report: 'Overwritten result'
      },
      { sessionId: SESSION_X }
    )
  )
  expect(changedResult.ok).toBe(false)
  expect(await readFile(join(root, `docs/work/tasks/example/reports/${id}.md`), 'utf8')).toContain(
    'API contract verified'
  )
})

it('rejects an unapproved claim before creating a coordinator Run and rejects a stale plan before writing', async () => {
  h.db.db.prepare('UPDATE project_task_items SET approved_revision=NULL').run()
  const runs = () => h.db.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n
  const before = runs()
  await expect(claim()).rejects.toThrow(/Approve/)
  expect(runs()).toBe(before)
  new TaskWorkflowStore(h.db).approve(projectId, task)
  const id = await claim()
  await writeFile(join(root, task.path), `${task.content}\nChanged plan\n`)
  const response = await dispatcher.dispatch(
    orchestrationRequest(
      'projectTask.progress',
      {
        ...base(),
        attempt: id,
        checkpoint: 'Must not overwrite'
      },
      { sessionId: SESSION_X }
    )
  )
  expect(response.ok).toBe(false)
  expect((await taskDocuments(root, task.path)).paths).toEqual([])
})

it('never enters review if the canonical report cannot be saved safely', async () => {
  const id = await claim()
  await symlink(root, join(root, 'docs/work/tasks/example/reports'))
  const response = await dispatcher.dispatch(
    orchestrationRequest(
      'projectTask.complete',
      {
        ...base(),
        attempt: id,
        checkpoint: 'Next: review',
        report: 'Unsaved result'
      },
      { sessionId: SESSION_X }
    )
  )
  expect(response.ok).toBe(false)
  expect(new TaskWorkflowStore(h.db).item(projectId, task.id).phase).toBe('active')
  expect(
    projectTaskWorkflow(new TaskWorkflowStore(h.db), projectId, task).attempts[0].session?.blocker
  ).toContain('could not be saved')
  await expect(readFile(join(root, `${id}.md`))).rejects.toThrow()
})

it('serializes competing chats and refuses missing identity or a changed execution host', async () => {
  const unauthenticated = await dispatcher.dispatch({
    id: 'no-identity',
    authToken: 'fixture',
    method: 'projectTask.claim',
    params: base()
  })
  expect(unauthenticated.ok).toBe(false)
  const wrongHost = await dispatcher.dispatch(
    orchestrationRequest(
      'projectTask.claim',
      { ...base(), expectedExecutionHostId: 'ssh:other' },
      { sessionId: SESSION_X }
    )
  )
  expect(wrongHost.ok).toBe(false)
  const results = await Promise.allSettled([claim(SESSION_X), claim(SESSION_Y)])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  expect(h.db.db.prepare('SELECT COUNT(*) AS n FROM project_task_attempts').get()?.n).toBe(1)
})

it('hands off only after the owner explicitly saves and releases, without stopping the chat', async () => {
  const id = await claim()
  const release = (sessionId: string) =>
    dispatcher.dispatch(
      orchestrationRequest(
        'projectTask.progress',
        {
          ...base(),
          attempt: id,
          checkpoint: 'Handoff: API contract saved; next run integration checks.',
          release: true
        },
        { sessionId }
      )
    )
  expect((await release(SESSION_Y)).ok).toBe(false)
  expect((await release(SESSION_X)).ok).toBe(true)
  expect(new TaskWorkflowStore(h.db).item(projectId, task.id).phase).toBe('ready')
  const second = await claim(SESSION_Y)
  expect(second).not.toBe(id)
  const before = await readFile(join(root, 'docs/work/tasks/example/checkpoint.md'), 'utf8')
  expect((await release(SESSION_X)).ok).toBe(true)
  expect(await readFile(join(root, 'docs/work/tasks/example/checkpoint.md'), 'utf8')).toBe(before)
  expect(new TaskWorkflowStore(h.db).item(projectId, task.id).phase).toBe('active')
  expect(h.records.has(SESSION_X)).toBe(true)
  const oldProgress = await dispatcher.dispatch(
    orchestrationRequest(
      'projectTask.progress',
      {
        ...base(),
        attempt: id,
        checkpoint: 'Old owner must no longer write'
      },
      { sessionId: SESSION_X }
    )
  )
  expect(oldProgress.ok).toBe(false)
})
