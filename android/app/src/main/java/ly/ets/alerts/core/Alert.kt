package ly.ets.alerts.core

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeParseException

enum class Severity(val wire: String) {
    INFO("info"), WARNING("warning"), CRITICAL("critical");

    companion object {
        fun from(value: String?): Severity =
            values().firstOrNull { it.wire.equals(value?.trim(), ignoreCase = true) } ?: INFO
    }
}

/** One item of `GET /api/m/notifications`. */
data class Alert(
    val id: Long,
    val type: String,
    val severity: Severity,
    val title: String,
    val body: String,
    val link: String?,
    val createdAt: String,
    val read: Boolean,
) {
    /** Epoch millis of [createdAt], or null if it cannot be parsed. */
    fun createdAtMillis(): Long? = parseTime(createdAt)

    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("type", type)
        .put("severity", severity.wire)
        .put("title", title)
        .put("body", body)
        .put("link", link ?: JSONObject.NULL)
        .put("created_at", createdAt)
        .put("read", read)

    companion object {
        /** Returns null for items without a usable id so one bad row never breaks the list. */
        fun fromJson(obj: JSONObject): Alert? {
            val id = Json.optLongOrNull(obj, "id") ?: return null
            if (id <= 0) return null
            return Alert(
                id = id,
                type = Json.optStringOrNull(obj, "type").orEmpty(),
                severity = Severity.from(Json.optStringOrNull(obj, "severity")),
                title = Json.optStringOrNull(obj, "title").orEmpty(),
                body = Json.optStringOrNull(obj, "body").orEmpty(),
                link = Json.optStringOrNull(obj, "link"),
                createdAt = Json.optStringOrNull(obj, "created_at").orEmpty(),
                read = Json.optBoolean(obj, "read", false),
            )
        }

        fun listFromJson(array: JSONArray?): List<Alert> {
            if (array == null) return emptyList()
            val out = ArrayList<Alert>(array.length())
            for (i in 0 until array.length()) {
                val o = array.optJSONObject(i) ?: continue
                fromJson(o)?.let(out::add)
            }
            return out
        }

        fun listToJson(alerts: List<Alert>): JSONArray {
            val arr = JSONArray()
            alerts.forEach { arr.put(it.toJson()) }
            return arr
        }

        /** ISO-8601 with offset (`2026-10-19T10:00:00.000Z`); naive timestamps are read as UTC. */
        fun parseTime(value: String): Long? {
            val v = value.trim()
            if (v.isEmpty()) return null
            try {
                return OffsetDateTime.parse(v).toInstant().toEpochMilli()
            } catch (e: DateTimeParseException) {
            }
            try {
                return Instant.parse(v).toEpochMilli()
            } catch (e: DateTimeParseException) {
            }
            return try {
                LocalDateTime.parse(v.replace(' ', 'T')).toInstant(ZoneOffset.UTC).toEpochMilli()
            } catch (e: DateTimeParseException) {
                null
            }
        }
    }
}

/** Response of `GET /api/m/notifications`. */
data class AlertPage(val items: List<Alert>, val unread: Int) {
    companion object {
        fun fromJson(obj: JSONObject): AlertPage = AlertPage(
            items = Alert.listFromJson(obj.optJSONArray("items")),
            unread = (Json.optLongOrNull(obj, "unread") ?: 0L).toInt().coerceAtLeast(0),
        )
    }
}

/**
 * Keeps the newest [limit] alerts by id, newer copies replacing older ones
 * (so read flags refreshed from the server win).
 */
fun mergeRecent(existing: List<Alert>, incoming: List<Alert>, limit: Int = 50): List<Alert> {
    val byId = LinkedHashMap<Long, Alert>()
    existing.forEach { byId[it.id] = it }
    incoming.forEach { byId[it.id] = it }
    return byId.values.sortedByDescending { it.id }.take(limit)
}

/**
 * Which of the freshly fetched items deserve a system notification:
 * unread, newer than the last notified id, newest first, at most [max].
 */
fun selectToNotify(items: List<Alert>, lastNotifiedId: Long, max: Int = 10): List<Alert> =
    items.filter { !it.read && it.id > lastNotifiedId }
        .sortedByDescending { it.id }
        .take(max)
