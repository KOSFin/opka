package expo.modules.opkaappupdate

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import java.io.ByteArrayOutputStream
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import org.json.JSONObject

private const val ROOT = "https://github.com/KOSFin/opka/releases/download/"
private const val PACKAGE = "com.kosfin.opka.mobile"
private const val MAX_APK_BYTES = 512L * 1024 * 1024

class OpkaAppUpdateModule : Module() {
  @Volatile private var activeAttempt: OpkaUpdateTransaction.Attempt? = null
  @Volatile private var destroyed = false

  override fun definition() = ModuleDefinition {
    Name("OpkaAppUpdate")
    Events("onInstallProgress")
    OnCreate {
      appContext.reactContext?.let { OpkaUpdateCacheCleanup.run(it) }
    }
    OnDestroy {
      destroyed = true
      activeAttempt?.cancel()
    }
    AsyncFunction("install") { manifestUrl: String ->
      check(!destroyed) { "The update screen was closed. Please retry." }
      val attempt = OpkaUpdateTransaction.begin()
      activeAttempt = attempt
      try {
        if (destroyed) attempt.cancel()
        attempt.checkActive()
        install(manifestUrl, attempt)
      } finally {
        activeAttempt = null
        OpkaUpdateTransaction.finish(attempt)
      }
    }
  }

  private fun install(manifestUrl: String, attempt: OpkaUpdateTransaction.Attempt) {
    check(Build.VERSION.SDK_INT >= 28) { "Verified Opka updates require Android 9 or newer." }
    val context = requireNotNull(appContext.reactContext)
    check(context.packageName == PACKAGE) { "This installer is only for Opka." }
    val match = Regex("https://github\\.com/KOSFin/opka/releases/download/v(\\d+\\.\\d+\\.\\d+-rc\\.[1-9]\\d*)/latest-android\\.json").matchEntire(manifestUrl)
    requireNotNull(match) { "Invalid Opka update channel." }
    val version = match.groupValues[1]
    val manifest = JSONObject(download(manifestUrl, 65536, attempt).toString(Charsets.UTF_8))
    val apkUrl = "${ROOT}v$version/opka-android.apk"
    require(manifest.getInt("schemaVersion") == 1 && manifest.getString("packageName") == PACKAGE && manifest.getString("version") == version && manifest.getString("url") == apkUrl) { "Update identity mismatch." }
    val bytes = manifest.getLong("bytes")
    require(bytes in 1..MAX_APK_BYTES) { "Invalid update size." }
    val manager = context.packageManager
    val installed = manager.getPackageInfo(PACKAGE, PackageManager.GET_SIGNING_CERTIFICATES)
    val versionCode = manifest.getLong("versionCode")
    require(versionCode > installed.longVersionCode) { "This update is already installed or older." }
    if (!manager.canRequestPackageInstalls()) {
      context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$PACKAGE")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      error("Allow Opka to request app installs in Android settings, then tap Retry. No APK has been downloaded.")
    }
    val directory = File(context.cacheDir, "opka-updates").apply { mkdirs() }
    OpkaUpdateCacheCleanup.cleanDirectory(context)
    val apk = File(directory, OpkaUpdateCachePolicy.artifactName(versionCode, manifest.getString("sha256")))
    val reusable = apk.isFile
    if (!reusable) {
      check(OpkaUpdateCachePolicy.allowsArtifact(directory.list()?.toList() ?: emptyList(), apk.name)) { "Two updates are still awaiting Android installation. Finish the earlier installation before downloading another version." }
    }
    val partial = File(directory, "${UUID.randomUUID()}.part")
    val candidate = if (reusable) apk else partial
    try {
      val hash = MessageDigest.getInstance("SHA-256")
      var count = 0L
      var lastProgressAt = 0L
      val connection = if (reusable) null else OpkaUpdateConnection.open(apkUrl, attempt)
      try {
        val input = connection?.inputStream ?: apk.inputStream()
        input.use {
          val output = if (reusable) null else partial.outputStream()
          try {
            val buffer = ByteArray(65536)
            while (true) {
              attempt.checkActive()
              val read = it.read(buffer)
              if (read < 0) break
              count += read
              if (count > bytes) {
                OpkaUpdateArtifactVerification.reject(candidate, "Update exceeds its declared size.")
              }
              hash.update(buffer, 0, read)
              output?.write(buffer, 0, read)
              val now = SystemClock.elapsedRealtime()
              if (now - lastProgressAt >= 250 || count == bytes) {
                sendEvent("onInstallProgress", mapOf("phase" to "downloading", "downloadedBytes" to count, "totalBytes" to bytes))
                lastProgressAt = now
              }
            }
          } finally { output?.close() }
        }
      } finally { connection?.let { OpkaUpdateConnection.release(it, attempt) } }
      attempt.checkActive()
      sendEvent("onInstallProgress", mapOf("phase" to "verifying"))
      val currentCerts = requireNotNull(installed.signingInfo).apkContentsSigners.map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }.toSet()
      OpkaUpdateArtifactVerification.verify(candidate) {
        OpkaUpdatePolicy.verifyChecksum(count, bytes, hex(hash.digest()), manifest.getString("sha256"))
        val archive = requireNotNull(manager.getPackageArchiveInfo(candidate.path, PackageManager.GET_SIGNING_CERTIFICATES)) { "Invalid APK." }
        val updateCerts = requireNotNull(archive.signingInfo).apkContentsSigners.map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }.toSet()
        OpkaUpdatePolicy.verifyIdentity(archive.packageName, archive.versionName, archive.longVersionCode,
          version, versionCode, installed.longVersionCode, currentCerts, updateCerts, manifest.getString("certificateSha256"))
      }
      attempt.handoff {
        // Published APK paths are immutable while Android may still read their URI.
        if (!reusable) check(!apk.exists() && partial.renameTo(apk)) { "Could not prepare the verified update. Please retry." }
        val uri = FileProvider.getUriForFile(context, "$PACKAGE.opka-updates", apk)
        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    } finally {
      partial.delete()
    }
  }

  private fun download(url: String, limit: Int, attempt: OpkaUpdateTransaction.Attempt): ByteArray {
    val connection = OpkaUpdateConnection.open(url, attempt)
    try {
      return connection.inputStream.use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
          attempt.checkActive()
          val count = input.read(buffer)
          if (count < 0) break
          require(output.size() + count <= limit) { "Update metadata is too large." }
          output.write(buffer, 0, count)
        }
        output.toByteArray()
      }
    } finally { OpkaUpdateConnection.release(connection, attempt) }
  }

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
}
