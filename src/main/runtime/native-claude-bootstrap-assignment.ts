import { z } from 'zod'
import type { NativeCliAccountLaunchRequest } from '../../shared/native-cli-account-launch'
import type { NativeCliTerminalOwner } from './native-cli-terminal-owner'
import type { OrchestrationDb } from './orchestration/db/orchestration-db'

/** Only the terminal creator's disposable admission may transfer into a new native scope. */
export function isNativeClaudeBootstrapOwner(ownerKey: string): boolean {
  return ownerKey.startsWith('pty:') && z.uuid().safeParse(ownerKey.slice(4)).success
}
export function readNativeClaudeBootstrapAssignment(
  db: {
    listAccountPoolAssignments: () => ReturnType<OrchestrationDb['listAccountPoolAssignments']>
  },
  request: Pick<NativeCliAccountLaunchRequest, 'initialAssignmentOwnerKey' | 'accountId'>,
  owner: NativeCliTerminalOwner | null
) {
  const key = request.initialAssignmentOwnerKey
  return owner && key && isNativeClaudeBootstrapOwner(key)
    ? db
        .listAccountPoolAssignments()
        .find(
          (row) =>
            row.ownerKey === key &&
            row.provider === 'claude' &&
            row.ptyId === owner.ptyId &&
            row.incarnationId === owner.incarnationId &&
            (!request.accountId || row.accountId === request.accountId)
        )
    : undefined
}
