package ly.ets.alerts.net

import ly.ets.alerts.core.AlertPage
import ly.ets.alerts.core.Json
import ly.ets.alerts.core.UrlRules
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** The device token was revoked or is unknown (HTTP 401). The app must unpair. */
class UnauthorizedException : IOException("unauthorized")

/** Any other non-success HTTP status. [serverMessage] is the server's `error` field if present. */
class ApiException(val status: Int, val serverMessage: String?) : IOException("HTTP $status")

data class PairResult(val deviceId: String, val token: String, val fullName: String, val lang: String?)

/** Result of asking the server to revoke this device (`DELETE /api/m/device`). */
enum class RemoteUnpair {
    /** 2xx: the server revoked the device. */
    REVOKED,

    /** 401: the token is already unknown or revoked, so there is nothing left to revoke. */
    ALREADY_GONE,

    /** Network error, timeout or any other status: the device may still be listed on the web. */
    FAILED,
}

data class Me(val fullName: String, val lang: String?, val serverVersion: String?)

/**
 * Thin client for the ETS device API. Free of Android classes so it is unit tested on the JVM.
 * The token is only ever placed in the Authorization header; it is never logged or put in URLs.
 */
class EtsApi(
    private val baseUrl: String,
    private val client: OkHttpClient,
    private val token: String?,
    private val userAgent: String,
) {
    fun pair(code: String, deviceName: String, appVersion: String): PairResult {
        val body = JSONObject()
            .put("code", code)
            .put("device_name", deviceName)
            .put("platform", "android")
            .put("app_version", appVersion)
        val request = baseRequest("/api/devices/pair", authenticated = false)
            .post(body.toString().toRequestBody(JSON))
            .build()
        // A 401 here means a bad pairing code, not a revoked device.
        val obj = execute(request, unauthorizedIsRevocation = false)
        val user = obj.optJSONObject("user")
        val deviceId = Json.optStringOrNull(obj, "device_id")
        val token = Json.optStringOrNull(obj, "token")
        if (deviceId.isNullOrEmpty() || token.isNullOrEmpty()) throw IOException("Malformed pairing response")
        return PairResult(
            deviceId = deviceId,
            token = token,
            fullName = user?.let { Json.optStringOrNull(it, "full_name") }.orEmpty(),
            lang = user?.let { Json.optStringOrNull(it, "lang") },
        )
    }

    fun me(): Me {
        val obj = execute(baseRequest("/api/m/me").get().build())
        return Me(
            fullName = Json.optStringOrNull(obj, "full_name").orEmpty(),
            lang = Json.optStringOrNull(obj, "lang"),
            serverVersion = Json.optStringOrNull(obj, "server_version"),
        )
    }

    fun notifications(afterId: Long, limit: Int = PAGE_SIZE): AlertPage {
        val path = "/api/m/notifications?after_id=${afterId.coerceAtLeast(0)}&limit=$limit"
        return AlertPage.fromJson(execute(baseRequest(path).get().build()))
    }

    fun markRead(id: Long) {
        val request = baseRequest("/api/m/notifications/$id/read")
            .post(ByteArray(0).toRequestBody(null))
            .build()
        client.newCall(request).execute().use { checkStatus(it, unauthorizedIsRevocation = true) }
    }

    /**
     * Best-effort `DELETE /api/m/device` with a short overall timeout. Never throws:
     * the caller always wipes local state afterwards, whatever the outcome.
     */
    fun unregisterDevice(timeoutMs: Long = UNPAIR_TIMEOUT_MS): RemoteUnpair {
        val quick = client.newBuilder()
            .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(false)
            .build()
        return try {
            val request = baseRequest("/api/m/device").delete().build()
            quick.newCall(request).execute().use { response ->
                when {
                    response.isSuccessful -> RemoteUnpair.REVOKED
                    response.code == 401 -> RemoteUnpair.ALREADY_GONE
                    else -> RemoteUnpair.FAILED
                }
            }
        } catch (e: UnauthorizedException) {
            RemoteUnpair.ALREADY_GONE // no token stored at all
        } catch (e: IOException) {
            RemoteUnpair.FAILED
        } catch (e: RuntimeException) {
            RemoteUnpair.FAILED
        }
    }

    /** Request for the SSE stream; executed by okhttp-sse in the foreground service. */
    fun eventsRequest(): Request = baseRequest("/api/m/events")
        .header("Accept", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .get()
        .build()

    private fun baseRequest(path: String, authenticated: Boolean = true): Request.Builder {
        val builder = Request.Builder()
            .url(UrlRules.api(baseUrl, path))
            .header("User-Agent", userAgent)
            .header("Accept", "application/json")
        if (authenticated) {
            val t = token ?: throw UnauthorizedException()
            builder.header("Authorization", "Bearer $t")
        }
        return builder
    }

    private fun execute(request: Request, unauthorizedIsRevocation: Boolean = true): JSONObject =
        client.newCall(request).execute().use { response ->
            checkStatus(response, unauthorizedIsRevocation)
            val text = response.body?.string().orEmpty()
            try {
                JSONObject(text)
            } catch (e: JSONException) {
                throw IOException("Malformed JSON from server")
            }
        }

    private fun checkStatus(response: Response, unauthorizedIsRevocation: Boolean) {
        if (response.isSuccessful) return
        if (response.code == 401 && unauthorizedIsRevocation) throw UnauthorizedException()
        val message = try {
            val text = response.body?.string().orEmpty()
            Json.optStringOrNull(JSONObject(text), "error")
        } catch (e: Exception) {
            null
        }
        throw ApiException(response.code, message?.take(200))
    }

    companion object {
        const val PAGE_SIZE = 50
        const val UNPAIR_TIMEOUT_MS = 5_000L
        private val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
