import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { PROJECT_TASK_METHODS } from '../../src/main/runtime/rpc/methods/project-tasks'
import { closeProjectTaskWorkspaces } from '../../src/main/runtime/project-task-workspaces'
import { PROJECT_TASK_HANDLERS } from '../../src/cli/handlers/project-task'
import { RuntimeClientError } from '../../src/cli/runtime-client'
import { parseProjectTask } from '../../src/main/project-tasks/task-document'

vi.mock('../../src/main/runtime/file-watcher-host', () => ({
  watchFileExplorerInWatcherProcess: vi.fn(async () => async () => undefined)
}))

const runtimes = []
const directories = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(closeProjectTaskWorkspaces))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-project-task-rpc-')))
  directories.push(root)
  const resolve = vi.fn(async () => ({
    worktree: { id: 'folder-1', path: root },
    executionHostId: 'local'
  }))
  const runtime = {
    getRuntimeId: () => 'task-fixture',
    listVisibleFolderWorkspaces: () => [],
    listVisibleProjectGroups: () => [],
    listVisibleRepos: () => [],
    resolveRuntimeFileTarget: resolve
  }
  runtimes.push(runtime)
  const dispatcher = new RpcDispatcher({ runtime, methods: PROJECT_TASK_METHODS })
  const request = (method, params) =>
    dispatcher.dispatch({ id: 'test-request', authToken: 'test-only', method, params })
  return { root, runtime, resolve, request }
}

describe('project-task CLI through the actual RPC contract and file service', () => {
  it('initializes, creates, lists, and reconstructs bounded context without a worker or account', async () => {
    const { root, runtime, request, resolve } = await fixture()
    const call = vi.fn(async (method, params) => {
      const reply = await request(method, params)
      if (!reply.ok) {
        throw new RuntimeClientError(reply.error.code, reply.error.message)
      }
      return reply
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const run = async (name, flags) => {
      const context = {
        client: { call, isRemote: false },
        cwd: root,
        flags: new Map(flags),
        json: false
      }
      await PROJECT_TASK_HANDLERS[`project-task ${name}`](context)
    }
    await run('init', [])
    await run('create', [
      ['slug', 'pipeline'],
      ['title', 'Repair pipeline'],
      ['detailed', true]
    ])
    const task = parseProjectTask(
      await readFile(join(root, 'docs/work/tasks/pipeline/task.md'), 'utf8')
    )
    await run('list', [])
    expect(log.mock.calls.at(-1)?.[0]).toContain(task.id)
    await closeProjectTaskWorkspaces(runtime)
    await run('context', [['id', task.id]])
    expect(log.mock.calls.at(-1)?.[0]).toContain('Execution: unknown; approval: unverified')
    expect(log.mock.calls.at(-1)?.[0]).toContain('Repair pipeline')
    expect(resolve).toHaveBeenCalledWith(`path:${root}`)
    expect(
      call.mock.calls
        .map(([method]) => method)
        .some((method) => /worker|terminal|orchestration/.test(method))
    ).toBe(false)
    const bad = await request('projectTask.update', {
      worktree: 'id:folder-1',
      id: task.id,
      revision: task.revision,
      content: task.content
    })
    expect(bad.ok).toBe(false)
  })

  it('refuses host changes and SSH-owned paths before local filesystem access', async () => {
    const { resolve, request } = await fixture()
    expect(
      await request('projectTask.init', {
        worktree: 'id:folder-1',
        expectedExecutionHostId: 'ssh:other'
      })
    ).toMatchObject({ ok: false })
    resolve.mockResolvedValue({
      worktree: { id: 'folder-1', path: '/not-a-local-workspace' },
      executionHostId: 'ssh:remote'
    })
    const reply = await request('projectTask.target', { worktree: 'id:folder-1' })
    expect(reply).toMatchObject({ ok: false })
  })

  it('explains an older runtime instead of silently accessing local files', async () => {
    const call = vi.fn(async () => {
      throw new RuntimeClientError('method_not_found', 'old host')
    })
    const context = {
      client: { call, isRemote: true },
      cwd: '/unused',
      flags: new Map([['worktree', 'id:folder-1']]),
      json: true
    }
    await expect(PROJECT_TASK_HANDLERS['project-task list'](context)).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
    context.flags.clear()
    await expect(PROJECT_TASK_HANDLERS['project-task list'](context)).rejects.toThrow(
      /explicit --worktree/
    )
  })

  it('refuses bridged file input before reading a same-named client-side file', async () => {
    vi.stubEnv('ORCA_CLI_CWD', '/remote-only')
    const call = vi.fn()
    const context = {
      client: { call, isRemote: true },
      cwd: '/remote-only',
      flags: new Map([
        ['worktree', 'id:folder-1'],
        ['file', 'task.md'],
        ['slug', 'remote']
      ]),
      json: true
    }
    await expect(PROJECT_TASK_HANDLERS['project-task create'](context)).rejects.toThrow(
      /Bridged --file/
    )
    expect(call).not.toHaveBeenCalled()
  })
})
