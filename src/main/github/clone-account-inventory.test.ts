import { describe, expect, it } from 'vitest'
import { requiredHostForGitHubClone } from './clone-account-inventory'

describe('clone account inventory host', () => {
  it('derives the exact canonical server authority from a clone URL', () => {
    expect(requiredHostForGitHubClone('https://GitHub.COM/team/repo.git')).toBe('github.com')
    expect(requiredHostForGitHubClone('https://ghe.example:8443/team/repo.git')).toBe(
      'ghe.example:8443'
    )
  })

  it.each([
    'git@github.com:team/repo.git',
    'https://other.example/',
    'https://alice:token@github.com/team/repo.git',
    'https://github.com.evil.test/team/repo.git?next=github.com',
    'https://github.com./team/repo.git'
  ])('refuses invalid or ambiguous URLs before querying accounts: %s', (url) => {
    expect(() => requiredHostForGitHubClone(url)).toThrow()
  })
})
