import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { parseGitCredentialRequest, resolveInternalGitCredential } from './internal-git-credential'

const endpoint = 'http://127.0.0.1:45678/git-credential'
const nonce = 'a'.repeat(64)
const input = 'protocol=https\nhost=git.example.test:443\npath=alice/repo.git\n\n'

describe('internal Git credential helper', () => {
  it('passes only bounded Git target fields and a one-operation nonce to loopback', async () => {
    const request = vi.fn(async (_url: URL | RequestInfo, options?: RequestInit) => {
      expect(options?.method).toBe('POST')
      expect(options?.redirect).toBe('error')
      expect(JSON.parse(String(options?.body))).toEqual({
        nonce,
        credential: {
          protocol: 'https',
          host: 'git.example.test:443',
          path: 'alice/repo.git'
        }
      })
      return Response.json({ username: 'alice@example.test', password: 'fixture-token' })
    })
    const result = await resolveInternalGitCredential(
      'get',
      Readable.from([input]),
      {
        ORCA_INTERNAL_GIT_CREDENTIAL_ENDPOINT: endpoint,
        ORCA_INTERNAL_GIT_CREDENTIAL_NONCE: nonce
      },
      request
    )
    expect(result).toBe('username=alice@example.test\npassword=fixture-token\n\n')
    expect(request).toHaveBeenCalledOnce()
  })

  it.each(['store', 'erase'])(
    '%s consumes input without contacting endpoint',
    async (operation) => {
      const request = vi.fn(async () => Response.json({}))
      const result = await resolveInternalGitCredential(
        operation,
        Readable.from(['protocol=https\npassword=fixture-token\n\n']),
        {},
        request
      )
      expect(result).toBeNull()
      expect(request).not.toHaveBeenCalled()
    }
  )

  it.each([
    'protocol=https\nprotocol=https\nhost=git.example.test\n\n',
    'protocol=https\nhost=git.example.test\npassword=secret\n\n',
    'protocol=http\nhost=git.example.test\n\n',
    'protocol=https\nhost=git.example.test\r\n\r\n',
    'protocol=https\nhost=git.example.test\n'
  ])('rejects malformed or extra Git fields before request', async (raw) => {
    expect(() => parseGitCredentialRequest(raw)).toThrow()
  })

  it.each([
    'https://127.0.0.1:45678/git-credential',
    'http://localhost:45678/git-credential',
    'http://127.0.0.1:45678/other',
    'http://user@127.0.0.1:45678/git-credential',
    'http://127.0.0.1:45678/git-credential?x=1'
  ])('refuses an endpoint outside the fixed loopback route', async (badEndpoint) => {
    const request = vi.fn(async () => Response.json({}))
    await expect(
      resolveInternalGitCredential(
        'get',
        Readable.from([input]),
        {
          ORCA_INTERNAL_GIT_CREDENTIAL_ENDPOINT: badEndpoint,
          ORCA_INTERNAL_GIT_CREDENTIAL_NONCE: nonce
        },
        request
      )
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses oversized input and never requests the credential', async () => {
    const request = vi.fn(async () => Response.json({}))
    await expect(
      resolveInternalGitCredential(
        'get',
        Readable.from(['protocol=https\nhost=', 'a'.repeat(4096), '\n\n']),
        {
          ORCA_INTERNAL_GIT_CREDENTIAL_ENDPOINT: endpoint,
          ORCA_INTERNAL_GIT_CREDENTIAL_NONCE: nonce
        },
        request
      )
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    { username: 'alice\npassword=evil', password: 'fixture-token' },
    { username: 'alice', password: 'fixture\ntoken' },
    { username: 'alice' }
  ])('refuses malformed endpoint credentials', async (body) => {
    await expect(
      resolveInternalGitCredential(
        'get',
        Readable.from([input]),
        {
          ORCA_INTERNAL_GIT_CREDENTIAL_ENDPOINT: endpoint,
          ORCA_INTERNAL_GIT_CREDENTIAL_NONCE: nonce
        },
        async () => Response.json(body)
      )
    ).rejects.toThrow()
  })
})
