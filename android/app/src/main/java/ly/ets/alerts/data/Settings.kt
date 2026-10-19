package ly.ets.alerts.data

import android.content.Context
import android.content.SharedPreferences
import ly.ets.alerts.core.Alert
import org.json.JSONArray

/** Snapshot of the pairing needed to talk to the server. */
data class Pairing(
    val baseUrl: String,
    val certSha256: String?,
    val token: String,
)

/**
 * App state in private SharedPreferences (backups are disabled in the manifest).
 * The bearer token is stored only as Keystore-wrapped ciphertext, see [TokenVault].
 */
class Settings private constructor(private val prefs: SharedPreferences) {

    /** Returns the current pairing, or null when the app is not paired (or the token was lost). */
    fun pairing(): Pairing? {
        val url = prefs.getString(K_URL, null) ?: return null
        val token = TokenVault.decrypt(prefs.getString(K_TOKEN, null)) ?: return null
        return Pairing(url, prefs.getString(K_PIN, null), token)
    }

    val isPaired: Boolean get() = prefs.getString(K_URL, null) != null && prefs.getString(K_TOKEN, null) != null

    val baseUrl: String? get() = prefs.getString(K_URL, null)
    val certSha256: String? get() = prefs.getString(K_PIN, null)
    val fullName: String? get() = prefs.getString(K_NAME, null)
    val deviceId: String? get() = prefs.getString(K_DEVICE, null)

    var persistentConnection: Boolean
        get() = prefs.getBoolean(K_PERSISTENT, true)
        set(value) = prefs.edit().putBoolean(K_PERSISTENT, value).apply()

    var lastNotifiedId: Long
        get() = prefs.getLong(K_LAST_ID, 0L)
        set(value) = prefs.edit().putLong(K_LAST_ID, value).apply()

    /** False until the first sync after pairing, which records a baseline without notifying. */
    var baselineDone: Boolean
        get() = prefs.getBoolean(K_BASELINE, false)
        set(value) = prefs.edit().putBoolean(K_BASELINE, value).apply()

    var unread: Int
        get() = prefs.getInt(K_UNREAD, 0)
        set(value) = prefs.edit().putInt(K_UNREAD, value).apply()

    var recent: List<Alert>
        get() = try {
            Alert.listFromJson(JSONArray(prefs.getString(K_RECENT, "[]") ?: "[]"))
        } catch (e: Exception) {
            emptyList()
        }
        set(value) = prefs.edit().putString(K_RECENT, Alert.listToJson(value).toString()).apply()

    fun savePairing(baseUrl: String, certSha256: String?, token: String, deviceId: String, fullName: String, lang: String?) {
        prefs.edit()
            .putString(K_URL, baseUrl)
            .putString(K_PIN, certSha256)
            .putString(K_TOKEN, TokenVault.encrypt(token))
            .putString(K_DEVICE, deviceId)
            .putString(K_NAME, fullName)
            .putString(K_LANG, lang)
            .putLong(K_LAST_ID, 0L)
            .putBoolean(K_BASELINE, false)
            .putInt(K_UNREAD, 0)
            .remove(K_RECENT)
            .commit()
    }

    fun updateProfile(fullName: String?) {
        if (!fullName.isNullOrBlank()) prefs.edit().putString(K_NAME, fullName).apply()
    }

    /** Wipes the token and all server data. Returns true if a pairing existed. */
    fun clearPairing(): Boolean {
        val had = prefs.getString(K_TOKEN, null) != null
        val persistent = persistentConnection
        prefs.edit().clear().putBoolean(K_PERSISTENT, persistent).commit()
        TokenVault.deleteKey()
        return had
    }

    companion object {
        private const val FILE = "ets_alerts"
        private const val K_URL = "base_url"
        private const val K_PIN = "cert_sha256"
        private const val K_TOKEN = "token_wrapped"
        private const val K_DEVICE = "device_id"
        private const val K_NAME = "full_name"
        private const val K_LANG = "lang"
        private const val K_PERSISTENT = "persistent_connection"
        private const val K_LAST_ID = "last_notified_id"
        private const val K_BASELINE = "baseline_done"
        private const val K_UNREAD = "unread"
        private const val K_RECENT = "recent_alerts"

        @Volatile
        private var instance: Settings? = null

        fun get(context: Context): Settings =
            instance ?: synchronized(this) {
                instance ?: Settings(
                    context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE),
                ).also { instance = it }
            }
    }
}
