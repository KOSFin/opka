import { describe, expect, it, vi } from 'vitest'
import { verifyGitLabNetworkProfileToken } from './gitlab-network-profile-identity'

describe('GitLab profile identity verification', () => {
  it('uses only the supported fixed GitLab user endpoint and returns a verified login', async () => {
    const request = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      expect(options?.redirect).toBe('error')
      expect(options?.headers).toEqual({
        'PRIVATE-TOKEN': 'fixture-token',
        Accept: 'application/json'
      })
      return Response.json({ username: 'Alice' })
    })
    expect(await verifyGitLabNetworkProfileToken('fixture-token', 'gitlab.com', request)).toBe(
      'alice'
    )
    expect(request).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/user',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it.each([401, 403, 302])('rejects provider status %s without a login', async (status) => {
    expect(
      await verifyGitLabNetworkProfileToken(
        'fixture-token',
        'gitlab.com',
        async () => new Response(null, { status })
      )
    ).toBeNull()
  })

  it('rejects an oversized response and malformed login', async () => {
    expect(
      await verifyGitLabNetworkProfileToken('fixture-token', 'gitlab.com', async () =>
        Response.json({ username: 'a'.repeat(5000) })
      )
    ).toBeNull()
    expect(
      await verifyGitLabNetworkProfileToken('fixture-token', 'gitlab.com', async () =>
        Response.json({ username: '../wrong' })
      )
    ).toBeNull()
  })

  it('rejects header injection before a request', async () => {
    const request = vi.fn(async () => Response.json({ username: 'alice' }))
    expect(
      await verifyGitLabNetworkProfileToken('fixture\ntoken', 'gitlab.com', request)
    ).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('verifies only the selected self-hosted HTTPS authority', async () => {
    const request = vi.fn(async () => Response.json({ username: 'alice' }))
    expect(
      await verifyGitLabNetworkProfileToken('fixture-token', 'gitlab.example:8443', request)
    ).toBe('alice')
    expect(request).toHaveBeenCalledWith(
      'https://gitlab.example:8443/api/v4/user',
      expect.objectContaining({ redirect: 'error' })
    )
    expect(
      await verifyGitLabNetworkProfileToken('fixture-token', 'gitlab.example/path', request)
    ).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })
})
