package ly.ets.alerts.core

import org.json.JSONException
import org.json.JSONObject

/**
 * Content of the pairing QR shown on the ETS web Profile page (أجهزتي):
 * `{"v":1,"url":"https://ets.example.local","code":"ABCD-1234","cert_sha256":"<hex>|null"}`.
 *
 * Pure Kotlin + org.json so it can be unit tested on the JVM.
 */
data class PairingPayload(
    val baseUrl: String,
    val code: String,
    /** Lowercase 64-char hex SHA-256 of the server leaf certificate (DER), or null for system trust. */
    val certSha256: String?,
) {
    companion object {
        const val SUPPORTED_VERSION = 1
        private const val MAX_CODE_LENGTH = 64
        private val CODE_PATTERN = Regex("^[A-Za-z0-9-]+$")

        /** Parses and validates a scanned or pasted payload. Throws [PairingException] with a reason. */
        fun parse(raw: String): PairingPayload {
            val text = raw.trim()
            if (text.isEmpty()) throw PairingException(PairingException.Reason.EMPTY)
            val obj = try {
                JSONObject(text)
            } catch (e: JSONException) {
                throw PairingException(PairingException.Reason.NOT_JSON)
            }

            val version = Json.optLongOrNull(obj, "v")
            if (version != SUPPORTED_VERSION.toLong()) {
                throw PairingException(PairingException.Reason.UNSUPPORTED_VERSION)
            }

            val url = Json.optStringOrNull(obj, "url")
                ?: throw PairingException(PairingException.Reason.BAD_URL)
            val baseUrl = try {
                UrlRules.normalizeBaseUrl(url)
            } catch (e: IllegalArgumentException) {
                throw PairingException(PairingException.Reason.BAD_URL)
            }

            val code = Json.optStringOrNull(obj, "code")?.trim().orEmpty()
            if (code.isEmpty() || code.length > MAX_CODE_LENGTH || !CODE_PATTERN.matches(code)) {
                throw PairingException(PairingException.Reason.BAD_CODE)
            }

            val pinRaw = Json.optStringOrNull(obj, "cert_sha256")?.trim()
            val pin = if (pinRaw.isNullOrEmpty()) {
                null
            } else {
                Fingerprint.normalize(pinRaw)
                    ?: throw PairingException(PairingException.Reason.BAD_FINGERPRINT)
            }

            return PairingPayload(baseUrl, code, pin)
        }
    }
}

class PairingException(val reason: Reason) : Exception(reason.name) {
    enum class Reason { EMPTY, NOT_JSON, UNSUPPORTED_VERSION, BAD_URL, BAD_CODE, BAD_FINGERPRINT }
}
