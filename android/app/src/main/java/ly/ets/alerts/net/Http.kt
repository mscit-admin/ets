package ly.ets.alerts.net

import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext

/**
 * OkHttp clients. One shared base (connection pool, dispatcher) and a derived client per
 * trust mode:
 *  - pin present  -> [PinnedTrustManager] + [PinnedHostnameVerifier] (only that certificate).
 *  - pin absent   -> platform trust store as configured by res/xml/network_security_config.xml.
 * Cleartext is impossible: only MODERN_TLS connection specs are allowed and http:// base
 * URLs are rejected at pairing time. Redirects are not followed so the bearer token is never
 * sent anywhere other than the paired origin.
 */
object Http {
    private val base: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .callTimeout(60, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
    }

    private val lock = Any()
    private var cachedPin: String? = null
    private var cachedClient: OkHttpClient? = null

    fun client(pinSha256: String?): OkHttpClient = synchronized(lock) {
        val cached = cachedClient
        if (cached != null && cachedPin == pinSha256) return cached
        val built = if (pinSha256 == null) {
            base
        } else {
            val tm = PinnedTrustManager(pinSha256)
            val ctx = SSLContext.getInstance("TLS")
            ctx.init(null, arrayOf(tm), null)
            base.newBuilder()
                .sslSocketFactory(ctx.socketFactory, tm)
                .hostnameVerifier(PinnedHostnameVerifier(pinSha256))
                .build()
        }
        cachedPin = pinSha256
        cachedClient = built
        built
    }

    /** Long-lived SSE client: no call timeout; read timeout well above the 25 s heartbeat. */
    fun streamClient(pinSha256: String?): OkHttpClient =
        client(pinSha256).newBuilder()
            .readTimeout(75, TimeUnit.SECONDS)
            .callTimeout(0, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()
}
