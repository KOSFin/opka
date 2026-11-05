import { NativeCliControlError } from '../../shared/native-cli-control-error'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'
import type { AgentSessionStoreState } from './agent-session-store-state'

export const NATIVE_STDIO_RETAINED_RECORD_LIMIT = 512
const PREFIX = 'native_stdio_'

/** Unknown internal rows consume capacity until their ownership can be reviewed safely. */
export function assertNativeStdioRecordCapacity(
  state: AgentSessionStoreState,
  request: AgentSessionReserveRequest
): void {
  if (
    request.operation.callerKey !== 'native-stdio' ||
    !request.sessionId.startsWith(PREFIX) ||
    state.records.has(request.sessionId) ||
    state.unreadableRecords.has(request.sessionId)
  ) {
    return
  }
  let retained = 0
  for (const id of state.records.keys()) {
    if (id.startsWith(PREFIX) && ++retained >= NATIVE_STDIO_RETAINED_RECORD_LIMIT) {
      throw new NativeCliControlError('retention_full')
    }
  }
  for (const id of state.unreadableRecords.keys()) {
    if (
      id.startsWith(PREFIX) &&
      !state.records.has(id) &&
      ++retained >= NATIVE_STDIO_RETAINED_RECORD_LIMIT
    ) {
      throw new NativeCliControlError('retention_full')
    }
  }
}
