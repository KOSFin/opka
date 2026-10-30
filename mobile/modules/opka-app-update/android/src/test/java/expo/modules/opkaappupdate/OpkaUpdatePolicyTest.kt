package expo.modules.opkaappupdate

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class OpkaUpdatePolicyTest {
  private val certificate = "a".repeat(64)
  private fun verify(packageName: String = "com.kosfin.opka.mobile", code: Long = 2,
    installedCode: Long = 1, archiveCertificates: Set<String> = setOf(certificate)) {
    OpkaUpdatePolicy.verifyIdentity(packageName, "1.4.236-rc.6", code,
      "1.4.236-rc.6", 2, installedCode, setOf(certificate), archiveCertificates, certificate)
  }

  @Test fun acceptsNewerSameKeyPackage() { verify() }
  @Test fun refusesWrongPackage() { assertThrows(IllegalArgumentException::class.java) { verify(packageName = "com.stably.orca.mobile") } }
  @Test fun refusesWrongKey() { assertThrows(IllegalArgumentException::class.java) { verify(archiveCertificates = setOf("b".repeat(64))) } }
  @Test fun refusesMissingSigner() { assertThrows(IllegalArgumentException::class.java) { verify(archiveCertificates = emptySet()) } }
  @Test fun refusesExtraSigner() { assertThrows(IllegalArgumentException::class.java) { verify(archiveCertificates = setOf(certificate, "b".repeat(64))) } }
  @Test fun refusesOlderVersion() { assertThrows(IllegalArgumentException::class.java) { verify(installedCode = 3) } }
  @Test fun refusesIncorrectVersionCode() { assertThrows(IllegalArgumentException::class.java) { verify(code = 3) } }
  @Test fun acceptsMatchingChecksum() { OpkaUpdatePolicy.verifyChecksum(100, 100, certificate, certificate) }
  @Test fun refusesWrongHash() { assertThrows(IllegalArgumentException::class.java) { OpkaUpdatePolicy.verifyChecksum(100, 100, certificate, "b".repeat(64)) } }
  @Test fun refusesTruncatedFile() { assertThrows(IllegalArgumentException::class.java) { OpkaUpdatePolicy.verifyChecksum(99, 100, certificate, certificate) } }

  @Test fun acceptsGitHubAssetRedirect() {
    val origin = OpkaUpdatePolicy.downloadAddress("https://github.com/KOSFin/opka/releases/download/v1.4.236-rc.6/opka-android.apk", 0)
    assertEquals("release-assets.githubusercontent.com", OpkaUpdatePolicy.redirectAddress(origin,
      "https://release-assets.githubusercontent.com/release.apk?signature=fixture", 1).host)
  }
  @Test fun refusesUntrustedDownloadAddresses() {
    for (address in listOf("http://github.com/asset", "https://github.com.evil.test/asset",
      "https://user@github.com/asset", "https://github.com:443/asset", "https://127.0.0.1/asset")) {
      assertThrows(IllegalArgumentException::class.java) { OpkaUpdatePolicy.downloadAddress(address, 0) }
    }
  }
  @Test fun refusesRedirectDowngradeAndMissingLocation() {
    val origin = OpkaUpdatePolicy.downloadAddress("https://github.com/asset", 0)
    for (location in listOf(null, "", "http://github.com/asset", "https://evil.test/asset")) {
      assertThrows(IllegalArgumentException::class.java) { OpkaUpdatePolicy.redirectAddress(origin, location, 1) }
    }
  }
  @Test fun refusesRedirectLoop() {
    assertThrows(IllegalArgumentException::class.java) {
      OpkaUpdatePolicy.downloadAddress("https://github.com/asset", 6)
    }
  }
}
