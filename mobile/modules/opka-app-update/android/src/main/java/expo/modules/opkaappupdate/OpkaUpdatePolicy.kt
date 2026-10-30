package expo.modules.opkaappupdate

import java.net.URL

internal object OpkaUpdatePolicy {
  fun downloadAddress(address: String, redirects: Int): URL {
    require(redirects in 0..5) { "Too many update redirects." }
    val url = URL(address)
    require(url.protocol == "https" && url.userInfo == null && url.port == -1 &&
      url.host in setOf("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")) {
      "Untrusted update download address."
    }
    return url
  }

  fun redirectAddress(origin: URL, location: String?, redirects: Int): URL {
    require(!location.isNullOrBlank()) { "Update redirect has no destination." }
    return downloadAddress(URL(origin, location).toString(), redirects)
  }

  fun verifyChecksum(actualBytes: Long, expectedBytes: Long, actualHash: String, expectedHash: String) {
    require(actualBytes == expectedBytes && actualHash == expectedHash && Regex("[a-f0-9]{64}").matches(expectedHash)) {
      "Update checksum mismatch. Please retry."
    }
  }

  fun verifyIdentity(
    packageName: String?, versionName: String?, versionCode: Long,
    expectedVersion: String, expectedCode: Long, installedCode: Long,
    installedCertificates: Set<String>, archiveCertificates: Set<String>, expectedCertificate: String
  ) {
    require(packageName == "com.kosfin.opka.mobile" && versionName == expectedVersion && versionCode == expectedCode) {
      "APK package or version mismatch."
    }
    require(expectedCode > installedCode) { "This update is already installed or older." }
    require(installedCertificates == archiveCertificates && archiveCertificates == setOf(expectedCertificate) && Regex("[a-f0-9]{64}").matches(expectedCertificate)) {
      "Update signing identity does not match this installation."
    }
  }
}
