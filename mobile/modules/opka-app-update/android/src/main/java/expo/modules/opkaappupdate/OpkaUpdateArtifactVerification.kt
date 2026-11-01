package expo.modules.opkaappupdate

import java.io.File

internal object OpkaUpdateArtifactVerification {
  fun reject(candidate: File, message: String): Nothing {
    candidate.delete()
    throw IllegalArgumentException(message)
  }

  fun verify(candidate: File, verification: () -> Unit) {
    try {
      verification()
    } catch (invalid: IllegalArgumentException) {
      // A corrupt cached artifact must not poison every later retry.
      candidate.delete()
      throw invalid
    }
  }
}
