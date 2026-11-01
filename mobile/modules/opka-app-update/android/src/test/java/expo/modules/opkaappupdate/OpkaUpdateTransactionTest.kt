package expo.modules.opkaappupdate

import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CancellationException
import org.junit.Assert.*
import org.junit.Test

class OpkaUpdateTransactionTest {
  private class Connection : HttpURLConnection(URL("https://github.com/")) {
    var disconnected = 0
    override fun disconnect() { disconnected++ }
    override fun usingProxy() = false
    override fun connect() {}
  }

  @Test fun cancellationKeepsProcessOwnershipUntilWriterActuallyFinishes() {
    val first = OpkaUpdateTransaction.begin()
    try {
      val connection = Connection()
      first.attach(connection)
      first.cancel()
      assertEquals(1, connection.disconnected)
      assertThrows(CancellationException::class.java) { first.checkActive() }
      assertThrows(IllegalStateException::class.java) { OpkaUpdateTransaction.begin() }
      var cleaned = false
      OpkaUpdateTransaction.whenIdle { cleaned = true }
      assertFalse(cleaned)
      var handedOff = false
      assertThrows(CancellationException::class.java) { first.handoff { handedOff = true } }
      assertFalse(handedOff)
    } finally { OpkaUpdateTransaction.finish(first) }
    val second = OpkaUpdateTransaction.begin()
    try {
      OpkaUpdateTransaction.finish(first)
      assertThrows(IllegalStateException::class.java) { OpkaUpdateTransaction.begin() }
    } finally { OpkaUpdateTransaction.finish(second) }
    var cleaned = false
    OpkaUpdateTransaction.whenIdle { cleaned = true }
    assertTrue(cleaned)
  }
}
