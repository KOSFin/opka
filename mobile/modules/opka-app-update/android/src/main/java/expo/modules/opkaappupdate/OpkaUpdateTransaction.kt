package expo.modules.opkaappupdate

import java.net.HttpURLConnection
import java.util.concurrent.CancellationException

internal object OpkaUpdateTransaction {
  private var active: Attempt? = null

  @Synchronized fun begin(): Attempt {
    check(active == null) { "An update download is already running." }
    return Attempt().also { active = it }
  }

  @Synchronized fun finish(attempt: Attempt) {
    if (active === attempt) active = null
  }

  @Synchronized fun whenIdle(cleanup: () -> Unit) {
    if (active == null) cleanup()
  }

  class Attempt {
    private var cancelled = false
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

    @Synchronized fun cancel() {
      cancelled = true
      connection?.disconnect()
      connection = null
    }

    @Synchronized fun handoff(action: () -> Unit) {
      checkActive()
      action()
    }
  }
}
