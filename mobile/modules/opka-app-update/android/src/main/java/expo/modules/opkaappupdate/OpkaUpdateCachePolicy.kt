package expo.modules.opkaappupdate

object OpkaUpdateCachePolicy {
  private const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000
  const val MAX_PENDING_ARTIFACTS = 2

  fun artifactName(version: Long, hash: String): String {
    require(version > 0 && Regex("[a-f0-9]{64}").matches(hash)) { "Invalid update artifact identity." }
    return "update-$version-$hash.apk"
  }

  fun artifactVersion(name: String): Long? {
    return Regex("update-(\\d+)-[a-f0-9]{64}\\.apk").matchEntire(name)?.groupValues?.get(1)?.toLongOrNull()
  }

  fun allowsArtifact(existingNames: List<String>, requestedName: String): Boolean {
    return requestedName in existingNames || existingNames.count { it == "update.apk" || artifactVersion(it) != null } < MAX_PENDING_ARTIFACTS
  }

  fun shouldDelete(installed: Long, target: Long?, modified: Long, now: Long): Boolean {
    return (target != null && installed >= target) || (modified > 0 && now - modified > MAX_AGE_MS)
  }

  fun legacyArchiveTarget(packageName: String?, version: Long?): Long? {
    return version?.takeIf { packageName == "com.kosfin.opka.mobile" && it > 0 }
  }
}
