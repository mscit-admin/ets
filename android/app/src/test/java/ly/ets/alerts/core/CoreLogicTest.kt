package ly.ets.alerts.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CoreLogicTest {
    @Test
    fun fingerprintOfKnownInput() {
        // SHA-256("abc") from FIPS 180-2.
        val expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        assertEquals(expected, Fingerprint.sha256Hex("abc".toByteArray()))
        assertTrue(Fingerprint.matches("abc".toByteArray(), expected))
        assertTrue(Fingerprint.matches("abc".toByteArray(), expected.uppercase().chunked(2).joinToString(":")))
        assertFalse(Fingerprint.matches("abd".toByteArray(), expected))
        assertFalse(Fingerprint.matches("abc".toByteArray(), "not-a-pin"))
        assertNull(Fingerprint.normalize("zz".repeat(32)))
    }

    @Test
    fun baseUrlRules() {
        assertEquals("https://ets.example.local", UrlRules.normalizeBaseUrl("HTTPS://ETS.example.local/"))
        assertEquals("https://h", UrlRules.normalizeBaseUrl("https://h:443"))
        assertEquals("https://h/ets", UrlRules.normalizeBaseUrl("https://h/ets/"))
        listOf("http://h", "ftp://h", "https://", "https://h?x=1", "https://h#f", "h", "").forEach {
            try {
                UrlRules.normalizeBaseUrl(it)
                throw AssertionError("accepted $it")
            } catch (e: IllegalArgumentException) {
                // expected
            }
        }
    }

    @Test
    fun linksStayOnServer() {
        val base = "https://ets.example.local"
        assertEquals("$base/app/123", UrlRules.resolveLink(base, "/app/123"))
        assertEquals("$base/app/1?tab=2", UrlRules.resolveLink(base, "/app/1?tab=2"))
        assertEquals("$base/", UrlRules.resolveLink(base, null))
        assertEquals("$base/", UrlRules.resolveLink(base, "https://evil.example/x"))
        assertEquals("$base/", UrlRules.resolveLink(base, "//evil.example/x"))
        assertEquals("$base/", UrlRules.resolveLink(base, "/\\evil.example"))
        assertEquals("$base/", UrlRules.resolveLink(base, "javascript:alert(1)"))
        assertEquals("$base/", UrlRules.resolveLink(base, "/a b"))
    }

    @Test
    fun backoffDoublesAndCaps() {
        val b = Backoff()
        val seq = (1..10).map { b.next() }
        assertEquals(listOf(2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 64_000L, 128_000L, 256_000L, 300_000L, 300_000L), seq)
        repeat(100) { b.next() }
        assertEquals(300_000L, b.next())
        b.reset()
        assertEquals(2_000L, b.next())
        assertEquals(1_600L, b.withJitter(2_000L, 0.0))
        assertEquals(300_000L, b.withJitter(300_000L, 1.0))
    }

    @Test
    fun parsesAlertPageIncludingStringIds() {
        val page = AlertPage.fromJson(
            JSONObject(
                """
                {"items":[
                  {"id":"41","type":"approval","severity":"critical","title":"T1","body":"B1",
                   "link":"/app/41","created_at":"2026-10-19T10:00:00.000Z","read":false},
                  {"id":42,"type":"x","severity":"weird","title":"T2","body":null,"link":null,
                   "created_at":"2026-10-19 10:00:00","read":true},
                  {"type":"no id"}
                ],"unread":"3"}
                """.trimIndent(),
            ),
        )
        assertEquals(3, page.unread)
        assertEquals(2, page.items.size)
        val a = page.items[0]
        assertEquals(41L, a.id)
        assertEquals(Severity.CRITICAL, a.severity)
        assertEquals("/app/41", a.link)
        assertEquals(1_792_404_000_000L, a.createdAtMillis())
        val b = page.items[1]
        assertEquals(Severity.INFO, b.severity)
        assertEquals("", b.body)
        assertNull(b.link)
        assertNotNull(b.createdAtMillis())
        assertTrue(b.read)

        // Round trip through the local cache format.
        val back = Alert.listFromJson(Alert.listToJson(page.items))
        assertEquals(page.items, back)
    }

    @Test
    fun mergeAndSelect() {
        fun al(id: Long, read: Boolean = false) =
            Alert(id, "t", Severity.INFO, "t$id", "", null, "", read)
        val merged = mergeRecent(listOf(al(1), al(2), al(3)), listOf(al(3, read = true), al(4)), limit = 3)
        assertEquals(listOf(4L, 3L, 2L), merged.map { it.id })
        assertTrue(merged[1].read)

        val chosen = selectToNotify(listOf(al(5), al(6, read = true), al(7), al(3)), lastNotifiedId = 4, max = 10)
        assertEquals(listOf(7L, 5L), chosen.map { it.id })
        assertEquals(listOf(7L), selectToNotify(listOf(al(5), al(7)), 0, max = 1).map { it.id })
    }
}
