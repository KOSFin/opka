import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ComputerUsePermissionStatusResult } from '../../../../shared/computer-use-permissions-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

export function readSkillOwnerComputerPermissions(
  target: RuntimeClientTarget
): Promise<ComputerUsePermissionStatusResult> {
  return target.kind === 'local'
    ? window.api.computerUsePermissions.getStatus()
    : callRuntimeRpc<ComputerUsePermissionStatusResult>(target, 'computer.permissionsStatus')
}
