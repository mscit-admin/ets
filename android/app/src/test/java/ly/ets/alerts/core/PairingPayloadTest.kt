package ly.ets.alerts.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class PairingPayloadTest {
    private val pin = "3f".repeat(32)

    private fun reasonOf(raw: String): PairingException.Reason? = try {
        PairingPayload.parse(raw)
        null
    } catch (e: PairingException) {
        e.reason
    }

    @Test
    fun parsesPinnedPayload() {
        val p = PairingPayload.parse(
            """{"v":1,"url":"https://ets.example.local/","code":"ABCD-1234","cert_sha256":"$pin"}""",
        )
        assertEquals("https://ets.example.local", p.baseUrl)
        assertEquals("ABCD-1234", p.code)
        assertEquals(pin, p.certSha256)
    }

    @Test
    fun nullOrMissingPinMeansSystemTrust() {
        assertNull(PairingPayload.parse("""{"v":1,"url":"https://a.b","code":"X1","cert_sha256":null}""").certSha256)
        assertNull(PairingPayload.parse("""{"v":1,"url":"https://a.b","code":"X1"}""").certSha256)
        assertNull(PairingPayload.parse("""{"v":1,"url":"https://a.b","code":"X1","cert_sha256":""}""").certSha256)
    }

    @Test
    fun acceptsColonSeparatedUppercasePin() {
        val colon = pin.uppercase().chunked(2).joinToString(":")
        val p = PairingPayload.parse("""{"v":1,"url":"https://a.b","code":"X1","cert_sha256":"$colon"}""")
        assertEquals(pin, p.certSha256)
    }

    @Test
    fun keepsPortAndIp() {
        val p = PairingPayload.parse("""{"v":1,"url":"https://10.8.0.1:8443","code":"X1"}""")
        assertEquals("https://10.8.0.1:8443", p.baseUrl)
    }

    @Test
    fun rejectsInvalidPayloads() {
        assertEquals(PairingException.Reason.EMPTY, reasonOf("   "))
        assertEquals(PairingException.Reason.NOT_JSON, reasonOf("ABCD-1234"))
        assertEquals(PairingException.Reason.UNSUPPORTED_VERSION, reasonOf("""{"v":2,"url":"https://a.b","code":"X1"}"""))
        assertEquals(PairingException.Reason.UNSUPPORTED_VERSION, reasonOf("""{"url":"https://a.b","code":"X1"}"""))
        assertEquals(PairingException.Reason.BAD_URL, reasonOf("""{"v":1,"url":"http://a.b","code":"X1"}"""))
        assertEquals(PairingException.Reason.BAD_URL, reasonOf("""{"v":1,"url":"https://u:p@a.b","code":"X1"}"""))
        assertEquals(PairingException.Reason.BAD_URL, reasonOf("""{"v":1,"code":"X1"}"""))
        assertEquals(PairingException.Reason.BAD_CODE, reasonOf("""{"v":1,"url":"https://a.b","code":""}"""))
        assertEquals(PairingException.Reason.BAD_CODE, reasonOf("""{"v":1,"url":"https://a.b","code":"a b"}"""))
        assertEquals(
            PairingException.Reason.BAD_FINGERPRINT,
            reasonOf("""{"v":1,"url":"https://a.b","code":"X1","cert_sha256":"abc"}"""),
        )
    }

    @Test
    fun parseNeverThrowsOtherExceptions() {
        listOf("[]", "{", "null", """{"v":"1"}""", """{"v":1,"url":123,"code":5}""").forEach {
            try {
                PairingPayload.parse(it)
                fail("expected PairingException for $it")
            } catch (e: PairingException) {
                // expected
            }
        }
    }
}
