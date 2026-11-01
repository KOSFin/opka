package expo.modules.opkaappupdate

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotEquals
import org.junit.Test

class OpkaUpdateCachePolicyTest {
  @Test fun removesInstalledUpdateButKeepsPendingInstallerFile() {
    assertTrue(OpkaUpdateCachePolicy.shouldDelete(20, 20, 100, 200))
    assertFalse(OpkaUpdateCachePolicy.shouldDelete(19, 20, 100, 200))
  }
  @Test fun expiresAbandonedAndPartialFiles() {
    assertTrue(OpkaUpdateCachePolicy.shouldDelete(19, null, 100, 100 + 8L * 24 * 60 * 60 * 1000))
    assertFalse(OpkaUpdateCachePolicy.shouldDelete(19, null, 100, 200))
  }

  @Test fun installUrisDifferAcrossVersionsAndHashes() {
    val first = OpkaUpdateCachePolicy.artifactName(20, "a".repeat(64))
    assertNotEquals(first, OpkaUpdateCachePolicy.artifactName(21, "a".repeat(64)))
    assertNotEquals(first, OpkaUpdateCachePolicy.artifactName(20, "b".repeat(64)))
    assertEquals(20L, OpkaUpdateCachePolicy.artifactVersion(first))
    assertNull(OpkaUpdateCachePolicy.artifactVersion("other-20.apk"))
  }

  @Test fun boundedCacheAllowsRetryWithoutEvictingInstallerUris() {
    val first = OpkaUpdateCachePolicy.artifactName(20, "a".repeat(64))
    val second = OpkaUpdateCachePolicy.artifactName(21, "b".repeat(64))
    val third = OpkaUpdateCachePolicy.artifactName(22, "c".repeat(64))
    assertTrue(OpkaUpdateCachePolicy.allowsArtifact(listOf(first), second))
    assertTrue(OpkaUpdateCachePolicy.allowsArtifact(listOf(first, second), first))
    assertFalse(OpkaUpdateCachePolicy.allowsArtifact(listOf(first, second), third))
    assertFalse(OpkaUpdateCachePolicy.allowsArtifact(listOf("update.apk", first), second))
    assertTrue(OpkaUpdateCachePolicy.allowsArtifact(listOf("orphan.part", first), second))
  }

  @Test fun receiptlessLegacyArchiveOnlyProvesOwnInstalledVersion() {
    val ownInstalled = OpkaUpdateCachePolicy.legacyArchiveTarget("com.kosfin.opka.mobile", 20)
    assertTrue(OpkaUpdateCachePolicy.shouldDelete(20, ownInstalled, 100, 200))
    val pending = OpkaUpdateCachePolicy.legacyArchiveTarget("com.kosfin.opka.mobile", 21)
    assertFalse(OpkaUpdateCachePolicy.shouldDelete(20, pending, 100, 200))
    val other = OpkaUpdateCachePolicy.legacyArchiveTarget("com.other.app", 19)
    assertNull(other)
    assertFalse(OpkaUpdateCachePolicy.shouldDelete(20, other, 100, 200))
    val unreadable = OpkaUpdateCachePolicy.legacyArchiveTarget(null, null)
    assertFalse(OpkaUpdateCachePolicy.shouldDelete(20, unreadable, 100, 200))
    assertTrue(OpkaUpdateCachePolicy.shouldDelete(20, unreadable, 100, 100 + 8L * 24 * 60 * 60 * 1000))
  }
  @Test fun newlineReceiptCleansInstalledButPreservesPendingArtifact() {
    val target = OpkaUpdateCachePolicy.legacyTarget(" 104236006\n") {
      throw AssertionError("Valid receipt must not parse the APK archive")
    }
    assertEquals(104236006L, target)
    assertEquals(104236006L, OpkaUpdateCachePolicy.receiptTarget(" ".repeat(54) + "104236006\n"))
    assertFalse(OpkaUpdateCachePolicy.shouldDelete(104236005, target, 100, 200))
    assertTrue(OpkaUpdateCachePolicy.shouldDelete(104236006, target, 100, 200))
  }

  @Test fun invalidReceiptsUseOnlyOwnArchiveIdentity() {
    for (receipt in listOf(null, "", "zero", "0", "-1", "9223372036854775808", " ".repeat(55) + "104236006\n")) {
      assertNull(OpkaUpdateCachePolicy.receiptTarget(receipt))
      val own = OpkaUpdateCachePolicy.legacyTarget(receipt) { "com.kosfin.opka.mobile" to 20L }
      assertTrue(OpkaUpdateCachePolicy.shouldDelete(20, own, 100, 200))
      val pending = OpkaUpdateCachePolicy.legacyTarget(receipt) { "com.kosfin.opka.mobile" to 21L }
      assertFalse(OpkaUpdateCachePolicy.shouldDelete(20, pending, 100, 200))
      val other = OpkaUpdateCachePolicy.legacyTarget(receipt) { "com.other.app" to 19L }
      assertNull(other)
      assertFalse(OpkaUpdateCachePolicy.shouldDelete(20, other, 100, 200))
      val unreadable = OpkaUpdateCachePolicy.legacyTarget(receipt) { null to null }
      assertNull(unreadable)
      assertFalse(OpkaUpdateCachePolicy.shouldDelete(20, unreadable, 100, 200))
      assertTrue(OpkaUpdateCachePolicy.shouldDelete(20, unreadable, 100, 100 + 8L * 24 * 60 * 60 * 1000))
    }
  }

}
