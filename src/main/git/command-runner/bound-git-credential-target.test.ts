import { describe, expect, it } from 'vitest'
import {
  matchesBoundGitCredentialTarget,
  parseBoundGitCredentialTarget
} from './bound-git-credential-target'

describe('bound Git credential target', () => {
  it('matches only the exact HTTPS host, port, path and selected user', () => {
    const target = parseBoundGitCredentialTarget('https://gitlab.com/team/repo.git', 'alice')
    expect(
      matchesBoundGitCredentialTarget(target, {
        protocol: 'https',
        host: 'gitlab.com',
        path: 'team/repo.git'
      })
    ).toBe(true)
    for (const request of [
      { protocol: 'https' as const, host: 'gitlab.com', path: 'team/other.git' },
      { protocol: 'https' as const, host: 'gitlab.com', path: 'team/repo.git', username: 'bob' },
      { protocol: 'https' as const, host: 'gitlab.example', path: 'team/repo.git' },
      { protocol: 'https' as const, host: 'gitlab.com:8443', path: 'team/repo.git' },
      { protocol: 'https' as const, host: 'gitlab.com' }
    ]) {
      expect(matchesBoundGitCredentialTarget(target, request)).toBe(false)
    }
  })

  it('keeps a nondefault port and refuses URL credentials, rewrites and ambiguity', () => {
    const target = parseBoundGitCredentialTarget('https://gitlab.example:8443/team/repo.git', 'bob')
    expect(
      matchesBoundGitCredentialTarget(target, {
        protocol: 'https',
        host: 'gitlab.example:8443',
        path: 'team/repo.git',
        username: 'bob'
      })
    ).toBe(true)
    for (const url of [
      'http://gitlab.example/team/repo.git',
      'https://alice:token@gitlab.example/team/repo.git',
      'https://gitlab.example/team/repo.git?ref=main',
      'https://gitlab.example/team/repo.git?',
      'https://gitlab.example/team/repo.git#',
      'https://gitlab.example/team repo.git',
      'https://gitlab.example/team/../other.git',
      'https://gitlab.example/team%2Frepo.git',
      'https://gitlab.example/'
    ]) {
      expect(() => parseBoundGitCredentialTarget(url, 'alice')).toThrow(
        'Bound Git target unavailable.'
      )
    }
  })
})
