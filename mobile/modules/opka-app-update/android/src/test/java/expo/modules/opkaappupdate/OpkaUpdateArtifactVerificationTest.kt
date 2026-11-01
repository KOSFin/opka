package expo.modules.opkaappupdate

import java.io.File
import java.io.IOException
import java.util.concurrent.CancellationException
import org.junit.Assert.*
import org.junit.Test

class OpkaUpdateArtifactVerificationTest {
  @Test fun corruptedCachedBytesAreRemovedSoRetryDownloadsAgain() {
    val artifact = File.createTempFile("opka-invalid", ".apk")
    try {
      artifact.writeText("corrupt")
      assertThrows(IllegalArgumentException::class.java) {
        OpkaUpdateArtifactVerification.verify(artifact) {
          OpkaUpdatePolicy.verifyChecksum(7, 8, "a".repeat(64), "b".repeat(64))
        }
      }
      assertFalse(artifact.isFile)
      artifact.writeText("replacement")
      OpkaUpdateArtifactVerification.verify(artifact) {
        OpkaUpdatePolicy.verifyChecksum(11, 11, "a".repeat(64), "a".repeat(64))
      }
      assertTrue(artifact.isFile)
    } finally { artifact.delete() }
  }

  @Test fun cancellationAndIoFailureDoNotInvalidateInstallerArtifact() {
    val artifact = File.createTempFile("opka-retained", ".apk")
    try {
      artifact.writeText("verified")
      assertThrows(CancellationException::class.java) {
        OpkaUpdateArtifactVerification.verify(artifact) { throw CancellationException() }
      }
      assertTrue(artifact.isFile)
      assertThrows(IOException::class.java) {
        OpkaUpdateArtifactVerification.verify(artifact) { throw IOException("read interrupted") }
      }
      assertEquals("verified", artifact.readText())
    } finally { artifact.delete() }
  }

  @Test fun wrongSignerInvalidatesCacheBeforeAnyInstallerHandoff() {
    val artifact = File.createTempFile("opka-wrong-signer", ".apk")
    try {
      artifact.writeText("wrong signer")
      assertThrows(IllegalArgumentException::class.java) {
        OpkaUpdateArtifactVerification.verify(artifact) {
          OpkaUpdatePolicy.verifyIdentity("com.kosfin.opka.mobile", "1.4.236-rc.6", 20,
            "1.4.236-rc.6", 20, 19, setOf("a".repeat(64)), setOf("b".repeat(64)), "b".repeat(64))
        }
      }
      assertFalse(artifact.exists())
    } finally { artifact.delete() }
  }
}
