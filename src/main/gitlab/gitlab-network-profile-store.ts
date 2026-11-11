import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  isGitLabNetworkProfile,
  normalizeGitLabNetworkUser,
  type GitLabNetworkProfile
} from '../../shared/gitlab-network-profile'
import { normalizeGitHttpsHost } from '../../shared/git-https-host'
import { getSecretStore, type SecretStore } from '../../shared/secret-store'
import { writeCredentialFileAtomic } from '../integration-credential-file'
import { verifyGitLabNetworkProfileToken } from './gitlab-network-profile-identity'

const MAX_PROFILES = 128
const MAX_TOKEN_LENGTH = 4096

function profileId(host: string, user: string): string {
  return createHash('sha256').update(`${host}\0${user}`).digest('hex')
}

function requireProtection(store: SecretStore): void {
  if (!store.isEncryptionAvailable() || store.describeProtectionGap() !== null) {
    throw new Error('Protected GitLab profile storage is unavailable on this host.')
  }
}

function readProfile(path: string, id: string): GitLabNetworkProfile | null {
  if (!existsSync(path)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      !isGitLabNetworkProfile(parsed) ||
      parsed.id !== id ||
      profileId(parsed.host, parsed.user) !== id
    ) {
      throw new Error('Invalid profile metadata')
    }
    return parsed
  } catch {
    throw new Error('Saved GitLab profile metadata is unavailable.')
  }
}

export function createGitLabNetworkProfileStore(
  directory = join(homedir(), '.opka', 'gitlab-network-profiles'),
  store: SecretStore = getSecretStore()
) {
  const metadataPath = (id: string): string => join(directory, `${id}.json`)
  const removalEpochPath = join(directory, 'removal-epoch')
  const removalEpoch = (): string | null =>
    existsSync(removalEpochPath) ? readFileSync(removalEpochPath, 'utf8') : null
  const tokenPath = (id: string, generation: string): string =>
    join(directory, `${id}.${generation}.enc`)
  const listProfiles = (): GitLabNetworkProfile[] => {
    if (!existsSync(directory)) {
      return []
    }
    const files = readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    if (files.length > MAX_PROFILES) {
      throw new Error('Too many saved GitLab profiles.')
    }
    return files
      .map((name) => readProfile(join(directory, name), name.slice(0, 64)))
      .filter((profile): profile is GitLabNetworkProfile => profile !== null)
      .sort((left, right) => left.user.localeCompare(right.user))
  }

  return {
    list: listProfiles,
    async provision(input: {
      host: string
      user: string
      token: string
      signal?: AbortSignal
      verifyUser?: (token: string, host: string) => Promise<string | null>
    }): Promise<GitLabNetworkProfile> {
      const host = normalizeGitHttpsHost(input.host)
      const user = normalizeGitLabNetworkUser(input.user)
      if (
        !host ||
        !user ||
        !input.token ||
        input.token.length > MAX_TOKEN_LENGTH ||
        /[\r\n\0]/.test(input.token)
      ) {
        throw new Error('Invalid GitLab profile input.')
      }
      requireProtection(store)
      const id = profileId(host, user)
      const oldProfile = readProfile(metadataPath(id), id)
      const expectedGeneration = oldProfile?.generation
      const expectedRemovalEpoch = removalEpoch()
      if (input.signal?.aborted) {
        throw new Error('GitLab profile save was cancelled.')
      }
      let verified: string | null
      try {
        const verifyUser = input.verifyUser ?? verifyGitLabNetworkProfileToken
        verified = normalizeGitLabNetworkUser((await verifyUser(input.token, host)) ?? '')
      } catch {
        throw new Error('GitLab token identity could not be verified.')
      }
      if (verified !== user) {
        throw new Error('GitLab token identity does not match the selected user.')
      }
      if (input.signal?.aborted) {
        throw new Error('GitLab profile save was cancelled.')
      }
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      if (!oldProfile && listProfiles().length >= MAX_PROFILES) {
        throw new Error('Too many saved GitLab profiles.')
      }
      const profile: GitLabNetworkProfile = {
        id,
        host,
        user,
        generation: randomUUID()
      }
      const payload = JSON.stringify({ ...profile, token: input.token })
      const sealed = store.encryptString(payload)
      const nextTokenPath = tokenPath(id, profile.generation)
      writeCredentialFileAtomic(nextTokenPath, sealed)
      try {
        const published = writeCredentialFileAtomic(
          metadataPath(id),
          Buffer.from(JSON.stringify(profile)),
          () =>
            !input.signal?.aborted &&
            removalEpoch() === expectedRemovalEpoch &&
            readProfile(metadataPath(id), id)?.generation === expectedGeneration
        )
        if (!published) {
          throw new Error('GitLab profile changed before save.')
        }
      } catch {
        unlinkSync(nextTokenPath)
        throw new Error('GitLab profile could not be saved.')
      }
      if (oldProfile) {
        try {
          unlinkSync(tokenPath(id, oldProfile.generation))
        } catch {
          // The old generation is no longer selectable.
        }
      }
      return profile
    },
    readToken(binding: GitLabNetworkProfile): string {
      requireProtection(store)
      if (
        !isGitLabNetworkProfile(binding) ||
        profileId(binding.host, binding.user) !== binding.id
      ) {
        throw new Error('Invalid GitLab profile binding.')
      }
      const current = readProfile(metadataPath(binding.id), binding.id)
      if (
        !current ||
        current.host !== binding.host ||
        current.user !== binding.user ||
        current.generation !== binding.generation
      ) {
        throw new Error('Selected GitLab profile is unavailable on this host.')
      }
      try {
        const parsed: unknown = JSON.parse(
          store.decryptString(readFileSync(tokenPath(binding.id, binding.generation)))
        )
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Object.keys(parsed).sort().join(',') !== 'generation,host,id,token,user' ||
          !('id' in parsed) ||
          parsed.id !== binding.id ||
          !('host' in parsed) ||
          parsed.host !== binding.host ||
          !('user' in parsed) ||
          parsed.user !== binding.user ||
          !('generation' in parsed) ||
          parsed.generation !== binding.generation ||
          !('token' in parsed) ||
          typeof parsed.token !== 'string' ||
          !parsed.token
        ) {
          throw new Error('Invalid sealed profile')
        }
        return parsed.token
      } catch {
        throw new Error('Selected GitLab profile credential is unavailable.')
      }
    },
    remove(binding: GitLabNetworkProfile): void {
      if (
        !isGitLabNetworkProfile(binding) ||
        profileId(binding.host, binding.user) !== binding.id
      ) {
        throw new Error('Invalid GitLab profile binding.')
      }
      const current = readProfile(metadataPath(binding.id), binding.id)
      if (!current || current.generation !== binding.generation) {
        throw new Error('Selected GitLab profile changed before removal.')
      }
      writeCredentialFileAtomic(removalEpochPath, Buffer.from(randomUUID()))
      unlinkSync(metadataPath(binding.id))
      try {
        unlinkSync(tokenPath(binding.id, binding.generation))
      } catch {
        // No metadata points at this generation after removal.
      }
    }
  }
}
