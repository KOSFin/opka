import { createHash, randomUUID } from 'node:crypto'
import { lstat, opendir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'

const STAGING_SCAN_LIMIT = 4096
const STAGING_REMOVAL_LIMIT = 32
const OWNED_STAGE = /^\.orca-backfill-v2-([a-f0-9]{32})-([1-9][0-9]*)-([a-f0-9-]{36})\.tmp$/

function machineTag(): string | null {
  const machine = profileStateAccessMachineIdentity()
  return machine ? createHash('sha256').update(machine).digest('hex').slice(0, 32) : null
}

export function createCodexSessionStagingPath(directory: string): string {
  const machine = machineTag()
  const owner = machine ? `v2-${machine}-${process.pid}-` : ''
  return join(directory, `.orca-backfill-${owner}${randomUUID()}.tmp`)
}

function processExitedHere(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}

/** Unknown hosts, reused live pids and older unowned stages are never evidence of exit. */
export async function cleanupExitedCodexSessionStages(directory: string): Promise<void> {
  const machine = machineTag()
  if (!machine) {
    return
  }
  try {
    const entries = await opendir(directory)
    let scanned = 0
    let removed = 0
    for await (const entry of entries) {
      if (++scanned > STAGING_SCAN_LIMIT || removed >= STAGING_REMOVAL_LIMIT) {
        break
      }
      const owner = OWNED_STAGE.exec(entry.name)
      if (!owner || owner[1] !== machine || !entry.isFile()) {
        continue
      }
      const pid = Number(owner[2])
      if (!Number.isSafeInteger(pid) || !processExitedHere(pid)) {
        continue
      }
      const file = join(directory, entry.name)
      try {
        const metadata = await lstat(file)
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          continue
        }
        removed += 1
        await rm(file, { force: true })
      } catch (error) {
        console.warn('[codex-session-backfill] Failed to remove exited owner stage:', error)
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      console.warn('[codex-session-backfill] Failed to inspect staged copies:', error)
    }
  }
}
