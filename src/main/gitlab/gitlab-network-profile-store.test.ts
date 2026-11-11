import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SecretStore } from '../../shared/secret-store'
import { createGitLabNetworkProfileStore } from './gitlab-network-profile-store'

const directories: string[] = []

function fakeSecretStore(gap: string | null = null): SecretStore {
  return {
    isEncryptionAvailable: () => gap === null,
    describeProtectionGap: () => gap,
    encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => {
      const text = value.toString('utf8')
      if (!text.startsWith('sealed:')) {
        throw new Error('Fixture sealed payload is invalid')
      }
      return Buffer.from(text.slice('sealed:'.length), 'base64').toString('utf8')
    }
  }
}

function testStore(secretStore = fakeSecretStore()) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-gitlab-profile-'))
  directories.push(directory)
  return { directory, registry: createGitLabNetworkProfileStore(directory, secretStore) }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('sealed GitLab network profiles', () => {
  it('separates the same user on canonical HTTPS hosts and preserves the gitlab.com id', async () => {
    const { registry } = testStore()
    const publicProfile = await registry.provision({
      host: 'gitlab.com',
      user: 'alice',
      token: 'public-fixture-token',
      verifyUser: async () => 'alice'
    })
    const privateProfile = await registry.provision({
      host: 'GitLab.Example:8443',
      user: 'alice',
      token: 'private-fixture-token',
      verifyUser: async () => 'alice'
    })
    expect(publicProfile.host).toBe('gitlab.com')
    expect(privateProfile.host).toBe('gitlab.example:8443')
    expect(privateProfile.id).not.toBe(publicProfile.id)
    expect(registry.readToken(publicProfile)).toBe('public-fixture-token')
    expect(registry.readToken(privateProfile)).toBe('private-fixture-token')
  })

  it('does not publish delayed verification after removal or cancellation', async () => {
    const { registry } = testStore()
    const first = await registry.provision({
      host: 'gitlab.com',
      user: 'alice',
      token: 'first-fixture-token',
      verifyUser: async () => 'alice'
    })
    let releaseVerify: ((user: string) => void) | undefined
    const delayed = registry.provision({
      host: 'gitlab.com',
      user: 'alice',
      token: 'delayed-fixture-token',
      verifyUser: () =>
        new Promise<string>((resolve) => {
          releaseVerify = resolve
        })
    })
    registry.remove(first)
    releaseVerify?.('alice')
    await expect(delayed).rejects.toThrow(/could not be saved/)
    expect(registry.list()).toEqual([])

    const controller = new AbortController()
    const cancelled = registry.provision({
      host: 'gitlab.com',
      user: 'alice',
      token: 'cancelled-fixture-token',
      signal: controller.signal,
      verifyUser: async () => 'alice'
    })
    controller.abort()
    await expect(cancelled).rejects.toThrow(/cancelled/)
    expect(registry.list()).toEqual([])
  })

  it('does not resurrect an initially absent profile after another owner adds and removes it', async () => {
    const { directory, registry } = testStore()
    const otherOwner = createGitLabNetworkProfileStore(directory, fakeSecretStore())
    let releaseVerify: ((user: string) => void) | undefined
    const delayed = registry.provision({
      host: 'gitlab.com',
      user: 'alice',
      token: 'stale-fixture-token',
      verifyUser: () =>
        new Promise<string>((resolve) => {
          releaseVerify = resolve
        })
    })
    const other = await otherOwner.provision({
      host: 'gitlab.com',
      user: 'alice',
      token: 'other-fixture-token',
      verifyUser: async () => 'alice'
    })
    otherOwner.remove(other)
    releaseVerify?.('alice')
    await expect(delayed).rejects.toThrow(/could not be saved/)
    expect(registry.list()).toEqual([])
    expect(readdirSync(directory).filter((name) => name.endsWith('.enc'))).toEqual([])
    const replacement = await registry.provision({
      host: 'gitlab.com',
      user: 'alice',
      token: 'replacement-fixture-token',
      verifyUser: async () => 'alice'
    })
    expect(registry.readToken(replacement)).toBe('replacement-fixture-token')
  })

  it('keeps two verified users and tokens separate on the same host', async () => {
    const { directory, registry } = testStore()
    const alice = await registry.provision({
      host: 'gitlab.com',
      user: 'Alice',
      token: 'alice-fixture-token',
      verifyUser: async () => 'alice'
    })
    const bob = await registry.provision({
      host: 'gitlab.com',
      user: 'Bob',
      token: 'bob-fixture-token',
      verifyUser: async () => 'bob'
    })
    expect(alice.id).not.toBe(bob.id)
    expect(registry.list()).toEqual([alice, bob])
    expect(registry.readToken(alice)).toBe('alice-fixture-token')
    expect(registry.readToken(bob)).toBe('bob-fixture-token')
    const files = readdirSync(directory).map((name) => readFileSync(join(directory, name), 'utf8'))
    expect(files.join('\n')).not.toContain('alice-fixture-token')
    expect(files.join('\n')).not.toContain('bob-fixture-token')
  })

  it('rejects an identity mismatch before storing anything', async () => {
    const { directory, registry } = testStore()
    const verifyUser = vi.fn(async () => 'bob')
    await expect(
      registry.provision({ host: 'gitlab.com', user: 'alice', token: 'fixture-token', verifyUser })
    ).rejects.toThrow(/identity/)
    expect(verifyUser).toHaveBeenCalledOnce()
    expect(readdirSync(directory)).toEqual([])
  })

  it('never falls back to plaintext when protection is unavailable', async () => {
    const { directory, registry } = testStore(fakeSecretStore('No protected keyring'))
    const verifyUser = vi.fn(async () => 'alice')
    await expect(
      registry.provision({ host: 'gitlab.com', user: 'alice', token: 'fixture-token', verifyUser })
    ).rejects.toThrow(/Protected/)
    expect(verifyUser).not.toHaveBeenCalled()
    expect(readdirSync(directory)).toEqual([])
  })

  it('rotates generation and refuses stale reads and removal', async () => {
    const { registry } = testStore()
    const first = await registry.provision({
      host: 'gitlab.com',
      user: 'alice',
      token: 'first-fixture-token',
      verifyUser: async () => 'alice'
    })
    const next = await registry.provision({
      host: 'gitlab.com',
      user: 'alice',
      token: 'next-fixture-token',
      verifyUser: async () => 'alice'
    })
    expect(next.id).toBe(first.id)
    expect(next.generation).not.toBe(first.generation)
    expect(() => registry.readToken(first)).toThrow(/unavailable/)
    expect(() => registry.remove(first)).toThrow(/changed/)
    expect(registry.readToken(next)).toBe('next-fixture-token')
    registry.remove(next)
    expect(registry.list()).toEqual([])
    expect(() => registry.readToken(next)).toThrow(/unavailable/)
  })

  it('rejects corrupt ciphertext and a path-shaped profile id', async () => {
    const { directory, registry } = testStore()
    const profile = await registry.provision({
      host: 'gitlab.com',
      user: 'alice',
      token: 'fixture-token',
      verifyUser: async () => 'alice'
    })
    writeFileSync(join(directory, `${profile.id}.${profile.generation}.enc`), 'plaintext')
    expect(() => registry.readToken(profile)).toThrow(/credential is unavailable/)
    expect(() => registry.readToken({ ...profile, id: '../escape' })).toThrow(/Invalid/)
    expect(() => registry.remove({ ...profile, id: '../escape' })).toThrow(/Invalid/)
  })
})
