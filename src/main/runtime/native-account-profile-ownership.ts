import { join } from 'node:path'
import { ORCAD_LOCK_FILE_NAME, readOrcadInstanceLockRecord } from '../orcad/orcad-instance-lock'

/** Every credential mutation must still belong to the host captured during runtime setup. */
export function captureNativeAccountProfileOwnership(dataRoot: string): () => void {
  const lockPath = join(dataRoot, ORCAD_LOCK_FILE_NAME)
  const owned = readOrcadInstanceLockRecord(lockPath)
  return () => {
    const current = readOrcadInstanceLockRecord(lockPath)
    if (
      !owned ||
      owned.pid !== process.pid ||
      current?.pid !== owned.pid ||
      current.nonce !== owned.nonce
    ) {
      throw new Error('Native account routing requires the execution host to own this profile.')
    }
  }
}
