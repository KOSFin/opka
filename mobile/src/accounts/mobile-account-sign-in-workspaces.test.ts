import { expect, it } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess, rpcRefusal } from '../transport/rpc-operation-test-families'
import { accountSignInWorkspacesRead } from './mobile-account-enrollment-operations'

it('uses the existing full ps catalog and preserves folder/git IDs, order and truncation', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValueOnce(
    rpcSuccess({
      worktrees: [
        {
          worktreeId: 'folder:one',
          displayName: 'Folder',
          path: '/folder',
          workspaceKind: 'folder-workspace'
        },
        { worktreeId: 'git-copy', displayName: 'Git', path: '/git', agents: [] }
      ],
      truncated: true,
      totalCount: 101
    })
  )
  expect(
    accountSignInWorkspacesRead.interpret(
      await accountSignInWorkspacesRead.request(client, { limit: 100 })
    )
  ).toEqual({
    worktrees: [
      { id: 'folder:one', displayName: 'Folder', path: '/folder' },
      { id: 'git-copy', displayName: 'Git', path: '/git' }
    ],
    truncated: true
  })
  expect(client.sendRequest).toHaveBeenCalledWith('worktree.ps', { limit: 100 })
})
it.each([
  { unchanged: true, snapshotId: 'old' },
  { worktrees: [{ id: 'legacy-list-row', displayName: 'Wrong', path: '/wrong' }] },
  { worktrees: [{ worktreeId: '', displayName: 'Wrong', path: '/wrong' }] },
  { worktrees: [{ worktreeId: 'x', displayName: 'Wrong' }] },
  { worktrees: [], truncated: 'false' }
])('rejects an incompatible catalog rather than presenting it as empty: %j', async (raw) => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValueOnce(rpcSuccess(raw))
  const outcome = await accountSignInWorkspacesRead.request(client, { limit: 100 })
  expect(() => accountSignInWorkspacesRead.interpret(outcome)).toThrow()
})
it('retains host refusal and cancelled-request failure instead of empty success', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValueOnce(rpcRefusal('timeout', 'Connection timed out'))
  const outcome = await accountSignInWorkspacesRead.request(client, { limit: 100 })
  expect(() => accountSignInWorkspacesRead.interpret(outcome)).toThrow('Connection timed out')
  client.sendRequest.mockRejectedValueOnce(new Error('cancelled'))
  await expect(accountSignInWorkspacesRead.request(client, { limit: 100 })).rejects.toThrow(
    'cancelled'
  )
})
