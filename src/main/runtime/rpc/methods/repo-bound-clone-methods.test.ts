import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { REPO_METHODS } from './repo'

describe('bound Git clone RPC methods', () => {
  it('routes selected profiles only through dedicated methods and rejects incomplete selection', async () => {
    const cloneRepo = vi.fn().mockResolvedValue({ id: 'repo-1', path: '/srv/repo', kind: 'git' })
    const runtime = { getRuntimeId: () => 'test-runtime', cloneRepo }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every runtime method used by these three clone handlers.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: REPO_METHODS
    })
    const request = (method: string, params: unknown) => ({
      id: 'req-1',
      authToken: 'tok',
      method,
      params
    })
    const github = await dispatcher.dispatch(
      request('repo.cloneBoundGitHub', {
        url: 'https://github.com/team/repo.git',
        destination: '/srv',
        account: { host: 'github.com', user: 'Alice' }
      })
    )
    expect(github.ok).toBe(true)
    expect(cloneRepo).toHaveBeenLastCalledWith(
      'https://github.com/team/repo.git',
      '/srv',
      undefined,
      { provider: 'github', host: 'github.com', user: 'Alice' }
    )
    const gitlab = await dispatcher.dispatch(
      request('repo.cloneBoundGitLab', {
        url: 'https://gitlab.com/team/repo.git',
        destination: '/srv',
        profileId: 'a'.repeat(64)
      })
    )
    expect(gitlab.ok).toBe(true)
    expect(cloneRepo).toHaveBeenLastCalledWith(
      'https://gitlab.com/team/repo.git',
      '/srv',
      undefined,
      { provider: 'gitlab', profileId: 'a'.repeat(64) }
    )
    const invalid = await dispatcher.dispatch(
      request('repo.cloneBoundGitLab', {
        url: 'https://gitlab.com/team/repo.git',
        destination: '/srv'
      })
    )
    expect(invalid.ok).toBe(false)
    expect(cloneRepo).toHaveBeenCalledTimes(2)
  })
})
