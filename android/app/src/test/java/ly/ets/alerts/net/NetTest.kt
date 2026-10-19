package ly.ets.alerts.net

import ly.ets.alerts.core.Fingerprint
import ly.ets.alerts.core.UrlRules
import okhttp3.OkHttpClient
import okhttp3.internal.tls.OkHostnameVerifier
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext

/**
 * Exercises the real TLS stack on the JVM against MockWebServer with self-signed certificates.
 */
class NetTest {
    private val servers = mutableListOf<MockWebServer>()

    private val localhostCert = HeldCertificate.Builder()
        .commonName("localhost")
        .addSubjectAlternativeName("localhost")
        .build()

    /** Certificate issued for a DNS name the phone does not use (e.g. reached via VPN IP). */
    private val otherNameCert = HeldCertificate.Builder()
        .commonName("ets.example.local")
        .addSubjectAlternativeName("ets.example.local")
        .build()

    @After
    fun tearDown() {
        servers.forEach { it.shutdown() }
    }

    private fun server(cert: HeldCertificate): MockWebServer {
        val s = MockWebServer()
        val hs = HandshakeCertificates.Builder().heldCertificate(cert).build()
        s.useHttps(hs.sslSocketFactory(), false)
        s.start()
        servers += s
        return s
    }

    private fun base(s: MockWebServer) = UrlRules.normalizeBaseUrl(s.url("/").toString())

    private fun pin(cert: HeldCertificate) = Fingerprint.sha256Hex(cert.certificate.encoded)

    /** Same construction as [Http.client] but with OkHttp's RFC 2818 verifier, since the JVM default rejects all. */
    private fun pinnedClient(pin: String): OkHttpClient {
        val tm = PinnedTrustManager(pin)
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf(tm), null)
        return OkHttpClient.Builder()
            .sslSocketFactory(ctx.socketFactory, tm)
            .hostnameVerifier(PinnedHostnameVerifier(pin, OkHostnameVerifier))
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.SECONDS)
            .build()
    }

    private fun api(s: MockWebServer, client: OkHttpClient, token: String? = "tok-123") =
        EtsApi(base(s), client, token, "ETS-Alerts-Test")

    @Test
    fun pairOverPinnedCertificate() {
        val s = server(localhostCert)
        s.enqueue(
            MockResponse().setBody(
                """{"device_id":"d-1","token":"secret","user":{"full_name":"Ali","lang":"ar"}}""",
            ),
        )
        val r = api(s, pinnedClient(pin(localhostCert)), token = null).pair("ABCD-1234", "Pixel", "1.0.0")
        assertEquals("d-1", r.deviceId)
        assertEquals("secret", r.token)
        assertEquals("Ali", r.fullName)
        assertEquals("ar", r.lang)

        val req = s.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/devices/pair", req.path)
        assertNull(req.getHeader("Authorization"))
        val sent = JSONObject(req.body.readUtf8())
        assertEquals("ABCD-1234", sent.getString("code"))
        assertEquals("android", sent.getString("platform"))
        assertEquals("Pixel", sent.getString("device_name"))
        assertEquals("1.0.0", sent.getString("app_version"))
    }

    @Test
    fun productionClientAcceptsPinnedCertificate() {
        val s = server(localhostCert)
        s.enqueue(MockResponse().setBody("""{"full_name":"Ali","lang":"en","server_version":"2.1"}"""))
        val me = api(s, Http.client(pin(localhostCert))).me()
        assertEquals("2.1", me.serverVersion)
        assertEquals("Bearer tok-123", s.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun wrongPinIsRejected() {
        val s = server(localhostCert)
        s.enqueue(MockResponse().setBody("{}"))
        try {
            api(s, pinnedClient(pin(otherNameCert))).me()
            fail("connection with a non-pinned certificate must fail")
        } catch (e: IOException) {
            assertFalse(e is UnauthorizedException)
        }
        assertEquals(0, s.requestCount)
    }

    @Test
    fun hostnameMismatchAcceptedOnlyBecausePinned() {
        val s = server(otherNameCert)
        s.enqueue(MockResponse().setBody("""{"full_name":"A"}"""))
        assertEquals("A", api(s, pinnedClient(pin(otherNameCert))).me().fullName)
    }

    @Test
    fun noPinUsesSystemTrustAndRejectsSelfSigned() {
        val s = server(localhostCert)
        s.enqueue(MockResponse().setBody("{}"))
        try {
            api(s, Http.client(null)).me()
            fail("self-signed certificate must not be trusted without a pin")
        } catch (e: IOException) {
            // expected: SSLHandshakeException
        }
    }

    @Test
    fun unauthorizedMeansRevokedExceptDuringPairing() {
        val s = server(localhostCert)
        val client = pinnedClient(pin(localhostCert))
        s.enqueue(MockResponse().setResponseCode(401))
        try {
            api(s, client).notifications(0)
            fail()
        } catch (e: UnauthorizedException) {
            // expected
        }
        s.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"invalid code"}"""))
        try {
            api(s, client, token = null).pair("X", "d", "1")
            fail()
        } catch (e: ApiException) {
            assertEquals(401, e.status)
            assertEquals("invalid code", e.serverMessage)
        }
    }

    @Test
    fun notificationsAndMarkRead() {
        val s = server(localhostCert)
        val client = pinnedClient(pin(localhostCert))
        s.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":7,"type":"t","severity":"warning","title":"T","body":"B",
                   "link":"/app/7","created_at":"2026-10-19T10:00:00Z","read":false}],"unread":1}""",
            ),
        )
        s.enqueue(MockResponse().setResponseCode(204))
        val page = api(s, client).notifications(5)
        assertEquals(1, page.unread)
        assertEquals(7L, page.items.single().id)
        assertEquals("/api/m/notifications?after_id=5&limit=50", s.takeRequest().path)

        api(s, client).markRead(7)
        val mark = s.takeRequest()
        assertEquals("POST", mark.method)
        assertEquals("/api/m/notifications/7/read", mark.path)
        assertTrue(mark.getHeader("Authorization")!!.startsWith("Bearer "))
    }
}
