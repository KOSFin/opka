import { join } from 'node:path'
import { beginNativeAccountPoolEpoch } from '../runtime/orchestration/db/account-pool-native-fences'
import { assertEngineWriterIdle } from './engine-writer-ownership'
import { CodexEngineLifecycle } from './codex-engine-lifecycle'
import { CodexEngineSessions } from './codex-engine-sessions'
import type { CodexEngineHostOptions } from './codex-engine-host-options'
import type { CodexPoolSelectionState } from './codex-pool-turn-session'
import type { EngineGrantDescriptor } from './engine-grant-files'

/** The registry exists only in the current exclusive host epoch, before its first engine writer. */
export function createCodexEngineNativeSessionLifetime(
  options: CodexEngineHostOptions,
  accepting: () => boolean,
  readState: (launchId: string) => CodexPoolSelectionState,
  connection: (accountId: string) => EngineGrantDescriptor | null,
  onRequestHeld?: () => void
) {
  let epoch: ReturnType<typeof beginNativeAccountPoolEpoch> | undefined
  const lifecycle = new CodexEngineLifecycle({
    ...options,
    onWriterIdleProven() {
      epoch ??= beginNativeAccountPoolEpoch(options.db.db, {
        assertExclusive: options.assertExclusiveProfile,
        assertWriterIdle: () =>
          assertEngineWriterIdle({
            directory: join(options.directory, 'runtime'),
            assertExclusive: options.assertExclusiveProfile
          })
      })
    }
  })
  const sessions = new CodexEngineSessions({
    db: options.db,
    readState,
    accepting,
    onRequestHeld,
    recordQuotaFailure: options.recordQuotaFailure,
    createAssignmentScope() {
      if (!epoch) {
        throw new Error('Native assignment recovery has not been proven')
      }
      return epoch.registerScope()
    },
    route(id) {
      const ready = id ? connection(id) : null
      if (!ready) {
        throw new Error('Native default accounts do not implicitly become engine grants.')
      }
      return lifecycle.route(ready)
    }
  })
  return { lifecycle, sessions }
}
