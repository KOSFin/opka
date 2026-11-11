package expo.modules.opkaappupdate

import java.net.HttpURLConnection
import java.util.concurrent.CancellationException

internal object OpkaUpdateTransaction {
  private data class Active(val id: String?, val attempt: Attempt)
  private var active: Active? = null

  @Synchronized fun begin(operationId: String? = null): Attempt {
    check(active == null) { "An update download is already running." }
    return Attempt().also { active = Active(operationId, it) }
  }

  @Synchronized fun finish(attempt: Attempt) {
    if (active?.attempt === attempt) {
      attempt.markFinished()
      active = null
    }
  }

  fun cancelMatching(operationId: String): Boolean {
    val attempt = synchronized(this) { active?.takeIf { it.id == operationId }?.attempt }
    return attempt?.cancel() ?: false
  }

  @Synchronized fun whenIdle(cleanup: () -> Unit) {
    if (active == null) cleanup()
  }

  class Attempt {
    private var cancelled = false
    private var finished = false
    private var handoffStarted = false
    private var connection: HttpURLConnection? = null

    @Synchronized fun checkActive() {
      if (cancelled) throw CancellationException("Update download cancelled.")
    }

    @Synchronized fun attach(next: HttpURLConnection) {
      checkActive()
      connection = next
    }

    @Synchronized fun detach(previous: HttpURLConnection) {
      if (connection === previous) connection = null
    }

    @Synchronized fun cancel(): Boolean {
      if (finished || handoffStarted) return false
      cancelled = true
      connection?.disconnect()
      connection = null
      return true
    }

    @Synchronized fun handoff(action: () -> Unit) {
      checkActive()
      handoffStarted = true
      action()
    }

    @Synchronized fun markFinished() {
      finished = true
    }
  }
}
