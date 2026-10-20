package ly.ets.alerts.core

import java.net.URI
import java.net.URISyntaxException
import java.util.Locale

/**
 * Rules of the in-app browser (1.1.0): which URLs stay in the WebView, which certificate error may be
 * overridden, and the User-Agent marker that makes the server open a read-only session.
 * Pure Kotlin, unit-tested; [ly.ets.alerts.ui.WebActivity] applies them.
 */
object WebRules {
    /** The server recognises the app by this product token (backend/src/middleware/auth.js, MOBILE_UA). */
    const val UA_PRODUCT = "ETSAlerts"

    private val VERSION_OK = Regex("^[0-9A-Za-z.+_-]{1,40}$")

    /** `<WebView default UA> ETSAlerts/<version> (Android)`. A version the server would not accept becomes "0". */
    fun userAgent(defaultUa: String?, version: String): String {
        val v = version.trim().takeIf { VERSION_OK.matches(it) } ?: "0"
        val base = defaultUa?.trim().orEmpty()
        return (if (base.isEmpty()) "" else "$base ") + "$UA_PRODUCT/$v (Android)"
    }

    private data class Origin(val host: String, val port: Int, val path: String)

    private fun origin(url: String?): Origin? {
        if (url.isNullOrBlank()) return null
        return try {
            val u = URI(url.trim())
            if (u.scheme?.lowercase(Locale.ROOT) != "https") return null
            if (u.rawUserInfo != null) return null
            val host = u.host?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() } ?: return null
            Origin(host, if (u.port == -1) 443 else u.port, u.rawPath ?: "")
        } catch (e: URISyntaxException) {
            null
        }
    }

    /** Same scheme (https), host and port as the paired server. */
    fun sameOrigin(baseUrl: String, url: String?): Boolean {
        val b = origin(baseUrl) ?: return false
        val u = origin(url) ?: return false
        return b.host == u.host && b.port == u.port
    }

    /**
     * True when [url] belongs in the WebView: the paired server's origin and, when ETS is served under a
     * path (`https://host/ets`), that path. Everything else opens in the external browser.
     */
    fun isInApp(baseUrl: String, url: String?): Boolean {
        if (!sameOrigin(baseUrl, url)) return false
        val basePath = origin(baseUrl)!!.path.trimEnd('/')
        if (basePath.isEmpty()) return true
        val path = origin(url)!!.path
        return path == basePath || path.startsWith("$basePath/")
    }

    /**
     * Whether a TLS error reported by the WebView may be overridden: ONLY when the pairing carries a pin,
     * the failing URL is on the paired host and port, and the SHA-256 of the leaf certificate's DER encoding
     * equals the pin. Without a pin the system trust decides (no override); anything missing means no.
     */
    fun allowCertificate(pin: String?, baseUrl: String, errorUrl: String?, leafDer: ByteArray?): Boolean {
        if (pin == null || leafDer == null || leafDer.isEmpty()) return false
        if (Fingerprint.normalize(pin) == null) return false
        if (!sameOrigin(baseUrl, errorUrl)) return false
        return Fingerprint.matches(leafDer, pin)
    }

    /**
     * After a page has loaded without a TLS error (a certificate the system trusts), a pinned pairing still
     * checks the page's certificate: false only when a certificate is known and differs from the pin.
     */
    fun pageCertificateOk(pin: String?, leafDer: ByteArray?): Boolean {
        if (pin == null || leafDer == null || leafDer.isEmpty()) return true
        return Fingerprint.matches(leafDer, pin)
    }
}
