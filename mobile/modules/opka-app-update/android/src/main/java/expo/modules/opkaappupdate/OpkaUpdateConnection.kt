package expo.modules.opkaappupdate

import java.net.HttpURLConnection
import java.net.URL

internal object OpkaUpdateConnection {
  fun open(
    url: String,
    attempt: OpkaUpdateTransaction.Attempt,
    redirects: Int = 0,
    create: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }
  ): HttpURLConnection {
    val parsed = OpkaUpdatePolicy.downloadAddress(url, redirects)
    val connection = create(parsed).apply {
      connectTimeout = 15000
      readTimeout = 30000
      instanceFollowRedirects = false
    }
    var handedOff = false
    val redirect = try {
      attempt.attach(connection)
      val status = connection.responseCode
      attempt.checkActive()
      if (status in setOf(301, 302, 303, 307, 308)) {
        OpkaUpdatePolicy.redirectAddress(parsed, connection.getHeaderField("Location"), redirects + 1)
      } else {
        check(status == 200) { "Update download HTTP $status. Please retry." }
        handedOff = true
        return connection
      }
    } finally {
      if (!handedOff) release(connection, attempt)
    }
    return open(redirect.toString(), attempt, redirects + 1, create)
  }

  fun release(connection: HttpURLConnection, attempt: OpkaUpdateTransaction.Attempt) {
    attempt.detach(connection)
    connection.disconnect()
  }
}
