import { describe, expect, it } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { GitLabWorkItem } from './mobile-tasks-provider-detail-types'
import type { ActionableTaskItem } from './mobile-tasks-project-workspace-types'
function gitlabItem(source: Partial<GitLabWorkItem> = {}): ActionableTaskItem {
  return {
    provider: 'gitlab',
    key: 'mr:1',
    title: 'MR',
    subtitle: '',
    status: 'Open',
    updatedAt: 'now',
    source: {
      id: '1',
      type: 'mr',
      number: 1,
      title: 'MR',
      state: 'opened',
      url: '',
      labels: [],
      author: null,
      updatedAt: 'now',
      repoId: 'repo',
      repoName: 'Repo',
      ...source
    }
  }
}
import type { DetailPayload } from './mobile-tasks-provider-detail-types'
import {
  gitLabMrDetailKey,
  gitLabMrCacheEpoch,
  invalidateGitLabMrDetail,
  readGitLabMrDetail,
  saveGitLabMrDetail
} from './gitlab-mr-detail-cache'
const payload: Extract<DetailPayload, { provider: 'gitlab' }> = {
  provider: 'gitlab',
  body: 'Description',
  comments: [],
  labels: [],
  assignees: [],
  pipelineJobs: []
}
describe('session-only GitLab MR detail cache', () => {
  it('partitions owner, generation, repository, provider project and revision', () => {
    let generation = 0
    const client = Object.assign(new FakeSession('connected'), { getGeneration: () => generation })
    const key = gitLabMrDetailKey(gitlabItem())!
    saveGitLabMrDetail(client, key, payload, 1)
    expect(readGitLabMrDetail(client, key, 2)).toBe(payload)
    expect(readGitLabMrDetail(new FakeSession('connected'), key, 2)).toBeNull()
    for (const source of [
      { repoId: 'other' },
      { updatedAt: 'new' },
      { projectRef: { host: 'other.example', path: 'group/repo' } }
    ]) {
      expect(readGitLabMrDetail(client, gitLabMrDetailKey(gitlabItem(source))!, 2)).toBeNull()
    }
    generation += 1
    expect(readGitLabMrDetail(client, key, 2)).toBeNull()
    expect(gitLabMrDetailKey(gitlabItem({ type: 'issue' }))).toBeNull()
  })
  it('expires after sixty seconds and invalidates explicit refreshes', () => {
    const client = new FakeSession('connected')
    saveGitLabMrDetail(client, 'first', payload, 100)
    expect(readGitLabMrDetail(client, 'first', 60_099)).toBe(payload)
    expect(readGitLabMrDetail(client, 'first', 60_100)).toBeNull()
    saveGitLabMrDetail(client, 'second', payload)
    invalidateGitLabMrDetail(client, 'second')
    expect(readGitLabMrDetail(client, 'second')).toBeNull()
  })
  it('evicts by bounded entry count and text budget', () => {
    const client = new FakeSession('connected')
    for (let index = 0; index < 25; index += 1) {
      saveGitLabMrDetail(client, String(index), payload, 1)
    }
    expect(readGitLabMrDetail(client, '0', 2)).toBeNull()
    expect(readGitLabMrDetail(client, '24', 2)).toBe(payload)
    saveGitLabMrDetail(client, 'huge', { ...payload, body: 'a'.repeat(1024 * 1024 + 1) }, 1)
    expect(readGitLabMrDetail(client, 'huge', 2)).toBeNull()
    const large = { ...payload, body: 'a'.repeat(600_000) }
    saveGitLabMrDetail(client, 'large1', large, 1)
    saveGitLabMrDetail(client, 'large2', large, 1)
    expect(readGitLabMrDetail(client, 'large1', 2)).toBeNull()
    expect(readGitLabMrDetail(client, 'large2', 2)).toBe(large)
  })
  it('does not repopulate a cache with a read started before a mutation', () => {
    const client = new FakeSession('connected')
    const epoch = gitLabMrCacheEpoch(client)
    invalidateGitLabMrDetail(client, 'item')
    saveGitLabMrDetail(client, 'item', payload, 1, epoch)
    expect(readGitLabMrDetail(client, 'item', 2)).toBeNull()
  })
})
