import { describe, expect, it } from 'vitest'
import { RpcDispatcher } from '../rpc/dispatcher'
import { GITLAB_METHODS } from '../rpc/methods/gitlab'
import {
  OrcaRuntimeService,
  getGitLabWorkItemDetailsMock,
  listGitLabMergeRequestsMock
} from '../orca-runtime-test-mocks.spec'
import { store } from '../orca-runtime-test-fixtures.spec'

describe('selected-project GitLab host RPC', () => {
  it('routes selected-project MR list and detail RPC to the owning repo without a same-host foreign query', async () => {
    const repos = [
      {
        id: 'tracker-a',
        path: '/synthetic/tracker-a',
        displayName: 'A',
        badgeColor: '',
        addedAt: 1
      },
      {
        id: 'tracker-b',
        path: '/synthetic/tracker-b',
        displayName: 'B',
        badgeColor: '',
        addedAt: 2
      },
      {
        id: 'foreign',
        path: '/synthetic/foreign',
        displayName: 'Foreign',
        badgeColor: '',
        addedAt: 3
      }
    ]
    const runtimeStore = {
      ...store,
      getRepos: () => repos,
      getRepo: (id: string) => repos.find((repo) => repo.id === id)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The synthetic store replaces only repo lookup for these existing runtime query methods.
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })
    listGitLabMergeRequestsMock.mockClear()
    getGitLabWorkItemDetailsMock.mockClear()
    listGitLabMergeRequestsMock.mockResolvedValue({ items: [] })
    const detail = {
      item: {
        id: 'gitlab-mr-11',
        type: 'mr',
        number: 11,
        title: 'Synthetic MR',
        state: 'opened',
        url: 'https://gitlab.example/tracker-a/-/merge_requests/11',
        labels: [],
        updatedAt: '2026-11-10T00:00:00Z',
        author: 'alice',
        branchName: 'feature/a'
      },
      body: 'Linked issue #7',
      comments: [
        {
          id: 1,
          author: 'reviewer',
          authorAvatarUrl: '',
          body: 'Check the branch',
          createdAt: '2026-11-10T00:00:00Z',
          url: 'https://gitlab.example/tracker-a/-/merge_requests/11#note_1'
        }
      ],
      files: [],
      pipelineJobs: [
        {
          id: 9,
          name: 'verify',
          stage: 'test',
          status: 'success',
          webUrl: 'https://gitlab.example/tracker-a/-/jobs/9',
          duration: 12
        }
      ]
    }
    getGitLabWorkItemDetailsMock.mockResolvedValue(detail)
    const request = (id: string, method: string, params: unknown) => ({
      id,
      authToken: 'synthetic',
      method,
      params
    })
    const selected = ['tracker-a', 'tracker-b']
    for (const id of selected) {
      const response = await dispatcher.dispatch(
        request(id, 'gitlab.listMRs', {
          repo: `id:${id}`,
          state: 'opened',
          page: 1,
          perPage: 25
        })
      )
      expect(response.ok).toBe(true)
    }
    expect(listGitLabMergeRequestsMock.mock.calls.map((call) => call[0])).toEqual([
      '/synthetic/tracker-a',
      '/synthetic/tracker-b'
    ])
    const response = await dispatcher.dispatch(
      request('detail-a', 'gitlab.workItemDetails', {
        repo: 'id:tracker-a',
        iid: 11,
        type: 'mr',
        projectRef: { host: 'gitlab.example', path: 'tracker-a' }
      })
    )
    expect(response).toMatchObject({ ok: true, result: detail })
    expect(getGitLabWorkItemDetailsMock).toHaveBeenLastCalledWith(
      '/synthetic/tracker-a',
      11,
      'mr',
      undefined,
      null,
      { host: 'gitlab.example', path: 'tracker-a' },
      {},
      { includeReviewDetails: undefined }
    )
    expect(listGitLabMergeRequestsMock.mock.calls.flatMap((call) => call)).not.toContain(
      '/synthetic/foreign'
    )
  })
})
