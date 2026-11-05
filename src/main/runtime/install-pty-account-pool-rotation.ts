import type { OrcaRuntimeService } from './orca-runtime'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { PtyAccountPoolRotation } from './pty-account-pool-rotation'

export function installPtyAccountPoolRotation(
  runtime: OrcaRuntimeService,
  readPty: (
    id: string
  ) => Pick<RuntimePtyWorktreeRecord, 'isWsl' | 'wslDistro' | 'launchConfig'> | undefined
): void {
  const rotation = new PtyAccountPoolRotation(runtime, readPty)
  runtime.agentTransitions.subscribe((change) => rotation.observe(change))
}
