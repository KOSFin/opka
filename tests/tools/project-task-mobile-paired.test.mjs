import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { PROJECT_TASK_METHODS } from '../../src/main/runtime/rpc/methods/project-tasks'
import { PROJECT_TASK_WORKFLOW_METHODS } from '../../src/main/runtime/rpc/methods/project-task-workflow'
import { closeProjectTaskWorkspaces } from '../../src/main/runtime/project-task-workspaces'
import { OrchestrationDb } from '../../src/main/runtime/orchestration/db'
import { OrcaRuntimeRpcServer } from '../../src/main/runtime/runtime-rpc'
import { projectTaskTemplate } from '../../src/shared/project-task-template'
import { decodePairingOffer, encodePairingOffer } from '../../src/shared/pairing'
import { pairMobileClient } from '../e2e/helpers/paired-mobile-client'
import {
  authenticate,
  createReader,
  send
} from '../../src/main/runtime/paired-client-navigation-test-harness'

vi.mock('../../src/main/runtime/file-watcher-host', () => ({
  watchFileExplorerInWatcherProcess: vi.fn(async () => async () => undefined)
}))
const cleanups = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

it('uses real encrypted mobile transport for task writes and preserves owner/revision/operator fences', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opka-phone-tasks-')))
  const db = new OrchestrationDb(join(root, 'runtime.db'))
  const worktree = 'folder:synthetic'
  const runtime = {
    getRuntimeId: () => 'synthetic-phone-runtime',
    getStartedAt: () => 1,
    readMachineName: () => 'Synthetic host',
    configureNotificationDismissalStore: () => {},
    cleanupSubscriptionsForConnection: () => {},
    cancelMobileDictationForConnection: () => {},
    onClientDisconnected: () => {},
    forgetClientNavigationState: () => {},
    listVisibleFolderWorkspaces: () => [],
    listVisibleProjectGroups: () => [],
    listVisibleRepos: () => [],
    getOrchestrationDb: () => db,
    resolveRuntimeFileTarget: async () => ({
      worktree: { id: 'synthetic', path: root, repoId: 'repo-1' },
      executionHostId: 'local'
    }),
    listRepos: () => [{ id: 'repo-1', path: root }]
  }
  cleanups.push(async () => {
    await closeProjectTaskWorkspaces(runtime)
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const methods = [...PROJECT_TASK_METHODS, ...PROJECT_TASK_WORKFLOW_METHODS]
  const owner = new RpcDispatcher({ runtime, methods })
  expect(
    await owner.dispatch({
      id: 'init',
      authToken: 'synthetic',
      method: 'projectTask.init',
      params: { worktree, expectedExecutionHostId: 'local' }
    })
  ).toMatchObject({ ok: true })
  await mkdir(join(root, 'profile'))
  const server = new OrcaRuntimeRpcServer({
    runtime,
    methods,
    userDataPath: join(root, 'profile'),
    enableWebSocket: true,
    wsPort: 0,
    pinnedBindHost: '127.0.0.1'
  })
  await server.start()
  cleanups.push(() => server.stop())
  const offer = server.createPairingOffer({
    address: '127.0.0.1',
    name: 'Synthetic phone',
    scope: 'mobile'
  })
  if (!offer.available) {
    throw new Error('Synthetic mobile pairing unavailable')
  }
  const phone = pairMobileClient(offer)
  cleanups.push(() => phone.dispose())
  const id = 'task-11111111-1111-4111-8111-111111111111'
  const content = projectTaskTemplate({ id, title: 'Phone created task' })
  const create = {
    worktree,
    expectedExecutionHostId: 'local',
    source: 'project',
    slug: 'phone',
    content
  }
  expect(
    await phone.request('projectTask.create', {
      ...create,
      expectedExecutionHostId: 'runtime:other'
    })
  ).toMatchObject({ ok: false, error: { message: expect.stringContaining('host changed') } })
  expect(
    await phone.request('projectTask.create', { ...create, expectedExecutionHostId: undefined })
  ).toMatchObject({ ok: false })
  const task = await phone.call('projectTask.create', create)
  expect(task).toMatchObject({ id, title: 'Phone created task' })
  expect(await phone.call('projectTask.board', { worktree })).toMatchObject({ total: 1 })
  const updatedContent = projectTaskTemplate({ id, title: 'Phone edited task' })
  const update = {
    worktree,
    id,
    expectedExecutionHostId: 'local',
    revision: task.revision,
    content: updatedContent
  }
  expect(
    await phone.request('projectTask.update', { ...update, revision: '0'.repeat(64) })
  ).toMatchObject({ ok: false })
  expect(
    await phone.request('projectTask.update', {
      ...update,
      expectedExecutionHostId: 'runtime:other'
    })
  ).toMatchObject({ ok: false })
  const updated = await phone.call('projectTask.update', update)
  expect(updated).toMatchObject({ title: 'Phone edited task' })
  expect(updated.revision).not.toBe(task.revision)
  const action = { worktree, id, revision: updated.revision, expectedExecutionHostId: 'local' }
  expect(
    await phone.request('projectTask.move', { ...action, revision: task.revision, phase: 'review' })
  ).toMatchObject({ ok: false })
  expect(
    await phone.request('projectTask.move', {
      ...action,
      expectedExecutionHostId: 'runtime:other',
      phase: 'review'
    })
  ).toMatchObject({ ok: false })
  expect(
    await phone.request('projectTask.move', { ...action, phase: 'done', reason: '' })
  ).toMatchObject({ ok: false, error: { message: expect.stringContaining('Record the result') } })
  expect(await phone.call('projectTask.move', { ...action, phase: 'review' })).toMatchObject({
    phase: 'review'
  })
  expect(
    await phone.request('projectTask.decide', {
      ...action,
      action: 'accept',
      reason: 'Reviewed synthetic result'
    })
  ).toMatchObject({ ok: false })
  expect(await phone.call('projectTask.approve', action)).toBeDefined()
  expect(
    await phone.request('projectTask.decide', {
      ...action,
      revision: task.revision,
      action: 'accept',
      reason: 'Stale review'
    })
  ).toMatchObject({ ok: false })
  expect(
    await phone.request('projectTask.decide', { ...action, action: 'accept', reason: '' })
  ).toMatchObject({ ok: false })
  const board = await phone.call('projectTask.board', { worktree })
  // A settled review is a fixture state; no worker/model is started by this transport test.
  db.db
    .prepare('UPDATE project_task_items SET phase=? WHERE project_id=? AND task_id=?')
    .run('review', board.project.id, id)
  expect(
    await phone.call('projectTask.decide', {
      ...action,
      action: 'accept',
      reason: 'Reviewed synthetic result and checks'
    })
  ).toMatchObject({ phase: 'done' })
  expect(await phone.call('projectTask.show', { worktree, id })).toMatchObject({
    title: 'Phone edited task',
    revision: updated.revision
  })
  expect(await phone.call('projectTask.documents', { worktree, id })).toBeDefined()
  db.db
    .prepare(`INSERT INTO project_task_attempts(id,project_id,task_id,revision,native_task_id,run_id)
    VALUES (?,?,?,?,?,?)`)
    .run(
      'synthetic-attempt',
      board.project.id,
      id,
      updated.revision,
      'unverifiable-task',
      'synthetic-run'
    )
  expect(await phone.request('projectTask.move', { ...action, phase: 'draft' })).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('Managed attempts') }
  })
  const session = await authenticate(offer.pairingUrl)
  cleanups.push(() => session.ws.close())
  const reader = createReader(session)
  cleanups.push(() => reader.dispose())
  send(session, {
    id: 'token-mismatch',
    method: 'projectTask.update',
    deviceToken: 'different-token',
    params: update
  })
  expect(await reader.next('token-mismatch')).toMatchObject({
    ok: false,
    error: { code: 'unauthorized' }
  })
  for (const name of [
    'delete',
    'archive',
    'rename',
    'init',
    'claim',
    'progress',
    'complete',
    'resumeClaim',
    'start',
    'stop',
    'agentSettings'
  ]) {
    expect(await phone.request(`projectTask.${name}`, action)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' }
    })
  }
  const parsed = decodePairingOffer(offer.pairingUrl)
  const invalid = pairMobileClient({
    pairingUrl: encodePairingOffer({ ...parsed, deviceToken: 'invalid-synthetic-token' })
  })
  cleanups.push(() => invalid.dispose())
  await expect(invalid.call('projectTask.create', create, 1000)).rejects.toThrow()
  expect(await server.revokeMobileDevice(parsed.pairedDeviceId)).toBe(true)
  await expect(phone.call('projectTask.update', update, 1000)).rejects.toThrow()
})
