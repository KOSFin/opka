import { afterEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import type { TaskWorkspace } from '../project-tasks/task-workspace'
import { closeProjectTaskWorkspaces, resolveProjectTaskWorkspace } from './project-task-workspaces'

vi.mock('../project-tasks/task-project-roots', () => ({
  resolveRegisteredTaskRoot: async (_runtime: unknown, path: string) => path
}))
vi.mock('./file-watcher-host', () => ({ watchFileExplorerInWatcherProcess: vi.fn() }))
const runtimes: OrcaRuntimeService[] = []
function runtime() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this cache test uses only the file-target resolver; registered-root authorization is mocked separately.
  const host = {
    resolveRuntimeFileTarget: async (path: string) => ({
      executionHostId: 'local',
      worktree: { path }
    })
  } as unknown as OrcaRuntimeService
  runtimes.push(host)
  return host
}
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(closeProjectTaskWorkspaces))
})

it('retains the 16-project overview and evicts the least recently used inactive project at its budget', async () => {
  const host = runtime()
  const entries: TaskWorkspace[] = []
  for (let index = 0; index < 16; index++) {
    entries.push((await resolveProjectTaskWorkspace(host, `/synthetic/${index}`)).workspace)
  }
  for (let index = 0; index < 16; index++) {
    expect((await resolveProjectTaskWorkspace(host, `/synthetic/${index}`)).workspace).toBe(
      entries[index]
    )
  }
  const close = vi.spyOn(entries[1], 'close')
  await resolveProjectTaskWorkspace(host, '/synthetic/0')
  await resolveProjectTaskWorkspace(host, '/synthetic/16')
  expect(close).toHaveBeenCalledTimes(1)
  expect((await resolveProjectTaskWorkspace(host, '/synthetic/0')).workspace).toBe(entries[0])
})

it('does not share same-path state between owning runtimes and checks expected ownership', async () => {
  const one = runtime(),
    two = runtime()
  expect((await resolveProjectTaskWorkspace(one, '/synthetic/0')).workspace).not.toBe(
    (await resolveProjectTaskWorkspace(two, '/synthetic/0')).workspace
  )
  await expect(resolveProjectTaskWorkspace(one, '/synthetic/0', 'ssh:other')).rejects.toThrow(
    /host changed/
  )
})
