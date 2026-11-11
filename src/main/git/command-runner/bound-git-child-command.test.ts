import { describe, expect, it } from 'vitest'
import { boundGitChildArgs, boundGitChildEnvironment } from './bound-git-child-command'

describe('bound Git child command', () => {
  it('removes inherited credential, config, trace and proxy overrides', () => {
    const env = boundGitChildEnvironment(
      {
        HOME: '/synthetic/home',
        PATH: '/synthetic/bin',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: 'Authorization: synthetic-ambient-secret',
        GIT_ASKPASS: '/synthetic/askpass',
        GIT_TRACE: '/synthetic/trace',
        GIT_CURL_VERBOSE: '1',
        NODE_OPTIONS: '--require /synthetic/preload',
        NODE_PATH: '/synthetic/modules',
        BASH_ENV: '/synthetic/bashrc',
        ORCA_CLI_CWD: '/synthetic/other-repo',
        GITHUB_TOKEN: 'synthetic-ambient-secret',
        GITHUB_API_URL: 'https://synthetic.invalid',
        NETRC: '/synthetic/home/.netrc',
        SSL_CERT_FILE: '/synthetic/ca.pem',
        GLAB_TOKEN: 'synthetic-ambient-secret',
        HTTPS_PROXY: 'http://synthetic:secret@proxy.invalid',
        http_proxy: 'http://proxy.invalid',
        SSH_ASKPASS: '/synthetic/askpass'
      },
      {
        ORCA_INTERNAL_GIT_CREDENTIAL_ENDPOINT: 'http://127.0.0.1:32123/git-credential',
        ORCA_INTERNAL_GIT_CREDENTIAL_NONCE: 'a'.repeat(64)
      },
      'linux'
    )
    expect(env.HOME).toBe('/synthetic/home')
    expect(env.PATH).toBe('/synthetic/bin')
    expect(env.GIT_CONFIG_COUNT).toBeUndefined()
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined()
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined()
    expect(env.GIT_TRACE).toBeUndefined()
    expect(env.GIT_CURL_VERBOSE).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.NODE_PATH).toBeUndefined()
    expect(env.BASH_ENV).toBeUndefined()
    expect(env.ORCA_CLI_CWD).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GITHUB_API_URL).toBeUndefined()
    expect(env.NETRC).toBeUndefined()
    expect(env.SSL_CERT_FILE).toBeUndefined()
    expect(env.GLAB_TOKEN).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.http_proxy).toBeUndefined()
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_ASKPASS).toBe('')
    expect(env.SSH_ASKPASS).toBe('')
    expect(env.ORCA_INTERNAL_GIT_CREDENTIAL_NONCE).toBe('a'.repeat(64))
  })

  it('uses Git 2.25-compatible leading config and quotes a launcher path with spaces', () => {
    expect(
      boundGitChildArgs(['fetch', '--prune', 'origin'], "/tmp/Orca's CLI/orca", 'linux')
    ).toEqual([
      '-c',
      'credential.helper=',
      '-c',
      "credential.helper=!'/tmp/Orca'\\''s CLI/orca' internal-git-credential",
      '-c',
      'credential.useHttpPath=true',
      '-c',
      'http.followRedirects=false',
      '-c',
      'http.sslVerify=true',
      'fetch',
      '--prune',
      'origin'
    ])
  })

  it('refuses Windows and a missing or relative launcher before network', () => {
    expect(() => boundGitChildArgs(['fetch'], 'orca', 'linux')).toThrow(
      'Bound Git helper unavailable.'
    )
    expect(() => boundGitChildArgs(['fetch'], '/tmp/orca', 'win32')).toThrow(
      'Bound Git helper unavailable.'
    )
    expect(() => boundGitChildEnvironment({}, {}, 'linux')).toThrow(
      'Bound Git credential endpoint unavailable.'
    )
  })
})
