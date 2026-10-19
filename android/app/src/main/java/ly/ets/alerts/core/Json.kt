package ly.ets.alerts.core

import org.json.JSONObject

/**
 * Null-safe accessors that behave identically on Android's org.json and the
 * Maven org.json used in JVM tests (they differ on how JSON null is coerced).
 */
object Json {
    fun optStringOrNull(obj: JSONObject, key: String): String? {
        val value = obj.opt(key)
        if (value == null || value == JSONObject.NULL) return null
        return value as? String ?: value.toString()
    }

    /** Accepts a JSON number or a numeric string (PostgreSQL bigint ids arrive as strings). */
    fun optLongOrNull(obj: JSONObject, key: String): Long? {
        val value = obj.opt(key)
        if (value == null || value == JSONObject.NULL) return null
        return when (value) {
            is Int -> value.toLong()
            is Long -> value
            is Number -> {
                val d = value.toDouble()
                if (d % 1.0 == 0.0 && d >= Long.MIN_VALUE && d <= Long.MAX_VALUE) d.toLong() else null
            }
            is String -> value.trim().toLongOrNull()
            else -> null
        }
    }

    fun optBoolean(obj: JSONObject, key: String, default: Boolean): Boolean {
        val value = obj.opt(key)
        return when (value) {
            is Boolean -> value
            is Number -> value.toInt() != 0
            is String -> value.equals("true", ignoreCase = true)
            else -> default
        }
    }
}
