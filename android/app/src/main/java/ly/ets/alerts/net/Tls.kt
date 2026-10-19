package ly.ets.alerts.net

import ly.ets.alerts.core.Fingerprint
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSession
import javax.net.ssl.X509TrustManager

/**
 * Trusts exactly one server certificate: the leaf whose SHA-256 (over its DER encoding)
 * equals the fingerprint delivered in the pairing QR. No CA, user store or system store
 * is consulted, and every other certificate is rejected. This is the only trust manager
 * used when a pin is present; there is no trust-all path anywhere in the app.
 *
 * Expiry is intentionally not enforced: the pin identifies the exact certificate (like an
 * SSH host key), and self-signed ETS certificates are often long-lived or renewed with
 * the same key. Re-pairing is required whenever the server certificate changes.
 */
class PinnedTrustManager(private val pinSha256: String) : X509TrustManager {

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("Empty server certificate chain")
        if (!Fingerprint.matches(leaf.encoded, pinSha256)) {
            throw CertificateException("Server certificate does not match the paired fingerprint")
        }
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("Client certificates are not accepted")
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/**
 * Hostname verification for pinned connections.
 *
 * 1. Normal RFC 2818 verification against the certificate's subjectAltName (DNS or IP)
 *    using the platform verifier.
 * 2. If that fails (typically a self-signed certificate issued for a DNS name while the
 *    phone reaches the server by a VPN IP, or a certificate with no IP SAN), the
 *    connection is still accepted ONLY because the presented leaf is byte-for-byte the
 *    pinned certificate. [PinnedTrustManager] has already rejected any other certificate
 *    during the handshake; this re-check makes the exception explicit and self-contained.
 *
 * Without a pin the app uses OkHttp's default verifier and never takes this path.
 */
class PinnedHostnameVerifier(
    private val pinSha256: String,
    private val platform: HostnameVerifier = HttpsURLConnection.getDefaultHostnameVerifier(),
) : HostnameVerifier {
    override fun verify(hostname: String?, session: SSLSession?): Boolean {
        if (session == null) return false
        if (platform.verify(hostname, session)) return true
        val leaf = try {
            session.peerCertificates.firstOrNull() as? X509Certificate
        } catch (e: SSLPeerUnverifiedException) {
            null
        } ?: return false
        return Fingerprint.matches(leaf.encoded, pinSha256)
    }
}
