package ly.ets.alerts.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebRulesTest {
    private val base = "https://ets.example.ly"
    private val der = "leaf-certificate-der".toByteArray()
    private val pin = Fingerprint.sha256Hex(der)

    @Test
    fun pinnedCertificateIsAcceptedOnlyOnThePairedHost() {
        assertTrue(WebRules.allowCertificate(pin, base, "https://ets.example.ly/", der))
        assertTrue(WebRules.allowCertificate(pin, base, "https://ETS.example.ly:443/api/auth/me", der))
        // the pin in the AB:CD form is the same pin
        assertTrue(WebRules.allowCertificate(pin.uppercase().chunked(2).joinToString(":"), base, "https://ets.example.ly/x", der))
        // VPN address pairing
        assertTrue(WebRules.allowCertificate(pin, "https://10.20.0.5:8443", "https://10.20.0.5:8443/app/per", der))
    }

    @Test
    fun anythingElseIsRefused() {
        // no pin: the system trust decides, never an override
        assertFalse(WebRules.allowCertificate(null, base, "https://ets.example.ly/", der))
        // another certificate
        assertFalse(WebRules.allowCertificate(pin, base, "https://ets.example.ly/", "other".toByteArray()))
        // no certificate / empty
        assertFalse(WebRules.allowCertificate(pin, base, "https://ets.example.ly/", null))
        assertFalse(WebRules.allowCertificate(pin, base, "https://ets.example.ly/", ByteArray(0)))
        // another host, port or scheme, a look-alike host, no URL
        assertFalse(WebRules.allowCertificate(pin, base, "https://evil.example.ly/", der))
        assertFalse(WebRules.allowCertificate(pin, base, "https://ets.example.ly.evil.ly/", der))
        assertFalse(WebRules.allowCertificate(pin, base, "https://ets.example.ly:8443/", der))
        assertFalse(WebRules.allowCertificate(pin, base, "http://ets.example.ly/", der))
        assertFalse(WebRules.allowCertificate(pin, base, "https://user@ets.example.ly/", der))
        assertFalse(WebRules.allowCertificate(pin, base, null, der))
        assertFalse(WebRules.allowCertificate(pin, base, "not a url", der))
        // a malformed pin
        assertFalse(WebRules.allowCertificate("abc", base, "https://ets.example.ly/", der))
    }

    @Test
    fun pageCertificateCheck() {
        assertTrue(WebRules.pageCertificateOk(null, der))
        assertTrue(WebRules.pageCertificateOk(pin, null))
        assertTrue(WebRules.pageCertificateOk(pin, der))
        assertFalse(WebRules.pageCertificateOk(pin, "other".toByteArray()))
    }

    @Test
    fun onlyThePairedOriginStaysInTheApp() {
        assertTrue(WebRules.isInApp(base, "https://ets.example.ly/"))
        assertTrue(WebRules.isInApp(base, "https://ets.example.ly/app/per#fn-12"))
        assertTrue(WebRules.isInApp(base, "https://ets.example.ly:443/notifications?x=1"))
        assertFalse(WebRules.isInApp(base, "http://ets.example.ly/"))
        assertFalse(WebRules.isInApp(base, "https://example.ly/"))
        assertFalse(WebRules.isInApp(base, "https://ets.example.ly:444/"))
        assertFalse(WebRules.isInApp(base, "https://github.com/"))
        assertFalse(WebRules.isInApp(base, "file:///sdcard/x.html"))
        assertFalse(WebRules.isInApp(base, "content://x/y"))
        assertFalse(WebRules.isInApp(base, "javascript:alert(1)"))
        assertFalse(WebRules.isInApp(base, null))
        // ETS under a path
        val sub = "https://h.example/ets"
        assertTrue(WebRules.isInApp(sub, "https://h.example/ets"))
        assertTrue(WebRules.isInApp(sub, "https://h.example/ets/app/x"))
        assertFalse(WebRules.isInApp(sub, "https://h.example/etsother"))
        assertFalse(WebRules.isInApp(sub, "https://h.example/"))
    }

    @Test
    fun userAgentCarriesTheServerMarker() {
        // same pattern as backend/src/middleware/auth.js (MOBILE_UA)
        val server = Regex("\\bETSAlerts/[0-9A-Za-z.+_-]{1,40} \\(Android\\)")
        val ua = WebRules.userAgent("Mozilla/5.0 (Linux; Android 14; wv) Chrome/129.0 Mobile Safari/537.36", "1.1.0")
        assertEquals("Mozilla/5.0 (Linux; Android 14; wv) Chrome/129.0 Mobile Safari/537.36 ETSAlerts/1.1.0 (Android)", ua)
        assertTrue(server.containsMatchIn(ua))
        assertTrue(server.containsMatchIn(WebRules.userAgent(null, "1.1.0-debug")))
        assertEquals("ETSAlerts/0 (Android)", WebRules.userAgent("", "1.1 beta (x)"))
    }
}
