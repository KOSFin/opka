package expo.modules.opkaappupdate

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

object OpkaUpdateCacheCleanup {
  private val running = AtomicBoolean(false)
  private val completions = mutableListOf<() -> Unit>()

  fun run(context: Context, onFinished: () -> Unit = {}) {
    if (Build.VERSION.SDK_INT < 28 || context.packageName != "com.kosfin.opka.mobile") {
      onFinished()
      return
    }
    synchronized(completions) {
      completions.add(onFinished)
      if (!running.compareAndSet(false, true)) return
    }
    val application = context.applicationContext
    try {
      Thread({
        try {
          OpkaUpdateTransaction.whenIdle { cleanDirectory(application) }
        } finally { finishCompletions() }
      }, "opka-update-cache-cleanup").apply { isDaemon = true }.start()
    } catch (_: Throwable) { finishCompletions() }
  }

  private fun finishCompletions() {
    val pending = synchronized(completions) {
      completions.toList().also {
        completions.clear()
        running.set(false)
      }
    }
    pending.forEach { runCatching { it() } }
  }

  private fun readReceipt(receipt: File): String? = runCatching {
    if (!receipt.isFile) return@runCatching null
    receipt.inputStream().use { input ->
      val bytes = ByteArrayOutputStream(OpkaUpdateCachePolicy.MAX_RECEIPT_BYTES)
      repeat(OpkaUpdateCachePolicy.MAX_RECEIPT_BYTES + 1) {
        val next = input.read()
        if (next < 0) return@use bytes.toString("UTF-8")
        bytes.write(next)
      }
      null
    }
  }.getOrNull()

  internal fun cleanDirectory(context: Context) {
    runCatching {
      val directory = File(context.cacheDir, "opka-updates")
      val apk = File(directory, "update.apk")
      val receipt = File(directory, "version-code")
      val target = OpkaUpdateCachePolicy.legacyTarget(readReceipt(receipt)) {
        val archive = if (apk.isFile) runCatching { context.packageManager.getPackageArchiveInfo(apk.path, 0) }.getOrNull() else null
        archive?.packageName to archive?.longVersionCode
      }
      val current = context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode
      directory.listFiles()?.forEach { file ->
        val version = OpkaUpdateCachePolicy.artifactVersion(file.name)
        if (file.name.endsWith(".part") || (version != null && OpkaUpdateCachePolicy.shouldDelete(current, version, file.lastModified(), System.currentTimeMillis()))) {
          file.delete()
        }
      }
      if (OpkaUpdateCachePolicy.shouldDelete(current, target, apk.lastModified(), System.currentTimeMillis())) {
        apk.delete()
        receipt.delete()
      }
    }
  }
}

class OpkaUpdateCleanupReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
      val pending = goAsync()
      OpkaUpdateCacheCleanup.run(context) { pending?.finish() }
    }
  }
}
