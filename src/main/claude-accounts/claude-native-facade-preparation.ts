import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describeClaudeProfile } from './claude-profile-paths'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

export function assertClaudeNativeFacadeAbsent(directory: string): void {
  try {
    lstatSync(directory)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return
    }
    throw new Error('Claude native session preparation is unverifiable.')
  }
  throw new Error(
    'A retained native Claude session already owns this profile; restart with a fresh launch.'
  )
}

export function assertClaudeNativeFacadeForLaunchAbsent(dataRoot: string, launchId: string): void {
  const profile = describeClaudeProfile(join(dataRoot, 'native-cli-sessions'), launchId, {
    runtime: 'host',
    executionHostId: 'local'
  })
  assertClaudeNativeFacadeAbsent(dirname(profile.home))
}

function fingerprint(directory: string): string {
  const hash = createHash('sha256'),
    pending = [directory]
  let count = 0,
    bytes = 0
  while (pending.length) {
    const path = pending.pop()
    if (!path) {
      break
    }
    const stat = lstatSync(path, { bigint: true })
    if (++count > 256) {
      throw new Error('Native facade preparation inventory exceeds its bound.')
    }
    hash.update(
      JSON.stringify([
        path,
        stat.dev.toString(),
        stat.ino.toString(),
        stat.mode.toString(),
        stat.size.toString(),
        stat.mtimeNs.toString(),
        stat.ctimeNs.toString()
      ])
    )
    if (stat.isSymbolicLink()) {
      hash.update(readlinkSync(path))
    } else if (stat.isDirectory()) {
      pending.push(
        ...readdirSync(path)
          .sort()
          .map((entry) => join(path, entry))
      )
    } else if (stat.isFile()) {
      bytes += Number(stat.size)
      if (bytes > 4 * 1024 * 1024) {
        throw new Error('Native facade preparation bytes exceed their bound.')
      }
      hash.update(readFileSync(path))
    } else {
      throw new Error('Native facade preparation contains an unknown entry.')
    }
  }
  return hash.digest('hex')
}

/** Only an unchanged, privately created generation can be removed before any native child exists. */
export function createClaudeNativeFacadePreparation(
  directory: string,
  assertExclusive: () => void
) {
  assertExclusive()
  assertClaudeNativeFacadeAbsent(directory)
  let checkpoint: string | undefined
  return {
    checkpoint() {
      assertExclusive()
      checkpoint = fingerprint(directory)
    },
    rollback() {
      if (!checkpoint) {
        return
      }
      try {
        assertExclusive()
        if (fingerprint(directory) !== checkpoint) {
          return
        }
        assertExclusive()
        rmSync(directory, { recursive: true })
      } catch {
        /* Unknown ownership or changed files retain the bounded recovery generation. */
      }
    }
  }
}
