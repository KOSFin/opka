import { describe, expect, it, vi } from 'vitest'
import { createBoundGitCredentialEndpoint } from './bound-git-credential-endpoint'

async function askEndpoint(env: NodeJS.ProcessEnv, nonce = env.ORCA_INTERNAL_GIT_CREDENTIAL_NONCE) {
  const endpoint = env.ORCA_INTERNAL_GIT_CREDENTIAL_ENDPOINT
  if (!endpoint || !nonce) {
    throw new Error('Fixture endpoint missing')
  }
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nonce,
      credential: { protocol: 'https', host: 'git.example.test', path: 'alice/repo.git' }
    })
  })
}

describe('bound Git credential endpoint', () => {
  it('answers one exact local request and closes before a second request', async () => {
    const resolveCredential = vi.fn(async () => ({
      username: 'alice',
      password: 'fixture-token'
    }))
    const endpoint = await createBoundGitCredentialEndpoint(resolveCredential, { deadlineMs: 3000 })
    try {
      const result = await askEndpoint(endpoint.env)
      expect(result.status).toBe(200)
      expect(await result.json()).toEqual({ username: 'alice', password: 'fixture-token' })
      expect(resolveCredential).toHaveBeenCalledWith(
        { protocol: 'https', host: 'git.example.test', path: 'alice/repo.git' },
        expect.any(AbortSignal)
      )
      await endpoint.closed
      await expect(askEndpoint(endpoint.env)).rejects.toThrow()
      expect(resolveCredential).toHaveBeenCalledOnce()
    } finally {
      await endpoint.close()
    }
  })

  it('consumes a wrong nonce without releasing the credential', async () => {
    const resolveCredential = vi.fn(async () => ({
      username: 'alice',
      password: 'fixture-token'
    }))
    const endpoint = await createBoundGitCredentialEndpoint(resolveCredential, { deadlineMs: 3000 })
    try {
      const result = await askEndpoint(endpoint.env, 'b'.repeat(64))
      expect(result.status).toBe(403)
      expect(resolveCredential).not.toHaveBeenCalled()
      await endpoint.closed
    } finally {
      await endpoint.close()
    }
  })

  it('refuses a target rejected by host recheck', async () => {
    const endpoint = await createBoundGitCredentialEndpoint(async () => null, {
      deadlineMs: 3000
    })
    try {
      const result = await askEndpoint(endpoint.env)
      expect(result.status).toBe(403)
      await endpoint.closed
    } finally {
      await endpoint.close()
    }
  })

  it('closes on host cancellation before Git asks', async () => {
    const controller = new AbortController()
    const resolveCredential = vi.fn(async () => ({
      username: 'alice',
      password: 'fixture-token'
    }))
    const endpoint = await createBoundGitCredentialEndpoint(resolveCredential, {
      deadlineMs: 3000,
      signal: controller.signal
    })
    controller.abort()
    await endpoint.closed
    await expect(askEndpoint(endpoint.env)).rejects.toThrow()
    expect(resolveCredential).not.toHaveBeenCalled()
  })
})
