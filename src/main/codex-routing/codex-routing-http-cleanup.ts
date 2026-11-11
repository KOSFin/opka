import type { CodexReplaySpool } from './codex-replay-spool'
import type { CodexHttpAccountRoute, CodexRoutingHttpOptions } from './codex-routing-http-types'

export async function finishCodexRoutingRequest(
  options: CodexRoutingHttpOptions,
  route: CodexHttpAccountRoute | undefined,
  replay: CodexReplaySpool | undefined,
  providerPossible: boolean,
  positiveTerminal: boolean
): Promise<void> {
  try {
    if (providerPossible && !positiveTerminal && route?.holdUntilOwnerExit) {
      const held = route.holdUntilOwnerExit()
      if (held) {
        void held.then(
          async () => {
            try {
              await replay?.dispose()
              route?.finish()
            } catch {
              options.onCleanupUnverifiable()
            }
          },
          () => options.onCleanupUnverifiable()
        )
      }
      options.onCleanupUnverifiable()
    } else {
      await replay?.dispose()
      route?.finish()
    }
  } catch {
    try {
      options.onCleanupUnverifiable()
    } catch {
      /* A diagnostic cannot keep a request slot live. */
    }
  }
}
