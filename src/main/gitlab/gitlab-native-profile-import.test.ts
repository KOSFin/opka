import { describe, expect, it, vi } from 'vitest'
import type { GitLabNetworkProfile } from '../../shared/gitlab-network-profile'
import { ImportNativeNetworkProfile } from '../../shared/rpc-contract/gitlab-params'
import {
  importNativeGlabNetworkProfile,
  parseNativeGlabProfileStatus
} from './gitlab-native-profile-import'

const host = 'gitlab.example.com'
const status = `gitlab.example.com\n  ✓ Logged in to gitlab.example.com as alice (/home/owner/.config/glab-cli/config.yml)\n  ✓ Token: synthetic-token-123\n`
const profile: GitLabNetworkProfile = {
  id: 'a'.repeat(64),
  host,
  user: 'alice',
  generation: '00000000-0000-4000-8000-000000000001'
}

describe('native glab profile import', () => {
  it('rejects client-supplied credentials in the RPC contract', () => {
    expect(ImportNativeNetworkProfile.safeParse({ host, token: 'synthetic-token' }).success).toBe(
      false
    )
  })

  it('parses only a single host-matched login and unmasked token', () => {
    expect(parseNativeGlabProfileStatus(status, host)).toEqual({
      user: 'alice',
      token: 'synthetic-token-123'
    })
    expect(parseNativeGlabProfileStatus(status, 'another.example.com')).toBeNull()
    expect(
      parseNativeGlabProfileStatus(status.replace('synthetic-token-123', '*****'), host)
    ).toBeNull()
    expect(parseNativeGlabProfileStatus(`${status}${status}`, host)).toBeNull()
  })

  it('reuses the sealed profile when the native login is unchanged', async () => {
    const provision = vi.fn()
    const result = await importNativeGlabNetworkProfile(host, {
      readStatus: vi.fn(async () => status),
      profiles: {
        list: () => [profile],
        readToken: () => 'synthetic-token-123',
        provision
      }
    })
    expect(result).toEqual(profile)
    expect(provision).not.toHaveBeenCalled()
  })

  it('provisions a changed native login through the existing protected store', async () => {
    const provision = vi.fn(async () => profile)
    const result = await importNativeGlabNetworkProfile(host, {
      readStatus: vi.fn(async () => status),
      profiles: {
        list: () => [profile],
        readToken: () => 'old-token',
        provision
      }
    })
    expect(result).toEqual(profile)
    expect(provision).toHaveBeenCalledWith({
      host,
      user: 'alice',
      token: 'synthetic-token-123'
    })
  })

  it('redacts native CLI failures and rejects invalid requested hosts before spawning', async () => {
    const readStatus = vi.fn(async () => {
      throw new Error('synthetic-token-123')
    })
    await expect(importNativeGlabNetworkProfile(host, { readStatus })).rejects.toThrow(
      'could not import its saved glab login'
    )
    await expect(
      importNativeGlabNetworkProfile('https://gitlab.example.com', { readStatus })
    ).rejects.toThrow('Enter the GitLab HTTPS host')
    expect(readStatus).toHaveBeenCalledTimes(1)
  })
})
