package expo.modules.opkaappupdate

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CancellationException
import org.junit.Assert.*
import org.junit.Test

class OpkaUpdateConnectionTest {
  private class Connection(val status: Int = 200, val failure: Boolean = false, val location: String? = null) : HttpURLConnection(URL("https://github.com/")) {
    var disconnected = 0
    override fun getResponseCode(): Int {
      if (failure) throw IOException("response failed")
      return status
    }
    override fun getHeaderField(name: String): String? = if (name == "Location") location else null
    override fun disconnect() { disconnected++ }
    override fun usingProxy() = false
    override fun connect() {}
  }

  @Test fun responseFailureDisconnectsAndRetryCanSucceed() {
    val attempt = OpkaUpdateTransaction.begin()
    try {
      val failed = Connection(failure = true)
      assertThrows(IOException::class.java) { OpkaUpdateConnection.open("https://github.com/", attempt, create = { failed }) }
      assertEquals(1, failed.disconnected)
      val success = Connection()
      assertSame(success, OpkaUpdateConnection.open("https://github.com/", attempt, create = { success }))
      assertEquals(0, success.disconnected)
      OpkaUpdateConnection.release(success, attempt)
      assertEquals(1, success.disconnected)
    } finally { OpkaUpdateTransaction.finish(attempt) }
  }

  @Test fun rejectedRedirectAndHttpErrorReleaseConnections() {
    val attempt = OpkaUpdateTransaction.begin()
    try {
      val redirect = Connection(status = 302, location = "https://untrusted.invalid/update.apk")
      assertThrows(IllegalArgumentException::class.java) { OpkaUpdateConnection.open("https://github.com/", attempt, create = { redirect }) }
      assertEquals(1, redirect.disconnected)
      val failed = Connection(status = 503)
      assertThrows(IllegalStateException::class.java) { OpkaUpdateConnection.open("https://github.com/", attempt, create = { failed }) }
      assertEquals(1, failed.disconnected)
    } finally { OpkaUpdateTransaction.finish(attempt) }
  }

  @Test fun redirectReleasesOldConnectionBeforeOpeningNextAndCancellationRejectsSetup() {
    val attempt = OpkaUpdateTransaction.begin()
    try {
      val redirect = Connection(status = 302, location = "https://release-assets.githubusercontent.com/update.apk")
      val success = Connection()
      var opened = 0
      assertSame(success, OpkaUpdateConnection.open("https://github.com/", attempt, create = {
        if (opened++ == 0) redirect else {
          assertEquals(1, redirect.disconnected)
          success
        }
      }))
      OpkaUpdateConnection.release(success, attempt)
      attempt.cancel()
      val cancelled = Connection()
      assertThrows(CancellationException::class.java) { OpkaUpdateConnection.open("https://github.com/", attempt, create = { cancelled }) }
      assertEquals(1, cancelled.disconnected)
    } finally { OpkaUpdateTransaction.finish(attempt) }
  }
}
