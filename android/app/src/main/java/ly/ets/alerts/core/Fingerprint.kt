package ly.ets.alerts.core

import java.security.MessageDigest

/** SHA-256 certificate fingerprints, as lowercase hex without separators. */
object Fingerprint {
    private val HEX64 = Regex("^[0-9a-f]{64}$")

    /**
     * Accepts `abcd...`, `AB:CD:...` or `ab cd ...` and returns 64 lowercase hex chars,
     * or null if the value is not a SHA-256 fingerprint.
     */
    fun normalize(value: String): String? {
        val cleaned = value.trim().replace(":", "").replace(" ", "").lowercase()
        return if (HEX64.matches(cleaned)) cleaned else null
    }

    fun sha256Hex(der: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(der)
        val out = StringBuilder(digest.size * 2)
        for (b in digest) {
            val v = b.toInt() and 0xff
            out.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
        }
        return out.toString()
    }

    /** Constant-time comparison of the DER encoding's SHA-256 against a normalized pin. */
    fun matches(der: ByteArray, pin: String): Boolean {
        val expected = normalize(pin) ?: return false
        return MessageDigest.isEqual(
            sha256Hex(der).toByteArray(Charsets.US_ASCII),
            expected.toByteArray(Charsets.US_ASCII),
        )
    }

    /** `ab:cd:...` grouping for display to the user. */
    fun display(pin: String): String = pin.chunked(2).joinToString(":").uppercase()

    private val HEX = "0123456789abcdef".toCharArray()
}
