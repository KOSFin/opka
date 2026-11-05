import { opendirSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeNativeRefreshSources } from '../claude-accounts/claude-native-refresh-sources'
import { assertClaudeProfileDescendant } from '../claude-accounts/claude-profile-paths'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type { OrchestrationDb } from './orchestration/db/orchestration-db'
import {
  attachClaudeNativeAccountPoolEpoch,
  beginNativeAccountPoolEpoch,
  readNativeAccountPoolPartition
} from './orchestration/db/account-pool-native-fences'
import { NativeCliControlError } from '../../shared/native-cli-control-error'

/** Retained facades stay owned by their old launch; a new host may allocate only fresh scopes. */
export function createClaudeNativePoolScopeRegistry(options: {
  db: OrchestrationDb
  sources: Pick<ClaudeNativeRefreshSources, 'assertOwned' | 'assertWriterIdle'>
  dataRoot: string
}) {
  let registry: ReturnType<typeof beginNativeAccountPoolEpoch> | undefined
  const facadeCount = () => {
    const namespace = join(options.dataRoot, 'native-cli-sessions', 'claude-profiles')
    assertClaudeProfileDescendant(options.dataRoot, namespace)
    let directory: ReturnType<typeof opendirSync>
    try {
      directory = opendirSync(namespace)
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        return 0
      }
      throw error
    }
    let count = 0
    try {
      while (directory.readSync()) {
        if (++count >= 128) {
          throw new NativeCliControlError('capacity')
        }
      }
      return count
    } finally {
      directory.closeSync()
    }
  }
  const assertIdle = (retaining: boolean) => {
    options.sources.assertWriterIdle()
    if (
      options.db.db
        .prepare(`SELECT 1 FROM account_pool_assignments
      WHERE provider='claude' AND released_at IS NULL
      AND owner_key >= 'native-cli:' AND owner_key < 'native-cli;' LIMIT 1`)
        .get()
    ) {
      throw new NativeCliControlError('recovery_required')
    }
    if (facadeCount() && !retaining) {
      throw new NativeCliControlError('recovery_required')
    }
    options.sources.assertWriterIdle()
  }
  const establish = () => {
    const state = readNativeAccountPoolPartition(options.db.db, 'claude')
    const retaining = state.scopes > 0 || state.activeAssignments > 0 || facadeCount() > 0
    if (state.epoch === null && retaining) {
      throw new NativeCliControlError('recovery_required')
    }
    const proof = {
      assertExclusive: () => options.sources.assertOwned(),
      assertWriterIdle: () => assertIdle(retaining && state.epoch !== null)
    }
    return state.epoch !== null && retaining
      ? attachClaudeNativeAccountPoolEpoch(options.db.db, proof)
      : beginNativeAccountPoolEpoch(options.db.db, proof, 'claude')
  }
  return {
    registerScope() {
      options.sources.assertOwned()
      facadeCount()
      registry ??= establish()
      return registry.registerScope()
    }
  }
}
