package expo.modules.opkaappupdate

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import java.io.ByteArrayOutputStream
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.HttpURLConnection
import java.security.MessageDigest
import org.json.JSONObject

private const val ROOT = "https://github.com/KOSFin/opka/releases/download/"
private const val PACKAGE = "com.kosfin.opka.mobile"
private const val MAX_APK_BYTES = 512L * 1024 * 1024

class OpkaAppUpdateModule : Module() {
  private var installing = false

  override fun definition() = ModuleDefinition {
    Name("OpkaAppUpdate")
    AsyncFunction("install") { manifestUrl: String ->
      synchronized(this@OpkaAppUpdateModule) {
        check(!installing) { "An update download is already running." }
        installing = true
      }
      try { install(manifestUrl) } finally {
        synchronized(this@OpkaAppUpdateModule) { installing = false }
      }
    }
  }

  private fun install(manifestUrl: String) {
    check(Build.VERSION.SDK_INT >= 28) { "Verified Opka updates require Android 9 or newer." }
    val context = requireNotNull(appContext.reactContext)
    check(context.packageName == PACKAGE) { "This installer is only for Opka." }
    val match = Regex("https://github\\.com/KOSFin/opka/releases/download/v(\\d+\\.\\d+\\.\\d+-rc\\.[1-9]\\d*)/latest-android\\.json").matchEntire(manifestUrl)
    requireNotNull(match) { "Invalid Opka update channel." }
    val version = match.groupValues[1]
    val manifest = JSONObject(download(manifestUrl, 65536).toString(Charsets.UTF_8))
    val apkUrl = "${ROOT}v$version/opka-android.apk"
    require(manifest.getInt("schemaVersion") == 1 && manifest.getString("packageName") == PACKAGE && manifest.getString("version") == version && manifest.getString("url") == apkUrl) { "Update identity mismatch." }
    val bytes = manifest.getLong("bytes")
    require(bytes in 1..MAX_APK_BYTES) { "Invalid update size." }
    val manager = context.packageManager
    val installed = manager.getPackageInfo(PACKAGE, PackageManager.GET_SIGNING_CERTIFICATES)
    val versionCode = manifest.getLong("versionCode")
    require(versionCode > installed.longVersionCode) { "This update is already installed or older." }
    val directory = File(context.cacheDir, "opka-updates").apply { mkdirs() }
    val apk = File(directory, "update.apk")
    apk.delete()
    try {
      val hash = MessageDigest.getInstance("SHA-256")
      var count = 0L
      connection(apkUrl).let { connection ->
        try {
          connection.inputStream.use { input -> apk.outputStream().use { output ->
            val buffer = ByteArray(65536)
            while (true) {
              val read = input.read(buffer)
              if (read < 0) break
              count += read
              require(count <= bytes) { "Update exceeds its declared size." }
              hash.update(buffer, 0, read)
              output.write(buffer, 0, read)
            }
          } }
        } finally { connection.disconnect() }
      }
      OpkaUpdatePolicy.verifyChecksum(count, bytes, hex(hash.digest()), manifest.getString("sha256"))
      val archive = requireNotNull(manager.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNING_CERTIFICATES)) { "Invalid APK." }
      val currentCerts = requireNotNull(installed.signingInfo).apkContentsSigners.map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }.toSet()
      val updateCerts = requireNotNull(archive.signingInfo).apkContentsSigners.map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }.toSet()
      OpkaUpdatePolicy.verifyIdentity(archive.packageName, archive.versionName, archive.longVersionCode,
        version, versionCode, installed.longVersionCode, currentCerts, updateCerts, manifest.getString("certificateSha256"))
      if (!manager.canRequestPackageInstalls()) {
        context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$PACKAGE")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        error("Allow Opka to request app installs in Android settings, then tap Retry.")
      }
      val uri = FileProvider.getUriForFile(context, "$PACKAGE.opka-updates", apk)
      context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (error: Exception) {
      apk.delete()
      throw error
    }
  }

  private fun download(url: String, limit: Int): ByteArray {
    val connection = connection(url)
    try {
      return connection.inputStream.use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          require(output.size() + count <= limit) { "Update metadata is too large." }
          output.write(buffer, 0, count)
        }
        output.toByteArray()
      }
    } finally { connection.disconnect() }
  }

  private fun connection(url: String, redirects: Int = 0): HttpURLConnection {
    val parsed = OpkaUpdatePolicy.downloadAddress(url, redirects)
    val connection = (parsed.openConnection() as HttpURLConnection).apply {
      connectTimeout = 15000
      readTimeout = 30000
      instanceFollowRedirects = false
    }
    val status = connection.responseCode
    if (status in setOf(301, 302, 303, 307, 308)) {
      val location = connection.getHeaderField("Location")
      connection.disconnect()
      return connection(OpkaUpdatePolicy.redirectAddress(parsed, location, redirects + 1).toString(), redirects + 1)
    }
    if (status != 200) {
      connection.disconnect()
      error("Update download HTTP $status. Please retry.")
    }
    return connection
  }

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
}
