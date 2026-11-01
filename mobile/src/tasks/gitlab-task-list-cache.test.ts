import { expect, it } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import {
  gitLabTaskListEpoch,
  invalidateGitLabTaskLists,
  readGitLabTaskList,
  saveGitLabTaskList
} from './gitlab-task-list-cache'
it('keeps filter keys and owners separate, expires and invalidates after mutations', () => {
  let generation = 0
  const client = Object.assign(new FakeSession('connected'), { getGeneration: () => generation })
  saveGitLabTaskList(client, 'open', [], 'Partial result', 1)
  expect(readGitLabTaskList(client, 'open', 2)).toMatchObject({
    fresh: true,
    notice: 'Partial result'
  })
  expect(readGitLabTaskList(client, 'closed', 2)).toBeNull()
  expect(readGitLabTaskList(new FakeSession('connected'), 'open', 2)).toBeNull()
  expect(readGitLabTaskList(client, 'open', 60_001)).toMatchObject({ fresh: false })
  const epoch = gitLabTaskListEpoch(client)
  invalidateGitLabTaskLists(client)
  saveGitLabTaskList(client, 'open', [], '', 3, epoch)
  expect(readGitLabTaskList(client, 'open', 4)).toBeNull()
  saveGitLabTaskList(client, 'open', [], '', 1)
  generation += 1
  expect(readGitLabTaskList(client, 'open', 2)).toBeNull()
  saveGitLabTaskList(client, 'open', [], '', 1)
  expect(readGitLabTaskList(client, 'open', 600_001)).toBeNull()
})
it('bounds retained list count and byte use', () => {
  const client = new FakeSession('connected')
  for (let index = 0; index < 13; index += 1) {
    saveGitLabTaskList(client, String(index), [], '', 1)
  }
  expect(readGitLabTaskList(client, '0', 2)).toBeNull()
  expect(readGitLabTaskList(client, '12', 2)).not.toBeNull()
  saveGitLabTaskList(client, 'large', [], 'a'.repeat(1024 * 1024 + 1), 1)
  expect(readGitLabTaskList(client, 'large', 2)).toBeNull()
})

it('keeps new GitLab preferences off older strict ui.set schemas', async () => {
  const { TaskResumeState } =
    await import('../../../src/shared/rpc-contract/task-resume-state-params')
  const { splitGitLabTaskResumeState, saveGitLabTaskPreferences, readGitLabTaskPreferences } =
    await import('./gitlab-task-list-cache')
  let generation = 0
  const client = Object.assign(new FakeSession('connected'), { getGeneration: () => generation })
  const { host, preferences } = splitGitLabTaskResumeState({
    linearQuery: 'backend',
    gitlabView: 'project',
    gitlabFilter: 'merged',
    gitlabQuery: 'release'
  })
  expect(TaskResumeState.parse(host)).toEqual({ linearQuery: 'backend' })
  expect(host).not.toHaveProperty('gitlabQuery')
  saveGitLabTaskPreferences(client, preferences)
  invalidateGitLabTaskLists(client)
  expect(readGitLabTaskPreferences(client)).toMatchObject({
    gitlabFilter: 'merged',
    gitlabQuery: 'release'
  })
  generation += 1
  expect(readGitLabTaskPreferences(client)).toEqual({})
})
