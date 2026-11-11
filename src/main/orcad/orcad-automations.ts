/**
 * orcad executes the profile's schedules, as `orca serve` on Electron does. Without this a
 * persisted or migrated automation lists fine but never runs, and "Run now" has no service.
 */
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { createRuntimeAutomationService } from '../automations/runtime-automation-service'
import { isFinalAutomationRunStatus } from '../../shared/automations-types'
import { probeLinuxAutomationHost } from '../automations/automation-linux-host-probe'

type AutomationStore = Pick<Store, 'listAutomations' | 'listAutomationRuns'>

let stopScheduler: (() => void) | null = null

export async function startOrcadAutomations(
  runtime: OrcaRuntimeService,
  store: Store,
  registerCleanup: (cleanup: () => void) => void,
  profileRoot?: string
): Promise<void> {
  let generation: number | null = null
  if (profileRoot) {
    try {
      const runtimeId = runtime.getRuntimeId()
      const epoch = store.advanceCommandHostEpoch()
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      const stillOwns = () =>
        runtime.getRuntimeId() === runtimeId && store.getCommandHostEpoch() === epoch
      if (
        await probeLinuxAutomationHost({
          root: profileRoot,
          hostEpoch: epoch,
          runtimeId,
          stillOwns
        })
      ) {
        generation = epoch
      }
    } catch {
      generation = null
    }
  }
  const service = createRuntimeAutomationService({
    store,
    runtime,
    headless: true,
    ...(generation ? { verifiedCommandHost: { generation } } : {})
  })
  stopScheduler = () => service.stop()
  // Stops before the store flushes, so no run is written after the final profile save.
  registerCleanup(() => service.stop())
  service.start()
}

/** Halts scheduling and in-flight dispatch; a no-op before the service starts. */
export function stopOrcadAutomationScheduler(): void {
  stopScheduler?.()
}

/** Busy while a schedule may fire or a run has not settled; idling out would skip both. */
export function orcadAutomationsKeepHostBusy(store: AutomationStore): boolean {
  return (
    store.listAutomations().some((automation) => automation.enabled) ||
    store.listAutomationRuns().some((run) => !isFinalAutomationRunStatus(run.status))
  )
}
